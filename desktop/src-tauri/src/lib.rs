// Tray app around the bridge web UI.
//
// The window first shows the local shell page (shell/index.html), which switches to
// the Mac's tailnet URL once it answers. Closing the window hides it to the tray so the
// page stays connected and can raise notifications; the tray menu opens, reconnects or
// quits. The app starts minimized at login and only one copy runs.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Url, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const MINIMIZED_ARG: &str = "--minimized";

// Where the bundled shell page is served from inside the webview.
#[cfg(windows)]
const SHELL_URL: &str = "http://tauri.localhost/index.html";
#[cfg(not(windows))]
const SHELL_URL: &str = "tauri://localhost/index.html";

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Back to the shell page, which reconnects to the Mac (e.g. after the Mac restarted).
fn reconnect(app: &AppHandle) {
    if let (Some(window), Ok(url)) = (app.get_webview_window("main"), Url::parse(SHELL_URL)) {
        let _ = window.navigate(url);
    }
    show(app);
}

pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch just brings the existing window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![MINIMIZED_ARG])))
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Start with Windows by default; the user can turn it off in Task Manager → Startup.
            let autostart = app.autolaunch();
            if !autostart.is_enabled().unwrap_or(false) {
                let _ = autostart.enable();
            }

            let open = MenuItem::with_id(app, "open", "Open Messages", true, None::<&str>)?;
            let reconnect_item = MenuItem::with_id(app, "reconnect", "Reconnect to Mac", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &reconnect_item, &separator, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Messages")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "reconnect" => reconnect(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show(tray.app_handle());
                    }
                })
                .build(app)?;

            // The window is created hidden; show it unless we were started at login.
            if !std::env::args().any(|arg| arg == MINIMIZED_ARG) {
                show(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Messages tray app");
}
