use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DesktopError {
    #[error("runtime is already changing state")]
    RuntimeBusy,
    #[error("workspace does not exist or is not a directory: {0}")]
    InvalidWorkspace(String),
    #[error("runtime artifact is missing: {0}")]
    RuntimeArtifactMissing(String),
    #[error("runtime exited before readiness: {0}")]
    RuntimeExited(String),
    #[error("runtime is not ready")]
    RuntimeNotReady,
    #[error("configuration is invalid: {0}")]
    InvalidConfiguration(String),
    #[error("credential vault operation failed: {0}")]
    CredentialVault(String),
    #[error("I/O operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON operation failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("desktop operation failed: {0}")]
    Other(String),
}

impl Serialize for DesktopError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type DesktopResult<T> = Result<T, DesktopError>;
