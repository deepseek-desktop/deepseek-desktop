mod contracts;
mod credential_vault;
mod diagnostics;
mod error;
mod native_menu;
mod runtime;
mod runtime_update;
mod settings;
mod updater;

use std::sync::Arc;
use std::{env, thread};

use contracts::{DesktopAbout, DesktopSettings, RuntimeStatus, RuntimeUpdateStatus, UpdateStatus};
use diagnostics::Diagnostics;
use error::{DesktopError, DesktopResult};
use runtime::RuntimeSupervisor;
use runtime_update::{RuntimeStore, RuntimeUpdateManager};
use settings::{AppPaths, SettingsStore};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

const MIN_REACHABLE_WIDTH: i64 = 160;
const MIN_REACHABLE_HEIGHT: i64 = 80;

struct AppState {
    settings: Arc<SettingsStore>,
    diagnostics: Arc<Diagnostics>,
    supervisor: Arc<RuntimeSupervisor>,
    runtime_updates: Arc<RuntimeUpdateManager>,
}

#[tauri::command]
fn runtime_status(state: State<'_, AppState>) -> DesktopResult<RuntimeStatus> {
    state.supervisor.status()
}

#[tauri::command]
async fn runtime_start(state: State<'_, AppState>) -> DesktopResult<RuntimeStatus> {
    let supervisor = Arc::clone(&state.supervisor);
    let recovery = Arc::clone(&supervisor);
    let updater = Arc::clone(&state.runtime_updates);
    match tauri::async_runtime::spawn_blocking(move || {
        let mut first_failure = None;
        loop {
            match supervisor.start() {
                Ok(status) => return Ok(status),
                Err(error) if runtime_boot_failure(&error) => {
                    if first_failure.is_none() {
                        first_failure = Some(error);
                    }
                    if !updater.rollback_after_start_failure() {
                        return Err(first_failure.expect("Runtime failure was captured"));
                    }
                }
                Err(error) => return Err(first_failure.unwrap_or(error)),
            }
        }
    })
    .await
    {
        Ok(result) => result,
        Err(error) => recovery.task_failed(&error.to_string()),
    }
}

fn runtime_boot_failure(error: &DesktopError) -> bool {
    error.permits_runtime_rollback()
}

fn repaired_window_position(
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    monitors: &[(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)],
    fallback: (tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>),
) -> Option<tauri::PhysicalPosition<i32>> {
    let window_left = i64::from(position.x);
    let window_top = i64::from(position.y);
    let window_right = window_left + i64::from(size.width);
    let window_bottom = window_top + i64::from(size.height);
    let required_width = MIN_REACHABLE_WIDTH.min(i64::from(size.width));
    let required_height = MIN_REACHABLE_HEIGHT.min(i64::from(size.height));

    let is_reachable = monitors.iter().any(|(monitor_position, monitor_size)| {
        let monitor_left = i64::from(monitor_position.x);
        let monitor_top = i64::from(monitor_position.y);
        let monitor_right = monitor_left + i64::from(monitor_size.width);
        let monitor_bottom = monitor_top + i64::from(monitor_size.height);
        let visible_width = window_right.min(monitor_right) - window_left.max(monitor_left);
        let visible_height = window_bottom.min(monitor_bottom) - window_top.max(monitor_top);
        visible_width >= required_width && visible_height >= required_height
    });
    if is_reachable {
        return None;
    }

    let (monitor_position, monitor_size) = fallback;
    let x = i64::from(monitor_position.x)
        + (i64::from(monitor_size.width) - i64::from(size.width)).max(0) / 2;
    let y = i64::from(monitor_position.y)
        + (i64::from(monitor_size.height) - i64::from(size.height)).max(0) / 2;
    Some(tauri::PhysicalPosition::new(
        x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
    ))
}

fn keep_window_reachable(window: &tauri::Window) -> tauri::Result<()> {
    let monitors = window
        .available_monitors()?
        .into_iter()
        .map(|monitor| (*monitor.position(), *monitor.size()))
        .collect::<Vec<_>>();
    let Some(first_monitor) = monitors.first().copied() else {
        return Ok(());
    };
    let fallback = window
        .primary_monitor()?
        .map(|monitor| (*monitor.position(), *monitor.size()))
        .unwrap_or(first_monitor);
    if let Some(position) = repaired_window_position(
        window.outer_position()?,
        window.outer_size()?,
        &monitors,
        fallback,
    ) {
        window.set_position(tauri::Position::Physical(position))?;
    }
    Ok(())
}

#[tauri::command]
async fn runtime_stop(state: State<'_, AppState>) -> DesktopResult<RuntimeStatus> {
    let supervisor = Arc::clone(&state.supervisor);
    let recovery = Arc::clone(&supervisor);
    match tauri::async_runtime::spawn_blocking(move || supervisor.stop()).await {
        Ok(result) => result,
        Err(error) => recovery.task_failed(&error.to_string()),
    }
}

#[tauri::command]
async fn runtime_open(state: State<'_, AppState>) -> DesktopResult<()> {
    let supervisor = Arc::clone(&state.supervisor);
    tauri::async_runtime::spawn_blocking(move || supervisor.open_runtime())
        .await
        .map_err(|error| DesktopError::Other(error.to_string()))?
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> DesktopResult<DesktopSettings> {
    state.settings.get()
}

#[tauri::command]
fn settings_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    settings: DesktopSettings,
) -> DesktopResult<DesktopSettings> {
    let settings = state.settings.update(settings)?;
    native_menu::install(&app, &settings.locale)?;
    Ok(settings)
}

#[tauri::command]
fn desktop_about(state: State<'_, AppState>) -> DesktopResult<DesktopAbout> {
    let runtime = state.runtime_updates.status()?;
    Ok(DesktopAbout {
        desktop_version: env!("DEEPSEEK_DESKTOP_APP_VERSION").to_owned(),
        runtime_version: runtime.current_version,
        runtime_commit: runtime.current_commit,
        node_version: env!("DEEPSEEK_DESKTOP_NODE_VERSION").to_owned(),
        authors: env!("DEEPSEEK_DESKTOP_APP_AUTHORS").to_owned(),
        repository: env!("DEEPSEEK_DESKTOP_APP_REPOSITORY").to_owned(),
        channel: env!("DEEPSEEK_DESKTOP_RELEASE_CHANNEL").to_owned(),
        signed_release: env!("DEEPSEEK_DESKTOP_SIGNED_RELEASE") == "true",
    })
}

#[tauri::command]
fn runtime_update_status(state: State<'_, AppState>) -> DesktopResult<RuntimeUpdateStatus> {
    state.runtime_updates.status()
}

#[tauri::command]
async fn runtime_update_check(state: State<'_, AppState>) -> DesktopResult<RuntimeUpdateStatus> {
    let updates = Arc::clone(&state.runtime_updates);
    tauri::async_runtime::spawn_blocking(move || updates.check())
        .await
        .map_err(|error| DesktopError::Other(error.to_string()))?
}

#[tauri::command]
async fn runtime_update_download(state: State<'_, AppState>) -> DesktopResult<RuntimeUpdateStatus> {
    let updates = Arc::clone(&state.runtime_updates);
    tauri::async_runtime::spawn_blocking(move || updates.download())
        .await
        .map_err(|error| DesktopError::Other(error.to_string()))?
}

#[tauri::command]
async fn runtime_update_restore_bundled(
    state: State<'_, AppState>,
) -> DesktopResult<RuntimeUpdateStatus> {
    let supervisor = Arc::clone(&state.supervisor);
    let updates = Arc::clone(&state.runtime_updates);
    tauri::async_runtime::spawn_blocking(move || {
        supervisor.stop()?;
        updates.restore_bundled()
    })
    .await
    .map_err(|error| DesktopError::Other(error.to_string()))?
}

#[tauri::command]
fn repository_open(app: tauri::AppHandle) -> DesktopResult<()> {
    app.opener()
        .open_url(env!("DEEPSEEK_DESKTOP_APP_REPOSITORY"), None::<&str>)
        .map_err(|error| DesktopError::Other(error.to_string()))
}

#[tauri::command]
async fn update_check(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> DesktopResult<UpdateStatus> {
    updater::check(&app, &state.settings.get()?).await
}

#[tauri::command]
fn diagnostics_export(state: State<'_, AppState>) -> DesktopResult<String> {
    let path = state.diagnostics.export(
        &state.supervisor.status()?,
        &state.runtime_updates.status()?,
        &state.settings.get()?,
    )?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn logs_export(state: State<'_, AppState>) -> DesktopResult<String> {
    let path = state.diagnostics.export_logs()?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn run_credential_vault_helper() -> i32 {
    credential_vault::run()
}

pub fn run() {
    runtime::install_crypto_provider().expect("failed to initialize the Rustls crypto provider");
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _working_directory| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_menu_event(|app, event| match event.id().as_ref() {
            native_menu::WORKBENCH_MENU_ID => {
                if let Some(state) = app.try_state::<AppState>() {
                    let supervisor = Arc::clone(&state.supervisor);
                    thread::spawn(move || {
                        if supervisor.open_runtime().is_err() {
                            let _ = supervisor.show_management();
                        }
                    });
                }
            }
            native_menu::MANAGEMENT_MENU_ID => {
                if let Some(state) = app.try_state::<AppState>() {
                    let supervisor = Arc::clone(&state.supervisor);
                    thread::spawn(move || {
                        let _ = supervisor.show_management();
                    });
                }
            }
            native_menu::DOCUMENTATION_MENU_ID => {
                let _ = app.opener().open_url(
                    concat!(env!("DEEPSEEK_DESKTOP_APP_REPOSITORY"), "#readme"),
                    None::<&str>,
                );
            }
            _ => {}
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            let paths = AppPaths::resolve(&app_handle)?;
            let settings = Arc::new(SettingsStore::load(&paths)?);
            let diagnostics = Arc::new(Diagnostics::new(paths.clone()));
            let runtime_store = RuntimeStore::resolve(&app_handle, &paths)?;
            let runtime_updates = RuntimeUpdateManager::new(
                app_handle.clone(),
                Arc::clone(&settings),
                Arc::clone(&diagnostics),
                Arc::clone(&runtime_store),
            )?;
            runtime_updates.recover_invalid_current()?;
            let supervisor = RuntimeSupervisor::new(
                app_handle,
                paths,
                Arc::clone(&settings),
                Arc::clone(&diagnostics),
                runtime_store,
                Arc::clone(&runtime_updates),
            );
            if let Some(window) = app.get_window("main") {
                keep_window_reachable(&window)?;
                let surface = Arc::clone(&supervisor);
                window.on_window_event(move |event| {
                    if matches!(
                        event,
                        tauri::WindowEvent::Resized(_)
                            | tauri::WindowEvent::ScaleFactorChanged { .. }
                    ) {
                        let _ = surface.sync_surface_layout();
                    }
                });
            }
            app.manage(AppState {
                settings,
                diagnostics,
                supervisor,
                runtime_updates: Arc::clone(&runtime_updates),
            });
            let locale = app.state::<AppState>().settings.get()?.locale;
            native_menu::install(app.handle(), &locale)?;
            runtime_updates.start_startup_maintenance();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            runtime_start,
            runtime_stop,
            runtime_open,
            settings_get,
            settings_update,
            desktop_about,
            repository_open,
            update_check,
            runtime_update_status,
            runtime_update_check,
            runtime_update_download,
            runtime_update_restore_bundled,
            diagnostics_export,
            logs_export
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build desktop application");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. })
            && let Some(state) = app_handle.try_state::<AppState>()
        {
            let _ = state.supervisor.stop();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{repaired_window_position, runtime_boot_failure};
    use crate::error::DesktopError;

    #[test]
    fn rolls_back_only_for_runtime_boot_failures() {
        assert!(runtime_boot_failure(&DesktopError::RuntimeArtifactMissing(
            "entry".to_owned()
        )));
        assert!(runtime_boot_failure(&DesktopError::RuntimeExited(
            "exit 1".to_owned()
        )));
        assert!(runtime_boot_failure(&DesktopError::RuntimeBootFailed(
            "health check failed".to_owned()
        )));
        assert!(!runtime_boot_failure(&DesktopError::RuntimeStartRejected(
            "configuration was rejected".to_owned()
        )));
        assert!(!runtime_boot_failure(&DesktopError::InvalidConfiguration(
            "settings are invalid".to_owned()
        )));
        assert!(!runtime_boot_failure(&DesktopError::Io(
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "data directory")
        )));
    }

    #[test]
    fn preserves_a_saved_position_on_a_connected_external_monitor() {
        let monitors = [
            (
                tauri::PhysicalPosition::new(0, 0),
                tauri::PhysicalSize::new(2240, 1440),
            ),
            (
                tauri::PhysicalPosition::new(2240, 0),
                tauri::PhysicalSize::new(2240, 1440),
            ),
        ];
        assert_eq!(
            repaired_window_position(
                tauri::PhysicalPosition::new(2500, 180),
                tauri::PhysicalSize::new(1600, 1000),
                &monitors,
                monitors[0],
            ),
            None
        );
    }

    #[test]
    fn recenters_a_window_when_its_saved_monitor_is_disconnected() {
        let monitors = [(
            tauri::PhysicalPosition::new(0, 0),
            tauri::PhysicalSize::new(2240, 1440),
        )];
        assert_eq!(
            repaired_window_position(
                tauri::PhysicalPosition::new(4256, 180),
                tauri::PhysicalSize::new(1600, 1000),
                &monitors,
                monitors[0],
            ),
            Some(tauri::PhysicalPosition::new(320, 220))
        );
    }
}
