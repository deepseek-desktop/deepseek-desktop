use tauri::AppHandle;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

use crate::error::{DesktopError, DesktopResult};

pub const WORKBENCH_MENU_ID: &str = "desktop-workbench";
pub const MANAGEMENT_MENU_ID: &str = "desktop-management";
pub const DOCUMENTATION_MENU_ID: &str = "desktop-documentation";

const APP_NAME: &str = env!("DEEPSEEK_DESKTOP_APP_NAME");
const APP_VERSION: &str = env!("DEEPSEEK_DESKTOP_APP_VERSION");
const APP_COPYRIGHT: &str = env!("DEEPSEEK_DESKTOP_APP_COPYRIGHT");
const APP_AUTHORS: &str = env!("DEEPSEEK_DESKTOP_APP_AUTHORS");

#[derive(Clone, Copy)]
struct MenuLabels {
    file: &'static str,
    edit: &'static str,
    view: &'static str,
    window: &'static str,
    help: &'static str,
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
    #[cfg(target_os = "macos")]
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

pub fn install(app: &AppHandle, locale: &str) -> DesktopResult<()> {
    let labels = labels(locale);

    #[cfg(target_os = "macos")]
    let about = AboutMetadataBuilder::new()
        .name(Some(APP_NAME))
        .version(Some(APP_VERSION))
        .authors(Some(APP_AUTHORS.split(", ").map(str::to_owned).collect()))
        .copyright(Some(APP_COPYRIGHT))
        .license(Some("Apache-2.0"))
        .build();

    #[cfg(target_os = "macos")]
    let application = SubmenuBuilder::new(app, APP_NAME)
        .about_with_text(labels.about, Some(about))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit_with_text(labels.quit)
        .build()
        .map_err(desktop_error)?;

    let file = SubmenuBuilder::new(app, labels.file).close_window_with_text(labels.close);
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().quit_with_text(labels.quit);
    let file = file.build().map_err(desktop_error)?;
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
    let workbench = MenuItemBuilder::with_id(WORKBENCH_MENU_ID, labels.workbench)
        .accelerator("CmdOrCtrl+1")
        .build(app)
        .map_err(desktop_error)?;
    let management = MenuItemBuilder::with_id(MANAGEMENT_MENU_ID, labels.management)
        .accelerator("CmdOrCtrl+2")
        .build(app)
        .map_err(desktop_error)?;
    let view = SubmenuBuilder::new(app, labels.view)
        .item(&workbench)
        .item(&management);
    #[cfg(target_os = "macos")]
    let view = view.separator().fullscreen_with_text(labels.fullscreen);
    let view = view.build().map_err(desktop_error)?;
    let window = SubmenuBuilder::new(app, labels.window)
        .minimize_with_text(labels.minimize)
        .maximize_with_text(labels.maximize)
        .build()
        .map_err(desktop_error)?;
    let documentation = MenuItemBuilder::with_id(DOCUMENTATION_MENU_ID, labels.documentation)
        .build(app)
        .map_err(desktop_error)?;
    let help = SubmenuBuilder::new(app, labels.help).item(&documentation);
    #[cfg(not(target_os = "macos"))]
    let help = help.separator().about_with_text(
        labels.about,
        Some(
            AboutMetadataBuilder::new()
                .name(Some(APP_NAME))
                .version(Some(APP_VERSION))
                .authors(Some(APP_AUTHORS.split(", ").map(str::to_owned).collect()))
                .copyright(Some(APP_COPYRIGHT))
                .license(Some("Apache-2.0"))
                .build(),
        ),
    );
    let help = help.build().map_err(desktop_error)?;

    #[cfg(target_os = "macos")]
    let menu = MenuBuilder::new(app)
        .items(&[&application, &file, &edit, &view, &window, &help])
        .build()
        .map_err(desktop_error)?;
    #[cfg(not(target_os = "macos"))]
    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &view, &window, &help])
        .build()
        .map_err(desktop_error)?;
    app.set_menu(menu).map_err(desktop_error)?;
    Ok(())
}

fn labels(locale: &str) -> MenuLabels {
    match locale {
        "zh-TW" => MenuLabels {
            file: "檔案",
            edit: "編輯",
            view: "檢視",
            window: "視窗",
            help: "輔助說明",
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
            #[cfg(target_os = "macos")]
            fullscreen: "進入全螢幕",
            minimize: "縮到最小",
            maximize: "放到最大",
            documentation: "使用說明",
        },
        "en-US" => MenuLabels {
            file: "File",
            edit: "Edit",
            view: "View",
            window: "Window",
            help: "Help",
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
            #[cfg(target_os = "macos")]
            fullscreen: "Enter Full Screen",
            minimize: "Minimize",
            maximize: "Maximize",
            documentation: "Documentation",
        },
        _ => MenuLabels {
            file: "文件",
            edit: "编辑",
            view: "视图",
            window: "窗口",
            help: "帮助",
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
            #[cfg(target_os = "macos")]
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
