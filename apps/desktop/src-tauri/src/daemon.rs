use crate::config;
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    env,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

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
    child: Option<CommandChild>,
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
        pid: state.child.as_ref().map(CommandChild::pid),
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
    let mut values = HashMap::from([
        ("COHALL_RELAY_URL".into(), settings.relay_url.clone()),
        ("COHALL_TOKEN".into(), token),
        ("COHALL_DEVICE_ID".into(), settings.device_id.clone()),
        ("COHALL_DEVICE_NAME".into(), settings.device_name.clone()),
        (
            "COHALL_DEVICE_WORKSPACES".into(),
            settings.workspaces.join(","),
        ),
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
    let (mut events, child) = command.spawn().map_err(|error| {
        if let Ok(mut state) = lock(supervisor) {
            state.status = "failed".into();
            state.last_error = Some(error.to_string());
        }
        error.to_string()
    })?;
    let pid = child.pid();
    {
        let mut state = lock(supervisor)?;
        state.child = Some(child);
        state.status = "running".into();
    }
    append(supervisor, format!("Device process started with pid {pid}"));
    emit(app, supervisor);

    let handle = app.clone();
    let managed = supervisor.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !line.is_empty() {
                        log::info!(target: "cohall::device", "{line}");
                        append(&managed, line);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !line.is_empty() {
                        log::warn!(target: "cohall::device", "{line}");
                        append(&managed, line);
                    }
                }
                CommandEvent::Error(error) => {
                    log::error!(target: "cohall::device", "{error}");
                    append(&managed, format!("Device process error: {error}"));
                    if let Ok(mut state) = lock(&managed) {
                        state.last_error = Some(error);
                    }
                    emit(&handle, &managed);
                }
                CommandEvent::Terminated(payload) => {
                    let restart = if let Ok(mut state) = lock(&managed) {
                        if state.child.as_ref().map(CommandChild::pid) != Some(pid) {
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
                        format!("Device process exited with code {:?}", payload.code),
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
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

pub fn stop<R: Runtime>(app: &AppHandle<R>, supervisor: &Supervisor) -> Result<(), String> {
    let child = {
        let mut state = lock(supervisor)?;
        state.desired = false;
        state.status = "stopping".into();
        state.child.take()
    };
    if let Some(child) = child {
        child.kill().map_err(|error| error.to_string())?;
    }
    {
        let mut state = lock(supervisor)?;
        state.status = "stopped".into();
    }
    append(supervisor, "Device process stopped".into());
    emit(app, supervisor);
    Ok(())
}

pub fn restart<R: Runtime>(app: &AppHandle<R>, supervisor: &Supervisor) -> Result<(), String> {
    stop(app, supervisor)?;
    start(app, supervisor)
}
