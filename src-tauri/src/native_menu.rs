use tauri::AppHandle;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

use crate::error::{DesktopError, DesktopResult};

pub const WORKBENCH_MENU_ID: &str = "desktop-workbench";
pub const MANAGEMENT_MENU_ID: &str = "desktop-management";
pub const DOCUMENTATION_MENU_ID: &str = "desktop-documentation";

const APP_NAME: &str = "DeepSeek Harness Desktop";

#[derive(Clone, Copy)]
struct MenuLabels {
    file: &'static str,
    edit: &'static str,
    view: &'static str,
    window: &'static str,
    help: &'static str,
    about: &'static str,
    close: &'static str,
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

pub fn install(app: &AppHandle, locale: &str) -> DesktopResult<()> {
    let labels = labels(locale);
    let about = AboutMetadataBuilder::new()
        .name(Some(APP_NAME))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some("Copyright 2026 DeepSeek Harness Desktop Contributors"))
        .license(Some("Apache-2.0"))
        .build();

    let application = SubmenuBuilder::new(app, APP_NAME)
        .about_with_text(labels.about, Some(about))
        .separator();
    #[cfg(target_os = "macos")]
    let application = application
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator();
    let application = application.quit().build().map_err(desktop_error)?;

    let file = SubmenuBuilder::new(app, labels.file)
        .close_window_with_text(labels.close)
        .build()
        .map_err(desktop_error)?;
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
    let help = SubmenuBuilder::new(app, labels.help)
        .item(&documentation)
        .build()
        .map_err(desktop_error)?;
    let menu = MenuBuilder::new(app)
        .items(&[&application, &file, &edit, &view, &window, &help])
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
            about: "關於 DeepSeek Harness Desktop",
            close: "關閉視窗",
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
            about: "About DeepSeek Harness Desktop",
            close: "Close Window",
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
            about: "关于 DeepSeek Harness Desktop",
            close: "关闭窗口",
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

fn desktop_error(error: tauri::Error) -> DesktopError {
    DesktopError::Other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::labels;

    #[test]
    fn provides_complete_surface_labels_for_all_supported_locales() {
        assert_eq!(labels("zh-CN").workbench, "工作台");
        assert_eq!(labels("zh-TW").workbench, "工作臺");
        assert_eq!(labels("en-US").management, "Desktop Management");
    }
}
