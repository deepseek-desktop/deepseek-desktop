use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DesktopError {
    #[error("harness is already changing state")]
    HarnessBusy,
    #[error("harness artifact is missing: {0}")]
    HarnessArtifactMissing(String),
    #[error("harness exited before readiness: {0}")]
    HarnessExited(String),
    #[error("harness failed its startup checks: {0}")]
    HarnessBootFailed(String),
    #[error("harness startup was rejected by the desktop environment: {0}")]
    HarnessStartRejected(String),
    #[error("harness is not ready")]
    HarnessNotReady,
    #[error("Harness repository command timed out")]
    RepositoryCommandTimedOut,
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
    pub fn permits_harness_rollback(&self) -> bool {
        matches!(
            self,
            Self::HarnessArtifactMissing(_) | Self::HarnessExited(_) | Self::HarnessBootFailed(_)
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
