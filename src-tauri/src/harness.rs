use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;
use uuid::Uuid;

use reqwest::StatusCode;
use reqwest::header::{COOKIE, HeaderValue, LOCATION, SET_COOKIE};
use reqwest::redirect::Policy;

use crate::contracts::{HarnessPhase, HarnessStatus};
use crate::credential_vault::HarnessSession;
use crate::diagnostics::Diagnostics;
use crate::error::{DesktopError, DesktopResult};
use crate::harness_update::{HarnessLocation, HarnessStore, HarnessUpdateManager};
use crate::settings::{AppPaths, SettingsStore};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const HARNESS_WORK_DIR_NAME: &str = concat!("harness", "-workdir");
/// Required, not optional hardening slack: the Harness plugin loader reaches the
/// ESM cascaded loader through `internal/modules/esm/loader` and gates that on
/// `process.execArgv.includes("--expose-internals")`, so dropping the flag breaks
/// plugin loading and HMR outright. It widens Node's internal surface for
/// everything the Harness loads, third-party market plugins included.
const NODE_EXPOSE_INTERNALS_ARGUMENT: &str = "--expose-internals";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const MONITOR_INTERVAL: Duration = Duration::from_millis(500);
const MAX_RESTARTS: u8 = 2;
const PROFILE_PACKAGE_DIGEST_FILE: &str = ".deepseek-desktop-source.sha256";
const READY_PREFIX: &str = "dsh web: http://127.0.0.1:";
const DESKTOP_MENU_WEBVIEW_LABEL: &str = "desktop-menu";
const DESKTOP_MENU_INITIALIZATION_SCRIPT: &str = "window.__DEEPSEEK_DESKTOP_MENU_ONLY__ = true;";
const DISABLE_TEXT_ASSISTANCE_SCRIPT: &str = r#"
(() => {
  const selector = "input, textarea, [contenteditable='true'], [contenteditable='']";
  const disable = (element) => {
    if (!(element instanceof HTMLElement) || !element.matches(selector)) return;
    element.setAttribute("spellcheck", "false");
    element.setAttribute("autocorrect", "off");
    element.setAttribute("autocapitalize", "none");
    element.setAttribute("autocomplete", "off");
    element.setAttribute("writingsuggestions", "false");
  };
  const scan = (root) => {
    if (root instanceof Element) disable(root);
    root.querySelectorAll?.(selector).forEach(disable);
  };
  const start = () => {
    scan(document);
    document.addEventListener("focusin", (event) => disable(event.target), true);
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) scan(node);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
"#;
fn is_managed_harness_origin(managed_origin: &Url, candidate: &Url) -> bool {
    candidate.scheme() == managed_origin.scheme()
        && candidate.host_str() == managed_origin.host_str()
        && candidate.port_or_known_default() == managed_origin.port_or_known_default()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Navigation {
    Allow,
    Deny,
    External,
}

/// The Harness binds a fresh random port on every start, so the managed origin is
/// read at navigation time rather than captured when the workbench webview is
/// built. While no Harness is ready there is no origin to trust, and a web URL is
/// denied outright — handing it to the system browser could publish a tokenized
/// loopback URL that is about to become stale.
fn classify_navigation(managed_origin: Option<&Url>, candidate: &Url) -> Navigation {
    match candidate.scheme() {
        "http" | "https" => match managed_origin {
            Some(managed) if is_managed_harness_origin(managed, candidate) => Navigation::Allow,
            Some(_) => Navigation::External,
            None => Navigation::Deny,
        },
        "mailto" | "tel" => Navigation::External,
        "blob" => managed_origin
            .and_then(|managed| {
                candidate
                    .as_str()
                    .strip_prefix("blob:")
                    .map(|inner| (managed, inner))
            })
            .and_then(|(managed, inner)| Url::parse(inner).ok().map(|inner| (managed, inner)))
            .map(|(managed, inner)| {
                if is_managed_harness_origin(managed, &inner) {
                    Navigation::Allow
                } else {
                    Navigation::Deny
                }
            })
            .unwrap_or(Navigation::Deny),
        _ => Navigation::Deny,
    }
}

type ManagedOrigin = Arc<Mutex<Option<Url>>>;

fn current_managed_origin(origin: &ManagedOrigin) -> Option<Url> {
    origin
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

/// A loaded workbench page is only valid for the Harness instance that served it:
/// the plugin bundle URLs it holds carry that instance's graph revision, and a
/// stale revision is answered with 404, which the Harness surfaces as "Failed to
/// load plugins". Matching on origin alone is not enough, because a restarted
/// Harness can bind the same loopback port again, so the page is also keyed on the
/// generation counter that every successful start increments.
fn should_navigate_workbench(current: Option<&(u64, Url)>, generation: u64, next: &Url) -> bool {
    !current.is_some_and(|(loaded_generation, loaded)| {
        *loaded_generation == generation && is_managed_harness_origin(loaded, next)
    })
}

pub struct HarnessSupervisor {
    app: AppHandle,
    paths: AppPaths,
    settings: Arc<SettingsStore>,
    diagnostics: Arc<Diagnostics>,
    harness_store: Arc<HarnessStore>,
    harness_updates: Arc<HarnessUpdateManager>,
    operation: Mutex<()>,
    inner: Mutex<HarnessInner>,
    managed_origin: ManagedOrigin,
    workbench_page: Mutex<Option<(u64, Url)>>,
    harness_generation: AtomicU64,
    workbench_visible: AtomicBool,
}

struct HarnessInner {
    status: HarnessStatus,
    process: Option<ManagedChild>,
    browser_launch_url: Option<String>,
    manual_stop: bool,
}

struct ManagedChild {
    child: Child,
    _credential_session: HarnessSession,
    #[cfg(windows)]
    job: WindowsJob,
}

impl HarnessSupervisor {
    pub fn new(
        app: AppHandle,
        paths: AppPaths,
        settings: Arc<SettingsStore>,
        diagnostics: Arc<Diagnostics>,
        harness_store: Arc<HarnessStore>,
        harness_updates: Arc<HarnessUpdateManager>,
    ) -> Arc<Self> {
        let supervisor = Arc::new(Self {
            app,
            paths,
            settings,
            diagnostics,
            harness_store,
            harness_updates,
            operation: Mutex::new(()),
            inner: Mutex::new(HarnessInner {
                status: HarnessStatus::default(),
                process: None,
                browser_launch_url: None,
                manual_stop: false,
            }),
            managed_origin: Arc::new(Mutex::new(None)),
            workbench_page: Mutex::new(None),
            harness_generation: AtomicU64::new(0),
            workbench_visible: AtomicBool::new(false),
        });
        Self::start_monitor(&supervisor);
        supervisor
    }

    pub fn status(&self) -> DesktopResult<HarnessStatus> {
        Ok(self.lock_inner()?.status.clone())
    }

    pub fn start(&self) -> DesktopResult<HarnessStatus> {
        let _operation = self.lock_operation()?;
        let current = self.status()?;
        if is_active_harness(&current) {
            return Ok(current);
        }
        self.stop_locked(false)?;
        self.spawn_locked(0, HarnessPhase::Starting)
    }

    pub fn stop(&self) -> DesktopResult<HarnessStatus> {
        let _operation = self.lock_operation()?;
        self.stop_locked(true)
    }

    pub fn task_failed(&self, message: &str) -> DesktopResult<HarnessStatus> {
        let status = self.status()?;
        self.fail(
            status.restart_count,
            "harness-task-failed",
            DesktopError::HarnessStartRejected(message.to_owned()),
        )
    }

    pub fn open_harness(&self) -> DesktopResult<()> {
        let (status_url, browser_launch_url) = {
            let inner = self.lock_inner()?;
            (
                inner
                    .status
                    .url
                    .clone()
                    .ok_or(DesktopError::HarnessNotReady)?,
                inner.browser_launch_url.clone(),
            )
        };
        let managed_url =
            Url::parse(&status_url).map_err(|error| DesktopError::Other(error.to_string()))?;
        let raw_url = browser_launch_url.unwrap_or(status_url);
        let url = Url::parse(&raw_url).map_err(|error| DesktopError::Other(error.to_string()))?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !is_managed_harness_origin(&managed_url, &url)
        {
            return Err(DesktopError::Other(
                "harness URL is outside the managed loopback origin".to_owned(),
            ));
        }
        if let Some(webview) = self.app.get_webview("workbench") {
            let generation = self.harness_generation.load(Ordering::Acquire);
            let current = self
                .workbench_page
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            if should_navigate_workbench(current.as_ref(), generation, &managed_url) {
                webview
                    .navigate(url)
                    .map_err(|error| DesktopError::Other(error.to_string()))?;
                *self
                    .workbench_page
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) =
                    Some((generation, managed_url.clone()));
            }
            self.workbench_visible.store(true, Ordering::Release);
            webview
                .show()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
            self.layout_workbench()?;
            self.emit_surface("workbench");
            return Ok(());
        }
        let navigation_origin = Arc::clone(&self.managed_origin);
        let navigation_app = self.app.clone();
        let new_window_origin = Arc::clone(&self.managed_origin);
        let new_window_app = self.app.clone();
        let main_window = self
            .app
            .get_window("main")
            .ok_or_else(|| DesktopError::Other("main desktop window is unavailable".to_owned()))?;
        let (position, size) = self.workbench_bounds(&main_window)?;
        let builder =
            tauri::webview::WebviewBuilder::new("workbench", tauri::WebviewUrl::External(url))
                .initialization_script(DISABLE_TEXT_ASSISTANCE_SCRIPT)
                .on_navigation(move |candidate| {
                    let managed_origin = current_managed_origin(&navigation_origin);
                    match classify_navigation(managed_origin.as_ref(), candidate) {
                        Navigation::Allow => true,
                        Navigation::Deny => false,
                        // A failed hand-off leaves the page to the webview, so the
                        // link is never silently lost.
                        Navigation::External => navigation_app
                            .opener()
                            .open_url(candidate.as_str(), None::<&str>)
                            .is_err(),
                    }
                })
                .on_new_window(move |candidate, _features| {
                    match classify_navigation(
                        current_managed_origin(&new_window_origin).as_ref(),
                        &candidate,
                    ) {
                        Navigation::Allow => tauri::webview::NewWindowResponse::Allow,
                        Navigation::Deny => tauri::webview::NewWindowResponse::Deny,
                        Navigation::External => {
                            if new_window_app
                                .opener()
                                .open_url(candidate.as_str(), None::<&str>)
                                .is_ok()
                            {
                                tauri::webview::NewWindowResponse::Deny
                            } else {
                                tauri::webview::NewWindowResponse::Allow
                            }
                        }
                    }
                });
        let _webview = match main_window.add_child(builder, position, size) {
            Ok(webview) => webview,
            Err(error) => {
                self.workbench_visible.store(false, Ordering::Release);
                let _ = self.layout_settings();
                return Err(DesktopError::Other(error.to_string()));
            }
        };
        *self
            .workbench_page
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((self.harness_generation.load(Ordering::Acquire), managed_url));
        self.workbench_visible.store(true, Ordering::Release);
        self.layout_workbench()?;
        self.emit_surface("workbench");
        Ok(())
    }

    pub fn show_settings(&self, view: &str) -> DesktopResult<()> {
        if !matches!(
            view,
            "harness" | "diagnostics" | "update" | "desktop-update" | "about"
        ) {
            return Err(DesktopError::InvalidConfiguration(
                "unknown desktop settings view".to_owned(),
            ));
        }
        self.workbench_visible.store(false, Ordering::Release);
        if let Some(webview) = self.app.get_webview("workbench") {
            webview
                .hide()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
        }
        if let Some(webview) = self.app.get_webview(DESKTOP_MENU_WEBVIEW_LABEL) {
            webview
                .hide()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
        }
        if let Some(main) = self.app.get_webview("main") {
            main.show()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
        }
        self.layout_settings()?;
        let _ = self.app.emit("desktop://settings-view", view);
        self.emit_surface("settings");
        Ok(())
    }

    pub fn sync_surface_layout(&self) -> DesktopResult<()> {
        if self.workbench_visible.load(Ordering::Acquire) {
            self.layout_workbench()
        } else {
            self.layout_settings()
        }
    }

    pub fn workbench_visible(&self) -> bool {
        self.workbench_visible.load(Ordering::Acquire)
    }

    fn layout_workbench(&self) -> DesktopResult<()> {
        let window = self
            .app
            .get_window("main")
            .ok_or_else(|| DesktopError::Other("main desktop window is unavailable".to_owned()))?;
        let (position, size) = self.workbench_bounds(&window)?;
        let menu_position = tauri::LogicalPosition::new(
            0.0,
            (position.y - crate::native_menu::WINDOW_MENU_HEIGHT_LOGICAL).max(0.0),
        );
        let menu_size =
            tauri::LogicalSize::new(size.width, crate::native_menu::WINDOW_MENU_HEIGHT_LOGICAL);
        self.ensure_desktop_menu(&window, menu_position, menu_size)?;
        if let Some(main) = self.app.get_webview("main") {
            main.hide()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
        }
        if let Some(workbench) = self.app.get_webview("workbench") {
            workbench
                .set_bounds(tauri::Rect {
                    position: tauri::Position::Logical(position),
                    size: tauri::Size::Logical(size),
                })
                .map_err(|error| DesktopError::Other(error.to_string()))?;
        }
        Ok(())
    }

    fn ensure_desktop_menu(
        &self,
        window: &tauri::Window,
        position: tauri::LogicalPosition<f64>,
        size: tauri::LogicalSize<f64>,
    ) -> DesktopResult<()> {
        if let Some(webview) = self.app.get_webview(DESKTOP_MENU_WEBVIEW_LABEL) {
            webview
                .set_bounds(tauri::Rect {
                    position: tauri::Position::Logical(position),
                    size: tauri::Size::Logical(size),
                })
                .map_err(|error| DesktopError::Other(error.to_string()))?;
            webview
                .show()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
            return Ok(());
        }

        let builder = tauri::webview::WebviewBuilder::new(
            DESKTOP_MENU_WEBVIEW_LABEL,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .initialization_script(DESKTOP_MENU_INITIALIZATION_SCRIPT);
        window
            .add_child(builder, position, size)
            .map_err(|error| DesktopError::Other(error.to_string()))?;
        Ok(())
    }

    fn layout_settings(&self) -> DesktopResult<()> {
        let window = self
            .app
            .get_window("main")
            .ok_or_else(|| DesktopError::Other("main desktop window is unavailable".to_owned()))?;
        let main = self
            .app
            .get_webview("main")
            .ok_or_else(|| DesktopError::Other("main desktop surface is unavailable".to_owned()))?;
        let size = window
            .inner_size()
            .map_err(|error| DesktopError::Other(error.to_string()))?;
        let scale_factor = window
            .scale_factor()
            .map_err(|error| DesktopError::Other(error.to_string()))?;
        let logical_size = size.to_logical::<f64>(scale_factor);
        let top_inset =
            crate::native_menu::content_top_inset(&window)?.clamp(0.0, logical_size.height);
        main.set_bounds(tauri::Rect {
            position: tauri::Position::Logical(tauri::LogicalPosition::new(0.0, top_inset)),
            size: tauri::Size::Logical(tauri::LogicalSize::new(
                logical_size.width,
                (logical_size.height - top_inset).max(0.0),
            )),
        })
        .map_err(|error| DesktopError::Other(error.to_string()))?;
        Ok(())
    }

    fn workbench_bounds(
        &self,
        window: &tauri::Window,
    ) -> DesktopResult<(tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>)> {
        let window_size = window
            .inner_size()
            .map_err(|error| DesktopError::Other(error.to_string()))?;
        let scale_factor = window
            .scale_factor()
            .map_err(|error| DesktopError::Other(error.to_string()))?;
        let top_inset = crate::native_menu::content_top_inset(window)?;
        Ok(workbench_geometry(window_size, scale_factor, top_inset))
    }

    fn emit_surface(&self, surface: &str) {
        let _ = self.app.emit("desktop://surface", surface);
    }

    fn spawn_locked(&self, restart_count: u8, phase: HarnessPhase) -> DesktopResult<HarnessStatus> {
        self.publish(HarnessStatus {
            phase,
            restart_count,
            ..HarnessStatus::default()
        })?;
        let harness_working_directory = self.paths.data_dir.join(HARNESS_WORK_DIR_NAME);
        if let Err(error) = fs::create_dir_all(&harness_working_directory) {
            return self.fail(
                restart_count,
                "harness-workdir-unavailable",
                DesktopError::HarnessStartRejected(error.to_string()),
            );
        }
        let location = match self.harness_store.location() {
            Ok(location) => location,
            Err(error) => {
                return self.fail(
                    restart_count,
                    "harness-artifact-missing",
                    DesktopError::HarnessArtifactMissing(error.to_string()),
                );
            }
        };
        let harness_dir = location.harness_dir;
        let node = location.node;
        if let Err(error) = self.prepare_profile(&harness_dir, &node) {
            let code = if error.permits_harness_rollback() {
                "harness-artifact-missing"
            } else {
                "harness-profile-prepare-failed"
            };
            let error = if error.permits_harness_rollback() {
                error
            } else {
                DesktopError::HarnessStartRejected(error.to_string())
            };
            return self.fail(restart_count, code, error);
        }
        let dsh_entry = harness_dir.join(location.entry);
        let parent_watch =
            harness_dir.join("node_modules/deepseek-desktop-bundle/parent-watch.cjs");
        let locale_sync = harness_dir.join("node_modules/deepseek-desktop-bundle/locale-sync.cjs");
        if !dsh_entry.is_file() {
            return self.fail(
                restart_count,
                "harness-artifact-missing",
                DesktopError::HarnessArtifactMissing(dsh_entry.display().to_string()),
            );
        }
        if !parent_watch.is_file() {
            return self.fail(
                restart_count,
                "harness-artifact-missing",
                DesktopError::HarnessArtifactMissing(parent_watch.display().to_string()),
            );
        }
        if !locale_sync.is_file() {
            return self.fail(
                restart_count,
                "harness-artifact-missing",
                DesktopError::HarnessArtifactMissing(locale_sync.display().to_string()),
            );
        }
        let helper = match std::env::current_exe() {
            Ok(helper) => helper,
            Err(error) => {
                return self.fail(
                    restart_count,
                    "harness-helper-unavailable",
                    DesktopError::HarnessStartRejected(error.to_string()),
                );
            }
        };
        let credential_session = match HarnessSession::create(&self.paths.data_dir) {
            Ok(session) => session,
            Err(error) => {
                return self.fail(
                    restart_count,
                    "harness-credential-session-failed",
                    DesktopError::HarnessStartRejected(error.to_string()),
                );
            }
        };
        let environment = match self.harness_environment(&helper, &harness_dir, &node) {
            Ok(environment) => environment,
            Err(error) => {
                return self.fail(
                    restart_count,
                    "harness-environment-failed",
                    DesktopError::HarnessStartRejected(error.to_string()),
                );
            }
        };
        let mut command = Command::new(&node);
        command
            .arg(NODE_EXPOSE_INTERNALS_ARGUMENT)
            .arg("--require")
            .arg(parent_watch)
            .arg("--require")
            .arg(locale_sync)
            .arg(dsh_entry)
            .args([
                "--profile",
                "desktop-web",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--no-open",
            ])
            .current_dir(&harness_working_directory)
            .env_clear()
            .envs(environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut command);
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return self.fail(
                    restart_count,
                    "harness-exited",
                    DesktopError::HarnessBootFailed(format!(
                        "Harness process could not start: {error}"
                    )),
                );
            }
        };
        let mut managed = match ManagedChild::new(child, credential_session) {
            Ok(managed) => managed,
            Err(error) => {
                return self.fail(
                    restart_count,
                    "harness-process-management-failed",
                    DesktopError::HarnessStartRejected(error.to_string()),
                );
            }
        };
        let session_token = managed._credential_session.token().to_owned();
        let session_result = managed
            .child
            .stdin
            .take()
            .ok_or_else(|| {
                DesktopError::Other("harness credential channel is unavailable".to_owned())
            })
            .and_then(|mut stdin| {
                stdin.write_all(session_token.as_bytes())?;
                stdin.write_all(b"\n")?;
                Ok(())
            });
        if let Err(error) = session_result {
            managed.terminate();
            return self.fail(
                restart_count,
                "harness-credential-channel-failed",
                DesktopError::HarnessStartRejected(error.to_string()),
            );
        }
        let Some(stdout) = managed.child.stdout.take() else {
            managed.terminate();
            return self.fail(
                restart_count,
                "harness-output-unavailable",
                DesktopError::HarnessStartRejected("harness stdout is unavailable".to_owned()),
            );
        };
        let Some(stderr) = managed.child.stderr.take() else {
            managed.terminate();
            return self.fail(
                restart_count,
                "harness-output-unavailable",
                DesktopError::HarnessStartRejected("harness stderr is unavailable".to_owned()),
            );
        };
        let (ready_tx, ready_rx) = mpsc::channel::<String>();
        let stdout_diagnostics = Arc::clone(&self.diagnostics);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                stdout_diagnostics.append("harness.stdout", &line);
                if let Some(url) = parse_ready_url(&line) {
                    let _ = ready_tx.send(url);
                }
            }
        });
        let stderr_diagnostics = Arc::clone(&self.diagnostics);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                stderr_diagnostics.append("harness.stderr", &line);
            }
        });

        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let ready_url = loop {
            match managed.child.try_wait() {
                Ok(Some(exit)) => {
                    let message = format!("exit status {exit}");
                    managed.terminate();
                    return self.fail(
                        restart_count,
                        "harness-exited",
                        DesktopError::HarnessExited(message),
                    );
                }
                Ok(None) => {}
                Err(error) => {
                    managed.terminate();
                    return self.fail(
                        restart_count,
                        "harness-process-status-failed",
                        DesktopError::HarnessStartRejected(error.to_string()),
                    );
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                managed.terminate();
                return self.fail(
                    restart_count,
                    "harness-timeout",
                    DesktopError::HarnessBootFailed("harness startup timed out".to_owned()),
                );
            }
            match ready_rx.recv_timeout(remaining.min(Duration::from_millis(200))) {
                Ok(url) => break url,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    managed.terminate();
                    return self.fail(
                        restart_count,
                        "harness-output-closed",
                        DesktopError::HarnessExited(
                            "harness closed its output before readiness".to_owned(),
                        ),
                    );
                }
            }
        };
        let harness_http = match authenticate_harness(&ready_url) {
            Ok(harness_http) => harness_http,
            Err(error) => {
                managed.terminate();
                return self.fail(
                    restart_count,
                    "harness-health-check-failed",
                    DesktopError::HarnessBootFailed(error.to_string()),
                );
            }
        };
        let status = HarnessStatus {
            phase: HarnessPhase::Ready,
            url: Some(harness_http.to_string()),
            restart_count,
            diagnostic_id: None,
            error_code: None,
        };
        {
            let mut inner = self.lock_inner()?;
            inner.manual_stop = false;
            inner.process = Some(managed);
            inner.browser_launch_url = Some(ready_url);
            inner.status = status.clone();
        }
        self.harness_generation.fetch_add(1, Ordering::AcqRel);
        self.set_managed_origin(Some(harness_http));
        self.emit(&status);
        Ok(status)
    }

    fn set_managed_origin(&self, origin: Option<Url>) {
        *self
            .managed_origin
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = origin;
    }

    fn stop_locked(&self, manual: bool) -> DesktopResult<HarnessStatus> {
        let previous = self.status()?;
        if previous.phase != HarnessPhase::Idle {
            self.publish(HarnessStatus {
                phase: HarnessPhase::Stopping,
                ..previous.clone()
            })?;
        }
        let process = {
            let mut inner = self.lock_inner()?;
            inner.manual_stop = manual;
            inner.process.take()
        };
        if let Some(mut process) = process {
            process.terminate();
        }
        let surface_result = self.show_settings("harness");
        let status = HarnessStatus {
            phase: HarnessPhase::Idle,
            ..HarnessStatus::default()
        };
        let status = self.publish(status)?;
        surface_result?;
        Ok(status)
    }

    fn fail(
        &self,
        restart_count: u8,
        code: &str,
        error: DesktopError,
    ) -> DesktopResult<HarnessStatus> {
        self.diagnostics.append("supervisor", &error.to_string());
        let _ = self.show_settings("harness");
        let status = HarnessStatus {
            phase: HarnessPhase::Failed,
            restart_count,
            diagnostic_id: Some(Uuid::new_v4().to_string()),
            error_code: Some(code.to_owned()),
            ..HarnessStatus::default()
        };
        self.publish(status.clone())?;
        Err(error)
    }

    fn publish(&self, status: HarnessStatus) -> DesktopResult<HarnessStatus> {
        let mut inner = self.lock_inner()?;
        let ready = status.phase == HarnessPhase::Ready;
        if !ready {
            inner.browser_launch_url = None;
        }
        inner.status = status.clone();
        drop(inner);
        if !ready {
            self.set_managed_origin(None);
        }
        self.emit(&status);
        Ok(status)
    }

    fn emit(&self, status: &HarnessStatus) {
        let _ = self.app.emit("harness://status", status);
    }

    fn harness_environment(
        &self,
        helper: &Path,
        harness_dir: &Path,
        node: &Path,
    ) -> DesktopResult<HashMap<String, String>> {
        harness_environment(
            &self.paths,
            &self.settings.get()?.locale,
            helper,
            harness_dir,
            node,
        )
    }

    fn prepare_profile(&self, harness_dir: &Path, node: &Path) -> DesktopResult<()> {
        prepare_harness_profile(&self.paths, harness_dir, node)
    }

    fn lock_inner(&self) -> DesktopResult<MutexGuard<'_, HarnessInner>> {
        Ok(self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    fn lock_operation(&self) -> DesktopResult<MutexGuard<'_, ()>> {
        match self.operation.try_lock() {
            Ok(operation) => Ok(operation),
            Err(TryLockError::Poisoned(error)) => Ok(error.into_inner()),
            Err(TryLockError::WouldBlock) => Err(DesktopError::HarnessBusy),
        }
    }

    fn wait_for_operation(&self) -> MutexGuard<'_, ()> {
        self.operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn start_monitor(supervisor: &Arc<Self>) {
        let weak = Arc::downgrade(supervisor);
        thread::spawn(move || {
            loop {
                thread::sleep(MONITOR_INTERVAL);
                let Some(supervisor) = weak.upgrade() else {
                    break;
                };
                let restart = {
                    let Ok(mut inner) = supervisor.inner.lock() else {
                        break;
                    };
                    if inner.manual_stop || inner.status.phase != HarnessPhase::Ready {
                        None
                    } else {
                        match inner
                            .process
                            .as_mut()
                            .map(|process| process.child.try_wait())
                        {
                            Some(Ok(Some(exit))) => Some((
                                inner.status.restart_count,
                                exit.to_string(),
                                inner.process.take(),
                            )),
                            Some(Err(error)) => Some((
                                inner.status.restart_count,
                                format!("process status unavailable: {error}"),
                                inner.process.take(),
                            )),
                            Some(Ok(None)) | None => None,
                        }
                    }
                };
                let Some((restart_count, exit, process)) = restart else {
                    continue;
                };
                if let Some(mut process) = process {
                    process.terminate();
                }
                let _operation = supervisor.wait_for_operation();
                let recovery_is_current = {
                    let Ok(inner) = supervisor.inner.lock() else {
                        break;
                    };
                    recovery_event_is_current(&inner, restart_count)
                };
                if !recovery_is_current {
                    continue;
                }
                supervisor.diagnostics.append(
                    "supervisor",
                    &format!("harness exited unexpectedly: {exit}"),
                );
                if restart_count >= MAX_RESTARTS {
                    if supervisor.recover_with_available_rollback() != RollbackRecovery::Unavailable
                    {
                        continue;
                    }
                    let _ = supervisor.show_settings("harness");
                    let _ = supervisor.publish(HarnessStatus {
                        phase: HarnessPhase::Failed,
                        restart_count,
                        diagnostic_id: Some(Uuid::new_v4().to_string()),
                        error_code: Some("restart-limit-reached".to_owned()),
                        ..HarnessStatus::default()
                    });
                    continue;
                }
                let next = restart_count + 1;
                let _ = supervisor.show_settings("harness");
                let _ = supervisor.publish(HarnessStatus {
                    phase: HarnessPhase::Recovering,
                    restart_count: next,
                    ..HarnessStatus::default()
                });
                thread::sleep(if next == 1 {
                    Duration::from_secs(1)
                } else {
                    Duration::from_secs(3)
                });
                if let Err(error) = supervisor.spawn_locked(next, HarnessPhase::Recovering)
                    && error.permits_harness_rollback()
                {
                    let _ = supervisor.recover_with_available_rollback();
                }
            }
        });
    }

    fn recover_with_available_rollback(&self) -> RollbackRecovery {
        loop {
            if !self.harness_updates.rollback_after_start_failure() {
                return RollbackRecovery::Unavailable;
            }
            let _ = self.show_settings("harness");
            let _ = self.publish(HarnessStatus {
                phase: HarnessPhase::Recovering,
                restart_count: 0,
                ..HarnessStatus::default()
            });
            match self.spawn_locked(0, HarnessPhase::Recovering) {
                Ok(_) => return RollbackRecovery::Recovered,
                Err(error) if error.permits_harness_rollback() => {}
                Err(_) => return RollbackRecovery::Rejected,
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RollbackRecovery {
    Recovered,
    Rejected,
    Unavailable,
}

fn recovery_event_is_current(inner: &HarnessInner, restart_count: u8) -> bool {
    !inner.manual_stop
        && inner.process.is_none()
        && inner.status.phase == HarnessPhase::Ready
        && inner.status.restart_count == restart_count
}

pub(crate) fn smoke_harness_service(location: &HarnessLocation) -> DesktopResult<()> {
    let smoke_root = std::env::temp_dir().join(format!(
        "deepseek-desktop-harness-smoke-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let cleanup = HarnessSmokeDirectory(smoke_root.clone());
    let paths = AppPaths {
        data_dir: smoke_root.clone(),
        dsh_home: smoke_root.join("dsh"),
        logs_dir: smoke_root.join("logs"),
        backups_dir: smoke_root.join("backups"),
        diagnostics_dir: smoke_root.join("diagnostics"),
        updates_dir: smoke_root.join("updates"),
        settings_file: smoke_root.join("settings.json"),
    };
    for directory in [
        &paths.data_dir,
        &paths.dsh_home,
        &paths.logs_dir,
        &paths.backups_dir,
        &paths.diagnostics_dir,
        &paths.updates_dir,
    ] {
        fs::create_dir_all(directory)?;
    }
    let harness_working_directory = smoke_root.join(HARNESS_WORK_DIR_NAME);
    fs::create_dir_all(&harness_working_directory)?;
    prepare_harness_profile(&paths, &location.harness_dir, &location.node)?;
    let entry = location.harness_dir.join(&location.entry);
    let helper = std::env::current_exe()?;
    let credential_session = HarnessSession::create(&paths.data_dir)?;
    let mut command = Command::new(&location.node);
    command
        .arg(NODE_EXPOSE_INTERNALS_ARGUMENT)
        .arg("--require")
        .arg(
            location
                .harness_dir
                .join("node_modules/deepseek-desktop-bundle/parent-watch.cjs"),
        )
        .arg("--require")
        .arg(
            location
                .harness_dir
                .join("node_modules/deepseek-desktop-bundle/locale-sync.cjs"),
        )
        .arg(entry)
        .args([
            "--profile",
            "desktop-web",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--no-open",
        ])
        .current_dir(&harness_working_directory)
        .env_clear()
        .envs(harness_environment(
            &paths,
            "en-US",
            &helper,
            &location.harness_dir,
            &location.node,
        )?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let child = command.spawn().map_err(|error| {
        DesktopError::HarnessBootFailed(format!("Harness smoke could not start: {error}"))
    })?;
    let mut managed = ManagedChild::new(child, credential_session)?;
    let token = managed._credential_session.token().to_owned();
    let result = (|| {
        let mut stdin = managed.child.stdin.take().ok_or_else(|| {
            DesktopError::HarnessStartRejected(
                "Harness smoke credential channel is unavailable".to_owned(),
            )
        })?;
        stdin.write_all(token.as_bytes())?;
        stdin.write_all(b"\n")?;
        drop(stdin);
        let stdout = managed.child.stdout.take().ok_or_else(|| {
            DesktopError::HarnessBootFailed("Harness smoke stdout is unavailable".to_owned())
        })?;
        let stderr = managed.child.stderr.take().ok_or_else(|| {
            DesktopError::HarnessBootFailed("Harness smoke stderr is unavailable".to_owned())
        })?;
        let (ready_tx, ready_rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(url) = parse_ready_url(&line) {
                    let _ = ready_tx.send(url);
                }
            }
        });
        thread::spawn(
            move || {
                for _ in BufReader::new(stderr).lines().map_while(Result::ok) {}
            },
        );
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let ready_url = loop {
            if let Some(exit) = managed.child.try_wait()? {
                return Err(DesktopError::HarnessExited(format!(
                    "Harness smoke exited with {exit}"
                )));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(DesktopError::HarnessBootFailed(
                    "Harness smoke startup timed out".to_owned(),
                ));
            }
            match ready_rx.recv_timeout(remaining.min(Duration::from_millis(200))) {
                Ok(url) => break url,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(DesktopError::HarnessExited(
                        "Harness smoke closed stdout before readiness".to_owned(),
                    ));
                }
            }
        };
        authenticate_harness(&ready_url)?;
        Ok(())
    })();
    managed.terminate();
    drop(cleanup);
    result
}

struct HarnessSmokeDirectory(PathBuf);

impl Drop for HarnessSmokeDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn harness_environment(
    paths: &AppPaths,
    locale: &str,
    helper: &Path,
    harness_dir: &Path,
    node: &Path,
) -> DesktopResult<HashMap<String, String>> {
    let mut environment = HashMap::new();
    for name in [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "APPDATA",
        "LOCALAPPDATA",
        "USERPROFILE",
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
    ] {
        if let Ok(value) = std::env::var(name) {
            environment.insert(name.to_owned(), value);
        }
    }
    environment.insert(
        "DSH_HOME".to_owned(),
        paths.dsh_home.to_string_lossy().into_owned(),
    );
    environment.insert("DSH_TELEMETRY_DISABLED".to_owned(), "true".to_owned());
    environment.insert(
        "DEEPSEEK_DESKTOP_PARENT_PID".to_owned(),
        std::process::id().to_string(),
    );
    environment.insert(
        "DEEPSEEK_DESKTOP_HELPER_PATH".to_owned(),
        helper.to_string_lossy().into_owned(),
    );
    environment.insert(
        "DEEPSEEK_DESKTOP_DATA_DIR".to_owned(),
        paths.data_dir.to_string_lossy().into_owned(),
    );
    environment.insert("DEEPSEEK_DESKTOP_LOCALE".to_owned(), locale.to_owned());
    environment.insert(
        "DEEPSEEK_DESKTOP_NODE_PATH".to_owned(),
        node.to_string_lossy().into_owned(),
    );
    environment.insert(
        "DEEPSEEK_DESKTOP_PNPM_CLI".to_owned(),
        harness_dir
            .join("node_modules/pnpm/bin/pnpm.cjs")
            .to_string_lossy()
            .into_owned(),
    );
    let mut search_paths = vec![paths.data_dir.join("harness-bin")];
    if let Some(path) = std::env::var_os("PATH") {
        search_paths.extend(std::env::split_paths(&path));
    }
    environment.insert(
        "PATH".to_owned(),
        std::env::join_paths(search_paths)
            .map_err(|error| DesktopError::Other(error.to_string()))?
            .to_string_lossy()
            .into_owned(),
    );
    Ok(environment)
}

fn prepare_harness_profile(paths: &AppPaths, harness_dir: &Path, node: &Path) -> DesktopResult<()> {
    let profile = paths.dsh_home.join("profiles/desktop-web");
    let modules = profile.join("node_modules");
    fs::create_dir_all(&modules)?;
    let manifest_path = profile.join("package.json");
    let existing = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok());
    let manifest = merge_profile_manifest(existing);
    fs::write(
        manifest_path,
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )?;
    if !profile.join("cordis.patch.yml").exists() {
        fs::write(profile.join("cordis.patch.yml"), "[]\n")?;
    }
    if !profile.join("pnpm-workspace.yaml").exists() {
        fs::write(
            profile.join("pnpm-workspace.yaml"),
            "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
        )?;
    }
    for package in [
        "deepseek-desktop-bundle",
        "deepseek-desktop-credentials-vault",
    ] {
        sync_profile_package(
            &harness_dir.join("node_modules").join(package),
            &modules.join(package),
        )?;
    }
    prepare_package_manager(paths, harness_dir, node)
}

fn prepare_package_manager(paths: &AppPaths, harness_dir: &Path, node: &Path) -> DesktopResult<()> {
    let pnpm_cli = harness_dir.join("node_modules/pnpm/bin/pnpm.cjs");
    if !pnpm_cli.is_file() {
        return Err(DesktopError::HarnessArtifactMissing(
            pnpm_cli.display().to_string(),
        ));
    }
    let harness_bin = paths.data_dir.join("harness-bin");
    fs::create_dir_all(&harness_bin)?;
    #[cfg(windows)]
    fs::write(
        harness_bin.join("pnpm.cmd"),
        "@echo off\r\n\"%DEEPSEEK_DESKTOP_NODE_PATH%\" \"%DEEPSEEK_DESKTOP_PNPM_CLI%\" %*\r\n",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let wrapper = harness_bin.join("pnpm");
        fs::write(
            &wrapper,
            "#!/bin/sh\nexec \"$DEEPSEEK_DESKTOP_NODE_PATH\" \"$DEEPSEEK_DESKTOP_PNPM_CLI\" \"$@\"\n",
        )?;
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700))?;
    }
    if !node.is_file() {
        return Err(DesktopError::HarnessArtifactMissing(
            node.display().to_string(),
        ));
    }
    Ok(())
}

impl Drop for HarnessSupervisor {
    fn drop(&mut self) {
        if let Ok(inner) = self.inner.get_mut()
            && let Some(process) = inner.process.as_mut()
        {
            process.terminate();
        }
    }
}

impl ManagedChild {
    fn new(child: Child, credential_session: HarnessSession) -> DesktopResult<Self> {
        #[cfg(windows)]
        let (child, job) = {
            let mut child = child;
            let job = match WindowsJob::attach(&child) {
                Ok(job) => job,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            };
            (child, job)
        };
        Ok(Self {
            child,
            _credential_session: credential_session,
            #[cfg(windows)]
            job,
        })
    }

    fn terminate(&mut self) {
        #[cfg(windows)]
        self.job.terminate();
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn configure_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    command.creation_flags(CREATE_NO_WINDOW);
}

fn is_active_harness(status: &HarnessStatus) -> bool {
    matches!(
        status.phase,
        HarnessPhase::Starting | HarnessPhase::Ready | HarnessPhase::Recovering
    )
}

#[cfg(any(test, windows))]
pub(crate) fn strip_windows_verbatim_prefix(path: &[u16]) -> Vec<u16> {
    const BACKSLASH: u16 = b'\\' as u16;
    const QUESTION_MARK: u16 = b'?' as u16;
    const VERBATIM_PREFIX: [u16; 4] = [BACKSLASH, BACKSLASH, QUESTION_MARK, BACKSLASH];
    const UNC: [u16; 3] = [b'U' as u16, b'N' as u16, b'C' as u16];

    if path.starts_with(&VERBATIM_PREFIX)
        && path.len() >= 8
        && path[4..7]
            .iter()
            .zip(UNC)
            .all(|(actual, expected)| *actual == expected || *actual == expected + 32)
        && path[7] == BACKSLASH
    {
        let mut normalized = vec![BACKSLASH, BACKSLASH];
        normalized.extend_from_slice(&path[8..]);
        return normalized;
    }
    if path.starts_with(&VERBATIM_PREFIX) {
        return path[VERBATIM_PREFIX.len()..].to_vec();
    }
    path.to_vec()
}

fn parse_ready_url(line: &str) -> Option<String> {
    let start = line.find(READY_PREFIX)?;
    let value = line[start + "dsh web: ".len()..]
        .split_whitespace()
        .next()?;
    let url = Url::parse(value).ok()?;
    (url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some())
        .then(|| value.to_owned())
}

fn workbench_geometry(
    window_size: tauri::PhysicalSize<u32>,
    scale_factor: f64,
    top_inset: f64,
) -> (tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>) {
    let logical_size = window_size.to_logical::<f64>(scale_factor);
    let top_inset = top_inset.clamp(0.0, logical_size.height);
    let menu_height =
        crate::native_menu::WINDOW_MENU_HEIGHT_LOGICAL.clamp(0.0, logical_size.height - top_inset);
    (
        tauri::LogicalPosition::new(0.0, top_inset + menu_height),
        tauri::LogicalSize::new(
            logical_size.width,
            (logical_size.height - top_inset - menu_height).max(0.0),
        ),
    )
}

fn authenticate_harness(url: &str) -> DesktopResult<Url> {
    install_crypto_provider()?;
    let launch_url = Url::parse(url).map_err(|error| DesktopError::Other(error.to_string()))?;
    validate_harness_launch_url(&launch_url)?;
    let mut root_url = launch_url.clone();
    root_url.set_path("/");
    root_url.set_query(None);
    root_url.set_fragment(None);
    let client = reqwest::blocking::Client::builder()
        .timeout(HEALTH_TIMEOUT)
        .redirect(Policy::none())
        .build()
        .map_err(|error| DesktopError::Other(error.to_string()))?;

    let cookie = if launch_url.query().is_some() {
        let exchange = client
            .get(launch_url.clone())
            .send()
            .map_err(|error| DesktopError::Other(error.to_string()))?;
        if exchange.status() != StatusCode::SEE_OTHER {
            return Err(DesktopError::Other(format!(
                "harness browser authentication returned {}",
                exchange.status()
            )));
        }
        let location = exchange
            .headers()
            .get(LOCATION)
            .ok_or_else(|| {
                DesktopError::Other(
                    "harness browser authentication omitted its redirect".to_owned(),
                )
            })?
            .to_str()
            .map_err(|_| {
                DesktopError::Other(
                    "harness browser authentication returned an invalid redirect".to_owned(),
                )
            })?;
        let redirected = launch_url
            .join(location)
            .map_err(|error| DesktopError::Other(error.to_string()))?;
        if redirected != root_url {
            return Err(DesktopError::Other(
                "harness browser authentication redirected outside the managed root".to_owned(),
            ));
        }
        let set_cookie = exchange
            .headers()
            .get(SET_COOKIE)
            .ok_or_else(|| {
                DesktopError::Other(
                    "harness browser authentication omitted its session cookie".to_owned(),
                )
            })?
            .to_str()
            .map_err(|_| {
                DesktopError::Other(
                    "harness browser authentication returned an invalid session cookie".to_owned(),
                )
            })?;
        let pair = set_cookie
            .split(';')
            .next()
            .filter(|value| value.contains('=') && !value.trim().is_empty())
            .ok_or_else(|| {
                DesktopError::Other(
                    "harness browser authentication returned an empty session cookie".to_owned(),
                )
            })?;
        Some(HeaderValue::from_str(pair).map_err(|_| {
            DesktopError::Other(
                "harness browser authentication returned an invalid session cookie".to_owned(),
            )
        })?)
    } else {
        None
    };

    let mut request = client.get(root_url.clone());
    if let Some(cookie) = &cookie {
        request = request.header(COOKIE, cookie.clone());
    }
    let response = request
        .send()
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    if !response.status().is_success() {
        return Err(DesktopError::Other(format!(
            "harness health check returned {}",
            response.status()
        )));
    }
    Ok(root_url)
}

fn validate_harness_launch_url(url: &Url) -> DesktopResult<()> {
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(DesktopError::Other(
            "harness readiness URL is outside the managed loopback origin".to_owned(),
        ));
    }
    if let Some(query) = url.query() {
        let mut pairs = url.query_pairs();
        let Some((name, token)) = pairs.next() else {
            return Err(DesktopError::Other(
                "harness readiness URL contains an invalid query".to_owned(),
            ));
        };
        if name != "token"
            || token.is_empty()
            || token.len() > 512
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || pairs.next().is_some()
            || !query.starts_with("token=")
        {
            return Err(DesktopError::Other(
                "harness readiness URL contains an invalid browser token".to_owned(),
            ));
        }
    }
    Ok(())
}

pub fn install_crypto_provider() -> DesktopResult<()> {
    if rustls::crypto::CryptoProvider::get_default().is_some() {
        return Ok(());
    }
    let installed = rustls::crypto::ring::default_provider().install_default();
    if installed.is_err() && rustls::crypto::CryptoProvider::get_default().is_none() {
        return Err(DesktopError::Other(
            "could not install the Rustls crypto provider".to_owned(),
        ));
    }
    Ok(())
}

fn copy_directory(source: &Path, target: &Path) -> DesktopResult<()> {
    if !source.is_dir() {
        return Err(DesktopError::HarnessArtifactMissing(
            source.display().to_string(),
        ));
    }
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

fn sync_profile_package(source: &Path, target: &Path) -> DesktopResult<()> {
    let digest = directory_digest(source)?;
    let marker = target.join(PROFILE_PACKAGE_DIGEST_FILE);
    if fs::read_to_string(&marker).is_ok_and(|existing| existing.trim() == digest) {
        return Ok(());
    }
    if target.exists() {
        fs::remove_dir_all(target)?;
    }
    copy_directory(source, target)?;
    fs::write(marker, format!("{digest}\n"))?;
    Ok(())
}

fn directory_digest(source: &Path) -> DesktopResult<String> {
    if !source.is_dir() {
        return Err(DesktopError::HarnessArtifactMissing(
            source.display().to_string(),
        ));
    }
    let mut files = Vec::new();
    collect_directory_files(source, source, &mut files)?;
    files.sort();
    let mut digest = Sha256::new();
    for relative in files {
        digest.update(relative.to_string_lossy().as_bytes());
        digest.update([0]);
        digest.update(fs::read(source.join(relative))?);
        digest.update([0]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn collect_directory_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<PathBuf>,
) -> DesktopResult<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        if entry.file_name() == PROFILE_PACKAGE_DIGEST_FILE {
            continue;
        }
        if entry.file_type()?.is_dir() {
            collect_directory_files(root, &entry.path(), files)?;
        } else {
            files.push(
                entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|error| DesktopError::Other(error.to_string()))?
                    .to_path_buf(),
            );
        }
    }
    Ok(())
}

fn merge_profile_manifest(existing: Option<serde_json::Value>) -> serde_json::Value {
    const BUILT_IN_BUNDLES: [&str; 4] = [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "deepseek-desktop-bundle",
        "dshmarket",
    ];

    let mut manifest = existing
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    let preserved_bundles = manifest
        .pointer("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let object = manifest.as_object_mut().expect("profile manifest object");
    object
        .entry("name")
        .or_insert_with(|| serde_json::json!("deepseek-desktop-web-profile"));
    object.insert("private".to_owned(), serde_json::json!(true));
    if !object
        .get("dependencies")
        .is_some_and(serde_json::Value::is_object)
    {
        object.insert("dependencies".to_owned(), serde_json::json!({}));
    }
    if !object.get("dsh").is_some_and(serde_json::Value::is_object) {
        object.insert("dsh".to_owned(), serde_json::json!({}));
    }
    let dsh = object
        .get_mut("dsh")
        .and_then(serde_json::Value::as_object_mut)
        .expect("dsh profile object");
    if !dsh.get("profile").is_some_and(serde_json::Value::is_object) {
        dsh.insert("profile".to_owned(), serde_json::json!({}));
    }
    let profile = dsh
        .get_mut("profile")
        .and_then(serde_json::Value::as_object_mut)
        .expect("dsh profile settings object");
    let mut seen = HashSet::new();
    let mut bundles = Vec::new();
    for bundle in BUILT_IN_BUNDLES.into_iter().map(str::to_owned).chain(
        preserved_bundles
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_owned)),
    ) {
        if seen.insert(bundle.clone()) {
            bundles.push(serde_json::Value::String(bundle));
        }
    }
    profile.insert("bundles".to_owned(), serde_json::Value::Array(bundles));
    manifest
}

#[cfg(windows)]
struct WindowsJob(isize);

#[cfg(windows)]
impl WindowsJob {
    fn attach(child: &Child) -> DesktopResult<Self> {
        use std::mem::{size_of, zeroed};
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(DesktopError::Other(
                    "could not create Windows Job Object".to_owned(),
                ));
            }
            let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &information as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0
            {
                CloseHandle(job);
                return Err(DesktopError::Other(
                    "could not attach harness to Windows Job Object".to_owned(),
                ));
            }
            Ok(Self(job as isize))
        }
    }

    fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            TerminateJobObject(self.0 as _, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            CloseHandle(self.0 as _);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    fn read_http_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 2048];
        loop {
            let length = stream.read(&mut buffer).unwrap();
            if length == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..length]);
            let Some(headers_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers_end = headers_end + 4;
            let headers = String::from_utf8_lossy(&bytes[..headers_end]).to_ascii_lowercase();
            let content_length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or_default();
            if bytes.len() >= headers_end + content_length {
                break;
            }
        }
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn parses_only_managed_ready_urls() {
        assert_eq!(
            parse_ready_url("dsh web: http://127.0.0.1:43127"),
            Some("http://127.0.0.1:43127".to_owned())
        );
        assert_eq!(parse_ready_url("dsh web: http://localhost:43127"), None);
        assert_eq!(
            parse_ready_url("dsh web: http://127.0.0.1:43127/?token=test_token"),
            Some("http://127.0.0.1:43127/?token=test_token".to_owned())
        );
        assert_eq!(parse_ready_url("noise"), None);
    }

    #[test]
    fn reserves_the_shell_menu_above_the_embedded_workbench() {
        let (position, size) = workbench_geometry(tauri::PhysicalSize::new(2240, 1440), 2.0, 28.0);
        assert_eq!(position, tauri::LogicalPosition::new(0.0, 66.0));
        assert_eq!(size, tauri::LogicalSize::new(1120.0, 654.0));

        let (position, size) = workbench_geometry(tauri::PhysicalSize::new(1000, 700), 1.0, 0.0);
        assert_eq!(position, tauri::LogicalPosition::new(0.0, 38.0));
        assert_eq!(size, tauri::LogicalSize::new(1000.0, 662.0));
    }

    #[test]
    fn reuses_the_existing_workbench_for_the_same_harness_origin() {
        let loaded = (7, Url::parse("http://127.0.0.1:43127/").unwrap());
        let same_harness = Url::parse("http://127.0.0.1:43127/?token=rotated").unwrap();
        let replacement_harness = Url::parse("http://127.0.0.1:43128/?token=new").unwrap();

        assert!(!should_navigate_workbench(Some(&loaded), 7, &same_harness));
        assert!(should_navigate_workbench(
            Some(&loaded),
            7,
            &replacement_harness
        ));
        assert!(should_navigate_workbench(None, 7, &same_harness));
    }

    #[test]
    fn reloads_the_workbench_after_a_harness_restart_reuses_the_same_port() {
        // A restarted Harness rebuilds its plugin graph, so the revision embedded in
        // the loaded page's bundle URL no longer resolves and the Harness reports
        // "Failed to load plugins". Reusing the page is only safe within one start.
        let loaded = (7, Url::parse("http://127.0.0.1:43127/").unwrap());
        let restarted_same_port = Url::parse("http://127.0.0.1:43127/?token=restarted").unwrap();

        assert!(should_navigate_workbench(
            Some(&loaded),
            8,
            &restarted_same_port
        ));
    }

    #[test]
    fn treats_repeated_start_for_active_harness_as_idempotent() {
        for phase in [
            HarnessPhase::Starting,
            HarnessPhase::Ready,
            HarnessPhase::Recovering,
        ] {
            let status = HarnessStatus {
                phase,
                ..HarnessStatus::default()
            };
            assert!(is_active_harness(&status));
        }

        let failed = HarnessStatus {
            phase: HarnessPhase::Failed,
            ..HarnessStatus::default()
        };
        assert!(!is_active_harness(&failed));
    }

    #[test]
    fn abandons_a_stale_monitor_recovery_after_an_intervening_operation() {
        let mut inner = HarnessInner {
            status: HarnessStatus {
                phase: HarnessPhase::Ready,
                restart_count: 1,
                ..HarnessStatus::default()
            },
            process: None,
            browser_launch_url: None,
            manual_stop: false,
        };
        assert!(recovery_event_is_current(&inner, 1));
        inner.status.phase = HarnessPhase::Recovering;
        assert!(!recovery_event_is_current(&inner, 1));
        inner.status.phase = HarnessPhase::Ready;
        inner.status.restart_count = 0;
        assert!(!recovery_event_is_current(&inner, 1));
        inner.status.restart_count = 1;
        inner.manual_stop = true;
        assert!(!recovery_event_is_current(&inner, 1));
    }

    #[test]
    fn preserves_user_plugins_while_ensuring_desktop_bundles() {
        let manifest = merge_profile_manifest(Some(serde_json::json!({
            "name": "existing-profile",
            "dependencies": {
                "custom-plugin": "1.2.3"
            },
            "dsh": {
                "profile": {
                    "bundles": ["custom-plugin", "deepseek-desktop-bundle"]
                }
            }
        })));

        assert_eq!(manifest["name"], "existing-profile");
        assert_eq!(manifest["dependencies"]["custom-plugin"], "1.2.3");
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            serde_json::json!([
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                "deepseek-desktop-bundle",
                "dshmarket",
                "custom-plugin"
            ])
        );
    }

    #[test]
    fn exposes_node_internals_for_the_harness_live_profile() {
        assert_eq!(NODE_EXPOSE_INTERNALS_ARGUMENT, "--expose-internals");
    }

    #[test]
    fn copies_profile_packages_only_when_the_bundled_source_changes() {
        let root =
            std::env::temp_dir().join(format!("deepseek-desktop-profile-sync-{}", Uuid::new_v4()));
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("index.js"), "first").unwrap();

        sync_profile_package(&source, &target).unwrap();
        fs::write(target.join("preserved.txt"), "unchanged").unwrap();
        sync_profile_package(&source, &target).unwrap();
        assert!(target.join("preserved.txt").exists());

        fs::write(source.join("index.js"), "second").unwrap();
        sync_profile_package(&source, &target).unwrap();
        assert!(!target.join("preserved.txt").exists());
        assert_eq!(
            fs::read_to_string(target.join("index.js")).unwrap(),
            "second"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installs_crypto_provider_and_checks_legacy_loopback_harness() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });

        install_crypto_provider().unwrap();
        let root_url = authenticate_harness(&format!("http://{address}")).unwrap();
        assert_eq!(root_url.as_str(), format!("http://{address}/"));
        server.join().unwrap();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn exchanges_the_harness_browser_token_before_health_checks() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut exchange, _) = listener.accept().unwrap();
            let request = read_http_request(&mut exchange);
            assert!(request.starts_with("GET /?token=test_token HTTP/1.1"));
            exchange
                .write_all(
                    b"HTTP/1.1 303 See Other\r\nLocation: /\r\nSet-Cookie: dsh-auth-test=session_value; Path=/; HttpOnly\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();

            let (mut health, _) = listener.accept().unwrap();
            let request = read_http_request(&mut health);
            assert!(request.starts_with("GET / HTTP/1.1"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("cookie: dsh-auth-test=session_value")
            );
            health
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });

        let root_url =
            authenticate_harness(&format!("http://{address}/?token=test_token")).unwrap();
        assert_eq!(root_url.as_str(), format!("http://{address}/"));
        server.join().unwrap();
    }

    #[test]
    fn rejects_unmanaged_harness_readiness_queries() {
        for candidate in [
            "http://localhost:43127/?token=test_token",
            "http://127.0.0.1:43127/?other=value",
            "http://127.0.0.1:43127/?token=first&token=second",
            "http://127.0.0.1:43127/?token=invalid%20token",
            "http://127.0.0.1:43127/?token=valid#fragment",
            "http://127.0.0.1:43127/workbench?token=valid",
        ] {
            let url = Url::parse(candidate).unwrap();
            assert!(validate_harness_launch_url(&url).is_err(), "{candidate}");
        }
    }

    #[test]
    fn strips_windows_verbatim_prefixes_for_node_module_loading() {
        for (source, expected) in [
            (
                r"\\?\C:\Program Files\DeepSeek Desktop\harness",
                r"C:\Program Files\DeepSeek Desktop\harness",
            ),
            (
                r"\\?\UNC\server\share\DeepSeek Desktop\harness",
                r"\\server\share\DeepSeek Desktop\harness",
            ),
            (
                r"C:\Users\developer\DeepSeek Desktop\harness",
                r"C:\Users\developer\DeepSeek Desktop\harness",
            ),
        ] {
            let normalized =
                strip_windows_verbatim_prefix(&source.encode_utf16().collect::<Vec<_>>());
            assert_eq!(String::from_utf16(normalized.as_slice()).unwrap(), expected);
        }
    }

    #[test]
    fn disables_webview_text_assistance_without_rewriting_values() {
        for attribute in [
            "spellcheck",
            "autocorrect",
            "autocapitalize",
            "autocomplete",
            "writingsuggestions",
        ] {
            assert!(DISABLE_TEXT_ASSISTANCE_SCRIPT.contains(attribute));
        }
        assert!(!DISABLE_TEXT_ASSISTANCE_SCRIPT.contains("element.value"));
        assert!(DISABLE_TEXT_ASSISTANCE_SCRIPT.contains("MutationObserver"));
        assert!(DISABLE_TEXT_ASSISTANCE_SCRIPT.contains("focusin"));
    }

    #[test]
    fn identifies_external_http_links_without_intercepting_harness_navigation() {
        let managed = Url::parse("http://127.0.0.1:43127/").unwrap();
        for candidate in [
            "https://example.com/docs",
            "http://example.com/docs",
            "http://127.0.0.1:43128/other-harness",
        ] {
            assert_eq!(
                classify_navigation(Some(&managed), &Url::parse(candidate).unwrap()),
                Navigation::External,
                "{candidate}"
            );
        }
        for candidate in [
            "http://127.0.0.1:43127/conversation",
            "http://127.0.0.1:43127/?token=launch_token",
            "blob:http://127.0.0.1:43127/7de901da-2e4f-4ba0-b3ce-fb83998dbbfd",
        ] {
            assert_eq!(
                classify_navigation(Some(&managed), &Url::parse(candidate).unwrap()),
                Navigation::Allow,
                "{candidate}"
            );
        }
        for candidate in ["mailto:developer@example.com", "tel:+10000000000"] {
            assert_eq!(
                classify_navigation(Some(&managed), &Url::parse(candidate).unwrap()),
                Navigation::External,
                "{candidate}"
            );
        }
        for candidate in [
            "file:///tmp/local.html",
            "javascript:alert('blocked')",
            "data:text/html,blocked",
            "blob:https://example.com/untrusted",
            "custom-scheme:payload",
        ] {
            assert_eq!(
                classify_navigation(Some(&managed), &Url::parse(candidate).unwrap()),
                Navigation::Deny,
                "{candidate}"
            );
        }
    }

    #[test]
    fn follows_the_harness_to_a_new_port_after_a_restart() {
        let restarted = Url::parse("http://127.0.0.1:43128/").unwrap();
        let relaunch = Url::parse("http://127.0.0.1:43128/?token=launch_token").unwrap();
        assert_eq!(
            classify_navigation(Some(&restarted), &relaunch),
            Navigation::Allow
        );
        let stale = Url::parse("http://127.0.0.1:43127/").unwrap();
        assert_eq!(
            classify_navigation(Some(&stale), &relaunch),
            Navigation::External,
            "a stale snapshot would publish the launch token to the system browser"
        );
    }

    #[test]
    fn denies_web_navigation_while_no_harness_is_managed() {
        for candidate in [
            "http://127.0.0.1:43127/?token=launch_token",
            "https://example.com/docs",
        ] {
            assert_eq!(
                classify_navigation(None, &Url::parse(candidate).unwrap()),
                Navigation::Deny,
                "{candidate}"
            );
        }
        assert_eq!(
            classify_navigation(None, &Url::parse("mailto:developer@example.com").unwrap()),
            Navigation::External
        );
    }

    #[test]
    fn reads_the_managed_origin_through_the_shared_handle() {
        let origin: ManagedOrigin = Arc::new(Mutex::new(None));
        assert_eq!(current_managed_origin(&origin), None);
        *origin.lock().unwrap() = Some(Url::parse("http://127.0.0.1:43127/").unwrap());
        assert_eq!(
            current_managed_origin(&origin),
            Some(Url::parse("http://127.0.0.1:43127/").unwrap())
        );
    }
}
