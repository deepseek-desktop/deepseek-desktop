#[cfg(any(target_os = "macos", test))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use tauri::menu::PredefinedMenuItem;
use tauri::menu::SubmenuBuilder;
use tauri::menu::{ContextMenu, MenuBuilder, MenuItemBuilder};
use tauri::{AppHandle, Manager};

use crate::error::{DesktopError, DesktopResult};

pub const WORKBENCH_MENU_ID: &str = "desktop-workbench";
pub const SETTINGS_MENU_ID: &str = "desktop-settings";
pub const DIAGNOSTICS_MENU_ID: &str = "desktop-diagnostics";
pub const HARNESS_UPDATE_MENU_ID: &str = "desktop-harness-update";
pub const DESKTOP_UPDATE_MENU_ID: &str = "desktop-update";
pub const ABOUT_MENU_ID: &str = "desktop-about";
pub const DOCUMENTATION_MENU_ID: &str = "desktop-documentation";
pub const CLOSE_MENU_ID: &str = "desktop-close";
pub const QUIT_MENU_ID: &str = "desktop-quit";
pub const FULLSCREEN_MENU_ID: &str = "desktop-fullscreen";
pub const MINIMIZE_MENU_ID: &str = "desktop-minimize";
pub const MAXIMIZE_MENU_ID: &str = "desktop-maximize";
pub const WINDOW_MENU_HEIGHT_LOGICAL: f64 = 38.0;

#[cfg(target_os = "macos")]
static NATIVE_MENU_POPUP_OPEN: AtomicBool = AtomicBool::new(false);

#[cfg(any(target_os = "macos", test))]
struct NativeMenuPopupGuard<'a> {
    open: &'a AtomicBool,
}

#[cfg(any(target_os = "macos", test))]
impl<'a> NativeMenuPopupGuard<'a> {
    fn try_acquire(open: &'a AtomicBool) -> Option<Self> {
        open.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .ok()
            .map(|_| Self { open })
    }
}

#[cfg(any(target_os = "macos", test))]
impl Drop for NativeMenuPopupGuard<'_> {
    fn drop(&mut self) {
        self.open.store(false, Ordering::Release);
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn content_top_inset(window: &tauri::Window) -> DesktopResult<f64> {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::MainThreadMarker;

    if MainThreadMarker::new().is_none() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = sender.send(content_top_inset(&target));
            })
            .map_err(desktop_error)?;
        return receiver.recv().map_err(desktop_error)?;
    }
    assert!(
        MainThreadMarker::new().is_some(),
        "AppKit view access requires the main thread"
    );

    let ns_window: &NSWindow = unsafe { &*window.ns_window().map_err(desktop_error)?.cast() };
    let content_view = retained_content_view(ns_window)?;
    let content_frame = content_view.frame();
    let layout = ns_window.contentLayoutRect();
    Ok((content_frame.size.height - (layout.origin.y + layout.size.height)).max(0.0))
}

#[cfg(target_os = "macos")]
fn retained_content_view(
    window: &objc2_app_kit::NSWindow,
) -> DesktopResult<objc2::rc::Retained<objc2_app_kit::NSView>> {
    use objc2::{msg_send, rc::Retained};
    use objc2_app_kit::NSView;

    // Avoid the optimized autorelease-return handshake here: release builds on
    // macOS 26 ARM64 otherwise over-release the mounted root view on each query.
    // The window owns this +0 result; Retained pairs our explicit retain with Drop.
    let view: *mut NSView = unsafe { msg_send![window, contentView] };
    unsafe { Retained::retain(view) }.ok_or_else(|| {
        DesktopError::Other("macOS window content view is unavailable".to_owned())
    })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn content_top_inset(_window: &tauri::Window) -> DesktopResult<f64> {
    Ok(0.0)
}

const APP_NAME: &str = env!("DEEPSEEK_DESKTOP_APP_NAME");
#[cfg(target_os = "macos")]
const HIDDEN_SHORTCUT_COUNT: isize = 10;

#[derive(Clone, Copy)]
struct MenuLabels {
    about: &'static str,
    settings: &'static str,
    close_settings: &'static str,
    quit: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    workbench: &'static str,
    fullscreen: &'static str,
    minimize: &'static str,
    maximize: &'static str,
    desktop_update: &'static str,
    harness_update: &'static str,
    diagnostics: &'static str,
    documentation: &'static str,
}

#[derive(Clone, Copy)]
pub(crate) struct CloseConfirmationLabels {
    pub(crate) title: &'static str,
    pub(crate) message: &'static str,
    pub(crate) confirm: &'static str,
    pub(crate) cancel: &'static str,
}

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle, locale: &str) -> DesktopResult<()> {
    let labels = labels(locale);
    let quit = item(app, QUIT_MENU_ID, labels.quit, Some("CmdOrCtrl+Q"))?;
    let undo = PredefinedMenuItem::undo(app, Some(labels.undo)).map_err(desktop_error)?;
    let redo = PredefinedMenuItem::redo(app, Some(labels.redo)).map_err(desktop_error)?;
    let cut = PredefinedMenuItem::cut(app, Some(labels.cut)).map_err(desktop_error)?;
    let copy = PredefinedMenuItem::copy(app, Some(labels.copy)).map_err(desktop_error)?;
    let paste = PredefinedMenuItem::paste(app, Some(labels.paste)).map_err(desktop_error)?;
    let select_all =
        PredefinedMenuItem::select_all(app, Some(labels.select_all)).map_err(desktop_error)?;
    let settings = item(app, SETTINGS_MENU_ID, labels.settings, Some("CmdOrCtrl+,"))?;
    let workbench = item(
        app,
        WORKBENCH_MENU_ID,
        labels.workbench,
        Some("CmdOrCtrl+1"),
    )?;
    let diagnostics = item(
        app,
        DIAGNOSTICS_MENU_ID,
        labels.diagnostics,
        Some("CmdOrCtrl+Shift+D"),
    )?;
    let close = item(
        app,
        CLOSE_MENU_ID,
        labels.close_settings,
        Some("CmdOrCtrl+W"),
    )?;
    let application = SubmenuBuilder::new(app, APP_NAME)
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        // These native responder actions stay registered so AppKit can route
        // standard editing shortcuts into the focused WKWebView. They are
        // hidden below because the window already exposes the one visible Edit
        // menu shared by every platform.
        .item(&undo)
        .item(&redo)
        .item(&cut)
        .item(&copy)
        .item(&paste)
        .item(&select_all)
        .item(&settings)
        .item(&workbench)
        .item(&diagnostics)
        .item(&close)
        .build()
        .map_err(desktop_error)?;
    let menu = MenuBuilder::new(app)
        .item(&application)
        .build()
        .map_err(desktop_error)?;
    app.set_menu(menu).map_err(desktop_error)?;
    hide_app_menu_edit_shortcuts()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn hide_app_menu_edit_shortcuts() -> DesktopResult<()> {
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    let mtm = MainThreadMarker::new().ok_or_else(|| {
        DesktopError::Other(
            "macOS application menu must be installed on the main thread".to_owned(),
        )
    })?;
    let application = NSApplication::sharedApplication(mtm);
    let menu = application
        .mainMenu()
        .ok_or_else(|| DesktopError::Other("macOS application menu is unavailable".to_owned()))?;
    let application_item = menu.itemAtIndex(0).ok_or_else(|| {
        DesktopError::Other("macOS application menu item is unavailable".to_owned())
    })?;
    let application_menu = application_item.submenu().ok_or_else(|| {
        DesktopError::Other("macOS application submenu is unavailable".to_owned())
    })?;
    let item_count = application_menu.numberOfItems();
    if item_count < HIDDEN_SHORTCUT_COUNT {
        return Err(DesktopError::Other(
            "macOS application menu is missing edit shortcuts".to_owned(),
        ));
    }

    for index in item_count - HIDDEN_SHORTCUT_COUNT..item_count {
        let shortcut = application_menu.itemAtIndex(index).ok_or_else(|| {
            DesktopError::Other("macOS edit shortcut menu item is unavailable".to_owned())
        })?;
        shortcut.setAllowsKeyEquivalentWhenHidden(true);
        shortcut.setHidden(true);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install(app: &AppHandle, locale: &str) -> DesktopResult<()> {
    let labels = labels(locale);
    let shortcuts = SubmenuBuilder::new(app, APP_NAME)
        .item(&item(
            app,
            SETTINGS_MENU_ID,
            labels.settings,
            Some("CmdOrCtrl+,"),
        )?)
        .item(&item(
            app,
            WORKBENCH_MENU_ID,
            labels.workbench,
            Some("CmdOrCtrl+1"),
        )?)
        .item(&item(
            app,
            DIAGNOSTICS_MENU_ID,
            labels.diagnostics,
            Some("CmdOrCtrl+Shift+D"),
        )?)
        .item(&item(
            app,
            CLOSE_MENU_ID,
            labels.close_settings,
            Some("CmdOrCtrl+W"),
        )?)
        .item(&item(app, QUIT_MENU_ID, labels.quit, Some("CmdOrCtrl+Q"))?)
        .build()
        .map_err(desktop_error)?;
    let window = app
        .get_window("main")
        .ok_or_else(|| DesktopError::Other("main desktop window is unavailable".to_owned()))?;
    window
        .set_menu(
            MenuBuilder::new(app)
                .item(&shortcuts)
                .build()
                .map_err(desktop_error)?,
        )
        .map_err(desktop_error)?;
    // Keep the native accelerator table attached without a second visible menu.
    window.hide_menu().map_err(desktop_error)?;
    Ok(())
}

pub fn popup(
    app: &AppHandle,
    locale: &str,
    menu_name: &str,
    anchor_x: f64,
    workbench_visible: bool,
) -> DesktopResult<()> {
    let window = app
        .get_window("main")
        .ok_or_else(|| DesktopError::Other("main desktop window is unavailable".to_owned()))?;
    if !anchor_x.is_finite() {
        return Err(DesktopError::InvalidConfiguration(
            "desktop menu anchor must be finite".to_owned(),
        ));
    }

    let anchor_x = {
        let scale_factor = window.scale_factor().map_err(desktop_error)?;
        let inner_size = window.inner_size().map_err(desktop_error)?;
        let logical_width = f64::from(inner_size.width) / scale_factor;
        anchor_x.clamp(0.0, logical_width)
    };

    // AppKit aborts when NSMenu's blocking popup loop is entered a second time.
    #[cfg(target_os = "macos")]
    let _popup_guard = match NativeMenuPopupGuard::try_acquire(&NATIVE_MENU_POPUP_OPEN) {
        Some(guard) => guard,
        None => return Ok(()),
    };

    let labels = labels(locale);
    let menu = match menu_name {
        "file" => {
            let settings = item(app, SETTINGS_MENU_ID, labels.settings, Some("CmdOrCtrl+,"))?;
            let quit = item(app, QUIT_MENU_ID, labels.quit, Some("CmdOrCtrl+Q"))?;
            let mut builder = MenuBuilder::new(app).item(&settings);
            // Merging the two windows into one left "close window" doing exactly
            // what quitting does. It now closes the settings layer instead, and
            // only appears while that layer is the surface a user could close.
            if !workbench_visible {
                let close = item(
                    app,
                    CLOSE_MENU_ID,
                    labels.close_settings,
                    Some("CmdOrCtrl+W"),
                )?;
                builder = builder.separator().item(&close);
            }
            builder.separator().item(&quit).build()
        }
        "edit" => MenuBuilder::new(app)
            .undo_with_text(labels.undo)
            .redo_with_text(labels.redo)
            .separator()
            .cut_with_text(labels.cut)
            .copy_with_text(labels.copy)
            .paste_with_text(labels.paste)
            .select_all_with_text(labels.select_all)
            .build(),
        "view" => {
            let workbench = item(
                app,
                WORKBENCH_MENU_ID,
                labels.workbench,
                Some("CmdOrCtrl+1"),
            )?;
            let fullscreen = item(app, FULLSCREEN_MENU_ID, labels.fullscreen, None)?;
            MenuBuilder::new(app)
                .item(&workbench)
                .separator()
                .item(&fullscreen)
                .build()
        }
        "window" => {
            let minimize = item(app, MINIMIZE_MENU_ID, labels.minimize, None)?;
            let maximize = item(app, MAXIMIZE_MENU_ID, labels.maximize, None)?;
            MenuBuilder::new(app)
                .item(&minimize)
                .item(&maximize)
                .build()
        }
        "help" => {
            let desktop_update = item(app, DESKTOP_UPDATE_MENU_ID, labels.desktop_update, None)?;
            let harness_update = item(app, HARNESS_UPDATE_MENU_ID, labels.harness_update, None)?;
            let diagnostics = item(
                app,
                DIAGNOSTICS_MENU_ID,
                labels.diagnostics,
                Some("CmdOrCtrl+Shift+D"),
            )?;
            let documentation = item(app, DOCUMENTATION_MENU_ID, labels.documentation, None)?;
            let about = item(app, ABOUT_MENU_ID, labels.about, None)?;
            MenuBuilder::new(app)
                .item(&desktop_update)
                .item(&harness_update)
                .item(&diagnostics)
                .separator()
                .item(&documentation)
                .separator()
                .item(&about)
                .build()
        }
        _ => {
            return Err(DesktopError::InvalidConfiguration(
                "unknown desktop menu".to_owned(),
            ));
        }
    }
    .map_err(desktop_error)?;

    #[cfg(target_os = "macos")]
    {
        popup_below_title(&menu, &window, anchor_x)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let popup_y = content_top_inset(&window)? + WINDOW_MENU_HEIGHT_LOGICAL;
        menu.popup_at(window, tauri::LogicalPosition::new(anchor_x, popup_y))
            .map_err(desktop_error)
    }
}

#[cfg(target_os = "macos")]
fn popup_below_title(
    menu: &impl ContextMenu,
    window: &tauri::Window,
    anchor_x: f64,
) -> DesktopResult<()> {
    use objc2_app_kit::{NSMenu, NSWindow};
    use objc2_foundation::{MainThreadMarker, NSPoint};

    let _mtm = MainThreadMarker::new().ok_or_else(|| {
        DesktopError::Other("macOS menus must open on the main thread".to_owned())
    })?;
    let ns_window: &NSWindow = unsafe { &*window.ns_window().map_err(desktop_error)?.cast() };
    let content = retained_content_view(ns_window)?;
    let y = content.frame().size.height - content_top_inset(window)? - WINDOW_MENU_HEIGHT_LOGICAL;
    let point = content.convertPoint_toView(NSPoint::new(anchor_x, y), None);
    let screen_point = ns_window.convertPointToScreen(point);
    // Screen coordinates keep the popup under its title without attaching the
    // blocking AppKit menu loop to Tao's root view (a macOS 26 crash path).
    let native: &NSMenu = unsafe { &*menu.inner_context().ns_menu().cast() };
    native.popUpMenuPositioningItem_atLocation_inView(None, screen_point, None);
    Ok(())
}

fn item(
    app: &AppHandle,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> DesktopResult<tauri::menu::MenuItem<tauri::Wry>> {
    let mut builder = MenuItemBuilder::with_id(id, label);
    if let Some(accelerator) = accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app).map_err(desktop_error)
}

fn labels(locale: &str) -> MenuLabels {
    match locale {
        "zh-TW" => MenuLabels {
            about: "關於 DeepSeek Desktop",
            settings: "設定…",
            close_settings: "關閉設定",
            quit: "結束 DeepSeek Desktop",
            undo: "還原",
            redo: "重做",
            cut: "剪下",
            copy: "複製",
            paste: "貼上",
            select_all: "全選",
            workbench: "工作臺",
            fullscreen: "進入全螢幕",
            minimize: "縮到最小",
            maximize: "放到最大",
            desktop_update: "檢查 Desktop 更新…",
            harness_update: "Harness 更新…",
            diagnostics: "診斷…",
            documentation: "使用說明",
        },
        "en-US" => MenuLabels {
            about: "About DeepSeek Desktop",
            settings: "Settings…",
            close_settings: "Close Settings",
            quit: "Quit DeepSeek Desktop",
            undo: "Undo",
            redo: "Redo",
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            select_all: "Select All",
            workbench: "Workbench",
            fullscreen: "Enter Full Screen",
            minimize: "Minimize",
            maximize: "Maximize",
            desktop_update: "Check Desktop Updates…",
            harness_update: "Harness Updates…",
            diagnostics: "Diagnostics…",
            documentation: "Documentation",
        },
        _ => MenuLabels {
            about: "关于 DeepSeek Desktop",
            settings: "设置…",
            close_settings: "关闭设置",
            quit: "退出 DeepSeek Desktop",
            undo: "撤销",
            redo: "重做",
            cut: "剪切",
            copy: "复制",
            paste: "粘贴",
            select_all: "全选",
            workbench: "工作台",
            fullscreen: "进入全屏幕",
            minimize: "最小化",
            maximize: "最大化",
            desktop_update: "检查 Desktop 更新…",
            harness_update: "Harness 更新…",
            diagnostics: "诊断…",
            documentation: "使用文档",
        },
    }
}

pub(crate) fn close_confirmation_labels(locale: &str) -> CloseConfirmationLabels {
    match locale {
        "zh-TW" => CloseConfirmationLabels {
            title: "關閉 DeepSeek Desktop？",
            message: "關閉視窗將停止目前執行中的任務。確定要關閉嗎？",
            confirm: "關閉",
            cancel: "取消",
        },
        "en-US" => CloseConfirmationLabels {
            title: "Close DeepSeek Desktop?",
            message: "Closing the window stops tasks that are still running. Are you sure?",
            confirm: "Close",
            cancel: "Cancel",
        },
        _ => CloseConfirmationLabels {
            title: "关闭 DeepSeek Desktop？",
            message: "关闭窗口将停止当前仍在运行的任务。确定要关闭吗？",
            confirm: "关闭",
            cancel: "取消",
        },
    }
}

fn desktop_error(error: impl std::fmt::Display) -> DesktopError {
    DesktopError::Other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::NativeMenuPopupGuard;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn native_menu_popup_guard_rejects_reentry_and_releases_on_drop() {
        let open = AtomicBool::new(false);
        let guard = NativeMenuPopupGuard::try_acquire(&open).expect("first popup should open");

        assert!(NativeMenuPopupGuard::try_acquire(&open).is_none());
        drop(guard);

        assert!(!open.load(Ordering::Acquire));
        assert!(NativeMenuPopupGuard::try_acquire(&open).is_some());
    }
}
