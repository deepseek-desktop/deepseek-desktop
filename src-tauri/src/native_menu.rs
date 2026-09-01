use tauri::AppHandle;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

use crate::error::{DesktopError, DesktopResult};

pub const WORKBENCH_MENU_ID: &str = "desktop-workbench";
pub const SETTINGS_MENU_ID: &str = "desktop-settings";
pub const DIAGNOSTICS_MENU_ID: &str = "desktop-diagnostics";
pub const RUNTIME_UPDATE_MENU_ID: &str = "desktop-runtime-update";
pub const DESKTOP_UPDATE_MENU_ID: &str = "desktop-update";
pub const ABOUT_MENU_ID: &str = "desktop-about";
pub const DOCUMENTATION_MENU_ID: &str = "desktop-documentation";
pub const CLOSE_MENU_ID: &str = "desktop-close";
pub const QUIT_MENU_ID: &str = "desktop-quit";
pub const FULLSCREEN_MENU_ID: &str = "desktop-fullscreen";
pub const MINIMIZE_MENU_ID: &str = "desktop-minimize";
pub const MAXIMIZE_MENU_ID: &str = "desktop-maximize";

#[cfg(target_os = "macos")]
const APP_NAME: &str = env!("DEEPSEEK_DESKTOP_APP_NAME");

#[derive(Clone, Copy)]
struct MenuLabels {
    file: &'static str,
    edit: &'static str,
    view: &'static str,
    window: &'static str,
    help: &'static str,
    about: &'static str,
    settings: &'static str,
    close: &'static str,
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
    runtime_update: &'static str,
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

pub fn install(app: &AppHandle, locale: &str) -> DesktopResult<()> {
    let labels = labels(locale);
    let workbench = item(
        app,
        WORKBENCH_MENU_ID,
        labels.workbench,
        Some("CmdOrCtrl+1"),
    )?;
    let settings = item(app, SETTINGS_MENU_ID, labels.settings, Some("CmdOrCtrl+,"))?;
    let close = item(app, CLOSE_MENU_ID, labels.close, Some("CmdOrCtrl+W"))?;
    let quit = item(app, QUIT_MENU_ID, labels.quit, Some("CmdOrCtrl+Q"))?;
    let fullscreen = item(app, FULLSCREEN_MENU_ID, labels.fullscreen, None)?;
    let minimize = item(app, MINIMIZE_MENU_ID, labels.minimize, None)?;
    let maximize = item(app, MAXIMIZE_MENU_ID, labels.maximize, None)?;
    let desktop_update = item(app, DESKTOP_UPDATE_MENU_ID, labels.desktop_update, None)?;
    let runtime_update = item(app, RUNTIME_UPDATE_MENU_ID, labels.runtime_update, None)?;
    let diagnostics = item(
        app,
        DIAGNOSTICS_MENU_ID,
        labels.diagnostics,
        Some("CmdOrCtrl+Shift+D"),
    )?;
    let documentation = item(app, DOCUMENTATION_MENU_ID, labels.documentation, None)?;
    let about = item(app, ABOUT_MENU_ID, labels.about, None)?;

    #[cfg(target_os = "macos")]
    let application = SubmenuBuilder::new(app, APP_NAME)
        .item(&about)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()
        .map_err(desktop_error)?;

    let file = {
        let builder = SubmenuBuilder::new(app, labels.file);
        #[cfg(not(target_os = "macos"))]
        let builder = builder.item(&settings).separator();
        let builder = builder.item(&close);
        #[cfg(not(target_os = "macos"))]
        let builder = builder.separator().item(&quit);
        builder.build().map_err(desktop_error)?
    };
    let edit = SubmenuBuilder::new(app, labels.edit)
        .undo_with_text(labels.undo)
        .redo_with_text(labels.redo)
        .separator()
        .cut_with_text(labels.cut)
        .copy_with_text(labels.copy)
        .paste_with_text(labels.paste)
        .select_all_with_text(labels.select_all)
        .build()
        .map_err(desktop_error)?;
    let view = SubmenuBuilder::new(app, labels.view)
        .item(&workbench)
        .separator()
        .item(&fullscreen)
        .build()
        .map_err(desktop_error)?;
    let window = SubmenuBuilder::new(app, labels.window)
        .item(&minimize)
        .item(&maximize)
        .build()
        .map_err(desktop_error)?;
    let help = {
        let builder = SubmenuBuilder::new(app, labels.help)
            .item(&desktop_update)
            .item(&runtime_update)
            .item(&diagnostics)
            .separator()
            .item(&documentation);
        #[cfg(not(target_os = "macos"))]
        let builder = builder.separator().item(&about);
        builder.build().map_err(desktop_error)?
    };

    let builder = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let builder = builder.item(&application);
    let menu = builder
        .item(&file)
        .item(&edit)
        .item(&view)
        .item(&window)
        .item(&help)
        .build()
        .map_err(desktop_error)?;
    app.set_menu(menu).map_err(desktop_error)?;
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
            file: "檔案",
            edit: "編輯",
            view: "顯示方式",
            window: "視窗",
            help: "輔助說明",
            about: "關於 DeepSeek Desktop",
            settings: "設定…",
            close: "關閉視窗",
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
            runtime_update: "Runtime 更新…",
            diagnostics: "診斷…",
            documentation: "使用說明",
        },
        "en-US" => MenuLabels {
            file: "File",
            edit: "Edit",
            view: "View",
            window: "Window",
            help: "Help",
            about: "About DeepSeek Desktop",
            settings: "Settings…",
            close: "Close Window",
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
            runtime_update: "Runtime Updates…",
            diagnostics: "Diagnostics…",
            documentation: "Documentation",
        },
        _ => MenuLabels {
            file: "文件",
            edit: "编辑",
            view: "视图",
            window: "窗口",
            help: "帮助",
            about: "关于 DeepSeek Desktop",
            settings: "设置…",
            close: "关闭窗口",
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
            runtime_update: "Runtime 更新…",
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
