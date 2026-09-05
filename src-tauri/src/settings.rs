use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use tauri::{AppHandle, Manager};
use url::Url;

use crate::contracts::{DesktopSettings, DesktopSettingsPatch, current_settings_schema_version};
use crate::error::{DesktopError, DesktopResult};

#[derive(Clone, Debug)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub dsh_home: PathBuf,
    pub logs_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub diagnostics_dir: PathBuf,
    pub updates_dir: PathBuf,
    pub settings_file: PathBuf,
}

impl AppPaths {
    pub fn resolve(app: &AppHandle) -> DesktopResult<Self> {
        let data_dir = debug_override("DEEPSEEK_DESKTOP_DATA_DIR")
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(|| {
                app.path()
                    .app_data_dir()
                    .map_err(|error| DesktopError::Other(error.to_string()))
            })?;
        let paths = Self {
            dsh_home: data_dir.join("dsh"),
            logs_dir: data_dir.join("logs"),
            backups_dir: data_dir.join("backups"),
            diagnostics_dir: data_dir.join("diagnostics"),
            updates_dir: data_dir.join("updates"),
            settings_file: data_dir.join("settings.json"),
            data_dir,
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
        Ok(paths)
    }
}

pub struct SettingsStore {
    path: PathBuf,
    backup_dir: PathBuf,
    current: RwLock<DesktopSettings>,
}

impl SettingsStore {
    pub fn load(paths: &AppPaths) -> DesktopResult<Self> {
        let current = match fs::read_to_string(&paths.settings_file) {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(value)
                    if value
                        .get("schemaVersion")
                        .and_then(serde_json::Value::as_u64)
                        .is_some_and(|version| {
                            version > u64::from(current_settings_schema_version())
                        }) =>
                {
                    quarantine_settings(paths, "future")?
                }
                Ok(value) => match serde_json::from_value::<DesktopSettings>(value) {
                    Ok(settings) if validate(&settings).is_ok() => settings,
                    Ok(_) | Err(_) => quarantine_settings(paths, "corrupt")?,
                },
                Err(_) => quarantine_settings(paths, "corrupt")?,
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                DesktopSettings::default()
            }
            Err(error) => return Err(error.into()),
        };
        validate(&current)?;
        Ok(Self {
            path: paths.settings_file.clone(),
            backup_dir: paths.backups_dir.clone(),
            current: RwLock::new(current),
        })
    }

    pub fn get(&self) -> DesktopResult<DesktopSettings> {
        self.current
            .read()
            .map(|settings| settings.clone())
            .map_err(|_| DesktopError::Other("settings lock is poisoned".to_owned()))
    }

    pub(crate) fn validated(mut settings: DesktopSettings) -> DesktopResult<DesktopSettings> {
        settings.recovery_reason = None;
        normalize_optional(&mut settings.harness_update_repository);
        normalize_optional(&mut settings.desktop_update_last_check_at);
        normalize_optional(&mut settings.desktop_update_ignored_version);
        validate(&settings)?;
        Ok(settings)
    }

    pub fn patch(&self, patch: DesktopSettingsPatch) -> DesktopResult<DesktopSettings> {
        self.mutate(|settings| {
            if settings.revision != patch.expected_revision {
                return Err(DesktopError::SettingsConflict(settings.revision));
            }
            patch.change.apply(settings);
            settings.revision += 1;
            Ok(())
        })
    }

    #[cfg(test)]
    pub fn update(&self, settings: DesktopSettings) -> DesktopResult<DesktopSettings> {
        self.mutate(|current| {
            *current = settings;
            Ok(())
        })
    }

    pub fn mutate(
        &self,
        change: impl FnOnce(&mut DesktopSettings) -> DesktopResult<()>,
    ) -> DesktopResult<DesktopSettings> {
        let mut current = self
            .current
            .write()
            .map_err(|_| DesktopError::Other("settings lock is poisoned".to_owned()))?;
        let mut settings = current.clone();
        change(&mut settings)?;
        let settings = Self::validated(settings)?;
        if self.path.exists() {
            let backup = self.backup_dir.join("settings.previous.json");
            fs::copy(&self.path, backup)?;
        }
        write_json_atomic(&self.path, &settings)?;
        *current = settings.clone();
        Ok(settings)
    }
}

pub fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> DesktopResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| DesktopError::Other(format!("path has no parent: {}", path.display())))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut file = fs::File::create(&temporary)?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    replace_file(&temporary, path)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> DesktopResult<()> {
    fs::rename(source, destination)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> DesktopResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

fn debug_override(name: &str) -> Option<std::ffi::OsString> {
    if cfg!(debug_assertions) {
        std::env::var_os(name)
    } else {
        None
    }
}

fn quarantine_settings(paths: &AppPaths, reason: &str) -> DesktopResult<DesktopSettings> {
    let backup = paths.backups_dir.join(format!("settings.{reason}.json"));
    replace_file(&paths.settings_file, &backup)?;
    let settings = DesktopSettings {
        recovery_reason: Some(reason.to_owned()),
        ..DesktopSettings::default()
    };
    write_json_atomic(&paths.settings_file, &settings)?;
    Ok(settings)
}

fn normalize_optional(value: &mut Option<String>) {
    *value = value
        .take()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
}

fn validate(settings: &DesktopSettings) -> DesktopResult<()> {
    if settings.schema_version != current_settings_schema_version() {
        return Err(DesktopError::InvalidConfiguration(format!(
            "unsupported settings schema {}",
            settings.schema_version
        )));
    }
    if !matches!(settings.locale.as_str(), "zh-CN" | "zh-TW" | "en-US") {
        return Err(DesktopError::InvalidConfiguration(format!(
            "unsupported locale {}",
            settings.locale
        )));
    }
    if !matches!(settings.update_channel.as_str(), "community" | "stable") {
        return Err(DesktopError::InvalidConfiguration(format!(
            "unsupported update channel {}",
            settings.update_channel
        )));
    }
    if settings.update_channel == "community" && settings.update_enabled {
        return Err(DesktopError::InvalidConfiguration(
            "community builds cannot enable automatic updates".to_owned(),
        ));
    }
    if !matches!(
        settings.harness_update_channel.as_str(),
        "stable" | "preview"
    ) {
        return Err(DesktopError::InvalidConfiguration(format!(
            "unsupported harness update channel {}",
            settings.harness_update_channel
        )));
    }
    if !matches!(
        settings.harness_update_mode.as_str(),
        "automatic" | "notify" | "manual"
    ) {
        return Err(DesktopError::InvalidConfiguration(format!(
            "unsupported harness update mode {}",
            settings.harness_update_mode
        )));
    }
    if let Some(value) = settings.harness_update_repository.as_deref() {
        validate_harness_repository(value)?;
    }
    if settings
        .harness_pinned_version
        .as_deref()
        .is_some_and(|version| semver::Version::parse(version).is_err())
    {
        return Err(DesktopError::InvalidConfiguration(
            "harness pinned version must be valid SemVer".to_owned(),
        ));
    }
    if settings
        .desktop_update_last_check_at
        .as_deref()
        .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
    {
        return Err(DesktopError::InvalidConfiguration(
            "Desktop update check time must be RFC 3339".to_owned(),
        ));
    }
    if settings
        .desktop_update_ignored_version
        .as_deref()
        .is_some_and(|version| semver::Version::parse(version).is_err())
    {
        return Err(DesktopError::InvalidConfiguration(
            "Desktop ignored version must be valid SemVer".to_owned(),
        ));
    }
    Ok(())
}

fn validate_harness_repository(value: &str) -> DesktopResult<()> {
    if value.starts_with("git@") {
        if value.contains(char::is_whitespace) || !value.contains(':') {
            return Err(DesktopError::InvalidConfiguration(
                "Harness repository SSH URL is invalid".to_owned(),
            ));
        }
        return Ok(());
    }
    let url = Url::parse(value).map_err(|error| {
        DesktopError::InvalidConfiguration(format!("Harness repository URL is invalid: {error}"))
    })?;
    if !matches!(url.scheme(), "https" | "http" | "ssh" | "git" | "file")
        || (matches!(url.scheme(), "https" | "http") && !url.username().is_empty())
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(DesktopError::InvalidConfiguration(
            "Harness repository URL must use HTTP(S), SSH, Git, or file without embedded credentials, query, or fragment"
                .to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn user_field_patches_preserve_backend_state_and_reject_stale_revisions() {
        let root = tempfile::TempDir::new().unwrap();
        let store = SettingsStore {
            path: root.path().join("settings.json"),
            backup_dir: root.path().to_owned(),
            current: RwLock::new(DesktopSettings::default()),
        };
        store
            .mutate(|settings| {
                settings.desktop_update_last_check_at = Some("2026-09-05T00:00:00Z".to_owned());
                Ok(())
            })
            .unwrap();
        let patch = DesktopSettingsPatch {
            expected_revision: 0,
            change: crate::contracts::DesktopSettingsChange::Locale("en-US".to_owned()),
        };
        let saved = store.patch(patch.clone()).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(
            saved.desktop_update_last_check_at.as_deref(),
            Some("2026-09-05T00:00:00Z")
        );
        assert!(matches!(
            store.patch(patch),
            Err(DesktopError::SettingsConflict(1))
        ));
        assert_eq!(store.get().unwrap(), saved);
        assert!(serde_json::from_value::<DesktopSettingsPatch>(serde_json::json!({"expectedRevision":1,"change":{"field":"desktopUpdateLastCheckAt","value":null}})).is_err());
    }

    #[test]
    fn rejects_updates_for_community_channel() {
        let settings = DesktopSettings {
            update_enabled: true,
            ..DesktopSettings::default()
        };
        assert!(validate(&settings).is_err());
    }

    #[test]
    fn accepts_only_semver_harness_pins() {
        let valid = DesktopSettings {
            harness_pinned_version: Some("1.0.0".to_owned()),
            ..DesktopSettings::default()
        };
        assert!(validate(&valid).is_ok());

        let invalid = DesktopSettings {
            harness_pinned_version: Some("latest".to_owned()),
            ..DesktopSettings::default()
        };
        assert!(validate(&invalid).is_err());
    }

    #[test]
    fn accepts_only_valid_desktop_update_memory() {
        let valid = DesktopSettings {
            desktop_update_last_check_at: Some("2026-08-30T10:00:00Z".to_owned()),
            desktop_update_ignored_version: Some("1.2.0-beta.1".to_owned()),
            ..DesktopSettings::default()
        };
        assert!(validate(&valid).is_ok());

        let invalid_time = DesktopSettings {
            desktop_update_last_check_at: Some("yesterday".to_owned()),
            ..DesktopSettings::default()
        };
        assert!(validate(&invalid_time).is_err());
        let invalid_version = DesktopSettings {
            desktop_update_ignored_version: Some("latest".to_owned()),
            ..DesktopSettings::default()
        };
        assert!(validate(&invalid_version).is_err());
    }

    #[test]
    fn accepts_a_custom_harness_repository_without_update_service_fields() {
        let settings = DesktopSettings {
            harness_update_repository: Some(
                "https://git.example.com/harness/deepseek-harness.git".to_owned(),
            ),
            ..DesktopSettings::default()
        };

        assert!(validate(&settings).is_ok());
    }

    #[test]
    fn rejects_a_harness_repository_with_embedded_credentials() {
        let settings = DesktopSettings {
            harness_update_repository: Some("https://token@example.com/harness.git".to_owned()),
            ..DesktopSettings::default()
        };
        assert!(validate(&settings).is_err());
    }

    #[test]
    fn writes_atomic_settings_with_current_schema() {
        let root =
            std::env::temp_dir().join(format!("deepseek-desktop-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let path = root.join("settings.json");
        write_json_atomic(&path, &DesktopSettings::default()).unwrap();
        let stored =
            serde_json::from_str::<DesktopSettings>(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(stored.schema_version, current_settings_schema_version());
        assert!(!root.join(".settings.json.tmp").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn quarantines_corrupt_settings_and_restores_defaults() {
        let root = std::env::temp_dir().join(format!(
            "deepseek-desktop-corrupt-settings-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let paths = AppPaths {
            data_dir: root.clone(),
            dsh_home: root.join("dsh"),
            logs_dir: root.join("logs"),
            backups_dir: root.join("backups"),
            diagnostics_dir: root.join("diagnostics"),
            updates_dir: root.join("updates"),
            settings_file: root.join("settings.json"),
        };
        fs::create_dir_all(&paths.backups_dir).unwrap();
        fs::write(&paths.settings_file, "{not-json\n").unwrap();

        let store = SettingsStore::load(&paths).unwrap();

        assert_eq!(
            store.get().unwrap().recovery_reason.as_deref(),
            Some("corrupt")
        );
        assert!(paths.backups_dir.join("settings.corrupt.json").is_file());
        let restored = serde_json::from_str::<DesktopSettings>(
            &fs::read_to_string(&paths.settings_file).unwrap(),
        )
        .unwrap();
        assert_eq!(restored.recovery_reason.as_deref(), Some("corrupt"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn quarantines_settings_from_a_future_schema() {
        let root = std::env::temp_dir().join(format!(
            "deepseek-desktop-future-settings-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let paths = AppPaths {
            data_dir: root.clone(),
            dsh_home: root.join("dsh"),
            logs_dir: root.join("logs"),
            backups_dir: root.join("backups"),
            diagnostics_dir: root.join("diagnostics"),
            updates_dir: root.join("updates"),
            settings_file: root.join("settings.json"),
        };
        fs::create_dir_all(&paths.backups_dir).unwrap();
        let mut value = serde_json::to_value(DesktopSettings::default()).unwrap();
        value["schemaVersion"] = serde_json::json!(current_settings_schema_version() + 1);
        fs::write(&paths.settings_file, serde_json::to_vec(&value).unwrap()).unwrap();

        let store = SettingsStore::load(&paths).unwrap();

        assert_eq!(
            store.get().unwrap().recovery_reason.as_deref(),
            Some("future")
        );
        assert!(paths.backups_dir.join("settings.future.json").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clears_recovery_notice_after_settings_are_saved() {
        let root = std::env::temp_dir().join(format!(
            "deepseek-desktop-recovered-settings-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let paths = AppPaths {
            data_dir: root.clone(),
            dsh_home: root.join("dsh"),
            logs_dir: root.join("logs"),
            backups_dir: root.join("backups"),
            diagnostics_dir: root.join("diagnostics"),
            updates_dir: root.join("updates"),
            settings_file: root.join("settings.json"),
        };
        fs::create_dir_all(&paths.backups_dir).unwrap();
        fs::write(&paths.settings_file, "{not-json\n").unwrap();
        let store = SettingsStore::load(&paths).unwrap();

        let saved = store.update(store.get().unwrap()).unwrap();

        assert_eq!(saved.recovery_reason, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn serializes_concurrent_settings_writes() {
        let root = std::env::temp_dir().join(format!(
            "deepseek-desktop-concurrent-settings-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let paths = AppPaths {
            data_dir: root.clone(),
            dsh_home: root.join("dsh"),
            logs_dir: root.join("logs"),
            backups_dir: root.join("backups"),
            diagnostics_dir: root.join("diagnostics"),
            updates_dir: root.join("updates"),
            settings_file: root.join("settings.json"),
        };
        fs::create_dir_all(&paths.backups_dir).unwrap();
        let store = Arc::new(SettingsStore::load(&paths).unwrap());
        let barrier = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for locale in ["zh-TW", "en-US"] {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                let settings = DesktopSettings {
                    locale: locale.to_owned(),
                    ..DesktopSettings::default()
                };
                barrier.wait();
                store.update(settings).unwrap();
            }));
        }
        barrier.wait();
        for thread in threads {
            thread.join().unwrap();
        }
        let memory = store.get().unwrap();
        let disk =
            serde_json::from_slice::<DesktopSettings>(&fs::read(&paths.settings_file).unwrap())
                .unwrap();
        assert_eq!(disk.locale, memory.locale);
        assert!(!root.join(".settings.json.tmp").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
