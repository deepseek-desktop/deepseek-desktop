mod contracts;
mod diagnostics;
mod error;
mod keychain;
mod runtime;
mod settings;
mod updater;

use std::sync::Arc;
use std::{env, path::PathBuf, thread};

use contracts::{DesktopAbout, DesktopSettings, RuntimeStatus, UpdateStatus};
use diagnostics::Diagnostics;
use error::{DesktopError, DesktopResult};
use runtime::RuntimeSupervisor;
use settings::{AppPaths, SettingsStore};
use tauri::{Manager, State};

struct AppState {
    settings: Arc<SettingsStore>,
    diagnostics: Arc<Diagnostics>,
    supervisor: Arc<RuntimeSupervisor>,
}

fn requested_workspace(arguments: &[String], working_directory: &str) -> Option<String> {
    let value = arguments
        .windows(2)
        .find(|pair| pair[0] == "--workspace")
        .map(|pair| pair[1].as_str())?;
    let candidate = PathBuf::from(value);
    let path = if candidate.is_absolute() {
        candidate
    } else {
        PathBuf::from(working_directory).join(candidate)
    };
    path.canonicalize()
        .ok()
        .filter(|path| path.is_dir())
        .map(|path| path.to_string_lossy().into_owned())
}

fn accept_workspace_argument(
    app: &tauri::AppHandle,
    arguments: &[String],
    working_directory: &str,
) {
    let Some(workspace) = requested_workspace(arguments, working_directory) else {
        return;
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(mut settings) = state.settings.get() else {
        return;
    };
    let should_start = settings.onboarding_completed;
    settings.workspace = Some(workspace.clone());
    if state.settings.update(settings).is_err() {
        return;
    }
    if should_start {
        let supervisor = Arc::clone(&state.supervisor);
        thread::spawn(move || {
            let _ = supervisor.start(workspace);
        });
    }
}

#[tauri::command]
fn runtime_status(state: State<'_, AppState>) -> DesktopResult<RuntimeStatus> {
    state.supervisor.status()
}

#[tauri::command]
async fn runtime_start(
    state: State<'_, AppState>,
    workspace: String,
) -> DesktopResult<RuntimeStatus> {
    let supervisor = Arc::clone(&state.supervisor);
    tauri::async_runtime::spawn_blocking(move || supervisor.start(workspace))
        .await
        .map_err(|error| DesktopError::Other(error.to_string()))?
}

#[tauri::command]
async fn runtime_restart(state: State<'_, AppState>) -> DesktopResult<RuntimeStatus> {
    let supervisor = Arc::clone(&state.supervisor);
    tauri::async_runtime::spawn_blocking(move || supervisor.restart())
        .await
        .map_err(|error| DesktopError::Other(error.to_string()))?
}

#[tauri::command]
async fn runtime_stop(state: State<'_, AppState>) -> DesktopResult<RuntimeStatus> {
    let supervisor = Arc::clone(&state.supervisor);
    tauri::async_runtime::spawn_blocking(move || supervisor.stop())
        .await
        .map_err(|error| DesktopError::Other(error.to_string()))?
}

#[tauri::command]
fn runtime_open(state: State<'_, AppState>) -> DesktopResult<()> {
    state.supervisor.open_runtime()
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> DesktopResult<DesktopSettings> {
    state.settings.get()
}

#[tauri::command]
fn settings_update(
    state: State<'_, AppState>,
    settings: DesktopSettings,
) -> DesktopResult<DesktopSettings> {
    state.settings.update(settings)
}

#[tauri::command]
async fn workspace_choose(title: String) -> DesktopResult<Option<String>> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 80 || title.chars().any(char::is_control) {
        return Err(DesktopError::InvalidConfiguration(
            "workspace dialog title is invalid".to_owned(),
        ));
    }
    let title = title.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(rfd::FileDialog::new()
            .set_title(&title)
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| DesktopError::Other(error.to_string()))?
}

#[tauri::command]
fn desktop_about() -> DesktopAbout {
    DesktopAbout {
        desktop_version: env!("CARGO_PKG_VERSION"),
        harness_version: "0.1.1-rc.2",
        harness_commit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
        node_version: "24.16.0",
        channel: "community",
        signed_release: false,
    }
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
    let path = state
        .diagnostics
        .export(&state.supervisor.status()?, &state.settings.get()?)?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn run_keychain_helper() -> i32 {
    keychain::run()
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, working_directory| {
                accept_workspace_argument(app, &arguments, &working_directory);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let paths = AppPaths::resolve(&app_handle)?;
            let settings = Arc::new(SettingsStore::load(&paths)?);
            let diagnostics = Arc::new(Diagnostics::new(paths.clone()));
            let supervisor = RuntimeSupervisor::new(
                app_handle,
                paths,
                Arc::clone(&settings),
                Arc::clone(&diagnostics),
            );
            app.manage(AppState {
                settings,
                diagnostics,
                supervisor,
            });
            let arguments = env::args().collect::<Vec<_>>();
            let working_directory = env::current_dir().unwrap_or_default();
            accept_workspace_argument(
                app.handle(),
                &arguments,
                &working_directory.to_string_lossy(),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            runtime_start,
            runtime_restart,
            runtime_stop,
            runtime_open,
            settings_get,
            settings_update,
            workspace_choose,
            desktop_about,
            update_check,
            diagnostics_export
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build DSH Desktop");
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
    use super::requested_workspace;

    #[test]
    fn resolves_an_explicit_workspace_argument() {
        let current = std::env::current_dir().unwrap();
        let arguments = vec![
            "dsh-desktop".to_owned(),
            "--workspace".to_owned(),
            ".".to_owned(),
        ];
        assert_eq!(
            requested_workspace(&arguments, &current.to_string_lossy()),
            Some(
                current
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            )
        );
    }
}
