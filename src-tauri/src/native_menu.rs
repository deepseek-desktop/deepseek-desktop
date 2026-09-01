#[cfg(target_os = "macos")]
use tauri::menu::SubmenuBuilder;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder};
use tauri::{AppHandle, LogicalPosition, Position, Window};

use crate::error::{DesktopError, DesktopResult};

pub const WORKBENCH_MENU_ID: &str = "desktop-workbench";
pub const MANAGEMENT_MENU_ID: &str = "desktop-management";
pub const DOCUMENTATION_MENU_ID: &str = "desktop-documentation";
pub const CLOSE_MENU_ID: &str = "desktop-close";
pub const QUIT_MENU_ID: &str = "desktop-quit";
pub const FULLSCREEN_MENU_ID: &str = "desktop-fullscreen";
pub const MINIMIZE_MENU_ID: &str = "desktop-minimize";
pub const MAXIMIZE_MENU_ID: &str = "desktop-maximize";

const APP_NAME: &str = env!("DEEPSEEK_DESKTOP_APP_NAME");
const APP_VERSION: &str = env!("DEEPSEEK_DESKTOP_APP_VERSION");
const APP_COPYRIGHT: &str = env!("DEEPSEEK_DESKTOP_APP_COPYRIGHT");
const APP_AUTHORS: &str = env!("DEEPSEEK_DESKTOP_APP_AUTHORS");

#[derive(Clone, Copy)]
struct MenuLabels {
    about: &'static str,
    close: &'static str,
    quit: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    workbench: &'static str,
    management: &'static str,
    fullscreen: &'static str,
    minimize: &'static str,
    maximize: &'static str,
    documentation: &'static str,
}

#[derive(Clone, Copy)]
pub(crate) struct CloseConfirmationLabels {
    pub(crate) title: &'static str,
    pub(crate) message: &'static str,
    pub(crate) confirm: &'static str,
    pub(crate) cancel: &'static str,
}

pub fn install(app: &AppHandle, _locale: &str) -> DesktopResult<()> {
    #[cfg(target_os = "macos")]
    {
        let labels = labels(_locale);
        let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, labels.quit)
            .accelerator("CmdOrCtrl+Q")
            .build(app)
            .map_err(desktop_error)?;
        let application = SubmenuBuilder::new(app, APP_NAME)
            .about_with_text(labels.about, Some(about_metadata()))
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
        let menu = MenuBuilder::new(app)
            .item(&application)
            .build()
            .map_err(desktop_error)?;
        app.set_menu(menu).map_err(desktop_error)?;
    }

    #[cfg(not(target_os = "macos"))]
    app.remove_menu().map_err(desktop_error)?;

    Ok(())
}

pub fn popup(
    app: &AppHandle,
    window: &Window,
    locale: &str,
    menu: &str,
    position: LogicalPosition<f64>,
) -> DesktopResult<()> {
    let labels = labels(locale);
    let menu = match menu {
        "file" => {
            let close = MenuItemBuilder::with_id(CLOSE_MENU_ID, labels.close)
                .accelerator("CmdOrCtrl+W")
                .build(app)
                .map_err(desktop_error)?;
            let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, labels.quit)
                .accelerator("CmdOrCtrl+Q")
                .build(app)
                .map_err(desktop_error)?;
            MenuBuilder::new(app)
                .item(&close)
                .separator()
                .item(&quit)
                .build()
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
            let workbench = MenuItemBuilder::with_id(WORKBENCH_MENU_ID, labels.workbench)
                .accelerator("CmdOrCtrl+1")
                .build(app)
                .map_err(desktop_error)?;
            let management = MenuItemBuilder::with_id(MANAGEMENT_MENU_ID, labels.management)
                .accelerator("CmdOrCtrl+2")
                .build(app)
                .map_err(desktop_error)?;
            let fullscreen = MenuItemBuilder::with_id(FULLSCREEN_MENU_ID, labels.fullscreen)
                .build(app)
                .map_err(desktop_error)?;
            MenuBuilder::new(app)
                .item(&workbench)
                .item(&management)
                .separator()
                .item(&fullscreen)
                .build()
        }
        "window" => {
            let minimize = MenuItemBuilder::with_id(MINIMIZE_MENU_ID, labels.minimize)
                .build(app)
                .map_err(desktop_error)?;
            let maximize = MenuItemBuilder::with_id(MAXIMIZE_MENU_ID, labels.maximize)
                .build(app)
                .map_err(desktop_error)?;
            MenuBuilder::new(app)
                .item(&minimize)
                .item(&maximize)
                .build()
        }
        "help" => {
            let documentation =
                MenuItemBuilder::with_id(DOCUMENTATION_MENU_ID, labels.documentation)
                    .build(app)
                    .map_err(desktop_error)?;
            MenuBuilder::new(app)
                .item(&documentation)
                .separator()
                .about_with_text(labels.about, Some(about_metadata()))
                .build()
        }
        _ => {
            return Err(DesktopError::InvalidConfiguration(
                "unknown desktop menu".to_owned(),
            ));
        }
    }
    .map_err(desktop_error)?;

    window
        .popup_menu_at(&menu, Position::Logical(position))
        .map_err(desktop_error)
}

fn about_metadata() -> tauri::menu::AboutMetadata<'static> {
    AboutMetadataBuilder::new()
        .name(Some(APP_NAME))
        .version(Some(APP_VERSION))
        .authors(Some(APP_AUTHORS.split(", ").map(str::to_owned).collect()))
        .copyright(Some(APP_COPYRIGHT))
        .license(Some("Apache-2.0"))
        .build()
}

fn labels(locale: &str) -> MenuLabels {
    match locale {
        "zh-TW" => MenuLabels {
            about: "關於",
            close: "關閉視窗",
            quit: "結束",
            undo: "還原",
            redo: "重做",
            cut: "剪下",
            copy: "複製",
            paste: "貼上",
            select_all: "全選",
            workbench: "工作臺",
            management: "桌面管理",
            fullscreen: "進入全螢幕",
            minimize: "縮到最小",
            maximize: "放到最大",
            documentation: "使用說明",
        },
        "en-US" => MenuLabels {
            about: "About",
            close: "Close Window",
            quit: "Quit",
            undo: "Undo",
            redo: "Redo",
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            select_all: "Select All",
            workbench: "Workbench",
            management: "Desktop Management",
            fullscreen: "Enter Full Screen",
            minimize: "Minimize",
            maximize: "Maximize",
            documentation: "Documentation",
        },
        _ => MenuLabels {
            about: "关于",
            close: "关闭窗口",
            quit: "退出",
            undo: "撤销",
            redo: "重做",
            cut: "剪切",
            copy: "复制",
            paste: "粘贴",
            select_all: "全选",
            workbench: "工作台",
            management: "桌面管理",
            fullscreen: "进入全屏幕",
            minimize: "最小化",
            maximize: "最大化",
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
            message: "Closing the window will stop any tasks currently running. Do you want to close it?",
            confirm: "Close",
            cancel: "Cancel",
        },
        _ => CloseConfirmationLabels {
            title: "关闭 DeepSeek Desktop？",
            message: "关闭窗口将停止当前运行中的任务。确定要关闭吗？",
            confirm: "关闭",
            cancel: "取消",
        },
    }
}

fn desktop_error(error: tauri::Error) -> DesktopError {
    DesktopError::Other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{close_confirmation_labels, labels};

    #[test]
    fn provides_complete_surface_labels_for_all_supported_locales() {
        assert_eq!(labels("zh-CN").workbench, "工作台");
        assert_eq!(labels("zh-TW").workbench, "工作臺");
        assert_eq!(labels("en-US").management, "Desktop Management");
        assert_eq!(labels("en-US").fullscreen, "Enter Full Screen");
    }

    #[test]
    fn provides_close_confirmation_labels_for_all_supported_locales() {
        assert_eq!(close_confirmation_labels("zh-CN").confirm, "关闭");
        assert_eq!(
            close_confirmation_labels("zh-TW").title,
            "關閉 DeepSeek Desktop？"
        );
        assert_eq!(close_confirmation_labels("en-US").cancel, "Cancel");
    }
}
