use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DesktopError {
    #[error("runtime is already changing state")]
    RuntimeBusy,
    #[error("runtime artifact is missing: {0}")]
    RuntimeArtifactMissing(String),
    #[error("runtime exited before readiness: {0}")]
    RuntimeExited(String),
    #[error("runtime failed its startup checks: {0}")]
    RuntimeBootFailed(String),
    #[error("runtime startup was rejected by the desktop environment: {0}")]
    RuntimeStartRejected(String),
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

impl DesktopError {
    pub fn permits_runtime_rollback(&self) -> bool {
        matches!(
            self,
            Self::RuntimeArtifactMissing(_) | Self::RuntimeExited(_) | Self::RuntimeBootFailed(_)
        )
    }
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
