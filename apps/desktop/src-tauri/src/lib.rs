mod config;
mod daemon;
mod tray;

use config::DesktopConfig;
use daemon::{RuntimeSnapshot, Supervisor};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConnection {
    url: String,
    token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSnapshot {
    desktop: bool,
    version: String,
    connection: Option<DesktopConnection>,
    config: Option<DesktopConfig>,
    runtime: RuntimeSnapshot,
}

#[tauri::command]
fn desktop_snapshot(
    app: AppHandle,
    supervisor: State<'_, Supervisor>,
) -> Result<DesktopSnapshot, String> {
    let settings = Some(
        config::load(&app)?
            .unwrap_or_else(|| config::default_config("http://127.0.0.1:8787".into())),
    );
    let mut runtime = daemon::status(&supervisor)?;
    let token = match config::load_token() {
        Ok(token) => token,
        Err(error) => {
            runtime.last_error = Some(error);
            None
        }
    };
    let connection = settings.as_ref().and_then(|current| {
        token.as_ref().map(|secret| DesktopConnection {
            url: current.relay_url.clone(),
            token: secret.clone(),
        })
    });
    Ok(DesktopSnapshot {
        desktop: true,
        version: app.package_info().version.to_string(),
        connection,
        config: settings,
        runtime,
    })
}

#[tauri::command]
fn save_desktop_connection(
    app: AppHandle,
    supervisor: State<'_, Supervisor>,
    relay_url: String,
    token: String,
) -> Result<DesktopSnapshot, String> {
    let settings = config::load(&app)?.unwrap_or_else(|| config::default_config(relay_url.clone()));
    let next = DesktopConfig {
        relay_url: relay_url.trim_end_matches('/').into(),
        ..settings
    };
    next.validate()?;
    config::save_token(&token)?;
    config::save(&app, &next)?;
    daemon::restart(&app, &supervisor)?;
    desktop_snapshot(app, supervisor)
}

#[tauri::command]
fn update_desktop_config(
    app: AppHandle,
    supervisor: State<'_, Supervisor>,
    config: DesktopConfig,
) -> Result<DesktopSnapshot, String> {
    config::save(&app, &config)?;
    if config::load_token()?.is_some() {
        daemon::restart(&app, &supervisor)?;
    }
    desktop_snapshot(app, supervisor)
}

#[tauri::command]
fn disconnect_desktop(
    app: AppHandle,
    supervisor: State<'_, Supervisor>,
) -> Result<DesktopSnapshot, String> {
    daemon::stop(&app, &supervisor)?;
    config::delete_token()?;
    desktop_snapshot(app, supervisor)
}

#[tauri::command]
fn start_desktop_device(
    app: AppHandle,
    supervisor: State<'_, Supervisor>,
) -> Result<RuntimeSnapshot, String> {
    daemon::start(&app, &supervisor)?;
    daemon::status(&supervisor)
}

#[tauri::command]
fn stop_desktop_device(
    app: AppHandle,
    supervisor: State<'_, Supervisor>,
) -> Result<RuntimeSnapshot, String> {
    daemon::stop(&app, &supervisor)?;
    daemon::status(&supervisor)
}

#[tauri::command]
fn open_desktop_logs(app: AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| error.to_string())
}

fn show(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

pub fn run() {
    let supervisor = Supervisor::default();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                show(&window);
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .manage(supervisor.clone())
        .invoke_handler(tauri::generate_handler![
            desktop_snapshot,
            save_desktop_connection,
            update_desktop_config,
            disconnect_desktop,
            start_desktop_device,
            stop_desktop_device,
            open_desktop_logs
        ])
        .setup(move |app| {
            tray::build(app.handle())?;
            if config::load(app.handle())
                .ok()
                .flatten()
                .is_some_and(|_| config::load_token().ok().flatten().is_some())
            {
                if let Err(error) = daemon::start(app.handle(), &supervisor) {
                    log::error!("Could not start the managed device: {error}");
                }
            }
            if std::env::args().any(|argument| argument == "--background") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Cohall desktop");
}
