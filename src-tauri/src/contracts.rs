use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub phase: RuntimePhase,
    pub url: Option<String>,
    pub workspace: Option<String>,
    pub restart_count: u8,
    pub diagnostic_id: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RuntimePhase {
    #[default]
    Idle,
    Starting,
    Ready,
    Stopping,
    Recovering,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    #[serde(default = "current_settings_schema_version")]
    pub schema_version: u8,
    pub locale: String,
    pub workspace: Option<String>,
    pub onboarding_completed: bool,
    pub update_channel: String,
    pub update_enabled: bool,
    #[serde(default = "default_runtime_update_channel")]
    pub runtime_update_channel: String,
    #[serde(default = "default_runtime_update_mode")]
    pub runtime_update_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_pinned_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_reason: Option<String>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            schema_version: current_settings_schema_version(),
            locale: "zh-CN".to_owned(),
            workspace: None,
            onboarding_completed: false,
            update_channel: "community".to_owned(),
            update_enabled: false,
            runtime_update_channel: default_runtime_update_channel(),
            runtime_update_mode: default_runtime_update_mode(),
            runtime_pinned_version: None,
            recovery_reason: None,
        }
    }
}

pub const fn current_settings_schema_version() -> u8 {
    2
}

fn default_runtime_update_channel() -> String {
    env!("DEEPSEEK_DESKTOP_RUNTIME_UPDATE_CHANNEL").to_owned()
}

fn default_runtime_update_mode() -> String {
    if env!("DEEPSEEK_DESKTOP_RUNTIME_AUTO_UPDATE") == "true" {
        "automatic".to_owned()
    } else {
        "notify".to_owned()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAbout {
    pub desktop_version: String,
    pub runtime_version: String,
    pub runtime_commit: String,
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
    pub message: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeUpdatePhase {
    Disabled,
    #[default]
    Idle,
    Checking,
    Available,
    Downloading,
    Staged,
    Applied,
    Failed,
    RolledBack,
    Pinned,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateStatus {
    pub enabled: bool,
    pub phase: RuntimeUpdatePhase,
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
