use crate::contracts::{DesktopSettings, UpdateStatus};
use crate::error::{DesktopError, DesktopResult};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

pub async fn check(app: &AppHandle, settings: &DesktopSettings) -> DesktopResult<UpdateStatus> {
    if !settings.update_enabled || settings.update_channel == "community" {
        return Ok(UpdateStatus {
            enabled: false,
            channel: settings.update_channel.clone(),
            current_version: env!("CARGO_PKG_VERSION").to_owned(),
            available_version: None,
            message: "updates-disabled".to_owned(),
        });
    }
    let endpoint = option_env!("DSH_DESKTOP_UPDATER_ENDPOINT").filter(|value| !value.is_empty());
    let public_key = option_env!("DSH_DESKTOP_UPDATER_PUBKEY").filter(|value| !value.is_empty());
    let (Some(endpoint), Some(public_key)) = (endpoint, public_key) else {
        return Ok(UpdateStatus {
            enabled: false,
            channel: settings.update_channel.clone(),
            current_version: env!("CARGO_PKG_VERSION").to_owned(),
            available_version: None,
            message: "signed-updater-not-configured".to_owned(),
        });
    };
    let endpoint = Url::parse(endpoint).map_err(|error| DesktopError::Other(error.to_string()))?;
    let updater = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| DesktopError::Other(error.to_string()))?
        .build()
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    let update = updater
        .check()
        .await
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    Ok(UpdateStatus {
        enabled: true,
        channel: settings.update_channel.clone(),
        current_version: env!("CARGO_PKG_VERSION").to_owned(),
        available_version: update.as_ref().map(|release| release.version.clone()),
        message: if update.is_some() {
            "update-available"
        } else {
            "up-to-date"
        }
        .to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn community_settings_always_disable_updates() {
        let settings = DesktopSettings::default();
        assert!(!settings.update_enabled);
        assert_eq!(settings.update_channel, "community");
    }
}
