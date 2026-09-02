use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use tauri::{AppHandle, Manager};
use url::Url;

use crate::contracts::{DesktopSettings, current_settings_schema_version};
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
                Ok(value) => match migrate_settings(value)
                    .and_then(serde_json::from_value::<DesktopSettings>)
                {
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
        normalize_optional(&mut settings.runtime_update_repository);
        normalize_optional(&mut settings.desktop_update_last_check_at);
        normalize_optional(&mut settings.desktop_update_ignored_version);
        validate(&settings)?;
        Ok(settings)
    }

    pub fn update(&self, settings: DesktopSettings) -> DesktopResult<DesktopSettings> {
        let settings = Self::validated(settings)?;
        let mut current = self
            .current
            .write()
            .map_err(|_| DesktopError::Other("settings lock is poisoned".to_owned()))?;
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

fn migrate_settings(mut value: serde_json::Value) -> serde_json::Result<serde_json::Value> {
    let schema = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1);
    if schema > u64::from(current_settings_schema_version()) {
        return Err(serde::de::Error::custom(
            "settings schema is from a future version",
        ));
    }
    if schema == 1 {
        let object = value
            .as_object_mut()
            .ok_or_else(|| serde::de::Error::custom("settings must be an object"))?;
        object.insert(
            "runtimeUpdateChannel".to_owned(),
            serde_json::json!(env!("DEEPSEEK_DESKTOP_RUNTIME_UPDATE_CHANNEL")),
        );
        object.insert(
            "runtimeUpdateMode".to_owned(),
            serde_json::json!(if env!("DEEPSEEK_DESKTOP_RUNTIME_AUTO_UPDATE") == "true" {
                "automatic"
            } else {
                "notify"
            }),
        );
        object.insert("runtimePinnedVersion".to_owned(), serde_json::Value::Null);
    }
    if schema <= 2 {
        let object = value
            .as_object_mut()
            .ok_or_else(|| serde::de::Error::custom("settings must be an object"))?;
        object.remove("workspace");
    }
    if schema <= 3 {
        let object = value
            .as_object_mut()
            .ok_or_else(|| serde::de::Error::custom("settings must be an object"))?;
        object.insert(
            "runtimeUpdateSource".to_owned(),
            serde_json::json!("official"),
        );
        object.insert(
            "runtimeUpdateManifestUrl".to_owned(),
            serde_json::Value::Null,
        );
        object.insert(
            "runtimeUpdateRepository".to_owned(),
            serde_json::Value::Null,
        );
        object.insert("runtimeUpdatePublisher".to_owned(), serde_json::Value::Null);
        object.insert("runtimeUpdatePublicKey".to_owned(), serde_json::Value::Null);
    }
    if schema <= 4 {
        let object = value
            .as_object_mut()
            .ok_or_else(|| serde::de::Error::custom("settings must be an object"))?;
        object.insert(
            "desktopUpdateLastCheckAt".to_owned(),
            serde_json::Value::Null,
        );
        object.insert(
            "desktopUpdateIgnoredVersion".to_owned(),
            serde_json::Value::Null,
        );
    }
    if schema <= 5 {
        let object = value
            .as_object_mut()
            .ok_or_else(|| serde::de::Error::custom("settings must be an object"))?;
        object.remove("runtimeUpdateSource");
        object.remove("runtimeUpdateManifestUrl");
        object.remove("runtimeUpdatePublisher");
        object.remove("runtimeUpdatePublicKey");
    }
    value
        .as_object_mut()
        .ok_or_else(|| serde::de::Error::custom("settings must be an object"))?
        .insert(
            "schemaVersion".to_owned(),
            serde_json::json!(current_settings_schema_version()),
        );
    Ok(value)
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
        settings.runtime_update_channel.as_str(),
        "stable" | "preview"
    ) {
        return Err(DesktopError::InvalidConfiguration(format!(
            "unsupported runtime update channel {}",
            settings.runtime_update_channel
        )));
    }
    if !matches!(
        settings.runtime_update_mode.as_str(),
        "automatic" | "notify" | "manual"
    ) {
        return Err(DesktopError::InvalidConfiguration(format!(
            "unsupported runtime update mode {}",
            settings.runtime_update_mode
        )));
    }
    if let Some(value) = settings.runtime_update_repository.as_deref() {
        validate_runtime_repository(value)?;
    }
    if settings
        .runtime_pinned_version
        .as_deref()
        .is_some_and(|version| semver::Version::parse(version).is_err())
    {
        return Err(DesktopError::InvalidConfiguration(
            "runtime pinned version must be valid SemVer".to_owned(),
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

fn validate_runtime_repository(value: &str) -> DesktopResult<()> {
    if value.starts_with("git@") {
        if value.contains(char::is_whitespace) || !value.contains(':') {
            return Err(DesktopError::InvalidConfiguration(
                "Runtime repository SSH URL is invalid".to_owned(),
            ));
        }
        return Ok(());
    }
    let url = Url::parse(value).map_err(|error| {
        DesktopError::InvalidConfiguration(format!("Runtime repository URL is invalid: {error}"))
    })?;
    if !matches!(url.scheme(), "https" | "http" | "ssh" | "git" | "file")
        || (matches!(url.scheme(), "https" | "http") && !url.username().is_empty())
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(DesktopError::InvalidConfiguration(
            "Runtime repository URL must use HTTP(S), SSH, Git, or file without embedded credentials, query, or fragment"
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
    fn rejects_updates_for_community_channel() {
        let settings = DesktopSettings {
            update_enabled: true,
            ..DesktopSettings::default()
        };
        assert!(validate(&settings).is_err());
    }

    #[test]
    fn accepts_only_semver_runtime_pins() {
        let valid = DesktopSettings {
            runtime_pinned_version: Some("1.0.0".to_owned()),
            ..DesktopSettings::default()
        };
        assert!(validate(&valid).is_ok());

        let invalid = DesktopSettings {
            runtime_pinned_version: Some("latest".to_owned()),
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
    fn accepts_a_custom_runtime_repository_without_update_service_fields() {
        let settings = DesktopSettings {
            runtime_update_repository: Some(
                "https://git.example.com/runtime/deepseek-harness.git".to_owned(),
            ),
            ..DesktopSettings::default()
        };

        assert!(validate(&settings).is_ok());
    }

    #[test]
    fn rejects_a_runtime_repository_with_embedded_credentials() {
        let settings = DesktopSettings {
            runtime_update_repository: Some("https://token@example.com/runtime.git".to_owned()),
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
    fn migrates_legacy_settings_without_retaining_desktop_workspace_state() {
        let value = serde_json::json!({
            "schemaVersion": 1,
            "locale": "en-US",
            "workspace": "/workspace",
            "onboardingCompleted": true,
            "updateChannel": "community",
            "updateEnabled": false
        });
        let settings: DesktopSettings =
            serde_json::from_value(migrate_settings(value).unwrap()).unwrap();
        assert_eq!(settings.schema_version, current_settings_schema_version());
        assert_eq!(settings.locale, "en-US");
        assert_eq!(settings.runtime_update_mode, "notify");
        assert!(settings.runtime_update_repository.is_none());
        let serialized = serde_json::to_value(settings).unwrap();
        assert!(serialized.get("workspace").is_none());
    }

    #[test]
    fn migrates_schema_three_to_the_default_runtime_repository() {
        let mut value = serde_json::to_value(DesktopSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.insert("schemaVersion".to_owned(), serde_json::json!(3));
        object.remove("runtimeUpdateSource");
        object.remove("runtimeUpdateManifestUrl");
        object.remove("runtimeUpdateRepository");
        object.remove("runtimeUpdatePublisher");
        object.remove("runtimeUpdatePublicKey");

        let settings: DesktopSettings =
            serde_json::from_value(migrate_settings(value).unwrap()).unwrap();

        assert_eq!(settings.schema_version, current_settings_schema_version());
        assert!(settings.runtime_update_repository.is_none());
    }

    #[test]
    fn migrates_schema_five_and_keeps_only_the_repository_override() {
        let mut value = serde_json::to_value(DesktopSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.insert("schemaVersion".to_owned(), serde_json::json!(5));
        object.insert(
            "runtimeUpdateSource".to_owned(),
            serde_json::json!("custom"),
        );
        object.insert(
            "runtimeUpdateRepository".to_owned(),
            serde_json::json!("https://github.com/example/deepseek-harness.git"),
        );
        object.insert(
            "runtimeUpdateManifestUrl".to_owned(),
            serde_json::json!("https://updates.example/manifest.json"),
        );
        object.insert(
            "runtimeUpdatePublisher".to_owned(),
            serde_json::json!("legacy"),
        );
        object.insert(
            "runtimeUpdatePublicKey".to_owned(),
            serde_json::json!("legacy"),
        );

        let settings: DesktopSettings =
            serde_json::from_value(migrate_settings(value).unwrap()).unwrap();
        let serialized = serde_json::to_value(&settings).unwrap();

        assert_eq!(settings.schema_version, current_settings_schema_version());
        assert_eq!(
            settings.runtime_update_repository.as_deref(),
            Some("https://github.com/example/deepseek-harness.git")
        );
        assert!(serialized.get("runtimeUpdateSource").is_none());
        assert!(serialized.get("runtimeUpdateManifestUrl").is_none());
        assert!(serialized.get("runtimeUpdatePublisher").is_none());
        assert!(serialized.get("runtimeUpdatePublicKey").is_none());
    }

    #[test]
    fn migrates_schema_four_to_desktop_update_memory() {
        let mut value = serde_json::to_value(DesktopSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.insert("schemaVersion".to_owned(), serde_json::json!(4));
        object.remove("desktopUpdateLastCheckAt");
        object.remove("desktopUpdateIgnoredVersion");

        let settings: DesktopSettings =
            serde_json::from_value(migrate_settings(value).unwrap()).unwrap();

        assert_eq!(settings.schema_version, current_settings_schema_version());
        assert!(settings.desktop_update_last_check_at.is_none());
        assert!(settings.desktop_update_ignored_version.is_none());
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
