use crate::daemon::{self, Supervisor};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Runtime,
};
use tauri_plugin_opener::OpenerExt;

fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn open_logs<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(path) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&path);
        let _ = app
            .opener()
            .open_path(path.to_string_lossy().into_owned(), None::<String>);
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Cohall", true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        "toggle-device",
        "Start or stop device",
        true,
        None::<&str>,
    )?;
    let logs = MenuItem::with_id(app, "logs", "Open logs", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Cohall", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &toggle, &logs, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id("cohall")
        .menu(&menu)
        .tooltip("Cohall")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "toggle-device" => {
                let supervisor = app.state::<Supervisor>();
                let running = daemon::status(&supervisor)
                    .map(|status| status.pid.is_some())
                    .unwrap_or(false);
                if running {
                    let _ = daemon::stop(app, &supervisor);
                } else {
                    let _ = daemon::start(app, &supervisor);
                }
            }
            "logs" => open_logs(app),
            "quit" => {
                let supervisor = app.state::<Supervisor>();
                let _ = daemon::stop(app, &supervisor);
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
