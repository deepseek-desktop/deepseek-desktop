use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Utc;
use serde::Serialize;

use crate::contracts::{DesktopSettings, HarnessStatus, HarnessUpdateStatus};
use crate::error::{DesktopError, DesktopResult};
use crate::settings::{AppPaths, write_json_atomic};

const LOG_FILE_SIZE: u64 = 10 * 1024 * 1024;
const LOG_FILE_COUNT: usize = 5;
const DIAGNOSTIC_LOG_BYTES: u64 = 128 * 1024;

pub struct Diagnostics {
    paths: AppPaths,
    write_lock: Mutex<()>,
}

impl Diagnostics {
    pub fn new(paths: AppPaths) -> Self {
        Self {
            paths,
            write_lock: Mutex::new(()),
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
        status: &HarnessStatus,
        harness_update: &HarnessUpdateStatus,
        settings: &DesktopSettings,
    ) -> DesktopResult<PathBuf> {
        let _guard = self.write_lock.lock()?;
        let filename = format!(
            "deepseek-desktop-diagnostics-{}.json",
            Utc::now().format("%Y%m%dT%H%M%SZ")
        );
        let path = self.paths.diagnostics_dir.join(filename);
        let mut redacted_status = status.clone();
        redacted_status.url = status.url.as_ref().map(|url| redact(url));
        let mut redacted_settings = settings.clone();
        redacted_settings.harness_update_repository = None;
        let document = DiagnosticDocument {
            generated_at: Utc::now().to_rfc3339(),
            desktop_version: env!("DEEPSEEK_DESKTOP_APP_VERSION"),
            harness_version: harness_update.current_version.clone(),
            target: env!("DEEPSEEK_DESKTOP_TARGET"),
            status: redacted_status,
            harness_update: harness_update.clone(),
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
        redact_roots(
            value,
            &self.paths.data_dir.to_string_lossy(),
            &home_directories(),
        )
    }
}

fn redact_roots(value: &str, data_dir: &str, homes: &[String]) -> String {
    let mut roots = vec![(data_dir, "<data-dir-redacted>")];
    for home in homes {
        roots.push((home.as_str(), "<home-redacted>"));
    }
    roots.sort_by_key(|root| std::cmp::Reverse(root.0.len()));
    roots.into_iter().filter(|(path, _)| !path.is_empty()).fold(
        value.to_owned(),
        |text, (path, placeholder)| {
            if is_windows_path(path) {
                replace_windows_path(&text, path, placeholder)
            } else {
                text.replace(path, placeholder)
            }
        },
    )
}

fn is_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with("\\\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/'))
}

fn replace_windows_path(value: &str, path: &str, placeholder: &str) -> String {
    let needle = path.as_bytes();
    let haystack = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    for (start, _) in value.char_indices() {
        if start < cursor || start + needle.len() > haystack.len() {
            continue;
        }
        let end = start + needle.len();
        if !value.is_char_boundary(end) {
            continue;
        }
        let matches = haystack[start..end]
            .iter()
            .zip(needle)
            .all(|(left, right)| {
                (matches!(left, b'\\' | b'/') && matches!(right, b'\\' | b'/'))
                    || left.eq_ignore_ascii_case(right)
            });
        if matches {
            output.push_str(&value[cursor..start]);
            output.push_str(placeholder);
            cursor = end;
        }
    }
    output.push_str(&value[cursor..]);
    output
}

/// Windows GUI processes carry the home directory in `USERPROFILE` (or the
/// `HOMEDRIVE` + `HOMEPATH` pair) rather than `HOME`, so an export that only
/// knows `HOME` ships `C:\Users\<name>\...` to whoever receives the bundle.
fn home_directories() -> Vec<String> {
    home_directories_from(|name| {
        std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
    })
}

/// Takes the environment as a lookup so the Windows resolution is covered by a
/// test on every platform: mutating the real environment is process-global and
/// racy under a parallel test runner.
fn home_directories_from(lookup: impl Fn(&str) -> Option<String>) -> Vec<String> {
    let mut roots = Vec::new();
    for name in ["HOME", "USERPROFILE"] {
        if let Some(value) = lookup(name) {
            roots.push(value);
        }
    }
    if let (Some(drive), Some(path)) = (lookup("HOMEDRIVE"), lookup("HOMEPATH")) {
        roots.push(format!("{drive}{path}"));
    }
    roots.retain(|root| !root.is_empty());
    roots.sort();
    roots.dedup();
    roots
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticDocument {
    generated_at: String,
    desktop_version: &'static str,
    harness_version: String,
    target: &'static str,
    status: HarnessStatus,
    harness_update: HarnessUpdateStatus,
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
                output.push_str(&redact_query_tokens(
                    &line.replace("Bearer ", "Bearer <redacted>"),
                ));
            }
            output.push_str(ending);
            output
        })
}

fn redact_query_tokens(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    loop {
        let remaining = &lower[cursor..];
        let relative = match (remaining.find("?token="), remaining.find("&token=")) {
            (Some(left), Some(right)) => left.min(right),
            (Some(index), None) | (None, Some(index)) => index,
            (None, None) => break,
        };
        let start = cursor + relative;
        let value_start = start + "?token=".len();
        output.push_str(&value[cursor..value_start]);
        output.push_str("<redacted>");
        let token_length = if value[value_start..].starts_with("<redacted>") {
            "<redacted>".len()
        } else {
            value[value_start..]
                .bytes()
                .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                .count()
        };
        cursor = value_start + token_length;
        if token_length == 0 {
            cursor = value_start;
        }
    }
    output.push_str(&value[cursor..]);
    output
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
        assert_eq!(
            redact("dsh web: http://127.0.0.1:43127/?token=unsafe_token"),
            "dsh web: http://127.0.0.1:43127/?token=<redacted>"
        );
        assert_eq!(
            redact("dsh web: http://127.0.0.1:43127/?token=<redacted>"),
            "dsh web: http://127.0.0.1:43127/?token=<redacted>"
        );
    }

    fn environment(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(candidate, _)| candidate == name)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn resolves_the_home_directory_on_every_platform() {
        assert_eq!(
            home_directories_from(environment(&[("HOME", "/Users/zhang")])),
            vec!["/Users/zhang".to_owned()]
        );
        // A Windows GUI process has no HOME.
        assert_eq!(
            home_directories_from(environment(&[("USERPROFILE", "C:\\Users\\zhang")])),
            vec!["C:\\Users\\zhang".to_owned()]
        );
        assert_eq!(
            home_directories_from(environment(&[
                ("HOMEDRIVE", "C:"),
                ("HOMEPATH", "\\Users\\zhang")
            ])),
            vec!["C:\\Users\\zhang".to_owned()]
        );
        // The same profile reached two ways must not produce two roots.
        assert_eq!(
            home_directories_from(environment(&[
                ("USERPROFILE", "C:\\Users\\zhang"),
                ("HOMEDRIVE", "C:"),
                ("HOMEPATH", "\\Users\\zhang"),
            ])),
            vec!["C:\\Users\\zhang".to_owned()]
        );
        assert!(home_directories_from(environment(&[("HOME", "")])).is_empty());
        assert!(home_directories_from(environment(&[("HOMEDRIVE", "C:")])).is_empty());
        assert!(home_directories_from(environment(&[])).is_empty());
    }

    #[test]
    fn redacts_a_windows_profile_resolved_from_the_environment() {
        let homes = home_directories_from(environment(&[
            ("USERPROFILE", "C:\\Users\\zhang"),
            ("HOMEDRIVE", "C:"),
            ("HOMEPATH", "\\Users\\zhang"),
        ]));
        let redacted = redact_roots(
            "harness=C:\\Users\\zhang\\Documents\\work; cache=C:\\Users\\zhang\\AppData\\Local\\npm",
            "C:\\Users\\zhang\\AppData\\Roaming\\deepseek.desktop",
            &homes,
        );
        assert!(!redacted.contains("zhang"), "{redacted}");
    }

    #[test]
    fn redacts_windows_user_profile_paths() {
        let homes = ["C:\\Users\\zhang".to_owned()];
        let redacted = redact_roots(
            "harness=C:\\Users\\zhang\\AppData\\Roaming\\deepseek.desktop\\logs; project=C:\\Users\\zhang\\work",
            "C:\\Users\\zhang\\AppData\\Roaming\\deepseek.desktop",
            &homes,
        );
        assert!(!redacted.contains("zhang"), "{redacted}");
        assert!(redacted.contains("<data-dir-redacted>\\logs"), "{redacted}");
        assert!(redacted.contains("<home-redacted>\\work"), "{redacted}");
    }

    #[test]
    fn redacts_windows_paths_case_insensitively_with_either_separator() {
        let homes = ["C:\\Users\\Zhang".to_owned()];
        let redacted = redact_roots(
            "harness=c:/users/zhang/appdata/roaming/deepseek.desktop/logs; project=C:/USERS/ZHANG/work",
            "C:\\Users\\Zhang\\AppData\\Roaming\\deepseek.desktop",
            &homes,
        );
        assert!(
            !redacted.to_ascii_lowercase().contains("zhang"),
            "{redacted}"
        );
        assert!(redacted.contains("<data-dir-redacted>/logs"), "{redacted}");
        assert!(redacted.contains("<home-redacted>/work"), "{redacted}");
    }

    #[test]
    fn redacts_application_data_paths() {
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

        diagnostics.append(
            "test",
            &format!("harness={}", root.join("data/harness-workdir").display()),
        );

        let log = fs::read_to_string(root.join("data/logs/desktop.log")).unwrap();
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
        diagnostics.append("harness", "Authorization: Bearer unsafe");
        diagnostics.append(
            "harness",
            "dsh web: http://127.0.0.1:43127/?token=harness_launch_token",
        );

        let exported = diagnostics.export_logs().unwrap();
        let log = fs::read_to_string(exported).unwrap();
        assert!(log.contains("desktop.log"));
        assert!(!log.contains("unsafe"));
        assert!(!log.contains("harness_launch_token"));
        assert!(log.contains("token=<redacted>"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn omits_the_custom_harness_repository_from_diagnostics() {
        let root = std::env::temp_dir().join(format!(
            "deepseek-desktop-update-source-diagnostics-{}",
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
        let settings = DesktopSettings {
            harness_update_repository: Some(
                "https://private.example/harness/harness.git".to_owned(),
            ),
            ..DesktopSettings::default()
        };

        let exported = diagnostics
            .export(
                &HarnessStatus::default(),
                &HarnessUpdateStatus::default(),
                &settings,
            )
            .unwrap();
        let document = fs::read_to_string(exported).unwrap();

        assert!(!document.contains("private.example"));
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
