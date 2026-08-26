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
        let _guard = self.write_lock.lock()?;
        let filename = format!(
            "deepseek-desktop-diagnostics-{}.json",
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
            desktop_version: env!("DEEPSEEK_DESKTOP_APP_VERSION"),
            runtime_version: env!("DEEPSEEK_DESKTOP_RUNTIME_VERSION"),
            target: env!("DEEPSEEK_DESKTOP_TARGET"),
            status: redacted_status,
            settings: redacted_settings,
            recent_log: self.read_tail(),
        };
        write_json_atomic(&path, &document)?;
        Ok(path)
    }

    pub fn export_logs(&self) -> DesktopResult<PathBuf> {
        let _guard = self.write_lock.lock()?;
        let filename = format!(
            "deepseek-desktop-logs-{}.log",
            Utc::now().format("%Y%m%dT%H%M%SZ")
        );
        let path = self.paths.diagnostics_dir.join(filename);
        fs::create_dir_all(&self.paths.diagnostics_dir)?;
        let current = self.paths.logs_dir.join("desktop.log");
        let mut sections = Vec::new();
        for index in (1..=LOG_FILE_COUNT).rev() {
            let rotated = current.with_extension(format!("log.{index}"));
            if let Ok(contents) = fs::read_to_string(&rotated) {
                sections.push(format!("===== desktop.log.{index} =====\n{contents}"));
            }
        }
        if let Ok(contents) = fs::read_to_string(&current) {
            sections.push(format!("===== desktop.log =====\n{contents}"));
        }
        let contents = if sections.is_empty() {
            "No desktop logs are available.\n".to_owned()
        } else {
            format!("{}\n", sections.join("\n"))
        };
        fs::write(&path, self.redact_paths(&redact(&contents)))?;
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
        let mut bytes = Vec::new();
        if file.read_to_end(&mut bytes).is_err() {
            return String::new();
        }
        if start > 0
            && let Some(line_start) = bytes.iter().position(|byte| *byte == b'\n')
        {
            bytes.drain(..=line_start);
        }
        let text = String::from_utf8_lossy(&bytes);
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
    runtime_version: &'static str,
    target: &'static str,
    status: RuntimeStatus,
    settings: DesktopSettings,
    recent_log: String,
}

fn rotate(path: &PathBuf) -> DesktopResult<()> {
    let oldest = path.with_extension(format!("log.{LOG_FILE_COUNT}"));
    if oldest.exists() {
        fs::remove_file(oldest)?;
    }
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
        .split_inclusive('\n')
        .fold(String::new(), |mut output, part| {
            let (line, ending) = if let Some(line) = part.strip_suffix("\r\n") {
                (line, "\r\n")
            } else if let Some(line) = part.strip_suffix('\n') {
                (line, "\n")
            } else {
                (part, "")
            };
            let lower = line.to_ascii_lowercase();
            if lower.contains("authorization:")
                || lower.contains("api_key")
                || lower.contains("apikey")
                || lower.contains("password")
                || lower.contains("cookie:")
                || lower.contains("secret")
            {
                output.push_str("<redacted>");
            } else {
                output.push_str(&line.replace("Bearer ", "Bearer <redacted>"));
            }
            output.push_str(ending);
            output
        })
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
        assert_eq!(
            redact("ready\r\npassword=unsafe\r\n"),
            "ready\r\n<redacted>\r\n"
        );
    }

    #[test]
    fn redacts_registered_workspace_and_data_paths() {
        let root = std::env::temp_dir().join(format!(
            "deepseek-desktop-diagnostics-{}",
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

    #[test]
    fn exports_redacted_plain_text_logs() {
        let root = std::env::temp_dir().join(format!(
            "deepseek-desktop-log-export-{}",
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
        diagnostics.append("runtime", &format!("workspace={workspace}"));
        diagnostics.append("runtime", "Authorization: Bearer unsafe");

        let exported = diagnostics.export_logs().unwrap();
        let log = fs::read_to_string(exported).unwrap();
        assert!(log.contains("desktop.log"));
        assert!(log.contains("<workspace-redacted>"));
        assert!(!log.contains(&workspace));
        assert!(!log.contains("unsafe"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_a_utf8_safe_tail_from_a_large_log() {
        let root =
            std::env::temp_dir().join(format!("deepseek-desktop-utf8-tail-{}", std::process::id()));
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
        let log = paths.logs_dir.join("desktop.log");
        let mut contents = "填充内容\n".repeat(20_000);
        contents.push_str("最后一行：运行正常\n");
        fs::write(log, contents).unwrap();
        let diagnostics = Diagnostics::new(paths);

        let tail = diagnostics.read_tail();

        assert!(tail.contains("最后一行：运行正常"));
        assert!(!tail.contains('\u{fffd}'));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rotates_and_exports_all_five_archives() {
        let root = std::env::temp_dir().join(format!(
            "deepseek-desktop-log-rotation-{}",
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
        let current = paths.logs_dir.join("desktop.log");
        fs::write(&current, "current\n").unwrap();
        for index in 1..=LOG_FILE_COUNT {
            fs::write(
                current.with_extension(format!("log.{index}")),
                format!("archive-{index}\n"),
            )
            .unwrap();
        }
        rotate(&current).unwrap();
        let diagnostics = Diagnostics::new(paths);

        let exported = fs::read_to_string(diagnostics.export_logs().unwrap()).unwrap();

        assert!(exported.contains("desktop.log.5"));
        assert!(exported.contains("archive-4"));
        assert!(!exported.contains("archive-5"));
        fs::remove_dir_all(root).unwrap();
    }
}
