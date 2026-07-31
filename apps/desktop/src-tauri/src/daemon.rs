use crate::config;
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    env,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::Child,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::ShellExt;

const LOG_LIMIT: usize = 400;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub status: String,
    pub pid: Option<u32>,
    pub last_error: Option<String>,
    pub logs: Vec<String>,
}

struct RuntimeState {
    child: Option<Child>,
    desired: bool,
    status: String,
    last_error: Option<String>,
    logs: VecDeque<String>,
}

#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Mutex<RuntimeState>>,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RuntimeState {
                child: None,
                desired: false,
                status: "stopped".into(),
                last_error: None,
                logs: VecDeque::new(),
            })),
        }
    }
}

fn lock(supervisor: &Supervisor) -> Result<std::sync::MutexGuard<'_, RuntimeState>, String> {
    supervisor
        .inner
        .lock()
        .map_err(|_| "Device supervisor lock was poisoned".into())
}

fn snapshot(supervisor: &Supervisor) -> Result<RuntimeSnapshot, String> {
    let state = lock(supervisor)?;
    Ok(RuntimeSnapshot {
        status: state.status.clone(),
        pid: state.child.as_ref().map(Child::id),
        last_error: state.last_error.clone(),
        logs: state.logs.iter().cloned().collect(),
    })
}

fn emit<R: Runtime>(app: &AppHandle<R>, supervisor: &Supervisor) {
    if let Ok(current) = snapshot(supervisor) {
        let _ = app.emit("cohall://device-status", current);
    }
}

fn append(supervisor: &Supervisor, line: String) {
    if let Ok(mut state) = lock(supervisor) {
        state.logs.push_back(line);
        while state.logs.len() > LOG_LIMIT {
            state.logs.pop_front();
        }
    }
}

fn capture<R: Runtime, T: Read + Send + 'static>(
    app: AppHandle<R>,
    supervisor: Supervisor,
    stream: T,
    stderr: bool,
) {
    std::thread::spawn(move || {
        for result in BufReader::new(stream).lines() {
            let line = match result {
                Ok(line) => line.trim().to_string(),
                Err(error) => {
                    let message = format!("Could not read device output: {error}");
                    append(&supervisor, message.clone());
                    if let Ok(mut state) = lock(&supervisor) {
                        state.last_error = Some(message);
                    }
                    emit(&app, &supervisor);
                    break;
                }
            };
            if line.is_empty() {
                continue;
            }
            if stderr {
                log::warn!(target: "cohall::device", "{line}");
            } else {
                log::info!(target: "cohall::device", "{line}");
            }
            append(&supervisor, line);
        }
    });
}

fn gui_path<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let mut paths = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    if let Ok(home) = app.path().home_dir() {
        paths.push(home.join(".local/bin"));
        paths.push(home.join(".cargo/bin"));
    }
    if let Some(current) = env::var_os("PATH") {
        paths.extend(env::split_paths(&current));
    }
    env::join_paths(paths)
        .ok()
        .map(|value| value.to_string_lossy().into_owned())
}

fn environment<R: Runtime>(
    app: &AppHandle<R>,
    settings: &config::DesktopConfig,
    token: String,
) -> Result<HashMap<String, String>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let workspaces =
        serde_json::to_string(&settings.workspaces).map_err(|error| error.to_string())?;
    let mut values = HashMap::from([
        ("COHALL_RELAY_URL".into(), settings.relay_url.clone()),
        ("COHALL_TOKEN".into(), token),
        ("COHALL_DEVICE_ID".into(), settings.device_id.clone()),
        ("COHALL_DEVICE_NAME".into(), settings.device_name.clone()),
        ("COHALL_DEVICE_WORKSPACES_JSON".into(), workspaces),
        (
            "COHALL_DATA_DIR".into(),
            data_dir.to_string_lossy().into_owned(),
        ),
        ("COHALL_CODEX_SANDBOX".into(), "workspace-write".into()),
    ]);
    if let Some(path) = gui_path(app) {
        values.insert("PATH".into(), path);
    }
    Ok(values)
}

pub fn status(supervisor: &Supervisor) -> Result<RuntimeSnapshot, String> {
    snapshot(supervisor)
}

pub fn start<R: Runtime>(app: &AppHandle<R>, supervisor: &Supervisor) -> Result<(), String> {
    {
        let mut state = lock(supervisor)?;
        state.desired = true;
        if state.child.is_some() {
            return Ok(());
        }
        state.status = "starting".into();
        state.last_error = None;
    }
    emit(app, supervisor);

    let settings =
        config::load(app)?.ok_or_else(|| "Pair this desktop with a relay first".to_string())?;
    let token = config::load_token()?
        .ok_or_else(|| "The relay session is missing from the keychain".to_string())?;
    let command = app
        .shell()
        .sidecar("cohall-device")
        .map_err(|error| error.to_string())?
        .arg("device")
        .envs(environment(app, &settings, token)?);
    let mut command: std::process::Command = command.into();
    let mut child = command.spawn().map_err(|error| {
        if let Ok(mut state) = lock(supervisor) {
            state.status = "failed".into();
            state.last_error = Some(error.to_string());
        }
        error.to_string()
    })?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let mut state = lock(supervisor)?;
        state.child = Some(child);
        state.status = "running".into();
    }
    if let Some(stdout) = stdout {
        capture(app.clone(), supervisor.clone(), stdout, false);
    }
    if let Some(stderr) = stderr {
        capture(app.clone(), supervisor.clone(), stderr, true);
    }
    append(supervisor, format!("Device process started with pid {pid}"));
    emit(app, supervisor);

    let handle = app.clone();
    let managed = supervisor.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let status = match lock(&managed) {
                Ok(mut state) if state.child.as_ref().map(Child::id) == Some(pid) => {
                    state.child.as_mut().map(Child::try_wait)
                }
                _ => return,
            };
            match status {
                Some(Ok(None)) => tokio::time::sleep(Duration::from_millis(100)).await,
                Some(Err(error)) => {
                    let message = format!("Could not monitor device process: {error}");
                    log::error!(target: "cohall::device", "{message}");
                    append(&managed, message.clone());
                    if let Ok(mut state) = lock(&managed) {
                        state.status = "failed".into();
                        state.last_error = Some(message);
                    }
                    emit(&handle, &managed);
                    return;
                }
                Some(Ok(Some(status))) => {
                    let restart = if let Ok(mut state) = lock(&managed) {
                        if state.child.as_ref().map(Child::id) != Some(pid) {
                            false
                        } else {
                            state.child.take();
                            state.status = if state.desired {
                                "restarting".into()
                            } else {
                                "stopped".into()
                            };
                            state.desired
                        }
                    } else {
                        false
                    };
                    append(
                        &managed,
                        format!("Device process exited with code {:?}", status.code()),
                    );
                    emit(&handle, &managed);
                    if restart {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        if let Err(error) = start(&handle, &managed) {
                            if let Ok(mut state) = lock(&managed) {
                                state.status = "failed".into();
                                state.last_error = Some(error);
                            }
                            emit(&handle, &managed);
                        }
                    }
                    return;
                }
                None => return,
            }
        }
    });
    Ok(())
}

pub fn stop<R: Runtime>(app: &AppHandle<R>, supervisor: &Supervisor) -> Result<(), String> {
    let result = {
        let mut state = lock(supervisor)?;
        state.desired = false;
        if state.child.is_none() {
            state.status = "stopped".into();
            return Ok(());
        }
        state.status = "stopping".into();
        state.child.as_mut().map(Child::kill)
    };
    if let Some(Err(error)) = result {
        let message = format!("Could not stop device process: {error}");
        if let Ok(mut state) = lock(supervisor) {
            state.status = "failed".into();
            state.last_error = Some(message.clone());
        }
        emit(app, supervisor);
        return Err(message);
    }
    append(supervisor, "Device process stop requested".into());
    emit(app, supervisor);
    Ok(())
}

pub fn restart<R: Runtime>(app: &AppHandle<R>, supervisor: &Supervisor) -> Result<(), String> {
    let result = {
        let mut state = lock(supervisor)?;
        state.desired = true;
        if state.child.is_none() {
            None
        } else {
            state.status = "restarting".into();
            state.child.as_mut().map(Child::kill)
        }
    };
    match result {
        None => start(app, supervisor),
        Some(Ok(())) => {
            append(supervisor, "Device process restart requested".into());
            emit(app, supervisor);
            Ok(())
        }
        Some(Err(error)) => {
            let message = format!("Could not restart device process: {error}");
            if let Ok(mut state) = lock(supervisor) {
                state.status = "failed".into();
                state.last_error = Some(message.clone());
            }
            emit(app, supervisor);
            Err(message)
        }
    }
}
