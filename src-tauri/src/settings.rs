use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use tauri::{AppHandle, Manager};

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
        let data_dir = std::env::var_os("DEEPSEEK_DESKTOP_DATA_DIR")
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
            Ok(text) => match serde_json::from_str::<DesktopSettings>(&text) {
                Ok(settings) if settings.schema_version > current_settings_schema_version() => {
                    return Err(DesktopError::InvalidConfiguration(format!(
                        "settings schema {} is newer than supported schema {}",
                        settings.schema_version,
                        current_settings_schema_version()
                    )));
                }
                Ok(settings) if validate(&settings).is_ok() => settings,
                Ok(_) | Err(_) => quarantine_invalid_settings(paths)?,
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

    pub fn update(&self, settings: DesktopSettings) -> DesktopResult<DesktopSettings> {
        validate(&settings)?;
        if self.path.exists() {
            let backup = self.backup_dir.join("settings.previous.json");
            fs::copy(&self.path, backup)?;
        }
        write_json_atomic(&self.path, &settings)?;
        let mut current = self
            .current
            .write()
            .map_err(|_| DesktopError::Other("settings lock is poisoned".to_owned()))?;
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

fn quarantine_invalid_settings(paths: &AppPaths) -> DesktopResult<DesktopSettings> {
    let backup = paths.backups_dir.join("settings.corrupt.json");
    replace_file(&paths.settings_file, &backup)?;
    let settings = DesktopSettings::default();
    write_json_atomic(&paths.settings_file, &settings)?;
    Ok(settings)
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
    if !matches!(settings.theme.as_str(), "system" | "light" | "dark") {
        return Err(DesktopError::InvalidConfiguration(format!(
            "unsupported theme {}",
            settings.theme
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_updates_for_community_channel() {
        let settings = DesktopSettings {
            update_enabled: true,
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

        assert_eq!(store.get().unwrap(), DesktopSettings::default());
        assert!(paths.backups_dir.join("settings.corrupt.json").is_file());
        let restored = serde_json::from_str::<DesktopSettings>(
            &fs::read_to_string(&paths.settings_file).unwrap(),
        )
        .unwrap();
        assert_eq!(restored, DesktopSettings::default());
        fs::remove_dir_all(root).unwrap();
    }
}
