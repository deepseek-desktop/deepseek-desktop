use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};

use chrono::Utc;
use serde::Serialize;

use crate::contracts::{DesktopSettings, RuntimeStatus};
use crate::error::{DesktopError, DesktopResult};
use crate::settings::{AppPaths, write_json_atomic};

const LOG_FILE_SIZE: u64 = 10 * 1024 * 1024;
const LOG_FILE_COUNT: usize = 5;
const DIAGNOSTIC_LOG_BYTES: u64 = 128 * 1024;

pub struct Diagnostics {
    paths: AppPaths,
    write_lock: Mutex<()>,
    workspace: RwLock<Option<String>>,
}

impl Diagnostics {
    pub fn new(paths: AppPaths) -> Self {
        Self {
            paths,
            write_lock: Mutex::new(()),
            workspace: RwLock::new(None),
        }
    }

    pub fn set_workspace(&self, workspace: &str) {
        if let Ok(mut current) = self.workspace.write() {
            *current = Some(workspace.to_owned());
        }
    }

    pub fn append(&self, source: &str, message: &str) {
        let Ok(_guard) = self.write_lock.lock() else {
            return;
        };
        let path = self.paths.logs_dir.join("desktop.log");
        if fs::metadata(&path)
            .map(|metadata| metadata.len() >= LOG_FILE_SIZE)
            .unwrap_or(false)
        {
            let _ = rotate(&path);
        }
        let redacted = self.redact_paths(&redact(message));
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(
                file,
                "{} [{}] {}",
                Utc::now().to_rfc3339(),
                source,
                redacted
            );
        }
    }

    pub fn export(
        &self,
        status: &RuntimeStatus,
        settings: &DesktopSettings,
    ) -> DesktopResult<PathBuf> {
        let filename = format!(
            "deepseek-harness-desktop-diagnostics-{}.json",
            Utc::now().format("%Y%m%dT%H%M%SZ")
        );
        let path = self.paths.diagnostics_dir.join(filename);
        let mut redacted_status = status.clone();
        redacted_status.workspace = status
            .workspace
            .as_ref()
            .map(|_| "<workspace-redacted>".to_owned());
        let mut redacted_settings = settings.clone();
        redacted_settings.workspace = settings
            .workspace
            .as_ref()
            .map(|_| "<workspace-redacted>".to_owned());
        let document = DiagnosticDocument {
            generated_at: Utc::now().to_rfc3339(),
            desktop_version: env!("CARGO_PKG_VERSION"),
            harness_version: "0.1.1-rc.2",
            target: env!("DEEPSEEK_HARNESS_DESKTOP_TARGET"),
            status: redacted_status,
            settings: redacted_settings,
            recent_log: self.read_tail(),
        };
        write_json_atomic(&path, &document)?;
        Ok(path)
    }

    fn read_tail(&self) -> String {
        let path = self.paths.logs_dir.join("desktop.log");
        let Ok(mut file) = fs::File::open(path) else {
            return String::new();
        };
        let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
            return String::new();
        };
        let start = length.saturating_sub(DIAGNOSTIC_LOG_BYTES);
        if file.seek(SeekFrom::Start(start)).is_err() {
            return String::new();
        }
        let mut text = String::new();
        if file.read_to_string(&mut text).is_err() {
            return String::new();
        }
        self.redact_paths(&redact(&text))
    }

    fn redact_paths(&self, value: &str) -> String {
        let mut roots = vec![(
            self.paths.data_dir.to_string_lossy().into_owned(),
            "<data-dir-redacted>",
        )];
        if let Ok(Some(workspace)) = self.workspace.read().map(|value| value.clone()) {
            roots.push((workspace, "<workspace-redacted>"));
        }
        if let Some(home) = std::env::var_os("HOME") {
            roots.push((home.to_string_lossy().into_owned(), "<home-redacted>"));
        }
        roots.sort_by_key(|root| std::cmp::Reverse(root.0.len()));
        roots
            .into_iter()
            .filter(|(path, _)| !path.is_empty())
            .fold(value.to_owned(), |text, (path, placeholder)| {
                text.replace(&path, placeholder)
            })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticDocument {
    generated_at: String,
    desktop_version: &'static str,
    harness_version: &'static str,
    target: &'static str,
    status: RuntimeStatus,
    settings: DesktopSettings,
    recent_log: String,
}

fn rotate(path: &PathBuf) -> DesktopResult<()> {
    for index in (1..LOG_FILE_COUNT).rev() {
        let from = path.with_extension(format!("log.{index}"));
        let to = path.with_extension(format!("log.{}", index + 1));
        if from.exists() {
            fs::rename(from, to)?;
        }
    }
    if path.exists() {
        fs::rename(path, path.with_extension("log.1"))?;
    }
    Ok(())
}

pub fn redact(value: &str) -> String {
    value
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.contains("authorization:")
                || lower.contains("api_key")
                || lower.contains("apikey")
                || lower.contains("password")
                || lower.contains("cookie:")
                || lower.contains("secret")
            {
                "<redacted>".to_owned()
            } else {
                line.replace("Bearer ", "Bearer <redacted>")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

impl From<std::sync::PoisonError<std::sync::MutexGuard<'_, ()>>> for DesktopError {
    fn from(_: std::sync::PoisonError<std::sync::MutexGuard<'_, ()>>) -> Self {
        DesktopError::Other("diagnostic lock is poisoned".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_secret_bearing_lines() {
        assert_eq!(
            redact("Authorization: Bearer token\nready"),
            "<redacted>\nready"
        );
        assert_eq!(redact("password=unsafe"), "<redacted>");
    }

    #[test]
    fn redacts_registered_workspace_and_data_paths() {
        let root = std::env::temp_dir().join(format!(
            "deepseek-harness-desktop-diagnostics-{}",
            std::process::id()
        ));
        let paths = AppPaths {
            data_dir: root.join("data"),
            dsh_home: root.join("data/dsh"),
            logs_dir: root.join("data/logs"),
            backups_dir: root.join("data/backups"),
            diagnostics_dir: root.join("data/diagnostics"),
            updates_dir: root.join("data/updates"),
            settings_file: root.join("data/settings.json"),
        };
        fs::create_dir_all(&paths.logs_dir).unwrap();
        let diagnostics = Diagnostics::new(paths);
        let workspace = root.join("workspace").to_string_lossy().into_owned();
        diagnostics.set_workspace(&workspace);

        diagnostics.append(
            "test",
            &format!("workspace={workspace} data={}", root.join("data").display()),
        );

        let log = fs::read_to_string(root.join("data/logs/desktop.log")).unwrap();
        assert!(!log.contains(&workspace));
        assert!(!log.contains(&root.join("data").to_string_lossy().into_owned()));
        fs::remove_dir_all(root).unwrap();
    }
}
