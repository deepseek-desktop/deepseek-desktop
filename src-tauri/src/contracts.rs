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
            recovery_reason: None,
        }
    }
}

pub const fn current_settings_schema_version() -> u8 {
    1
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAbout {
    pub desktop_version: &'static str,
    pub runtime_version: &'static str,
    pub runtime_commit: &'static str,
    pub node_version: &'static str,
    pub authors: &'static str,
    pub repository: &'static str,
    pub channel: &'static str,
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
