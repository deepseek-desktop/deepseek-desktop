use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;
use uuid::Uuid;

use crate::contracts::{RuntimePhase, RuntimeStatus};
use crate::credential_vault::RuntimeSession;
use crate::diagnostics::Diagnostics;
use crate::error::{DesktopError, DesktopResult};
use crate::settings::{AppPaths, SettingsStore};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const WORKSPACE_REGISTRATION_TIMEOUT: Duration = Duration::from_secs(5);
const MONITOR_INTERVAL: Duration = Duration::from_millis(500);
const MAX_RESTARTS: u8 = 2;
const READY_PREFIX: &str = "dsh web: http://127.0.0.1:";
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

pub struct RuntimeSupervisor {
    app: AppHandle,
    paths: AppPaths,
    settings: Arc<SettingsStore>,
    diagnostics: Arc<Diagnostics>,
    operation: Mutex<()>,
    inner: Mutex<RuntimeInner>,
    workbench_visible: AtomicBool,
}

struct RuntimeInner {
    status: RuntimeStatus,
    process: Option<ManagedChild>,
    manual_stop: bool,
}

struct ManagedChild {
    child: Child,
    _credential_session: RuntimeSession,
    #[cfg(windows)]
    job: WindowsJob,
}

impl RuntimeSupervisor {
    pub fn new(
        app: AppHandle,
        paths: AppPaths,
        settings: Arc<SettingsStore>,
        diagnostics: Arc<Diagnostics>,
    ) -> Arc<Self> {
        let supervisor = Arc::new(Self {
            app,
            paths,
            settings,
            diagnostics,
            operation: Mutex::new(()),
            inner: Mutex::new(RuntimeInner {
                status: RuntimeStatus::default(),
                process: None,
                manual_stop: false,
            }),
            workbench_visible: AtomicBool::new(false),
        });
        Self::start_monitor(&supervisor);
        supervisor
    }

    pub fn status(&self) -> DesktopResult<RuntimeStatus> {
        Ok(self.lock_inner()?.status.clone())
    }

    pub fn start(&self, workspace: String) -> DesktopResult<RuntimeStatus> {
        let _operation = self.lock_operation()?;
        validate_workspace(&workspace)?;
        let current = self.status()?;
        if is_active_workspace(&current, &workspace) {
            return Ok(current);
        }
        self.stop_locked(false)?;
        self.spawn_locked(workspace, 0, RuntimePhase::Starting)
    }

    pub fn restart(&self) -> DesktopResult<RuntimeStatus> {
        let _operation = self.lock_operation()?;
        let workspace = self
            .lock_inner()?
            .status
            .workspace
            .clone()
            .ok_or(DesktopError::RuntimeNotReady)?;
        self.stop_locked(false)?;
        self.spawn_locked(workspace, 0, RuntimePhase::Starting)
    }

    pub fn stop(&self) -> DesktopResult<RuntimeStatus> {
        let _operation = self.lock_operation()?;
        self.stop_locked(true)
    }

    pub fn task_failed(&self, message: &str) -> DesktopResult<RuntimeStatus> {
        let status = self.status()?;
        self.fail(
            status.workspace.as_deref().unwrap_or_default(),
            status.restart_count,
            "runtime-task-failed",
            message,
        )
    }

    pub fn open_runtime(&self) -> DesktopResult<()> {
        let status = self.status()?;
        let raw_url = status.url.ok_or(DesktopError::RuntimeNotReady)?;
        let url = Url::parse(&raw_url).map_err(|error| DesktopError::Other(error.to_string()))?;
        if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
            return Err(DesktopError::Other(
                "runtime URL is outside the managed loopback origin".to_owned(),
            ));
        }
        if let Some(webview) = self.app.get_webview("workbench") {
            webview
                .navigate(url)
                .map_err(|error| DesktopError::Other(error.to_string()))?;
            self.workbench_visible.store(true, Ordering::Release);
            self.layout_workbench()?;
            webview
                .show()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
            if let Some(main) = self.app.get_webview("main") {
                main.hide()
                    .map_err(|error| DesktopError::Other(error.to_string()))?;
            }
            webview
                .set_focus()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
            self.emit_surface("workbench");
            return Ok(());
        }
        let managed_origin = url.clone();
        let app = self.app.clone();
        let main_window = self
            .app
            .get_window("main")
            .ok_or_else(|| DesktopError::Other("main desktop window is unavailable".to_owned()))?;
        let (position, size) = self.workbench_bounds(&main_window)?;
        let builder =
            tauri::webview::WebviewBuilder::new("workbench", tauri::WebviewUrl::External(url))
                .initialization_script(DISABLE_TEXT_ASSISTANCE_SCRIPT)
                .on_navigation(move |candidate| {
                    let managed = candidate.scheme() == managed_origin.scheme()
                        && candidate.host_str() == managed_origin.host_str()
                        && candidate.port_or_known_default()
                            == managed_origin.port_or_known_default();
                    if !managed && matches!(candidate.scheme(), "http" | "https") {
                        let _ = app.opener().open_url(candidate.as_str(), None::<&str>);
                    }
                    managed
                });
        let webview = match main_window.add_child(builder, position, size) {
            Ok(webview) => webview,
            Err(error) => {
                self.workbench_visible.store(false, Ordering::Release);
                let _ = self.layout_management();
                return Err(DesktopError::Other(error.to_string()));
            }
        };
        self.workbench_visible.store(true, Ordering::Release);
        self.layout_workbench()?;
        if let Some(main) = self.app.get_webview("main") {
            main.hide()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
        }
        webview
            .set_focus()
            .map_err(|error| DesktopError::Other(error.to_string()))?;
        self.emit_surface("workbench");
        Ok(())
    }

    pub fn show_management(&self) -> DesktopResult<()> {
        self.workbench_visible.store(false, Ordering::Release);
        if let Some(webview) = self.app.get_webview("workbench") {
            webview
                .close()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
        }
        if let Some(main) = self.app.get_webview("main") {
            main.show()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
        }
        self.layout_management()?;
        if let Some(main) = self.app.get_webview("main") {
            main.set_focus()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
        }
        self.emit_surface("management");
        Ok(())
    }

    pub fn sync_surface_layout(&self) -> DesktopResult<()> {
        if self.workbench_visible.load(Ordering::Acquire) {
            self.layout_workbench()
        } else {
            self.layout_management()
        }
    }

    fn layout_workbench(&self) -> DesktopResult<()> {
        let window = self
            .app
            .get_window("main")
            .ok_or_else(|| DesktopError::Other("main desktop window is unavailable".to_owned()))?;
        let (position, size) = self.workbench_bounds(&window)?;
        if let Some(workbench) = self.app.get_webview("workbench") {
            workbench
                .set_bounds(tauri::Rect {
                    position: tauri::Position::Physical(position),
                    size: tauri::Size::Physical(size),
                })
                .map_err(|error| DesktopError::Other(error.to_string()))?;
        }
        Ok(())
    }

    fn layout_management(&self) -> DesktopResult<()> {
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
        main.set_bounds(tauri::Rect {
            position: tauri::Position::Physical(tauri::PhysicalPosition::new(0, 0)),
            size: tauri::Size::Physical(size),
        })
        .map_err(|error| DesktopError::Other(error.to_string()))?;
        Ok(())
    }

    fn workbench_bounds(
        &self,
        window: &tauri::Window,
    ) -> DesktopResult<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)> {
        let window_size = window
            .inner_size()
            .map_err(|error| DesktopError::Other(error.to_string()))?;
        Ok(workbench_geometry(window_size))
    }

    fn emit_surface(&self, surface: &str) {
        let _ = self.app.emit("desktop://surface", surface);
    }

    fn spawn_locked(
        &self,
        workspace: String,
        restart_count: u8,
        phase: RuntimePhase,
    ) -> DesktopResult<RuntimeStatus> {
        self.diagnostics.set_workspace(&workspace);
        self.publish(RuntimeStatus {
            phase,
            workspace: Some(workspace.clone()),
            restart_count,
            ..RuntimeStatus::default()
        })?;
        let runtime_dir = self.runtime_dir()?;
        let node = self.node_binary()?;
        self.prepare_profile(&runtime_dir, &node)?;
        let dsh_entry = runtime_dir.join(env!("DEEPSEEK_DESKTOP_RUNTIME_ENTRY"));
        let parent_watch =
            runtime_dir.join("node_modules/deepseek-desktop-bundle/parent-watch.cjs");
        let locale_sync = runtime_dir.join("node_modules/deepseek-desktop-bundle/locale-sync.cjs");
        if !dsh_entry.is_file() {
            return self.fail(
                &workspace,
                restart_count,
                "runtime-artifact-missing",
                &format!("missing {}", dsh_entry.display()),
            );
        }
        if !parent_watch.is_file() {
            return self.fail(
                &workspace,
                restart_count,
                "runtime-artifact-missing",
                &format!("missing {}", parent_watch.display()),
            );
        }
        if !locale_sync.is_file() {
            return self.fail(
                &workspace,
                restart_count,
                "runtime-artifact-missing",
                &format!("missing {}", locale_sync.display()),
            );
        }
        let helper = std::env::current_exe()?;
        let credential_session = RuntimeSession::create(&self.paths.data_dir)?;
        let mut command = Command::new(&node);
        command
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
            .current_dir(&workspace)
            .env_clear()
            .envs(self.runtime_environment(&helper, &runtime_dir, &node)?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut command);
        let child = command.spawn()?;
        let mut managed = ManagedChild::new(child, credential_session)?;
        let session_token = managed._credential_session.token().to_owned();
        let session_result = managed
            .child
            .stdin
            .take()
            .ok_or_else(|| {
                DesktopError::Other("runtime credential channel is unavailable".to_owned())
            })
            .and_then(|mut stdin| {
                stdin.write_all(session_token.as_bytes())?;
                stdin.write_all(b"\n")?;
                Ok(())
            });
        if let Err(error) = session_result {
            managed.terminate();
            return self.fail(
                &workspace,
                restart_count,
                "runtime-credential-channel-failed",
                &error.to_string(),
            );
        }
        let stdout = managed
            .child
            .stdout
            .take()
            .ok_or_else(|| DesktopError::Other("runtime stdout is unavailable".to_owned()))?;
        let stderr = managed
            .child
            .stderr
            .take()
            .ok_or_else(|| DesktopError::Other("runtime stderr is unavailable".to_owned()))?;
        let (ready_tx, ready_rx) = mpsc::channel::<String>();
        let stdout_diagnostics = Arc::clone(&self.diagnostics);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                stdout_diagnostics.append("runtime.stdout", &line);
                if let Some(url) = parse_ready_url(&line) {
                    let _ = ready_tx.send(url);
                }
            }
        });
        let stderr_diagnostics = Arc::clone(&self.diagnostics);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                stderr_diagnostics.append("runtime.stderr", &line);
            }
        });

        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let ready_url = loop {
            if let Some(exit) = managed.child.try_wait()? {
                let message = format!("exit status {exit}");
                managed.terminate();
                return self.fail(&workspace, restart_count, "runtime-exited", &message);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                managed.terminate();
                return self.fail(
                    &workspace,
                    restart_count,
                    "runtime-timeout",
                    "runtime startup timed out",
                );
            }
            match ready_rx.recv_timeout(remaining.min(Duration::from_millis(200))) {
                Ok(url) => break url,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    managed.terminate();
                    return self.fail(
                        &workspace,
                        restart_count,
                        "runtime-output-closed",
                        "runtime closed its output before readiness",
                    );
                }
            }
        };
        if let Err(error) = health_check(&ready_url) {
            managed.terminate();
            return self.fail(
                &workspace,
                restart_count,
                "runtime-health-check-failed",
                &error.to_string(),
            );
        }
        if let Err(error) = register_workspace(&ready_url, &workspace) {
            managed.terminate();
            return self.fail(
                &workspace,
                restart_count,
                "runtime-workspace-registration-failed",
                &error.to_string(),
            );
        }
        let status = RuntimeStatus {
            phase: RuntimePhase::Ready,
            url: Some(ready_url),
            workspace: Some(workspace),
            restart_count,
            diagnostic_id: None,
            error_code: None,
        };
        {
            let mut inner = self.lock_inner()?;
            inner.manual_stop = false;
            inner.process = Some(managed);
            inner.status = status.clone();
        }
        self.emit(&status);
        Ok(status)
    }

    fn stop_locked(&self, manual: bool) -> DesktopResult<RuntimeStatus> {
        let previous = self.status()?;
        if previous.phase != RuntimePhase::Idle {
            self.publish(RuntimeStatus {
                phase: RuntimePhase::Stopping,
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
        let surface_result = self.show_management();
        let status = RuntimeStatus {
            phase: RuntimePhase::Idle,
            workspace: previous.workspace,
            ..RuntimeStatus::default()
        };
        let status = self.publish(status)?;
        surface_result?;
        Ok(status)
    }

    fn fail(
        &self,
        workspace: &str,
        restart_count: u8,
        code: &str,
        message: &str,
    ) -> DesktopResult<RuntimeStatus> {
        self.diagnostics.append("supervisor", message);
        let _ = self.show_management();
        let status = RuntimeStatus {
            phase: RuntimePhase::Failed,
            workspace: Some(workspace.to_owned()),
            restart_count,
            diagnostic_id: Some(Uuid::new_v4().to_string()),
            error_code: Some(code.to_owned()),
            ..RuntimeStatus::default()
        };
        self.publish(status.clone())?;
        Err(DesktopError::RuntimeExited(message.to_owned()))
    }

    fn publish(&self, status: RuntimeStatus) -> DesktopResult<RuntimeStatus> {
        self.lock_inner()?.status = status.clone();
        self.emit(&status);
        Ok(status)
    }

    fn emit(&self, status: &RuntimeStatus) {
        let _ = self.app.emit("runtime://status", status);
    }

    fn runtime_dir(&self) -> DesktopResult<PathBuf> {
        if let Some(path) = std::env::var_os("DEEPSEEK_DESKTOP_RUNTIME_DIR") {
            return Ok(PathBuf::from(path));
        }
        if cfg!(debug_assertions) {
            return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../runtime/staging")
                .join(env!("DEEPSEEK_DESKTOP_TARGET")));
        }
        let resource_dir = self
            .app
            .path()
            .resource_dir()
            .map_err(|error| DesktopError::Other(error.to_string()))?;
        Ok(node_compatible_path(&resource_dir)
            .join("runtime/staging")
            .join(env!("DEEPSEEK_DESKTOP_TARGET")))
    }

    fn node_binary(&self) -> DesktopResult<PathBuf> {
        if let Some(path) = std::env::var_os("DEEPSEEK_DESKTOP_NODE_PATH") {
            return Ok(PathBuf::from(path));
        }
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let sibling = std::env::current_exe()?.with_file_name(format!("node{suffix}"));
        if sibling.is_file() {
            return Ok(sibling);
        }
        if cfg!(debug_assertions) {
            let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(format!(
                    "node-{}{}",
                    env!("DEEPSEEK_DESKTOP_TARGET"),
                    suffix
                ));
            if development.is_file() {
                return Ok(development);
            }
        }
        Err(DesktopError::RuntimeArtifactMissing(
            "Node sidecar".to_owned(),
        ))
    }

    fn runtime_environment(
        &self,
        helper: &Path,
        runtime_dir: &Path,
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
            self.paths.dsh_home.to_string_lossy().into_owned(),
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
            self.paths.data_dir.to_string_lossy().into_owned(),
        );
        environment.insert(
            "DEEPSEEK_DESKTOP_LOCALE".to_owned(),
            self.settings.get()?.locale,
        );
        environment.insert(
            "DEEPSEEK_DESKTOP_NODE_PATH".to_owned(),
            node.to_string_lossy().into_owned(),
        );
        environment.insert(
            "DEEPSEEK_DESKTOP_PNPM_CLI".to_owned(),
            runtime_dir
                .join("node_modules/pnpm/bin/pnpm.cjs")
                .to_string_lossy()
                .into_owned(),
        );
        let runtime_bin = self.paths.data_dir.join("runtime-bin");
        let mut search_paths = vec![runtime_bin];
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

    fn prepare_profile(&self, runtime_dir: &Path, node: &Path) -> DesktopResult<()> {
        let profile = self.paths.dsh_home.join("profiles/desktop-web");
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
            let source = runtime_dir.join("node_modules").join(package);
            let target = modules.join(package);
            if target.exists() {
                fs::remove_dir_all(&target)?;
            }
            copy_directory(&source, &target)?;
        }
        self.prepare_package_manager(runtime_dir, node)?;
        Ok(())
    }

    fn prepare_package_manager(&self, runtime_dir: &Path, node: &Path) -> DesktopResult<()> {
        let pnpm_cli = runtime_dir.join("node_modules/pnpm/bin/pnpm.cjs");
        if !pnpm_cli.is_file() {
            return Err(DesktopError::RuntimeArtifactMissing(
                pnpm_cli.display().to_string(),
            ));
        }
        let runtime_bin = self.paths.data_dir.join("runtime-bin");
        fs::create_dir_all(&runtime_bin)?;
        #[cfg(windows)]
        fs::write(
            runtime_bin.join("pnpm.cmd"),
            "@echo off\r\n\"%DEEPSEEK_DESKTOP_NODE_PATH%\" \"%DEEPSEEK_DESKTOP_PNPM_CLI%\" %*\r\n",
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let wrapper = runtime_bin.join("pnpm");
            fs::write(
                &wrapper,
                "#!/bin/sh\nexec \"$DEEPSEEK_DESKTOP_NODE_PATH\" \"$DEEPSEEK_DESKTOP_PNPM_CLI\" \"$@\"\n",
            )?;
            fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700))?;
        }
        if !node.is_file() {
            return Err(DesktopError::RuntimeArtifactMissing(
                node.display().to_string(),
            ));
        }
        Ok(())
    }

    fn lock_inner(&self) -> DesktopResult<MutexGuard<'_, RuntimeInner>> {
        Ok(self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    fn lock_operation(&self) -> DesktopResult<MutexGuard<'_, ()>> {
        match self.operation.try_lock() {
            Ok(operation) => Ok(operation),
            Err(TryLockError::Poisoned(error)) => Ok(error.into_inner()),
            Err(TryLockError::WouldBlock) => Err(DesktopError::RuntimeBusy),
        }
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
                    if inner.manual_stop || inner.status.phase != RuntimePhase::Ready {
                        None
                    } else {
                        match inner
                            .process
                            .as_mut()
                            .and_then(|process| process.child.try_wait().ok())
                            .flatten()
                        {
                            Some(exit) => {
                                inner.process.take();
                                Some((
                                    inner.status.workspace.clone(),
                                    inner.status.restart_count,
                                    exit.to_string(),
                                ))
                            }
                            None => None,
                        }
                    }
                };
                let Some((Some(workspace), restart_count, exit)) = restart else {
                    continue;
                };
                supervisor.diagnostics.append(
                    "supervisor",
                    &format!("runtime exited unexpectedly: {exit}"),
                );
                if restart_count >= MAX_RESTARTS {
                    let _ = supervisor.show_management();
                    let _ = supervisor.publish(RuntimeStatus {
                        phase: RuntimePhase::Failed,
                        workspace: Some(workspace),
                        restart_count,
                        diagnostic_id: Some(Uuid::new_v4().to_string()),
                        error_code: Some("restart-limit-reached".to_owned()),
                        ..RuntimeStatus::default()
                    });
                    continue;
                }
                let next = restart_count + 1;
                let _ = supervisor.show_management();
                let _ = supervisor.publish(RuntimeStatus {
                    phase: RuntimePhase::Recovering,
                    workspace: Some(workspace.clone()),
                    restart_count: next,
                    ..RuntimeStatus::default()
                });
                thread::sleep(if next == 1 {
                    Duration::from_secs(1)
                } else {
                    Duration::from_secs(3)
                });
                let Ok(_operation) = supervisor.operation.try_lock() else {
                    continue;
                };
                let _ = supervisor.spawn_locked(workspace, next, RuntimePhase::Recovering);
            }
        });
    }
}

impl Drop for RuntimeSupervisor {
    fn drop(&mut self) {
        if let Ok(inner) = self.inner.get_mut()
            && let Some(process) = inner.process.as_mut()
        {
            process.terminate();
        }
    }
}

impl ManagedChild {
    fn new(child: Child, credential_session: RuntimeSession) -> DesktopResult<Self> {
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

fn validate_workspace(workspace: &str) -> DesktopResult<()> {
    if !Path::new(workspace).is_dir() {
        return Err(DesktopError::InvalidWorkspace(workspace.to_owned()));
    }
    Ok(())
}

fn is_active_workspace(status: &RuntimeStatus, workspace: &str) -> bool {
    status.workspace.as_deref() == Some(workspace)
        && matches!(
            status.phase,
            RuntimePhase::Starting | RuntimePhase::Ready | RuntimePhase::Recovering
        )
}

#[cfg(windows)]
fn node_compatible_path(path: &Path) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let units = path.as_os_str().encode_wide().collect::<Vec<_>>();
    PathBuf::from(OsString::from_wide(&strip_windows_verbatim_prefix(&units)))
}

#[cfg(not(windows))]
fn node_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

#[cfg(any(test, windows))]
fn strip_windows_verbatim_prefix(path: &[u16]) -> Vec<u16> {
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
) -> (tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>) {
    (tauri::PhysicalPosition::new(0, 0), window_size)
}

fn health_check(url: &str) -> DesktopResult<()> {
    install_crypto_provider()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(HEALTH_TIMEOUT)
        .build()
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    if !response.status().is_success() {
        return Err(DesktopError::Other(format!(
            "runtime health check returned {}",
            response.status()
        )));
    }
    Ok(())
}

fn register_workspace(url: &str, workspace: &str) -> DesktopResult<()> {
    install_crypto_provider()?;
    let base = Url::parse(url).map_err(|error| DesktopError::Other(error.to_string()))?;
    if base.scheme() != "http" || base.host_str() != Some("127.0.0.1") || base.port().is_none() {
        return Err(DesktopError::Other(
            "runtime workspace endpoint is outside the managed loopback origin".to_owned(),
        ));
    }
    let endpoint = base
        .join("/api/workspace.create")
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    let rpc_id = Uuid::new_v4().to_string();
    let client = reqwest::blocking::Client::builder()
        .timeout(WORKSPACE_REGISTRATION_TIMEOUT)
        .build()
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    let response = client
        .post(endpoint)
        .json(&workspace_registration_request(&rpc_id, workspace))
        .send()
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    if !response.status().is_success() {
        return Err(DesktopError::Other(format!(
            "runtime workspace registration returned {}",
            response.status()
        )));
    }
    let envelope = response
        .json::<serde_json::Value>()
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    validate_workspace_registration_response(&rpc_id, &envelope)
}

fn workspace_registration_request(rpc_id: &str, workspace: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "client-request",
        "rpcId": rpc_id,
        "method": "workspace.create",
        "payload": { "path": workspace }
    })
}

fn validate_workspace_registration_response(
    rpc_id: &str,
    envelope: &serde_json::Value,
) -> DesktopResult<()> {
    if envelope.get("type").and_then(serde_json::Value::as_str) != Some("server-response")
        || envelope.get("rpcId").and_then(serde_json::Value::as_str) != Some(rpc_id)
    {
        return Err(DesktopError::Other(
            "runtime workspace registration returned an invalid response".to_owned(),
        ));
    }
    match envelope
        .pointer("/result/ok")
        .and_then(serde_json::Value::as_bool)
    {
        Some(true) => Ok(()),
        Some(false) => {
            let message = envelope
                .pointer("/result/error/message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("runtime rejected the workspace");
            Err(DesktopError::Other(message.to_owned()))
        }
        None => Err(DesktopError::Other(
            "runtime workspace registration returned an invalid result".to_owned(),
        )),
    }
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
        return Err(DesktopError::RuntimeArtifactMissing(
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
                    "could not attach runtime to Windows Job Object".to_owned(),
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
    use std::net::TcpListener;

    #[test]
    fn parses_only_managed_ready_urls() {
        assert_eq!(
            parse_ready_url("dsh web: http://127.0.0.1:43127"),
            Some("http://127.0.0.1:43127".to_owned())
        );
        assert_eq!(parse_ready_url("dsh web: http://localhost:43127"), None);
        assert_eq!(parse_ready_url("noise"), None);
    }

    #[test]
    fn fills_the_native_window_with_the_embedded_workbench() {
        let (position, size) = workbench_geometry(tauri::PhysicalSize::new(2240, 1440));
        assert_eq!(position, tauri::PhysicalPosition::new(0, 0));
        assert_eq!(size, tauri::PhysicalSize::new(2240, 1440));
    }

    #[test]
    fn treats_repeated_start_for_active_workspace_as_idempotent() {
        for phase in [
            RuntimePhase::Starting,
            RuntimePhase::Ready,
            RuntimePhase::Recovering,
        ] {
            let status = RuntimeStatus {
                phase,
                workspace: Some("/tmp/workspace".to_owned()),
                ..RuntimeStatus::default()
            };
            assert!(is_active_workspace(&status, "/tmp/workspace"));
            assert!(!is_active_workspace(&status, "/tmp/other"));
        }

        let failed = RuntimeStatus {
            phase: RuntimePhase::Failed,
            workspace: Some("/tmp/workspace".to_owned()),
            ..RuntimeStatus::default()
        };
        assert!(!is_active_workspace(&failed, "/tmp/workspace"));
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
    fn installs_crypto_provider_and_checks_loopback_runtime() {
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
        health_check(&format!("http://{address}")).unwrap();
        server.join().unwrap();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn builds_and_accepts_the_workspace_registration_contract() {
        let request = workspace_registration_request("rpc-1", "/tmp/workspace");
        assert_eq!(request["type"], "client-request");
        assert_eq!(request["rpcId"], "rpc-1");
        assert_eq!(request["method"], "workspace.create");
        assert_eq!(request["payload"]["path"], "/tmp/workspace");

        let response = serde_json::json!({
            "type": "server-response",
            "rpcId": "rpc-1",
            "result": {
                "ok": true,
                "value": {
                    "workspace": {
                        "workspaceId": "workspace-1",
                        "path": "/tmp/workspace",
                        "title": "workspace",
                        "sessionIds": [],
                        "createdAt": "2026-08-25T00:00:00Z",
                        "updatedAt": "2026-08-25T00:00:00Z"
                    },
                    "created": true
                }
            }
        });
        validate_workspace_registration_response("rpc-1", &response).unwrap();
    }

    #[test]
    fn rejects_failed_or_mismatched_workspace_registration_responses() {
        let rejected = serde_json::json!({
            "type": "server-response",
            "rpcId": "rpc-1",
            "result": {
                "ok": false,
                "error": { "code": "invalid-path", "message": "workspace is unavailable" }
            }
        });
        let error = validate_workspace_registration_response("rpc-1", &rejected).unwrap_err();
        assert!(error.to_string().contains("workspace is unavailable"));

        let mismatched = serde_json::json!({
            "type": "server-response",
            "rpcId": "rpc-2",
            "result": { "ok": true, "value": {} }
        });
        let error = validate_workspace_registration_response("rpc-1", &mismatched).unwrap_err();
        assert!(error.to_string().contains("invalid response"));
    }

    #[test]
    fn strips_windows_verbatim_prefixes_for_node_module_loading() {
        for (source, expected) in [
            (
                r"\\?\C:\Program Files\DeepSeek Desktop\runtime",
                r"C:\Program Files\DeepSeek Desktop\runtime",
            ),
            (
                r"\\?\UNC\server\share\DeepSeek Desktop\runtime",
                r"\\server\share\DeepSeek Desktop\runtime",
            ),
            (
                r"C:\Users\developer\DeepSeek Desktop\runtime",
                r"C:\Users\developer\DeepSeek Desktop\runtime",
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
}
