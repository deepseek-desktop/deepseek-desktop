use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    pub phase: HarnessPhase,
    pub url: Option<String>,
    pub restart_count: u8,
    pub diagnostic_id: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HarnessPhase {
    #[default]
    Idle,
    Starting,
    Ready,
    Stopping,
    Recovering,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopSettings {
    #[serde(default)]
    pub revision: u64,
    #[serde(default = "current_settings_schema_version")]
    pub schema_version: u8,
    pub locale: String,
    pub onboarding_completed: bool,
    pub update_channel: String,
    pub update_enabled: bool,
    #[serde(default = "default_harness_update_channel")]
    pub harness_update_channel: String,
    #[serde(default = "default_harness_update_mode")]
    pub harness_update_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_update_repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_pinned_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_update_last_check_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_update_ignored_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_reason: Option<String>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            revision: 0,
            schema_version: current_settings_schema_version(),
            locale: "zh-CN".to_owned(),
            onboarding_completed: false,
            update_channel: "community".to_owned(),
            update_enabled: false,
            harness_update_channel: default_harness_update_channel(),
            harness_update_mode: default_harness_update_mode(),
            harness_update_repository: None,
            harness_pinned_version: None,
            desktop_update_last_check_at: None,
            desktop_update_ignored_version: None,
            recovery_reason: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopSettingsPatch {
    pub expected_revision: u64,
    pub change: DesktopSettingsChange,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "field",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum DesktopSettingsChange {
    Locale(String),
    HarnessUpdateMode(String),
    HarnessUpdateChannel(String),
    HarnessUpdateRepository(Option<String>),
    HarnessPinnedVersion(Option<String>),
}

impl DesktopSettingsChange {
    pub fn apply(self, settings: &mut DesktopSettings) {
        match self {
            Self::Locale(value) => settings.locale = value,
            Self::HarnessUpdateMode(value) => settings.harness_update_mode = value,
            Self::HarnessUpdateChannel(value) => settings.harness_update_channel = value,
            Self::HarnessUpdateRepository(value) => settings.harness_update_repository = value,
            Self::HarnessPinnedVersion(value) => settings.harness_pinned_version = value,
        }
    }
}

pub const fn current_settings_schema_version() -> u8 {
    7
}

fn default_harness_update_channel() -> String {
    env!("DEEPSEEK_DESKTOP_HARNESS_UPDATE_CHANNEL").to_owned()
}

fn default_harness_update_mode() -> String {
    if env!("DEEPSEEK_DESKTOP_HARNESS_AUTO_UPDATE") == "true" {
        "automatic".to_owned()
    } else {
        "notify".to_owned()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAbout {
    pub desktop_version: String,
    pub harness_version: String,
    pub harness_commit: String,
    pub node_version: String,
    pub authors: String,
    pub repository: String,
    pub channel: String,
    pub signed_release: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub enabled: bool,
    pub channel: String,
    pub current_version: String,
    pub available_version: Option<String>,
    pub release_tag: Option<String>,
    pub published_at: Option<String>,
    pub release_notes: Option<String>,
    pub release_notes_format: ReleaseNotesFormat,
    pub prerelease: Option<bool>,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseNotesFormat {
    #[default]
    Markdown,
    Html,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessUpdatePhase {
    Disabled,
    #[default]
    Idle,
    Checking,
    Available,
    Downloading,
    Staged,
    Applying,
    Applied,
    Failed,
    RolledBack,
    Pinned,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessUpdateStatus {
    pub enabled: bool,
    pub phase: HarnessUpdatePhase,
    pub current_version: String,
    pub current_commit: String,
    pub current_source: String,
    pub available_version: Option<String>,
    pub pending_version: Option<String>,
    pub channel: String,
    pub mode: String,
    pub pinned_version: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub message: String,
}
