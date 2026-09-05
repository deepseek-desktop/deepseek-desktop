//! Isolated macOS lifecycle probe: no Harness, user data, or single-instance plugin.
#![allow(dead_code)]
#[cfg(target_os = "macos")]
#[path = "../src/error.rs"]
mod error;
#[cfg(target_os = "macos")]
#[path = "../src/native_menu.rs"]
mod native_menu;
#[cfg(target_os = "macos")]
#[path = "../src/tao_view_guard.rs"]
mod tao_view_guard;

#[cfg(target_os = "macos")]
fn main() {
    use tauri::{LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "deepseek.desktop.lifecycle-probe".into();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let window = tauri::window::WindowBuilder::new(app, "main")
                .title("Native Lifecycle Probe")
                .inner_size(800.0, 600.0)
                .build()?;
            if !std::env::args().any(|arg| arg == "--without-guard") {
                tao_view_guard::install(&window)?;
            }
            for (name, y, height) in [("probe-settings", 38.0, 562.0), ("probe-menu", 0.0, 38.0), ("probe-content", 38.0, 562.0)] {
                window.add_child(
                    WebviewBuilder::new(name, WebviewUrl::External("about:blank".parse()?))
                        .initialization_script("document.addEventListener('DOMContentLoaded', () => { document.body.innerHTML = '<input aria-label=probe value=lifecycle><p>Native lifecycle probe</p>'; });"),
                    LogicalPosition::new(0.0, y),
                    LogicalSize::new(800.0, height),
                )?;
            }
            app.get_webview("probe-settings").unwrap().hide()?;
            native_menu::install(app.handle(), "en-US")?;
            if std::env::args().any(|arg| arg == "--check-ownership") {
                use objc2::{msg_send, rc::autoreleasepool, runtime::AnyObject};
                let view = window.ns_view()?.cast::<AnyObject>();
                let count = || unsafe { msg_send![&*view, retainCount] };
                for iteration in 0..32 {
                    let before: usize = count();
                    autoreleasepool(|_| native_menu::content_top_inset(&window)).unwrap();
                    let after: usize = count();
                    eprintln!("ownership iteration={iteration} before={before} after={after}");
                    if before != after {
                        eprintln!("FAIL: inset query changed root view ownership");
                        // Exit this disposable probe without unwinding across Cocoa.
                        std::process::exit(1);
                    }
                }
                app.handle().exit(0);
            }
            eprintln!("probe ready pid={}", std::process::id());
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                let inset = native_menu::content_top_inset(window).unwrap();
                let size = window.inner_size().unwrap().to_logical::<f64>(window.scale_factor().unwrap());
                for name in ["probe-settings", "probe-content", "probe-menu"] {
                    if let Some(view) = window.app_handle().get_webview(name) {
                        let menu = name == "probe-menu";
                        let _ = view.set_bounds(tauri::Rect {
                            position: LogicalPosition::new(0.0, inset + if menu { 0.0 } else { 38.0 }).into(),
                            size: LogicalSize::new(size.width, if menu { 38.0 } else { (size.height - inset - 38.0).max(1.0) }).into(),
                        });
                    }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let dialog = window.dialog().message("Close lifecycle probe?")
                    .buttons(MessageDialogButtons::OkCancel).parent(window);
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    if dialog.blocking_show() {
                        app.exit(0);
                    }
                });
            }
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == native_menu::SETTINGS_MENU_ID {
                let _ = native_menu::popup(app, "en-US", "view", 0.0, true);
            }
            if event.id().as_ref() == native_menu::FULLSCREEN_MENU_ID {
                let window = app.get_window("main").unwrap();
                window.set_fullscreen(!window.is_fullscreen().unwrap()).unwrap();
            }
            if event.id().as_ref() == native_menu::CLOSE_MENU_ID {
                use std::sync::atomic::{AtomicBool, Ordering};
                static CONTENT_VISIBLE: AtomicBool = AtomicBool::new(true);
                let visible = CONTENT_VISIBLE.fetch_xor(true, Ordering::Relaxed);
                for name in ["probe-content", "probe-settings"] {
                    let view = app.get_webview(name).unwrap();
                    if (name == "probe-content") == visible { view.hide().unwrap(); }
                    else { view.show().unwrap(); }
                }
            }
        })
        .run(context)
        .expect("native lifecycle probe failed");
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This probe requires native macOS.");
}
