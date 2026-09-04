use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, Once};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use flate2::read::GzDecoder;
use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;
use uuid::Uuid;

use crate::contracts::{DesktopSettings, HarnessUpdatePhase, HarnessUpdateStatus};
use crate::diagnostics::Diagnostics;
use crate::error::{DesktopError, DesktopResult};
use crate::settings::{AppPaths, SettingsStore, write_json_atomic};

const MANIFEST_LIMIT: u64 = 1024 * 1024;
const ARCHIVE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const EXTRACTED_LIMIT: u64 = 4 * 1024 * 1024 * 1024;
const ENTRY_LIMIT: usize = 100_000;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// The signed manifest is capped at `MANIFEST_LIMIT`, so it must not inherit the
/// multi-gigabyte artifact budget: a stalled update host would otherwise hold the
/// update operation lock — and block the user's own actions — for twenty minutes.
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);
const SMOKE_TIMEOUT: Duration = Duration::from_secs(30);
const REPOSITORY_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const REPOSITORY_COMMAND_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const MANIFEST_CLOCK_SKEW: chrono::TimeDelta = chrono::TimeDelta::minutes(15);

#[derive(Clone, Debug)]
pub struct HarnessLocation {
    pub harness_dir: PathBuf,
    pub node: PathBuf,
    pub entry: String,
    pub version: String,
    pub commit: String,
    pub source: String,
}

#[derive(Clone, Debug)]
pub struct HarnessStore {
    root: PathBuf,
    versions: PathBuf,
    current: PathBuf,
    previous: PathBuf,
    pending: PathBuf,
    bundled: HarnessLocation,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct HarnessPointer {
    schema_version: u8,
    directory: String,
    harness_version: String,
    harness_commit: String,
    target: String,
    entry: String,
    node_file: String,
    node_version: String,
    node_module_abi: String,
    harness_protocol_version: u32,
    credential_protocol_version: u32,
    credential_provider_version: String,
    market_version: String,
    artifact_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignedManifestEnvelope {
    schema_version: u8,
    signed_payload: String,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessReleaseManifest {
    schema_version: u8,
    publisher: String,
    issued_at: String,
    expires_at: String,
    harness_version: String,
    channel: String,
    desktop_protocol_version: u32,
    harness_protocol_version: u32,
    credential_protocol_version: u32,
    minimum_desktop_version: String,
    maximum_desktop_version: String,
    harness_commit: String,
    harness_repository: String,
    desktop_commit: String,
    credential_provider_version: String,
    market_version: String,
    node_version: String,
    node_module_abi: String,
    #[serde(default)]
    allowed_origins: Vec<String>,
    artifacts: HashMap<String, HarnessArtifact>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptedManifest {
    schema_version: u8,
    channel: String,
    issued_at: String,
    harness_version: String,
    harness_commit: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessArtifact {
    url: String,
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessPackageMetadata {
    schema_version: u8,
    target: String,
    harness_version: String,
    harness_commit: String,
    entry: String,
    node_file: String,
    node_version: String,
    node_module_abi: String,
    harness_protocol_version: u32,
    credential_protocol_version: u32,
    credential_provider_version: String,
    market_version: String,
}

#[derive(Clone, Debug)]
struct VerifiedRelease {
    manifest_url: Url,
    source_fingerprint: [u8; 32],
    payload: HarnessReleaseManifest,
    artifact: HarnessArtifact,
}

#[derive(Clone, Debug)]
struct RepositoryRelease {
    source_fingerprint: [u8; 32],
    repository: String,
    commit: String,
}

#[derive(Clone, Debug)]
enum AvailableHarness {
    Manifest(Box<VerifiedRelease>),
    Repository(RepositoryRelease),
}

impl AvailableHarness {
    fn source_fingerprint(&self) -> [u8; 32] {
        match self {
            Self::Manifest(release) => release.source_fingerprint,
            Self::Repository(release) => release.source_fingerprint,
        }
    }

    fn available_version(&self) -> String {
        match self {
            Self::Manifest(release) => release.payload.harness_version.clone(),
            Self::Repository(release) => format!("commit {}", &release.commit[..12]),
        }
    }

    fn matches_channel(&self, channel: &str) -> bool {
        match self {
            Self::Manifest(release) => release.payload.channel == channel,
            Self::Repository(_) => true,
        }
    }

    fn total_bytes(&self) -> Option<u64> {
        match self {
            Self::Manifest(release) => Some(release.artifact.size),
            Self::Repository(_) => None,
        }
    }
}

#[derive(Clone, Debug)]
struct HarnessUpdateConfig {
    manifest_url: Option<Url>,
    publisher: String,
    public_key: Option<VerifyingKey>,
    desktop_version: Version,
    target: String,
    harness_repository: String,
    desktop_protocol_version: u32,
    harness_protocol_version: u32,
    credential_protocol_version: u32,
}

pub struct HarnessUpdateManager {
    app: AppHandle,
    settings: Arc<SettingsStore>,
    diagnostics: Arc<Diagnostics>,
    store: Arc<HarnessStore>,
    config: HarnessUpdateConfig,
    status: Mutex<HarnessUpdateStatus>,
    available: Mutex<Option<AvailableHarness>>,
    operation: Mutex<()>,
    startup_activation: Once,
}

impl HarnessStore {
    pub fn resolve(app: &AppHandle, paths: &AppPaths) -> DesktopResult<Arc<Self>> {
        let root = paths.updates_dir.join("harness");
        let versions = root.join("versions");
        fs::create_dir_all(&versions)?;
        let store = Arc::new(Self {
            current: root.join("current.json"),
            previous: root.join("previous.json"),
            pending: root.join("pending.json"),
            bundled: bundled_location(app)?,
            versions,
            root,
        });
        store.cleanup_staging()?;
        store.prune_versions()?;
        Ok(store)
    }

    pub fn location(&self) -> DesktopResult<HarnessLocation> {
        match read_pointer(&self.current)? {
            Some(pointer) => self.location_for_pointer(&pointer),
            None => Ok(self.bundled.clone()),
        }
    }

    fn location_for_pointer(&self, pointer: &HarnessPointer) -> DesktopResult<HarnessLocation> {
        validate_pointer(pointer)?;
        let root = self.versions.join(&pointer.directory);
        let harness_dir = root.join("harness");
        let node = root.join(&pointer.node_file);
        let entry = harness_dir.join(&pointer.entry);
        if !harness_dir.is_dir() || !node.is_file() || !entry.is_file() {
            return Err(DesktopError::HarnessArtifactMissing(
                "installed Harness is incomplete".to_owned(),
            ));
        }
        Ok(HarnessLocation {
            harness_dir,
            node,
            entry: pointer.entry.clone(),
            version: pointer.harness_version.clone(),
            commit: pointer.harness_commit.clone(),
            source: "updated".to_owned(),
        })
    }

    fn activate_pending(&self) -> DesktopResult<Option<HarnessPointer>> {
        let Some(pointer) = read_pointer(&self.pending)? else {
            return Ok(None);
        };
        let location = self.location_for_pointer(&pointer)?;
        smoke_candidate(&location, &pointer)?;
        if let Some(current) = read_pointer(&self.current)? {
            write_json_atomic(&self.previous, &current)?;
        } else if self.previous.exists() {
            fs::remove_file(&self.previous)?;
        }
        write_json_atomic(&self.current, &pointer)?;
        fs::remove_file(&self.pending)?;
        self.prune_versions()?;
        Ok(Some(pointer))
    }

    fn rollback(&self) -> DesktopResult<bool> {
        if !self.current.exists() {
            return Ok(false);
        }
        match read_pointer(&self.previous) {
            Ok(Some(previous)) if self.location_for_pointer(&previous).is_ok() => {
                write_json_atomic(&self.current, &previous)?;
                fs::remove_file(&self.previous)?;
            }
            Ok(Some(_)) | Ok(None) | Err(_) => {
                fs::remove_file(&self.current)?;
                if self.previous.exists() {
                    fs::remove_file(&self.previous)?;
                }
            }
        }
        self.prune_versions()?;
        Ok(true)
    }

    fn restore_bundled(&self) -> DesktopResult<()> {
        if self.current.exists() {
            match read_pointer(&self.current) {
                Ok(Some(current)) => write_json_atomic(&self.previous, &current)?,
                Ok(None) => {}
                Err(_) => {
                    if self.previous.exists() {
                        fs::remove_file(&self.previous)?;
                    }
                }
            }
            fs::remove_file(&self.current)?;
        }
        if self.pending.exists() {
            fs::remove_file(&self.pending)?;
        }
        self.prune_versions()?;
        Ok(())
    }

    fn discard_pending(&self) -> DesktopResult<()> {
        if self.pending.exists() {
            fs::remove_file(&self.pending)?;
        }
        self.prune_versions()
    }

    fn cleanup_staging(&self) -> DesktopResult<()> {
        let staging = self.root.join("staging");
        if staging.exists() {
            fs::remove_dir_all(&staging)?;
        }
        fs::create_dir_all(staging)?;
        Ok(())
    }

    fn prune_versions(&self) -> DesktopResult<()> {
        let mut retained = HashSet::new();
        for pointer_path in [&self.current, &self.previous, &self.pending] {
            if let Ok(Some(pointer)) = read_pointer(pointer_path)
                && validate_pointer(&pointer).is_ok()
            {
                retained.insert(pointer.directory);
            }
        }
        for entry in fs::read_dir(&self.versions)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir()
                && !retained.contains(entry.file_name().to_string_lossy().as_ref())
            {
                fs::remove_dir_all(path)?;
            }
        }
        Ok(())
    }

    fn accepted_manifest_path(&self, channel: &str) -> PathBuf {
        self.root.join(format!("accepted-{channel}.json"))
    }

    /// Read-only half of the replay and downgrade gate. `check` runs it so a
    /// replayed manifest never reaches a download, while the acceptance itself is
    /// only recorded once an artifact has actually been staged — a manifest that
    /// was merely looked at must not permanently bind the channel to its commit.
    fn verify_manifest_acceptance(&self, payload: &HarnessReleaseManifest) -> DesktopResult<()> {
        let path = self.accepted_manifest_path(&payload.channel);
        let candidate_version = Version::parse(&payload.harness_version).map_err(|error| {
            DesktopError::InvalidConfiguration(format!("Harness version is invalid: {error}"))
        })?;
        if let Ok(bytes) = fs::read(&path) {
            let previous: AcceptedManifest = serde_json::from_slice(&bytes)?;
            if previous.schema_version != 1 || previous.channel != payload.channel {
                return Err(DesktopError::InvalidConfiguration(
                    "accepted Harness manifest history is invalid".to_owned(),
                ));
            }
            let previous_version = Version::parse(&previous.harness_version).map_err(|error| {
                DesktopError::InvalidConfiguration(format!(
                    "accepted Harness version is invalid: {error}"
                ))
            })?;
            let previous_issued = chrono::DateTime::parse_from_rfc3339(&previous.issued_at)
                .map_err(|error| {
                    DesktopError::InvalidConfiguration(format!(
                        "accepted Harness manifest issue time is invalid: {error}"
                    ))
                })?;
            let candidate_issued = chrono::DateTime::parse_from_rfc3339(&payload.issued_at)
                .map_err(|error| {
                    DesktopError::InvalidConfiguration(format!(
                        "Harness manifest issue time is invalid: {error}"
                    ))
                })?;
            if candidate_version < previous_version || candidate_issued < previous_issued {
                return Err(DesktopError::InvalidConfiguration(
                    "Harness manifest replay or downgrade was rejected".to_owned(),
                ));
            }
            if candidate_version == previous_version
                && payload.harness_commit != previous.harness_commit
            {
                return Err(DesktopError::InvalidConfiguration(
                    "Harness manifest cannot replace an accepted version with another commit"
                        .to_owned(),
                ));
            }
        }
        Ok(())
    }

    fn record_manifest_acceptance(&self, payload: &HarnessReleaseManifest) -> DesktopResult<()> {
        self.verify_manifest_acceptance(payload)?;
        write_json_atomic(
            &self.accepted_manifest_path(&payload.channel),
            &AcceptedManifest {
                schema_version: 1,
                channel: payload.channel.clone(),
                issued_at: payload.issued_at.clone(),
                harness_version: payload.harness_version.clone(),
                harness_commit: payload.harness_commit.clone(),
            },
        )
    }

    /// Restoring the bundled baseline is the operator's recovery path, so it also
    /// forgets the accepted history: a withdrawn release that has to be re-cut at
    /// the same version with a different commit stays installable.
    fn clear_accepted_manifests(&self) -> DesktopResult<()> {
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("accepted-")
                && name.ends_with(".json")
                && entry.file_type()?.is_file()
            {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
}

impl HarnessUpdateManager {
    pub fn new(
        app: AppHandle,
        settings: Arc<SettingsStore>,
        diagnostics: Arc<Diagnostics>,
        store: Arc<HarnessStore>,
    ) -> DesktopResult<Arc<Self>> {
        let config = HarnessUpdateConfig::from_build()?;
        let current = store.location().unwrap_or_else(|_| store.bundled.clone());
        let saved = settings.get()?;
        let enabled = config.resolved_for(&saved)?.is_enabled();
        Ok(Arc::new(Self {
            app,
            settings,
            diagnostics,
            store,
            status: Mutex::new(HarnessUpdateStatus {
                enabled,
                phase: if enabled {
                    HarnessUpdatePhase::Idle
                } else {
                    HarnessUpdatePhase::Disabled
                },
                current_version: current.version,
                current_commit: current.commit,
                current_source: current.source,
                channel: saved.harness_update_channel,
                mode: saved.harness_update_mode,
                pinned_version: saved.harness_pinned_version,
                message: if enabled { "idle" } else { "not-configured" }.to_owned(),
                ..HarnessUpdateStatus::default()
            }),
            available: Mutex::new(None),
            operation: Mutex::new(()),
            startup_activation: Once::new(),
            config,
        }))
    }

    pub fn status(&self) -> DesktopResult<HarnessUpdateStatus> {
        let settings = self.settings.get()?;
        let config = self.config.resolved_for(&settings)?;
        let source_fingerprint = config.source_fingerprint();
        let enabled = config.is_enabled();
        let location = self
            .store
            .location()
            .unwrap_or_else(|_| self.store.bundled.clone());
        let mut status = self.lock_status()?.clone();
        let stale_available = {
            let mut available = self.lock_available()?;
            let stale = available.as_ref().is_some_and(|release| {
                !release.matches_channel(&settings.harness_update_channel)
                    || release.source_fingerprint() != source_fingerprint
                    || settings.harness_pinned_version.is_some()
            });
            if stale {
                *available = None;
            }
            stale
        };
        status.current_version = location.version;
        status.current_commit = location.commit;
        status.current_source = location.source;
        status.enabled = enabled;
        status.channel = settings.harness_update_channel;
        status.mode = settings.harness_update_mode;
        status.pinned_version = settings.harness_pinned_version;
        if status.pinned_version.is_some() {
            status.phase = HarnessUpdatePhase::Pinned;
            status.message = "pinned".to_owned();
            status.available_version = None;
        } else if !enabled {
            status.phase = HarnessUpdatePhase::Disabled;
            status.message = "not-configured".to_owned();
            status.available_version = None;
        } else if stale_available
            || matches!(
                status.phase,
                HarnessUpdatePhase::Pinned | HarnessUpdatePhase::Disabled
            )
        {
            status.phase = HarnessUpdatePhase::Idle;
            status.message = "idle".to_owned();
            status.available_version = None;
        }
        Ok(status)
    }

    pub fn save_settings(&self, settings: DesktopSettings) -> DesktopResult<DesktopSettings> {
        let settings = SettingsStore::validated(settings)?;
        let previous = self.settings.get()?;
        if previous.harness_update_repository == settings.harness_update_repository {
            return self.settings.update(settings);
        }

        let _operation = self.lock_operation()?;
        self.store.discard_pending()?;
        *self.lock_available()? = None;
        let settings = self.settings.update(settings)?;
        self.set_status(repository_changed_status(self.status()?))?;
        self.diagnostics
            .append("harness-update", "Harness repository selection changed");
        Ok(settings)
    }

    fn apply_pending_on_startup(&self) -> DesktopResult<HarnessUpdateStatus> {
        let _operation = self.lock_operation()?;
        let settings = self.settings.get()?;
        if settings.harness_pinned_version.is_some() {
            return self.publish(HarnessUpdatePhase::Pinned, "pinned");
        }
        // A pending pointer that cannot be read still has to reach activate_pending:
        // that is the branch which quarantines it, so it does not fail every launch.
        if matches!(read_pointer(&self.store.pending), Ok(None)) {
            return self.status();
        }
        self.publish(HarnessUpdatePhase::Applying, "applying")?;
        match self.store.activate_pending() {
            Ok(Some(pointer)) => {
                self.diagnostics.append(
                    "harness-update",
                    &format!(
                        "activated Harness {} ({})",
                        pointer.harness_version, pointer.harness_commit
                    ),
                );
                self.publish(HarnessUpdatePhase::Applied, "applied")
            }
            Ok(None) => self.status(),
            Err(error) => {
                self.diagnostics.append(
                    "harness-update",
                    &format!("pending Harness rejected: {error}"),
                );
                if self.store.pending.exists() {
                    let _ = fs::remove_file(&self.store.pending);
                }
                let _ = self.store.prune_versions();
                self.publish(HarnessUpdatePhase::Failed, "smoke-failed")
            }
        }
    }

    pub fn recover_invalid_current(&self) -> DesktopResult<HarnessUpdateStatus> {
        let _operation = self.lock_operation()?;
        if let Err(error) = self.store.location() {
            self.diagnostics.append(
                "harness-update",
                &format!("installed Harness pointer rejected; restoring bundled baseline: {error}"),
            );
            self.store.restore_bundled()?;
            return self.publish(HarnessUpdatePhase::RolledBack, "bundled-restored");
        }
        self.status()
    }

    pub fn check(&self) -> DesktopResult<HarnessUpdateStatus> {
        let _operation = self.lock_operation()?;
        *self.lock_available()? = None;
        let settings = self.settings.get()?;
        if settings.harness_pinned_version.is_some() {
            return self.publish(HarnessUpdatePhase::Pinned, "pinned");
        }
        if !self.status()?.enabled {
            return self.publish(HarnessUpdatePhase::Disabled, "not-configured");
        }
        let config = self.config.resolved_for(&settings)?;
        self.publish(HarnessUpdatePhase::Checking, "checking")?;
        if config.uses_repository() {
            let repository = config.harness_repository.clone();
            let commit = match repository_head(&repository) {
                Ok(commit) => commit,
                Err(error) => {
                    self.diagnostics.append(
                        "harness-update",
                        &format!("repository update check failed: {error}"),
                    );
                    self.publish(HarnessUpdatePhase::Failed, repository_check_failure(&error))?;
                    return Err(error);
                }
            };
            if commit == self.status()?.current_commit {
                return self.publish(HarnessUpdatePhase::Idle, "up-to-date");
            }
            let release = AvailableHarness::Repository(RepositoryRelease {
                source_fingerprint: config.source_fingerprint(),
                repository,
                commit,
            });
            let version = release.available_version();
            *self.lock_available()? = Some(release);
            let mut status = self.publish(HarnessUpdatePhase::Available, "available")?;
            status.available_version = Some(version);
            return self.set_status(status);
        }
        let release = match self.fetch_release(&settings.harness_update_channel, &config) {
            Ok(release) => release,
            Err(error) => {
                self.diagnostics
                    .append("harness-update", &format!("update check failed: {error}"));
                self.publish(HarnessUpdatePhase::Failed, "check-failed")?;
                return Err(error);
            }
        };
        let current = Version::parse(&self.status()?.current_version).map_err(|error| {
            DesktopError::InvalidConfiguration(format!(
                "current Harness version is invalid: {error}"
            ))
        })?;
        let candidate = Version::parse(&release.payload.harness_version).map_err(|error| {
            DesktopError::InvalidConfiguration(format!(
                "candidate Harness version is invalid: {error}"
            ))
        })?;
        if candidate <= current {
            *self.lock_available()? = None;
            return self.publish(HarnessUpdatePhase::Idle, "up-to-date");
        }
        let version = release.payload.harness_version.clone();
        *self.lock_available()? = Some(AvailableHarness::Manifest(Box::new(release)));
        let mut status = self.publish(HarnessUpdatePhase::Available, "available")?;
        status.available_version = Some(version);
        self.set_status(status)
    }

    pub fn download(&self) -> DesktopResult<HarnessUpdateStatus> {
        let _operation = self.lock_operation()?;
        let settings = self.settings.get()?;
        if settings.harness_pinned_version.is_some() {
            return self.publish(HarnessUpdatePhase::Pinned, "pinned");
        }
        let config = self.config.resolved_for(&settings)?;
        let release = self.lock_available()?.clone().ok_or_else(|| {
            DesktopError::InvalidConfiguration("check for a Harness update first".to_owned())
        })?;
        if !release.matches_channel(&settings.harness_update_channel) {
            *self.lock_available()? = None;
            return Err(DesktopError::InvalidConfiguration(
                "Harness update channel changed; check for updates again".to_owned(),
            ));
        }
        if release.source_fingerprint() != config.source_fingerprint() {
            *self.lock_available()? = None;
            return Err(DesktopError::InvalidConfiguration(
                "Harness update source changed; check for updates again".to_owned(),
            ));
        }
        let mut status = self.publish(
            HarnessUpdatePhase::Downloading,
            match &release {
                AvailableHarness::Manifest(_) => "downloading",
                AvailableHarness::Repository(_) => "preparing-repository",
            },
        )?;
        status.available_version = Some(release.available_version());
        status.total_bytes = release.total_bytes();
        self.set_status(status)?;
        let prepared = match &release {
            AvailableHarness::Manifest(release) => self.download_release(release),
            AvailableHarness::Repository(release) => self.prepare_repository_harness(release),
        };
        let pointer = match prepared {
            Ok(pointer) => pointer,
            Err(error) => {
                self.diagnostics.append(
                    "harness-update",
                    &format!("Harness preparation rejected: {error}"),
                );
                self.publish(HarnessUpdatePhase::Failed, "download-failed")?;
                return Err(error);
            }
        };
        let stage = match &release {
            AvailableHarness::Manifest(release) => self
                .store
                .record_manifest_acceptance(&release.payload)
                .and_then(|()| write_json_atomic(&self.store.pending, &pointer)),
            AvailableHarness::Repository(_) => write_json_atomic(&self.store.pending, &pointer),
        };
        if let Err(error) = stage {
            let _ = self.store.prune_versions();
            self.publish(HarnessUpdatePhase::Failed, "download-failed")?;
            return Err(error);
        }
        self.store.prune_versions()?;
        let mut status = self.publish(HarnessUpdatePhase::Staged, "restart-to-apply")?;
        status.available_version = Some(pointer.harness_version.clone());
        status.pending_version = Some(pointer.harness_version);
        status.downloaded_bytes = release.total_bytes().unwrap_or_default();
        status.total_bytes = release.total_bytes();
        self.set_status(status)
    }

    pub fn restore_bundled(&self) -> DesktopResult<HarnessUpdateStatus> {
        let _operation = self.lock_operation()?;
        self.store.restore_bundled()?;
        self.store.clear_accepted_manifests()?;
        *self.lock_available()? = None;
        self.diagnostics
            .append("harness-update", "restored bundled Harness baseline");
        self.publish(HarnessUpdatePhase::RolledBack, "bundled-restored")
    }

    /// Waits for the update operation lock instead of failing fast: an automatic
    /// check or download can hold it for minutes, and skipping the rollback would
    /// strand the user on a Harness that cannot boot.
    pub fn rollback_after_start_failure(&self) -> bool {
        let _operation = self
            .operation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match self.rollback_after_start_failure_locked() {
            Ok(rolled_back) => rolled_back,
            Err(error) => {
                self.diagnostics.append(
                    "harness-update",
                    &format!("Harness rollback after startup failure failed: {error}"),
                );
                false
            }
        }
    }

    fn rollback_after_start_failure_locked(&self) -> DesktopResult<bool> {
        let rolled_back = self.store.rollback()?;
        if rolled_back {
            self.diagnostics.append(
                "harness-update",
                "rolled back Harness after startup failure",
            );
            self.publish(HarnessUpdatePhase::RolledBack, "startup-rollback")?;
        }
        Ok(rolled_back)
    }

    /// Applying a staged Harness runs the full candidate smoke — three child
    /// processes plus a real local service boot — so it must never sit on the
    /// thread that drives the window. The automatic check follows in the same
    /// thread because both contend for the update operation lock.
    pub fn start_startup_maintenance(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        thread::spawn(move || {
            manager.ensure_startup_activation();
            manager.check_automatically();
        });
    }

    pub fn ensure_startup_activation(&self) {
        // Both startup paths may arrive first. Neither may spawn an old core
        // while the pending candidate is still being verified and activated.
        self.startup_activation.call_once(|| {
            if let Err(error) = self.apply_pending_on_startup() {
                self.diagnostics.append(
                    "harness-update",
                    &format!("startup Harness activation failed: {error}"),
                );
            }
        });
    }

    fn check_automatically(&self) {
        let settings = match self.settings.get() {
            Ok(settings) => settings,
            Err(_) => return,
        };
        if settings.harness_update_mode == "manual" || settings.harness_pinned_version.is_some() {
            return;
        }
        if self.check().is_ok()
            && self.settings.get().is_ok_and(|current| {
                current.harness_update_mode == "automatic"
                    && current.harness_pinned_version.is_none()
            })
        {
            let _ = self.download();
        }
    }

    fn fetch_release(
        &self,
        channel: &str,
        config: &HarnessUpdateConfig,
    ) -> DesktopResult<VerifiedRelease> {
        let manifest_url = config.manifest_url.clone().ok_or_else(|| {
            DesktopError::InvalidConfiguration(
                "Harness update manifest is not configured".to_owned(),
            )
        })?;
        let bytes = read_url_limited(&manifest_url, MANIFEST_LIMIT, None)?;
        let payload = verify_manifest(&bytes, config, channel)?;
        let artifact = payload
            .artifacts
            .get(&config.target)
            .cloned()
            .ok_or_else(|| {
                DesktopError::InvalidConfiguration(
                    "Harness manifest has no artifact for this platform".to_owned(),
                )
            })?;
        validate_sha256(&artifact.sha256)?;
        if artifact.size == 0 || artifact.size > ARCHIVE_LIMIT {
            return Err(DesktopError::InvalidConfiguration(
                "Harness artifact size is outside the allowed range".to_owned(),
            ));
        }
        validate_artifact_url(&manifest_url, &artifact.url, &payload.allowed_origins)?;
        self.store.verify_manifest_acceptance(&payload)?;
        Ok(VerifiedRelease {
            manifest_url,
            source_fingerprint: config.source_fingerprint(),
            payload,
            artifact,
        })
    }

    fn download_release(&self, release: &VerifiedRelease) -> DesktopResult<HarnessPointer> {
        let staging = self.store.root.join("staging");
        fs::create_dir_all(&staging)?;
        let token = Uuid::new_v4().to_string();
        let archive = staging.join(format!("{token}.tar.gz"));
        let extracted = staging.join(format!("{token}.unpacked"));
        let artifact_url = release
            .manifest_url
            .join(&release.artifact.url)
            .map_err(|error| DesktopError::InvalidConfiguration(error.to_string()))?;
        let result = (|| {
            download_verified(
                &artifact_url,
                &archive,
                release.artifact.size,
                &release.artifact.sha256,
            )?;
            secure_extract(&archive, &extracted)?;
            fs::remove_file(&archive)?;
            let metadata: HarnessPackageMetadata =
                serde_json::from_slice(&fs::read(extracted.join("harness-package.json"))?)?;
            validate_package_metadata(&metadata, &release.payload)?;
            let pointer = HarnessPointer {
                schema_version: 1,
                directory: version_directory(&metadata.harness_version, &metadata.harness_commit)?,
                harness_version: metadata.harness_version,
                harness_commit: metadata.harness_commit,
                target: metadata.target,
                entry: metadata.entry,
                node_file: metadata.node_file,
                node_version: metadata.node_version,
                node_module_abi: metadata.node_module_abi,
                harness_protocol_version: metadata.harness_protocol_version,
                credential_protocol_version: metadata.credential_protocol_version,
                credential_provider_version: metadata.credential_provider_version,
                market_version: metadata.market_version,
                artifact_sha256: release.artifact.sha256.clone(),
            };
            let candidate = HarnessLocation {
                harness_dir: extracted.join("harness"),
                node: extracted.join(&pointer.node_file),
                entry: pointer.entry.clone(),
                version: pointer.harness_version.clone(),
                commit: pointer.harness_commit.clone(),
                source: "updated".to_owned(),
            };
            validate_harness_files(&candidate, &pointer)?;
            let destination = self.store.versions.join(&pointer.directory);
            if destination.exists() {
                fs::remove_dir_all(&destination)?;
            }
            fs::rename(&extracted, destination)?;
            Ok(pointer)
        })();
        if archive.exists() {
            let _ = fs::remove_file(&archive);
        }
        if extracted.exists() {
            let _ = fs::remove_dir_all(&extracted);
        }
        result
    }

    fn prepare_repository_harness(
        &self,
        release: &RepositoryRelease,
    ) -> DesktopResult<HarnessPointer> {
        let staging = self
            .store
            .root
            .join("staging")
            .join(format!("repository-{}", Uuid::new_v4()));
        let source = staging.join("source");
        let candidate = staging.join("candidate");
        fs::create_dir_all(&staging)?;
        let result = (|| {
            let source_path = source.to_string_lossy().into_owned();
            run_repository_command(
                Path::new("git"),
                &["clone", "--depth", "1", &release.repository, &source_path],
                None,
                REPOSITORY_COMMAND_TIMEOUT,
                None,
                false,
                Some(&release.repository),
            )?;
            let commit = run_repository_command(
                Path::new("git"),
                &["rev-parse", "HEAD"],
                Some(&source),
                SMOKE_TIMEOUT,
                None,
                true,
                None,
            )?;
            if commit.trim() != release.commit {
                return Err(DesktopError::InvalidConfiguration(
                    "Harness repository changed; check for updates again".to_owned(),
                ));
            }

            let current = self.store.location()?;
            let pnpm_cli = current.harness_dir.join("node_modules/pnpm/bin/pnpm.cjs");
            if !pnpm_cli.is_file() {
                return Err(DesktopError::HarnessArtifactMissing(
                    pnpm_cli.display().to_string(),
                ));
            }
            let tools = staging.join("tools");
            prepare_repository_tool_wrappers(&tools, &current.node, &pnpm_cli)?;
            let harness_dir = candidate.join("harness");
            fs::create_dir_all(&candidate)?;
            let prepared =
                deploy_repository_harness(&staging, &source, &harness_dir, &current, &tools)?;
            let harness_version = prepared.version;

            let node_file = if cfg!(windows) { "node.exe" } else { "node" };
            let staged_node = candidate.join(node_file);
            fs::copy(&current.node, &staged_node)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&staged_node, fs::Permissions::from_mode(0o700))?;
            }
            let node_version = run_smoke_command(&staged_node, &["--version"], None)?
                .trim()
                .trim_start_matches('v')
                .to_owned();
            let node_module_abi =
                run_smoke_command(&staged_node, &["-p", "process.versions.modules"], None)?
                    .trim()
                    .to_owned();
            let credential_provider_version = read_package_version(
                &harness_dir.join("node_modules/deepseek-desktop-credentials-vault/package.json"),
            )?;
            let market_version =
                read_package_version(&harness_dir.join("node_modules/dshmarket/package.json"))?;
            let directory = version_directory(&harness_version, &release.commit)?;
            let mut identity = Sha256::new();
            identity.update(release.repository.as_bytes());
            identity.update([0]);
            identity.update(release.commit.as_bytes());
            let pointer = HarnessPointer {
                schema_version: 1,
                directory: directory.clone(),
                harness_version,
                harness_commit: release.commit.clone(),
                target: env!("DEEPSEEK_DESKTOP_TARGET").to_owned(),
                entry: prepared.entry,
                node_file: node_file.to_owned(),
                node_version,
                node_module_abi,
                harness_protocol_version: self.config.harness_protocol_version,
                credential_protocol_version: self.config.credential_protocol_version,
                credential_provider_version,
                market_version,
                artifact_sha256: format!("{:x}", identity.finalize()),
            };
            let location = HarnessLocation {
                harness_dir,
                node: staged_node,
                entry: pointer.entry.clone(),
                version: pointer.harness_version.clone(),
                commit: pointer.harness_commit.clone(),
                source: "updated".to_owned(),
            };
            smoke_candidate(&location, &pointer)?;
            let destination = self.store.versions.join(&directory);
            if destination.exists() {
                fs::remove_dir_all(&destination)?;
            }
            fs::rename(&candidate, destination)?;
            Ok(pointer)
        })();
        if staging.exists() {
            let _ = fs::remove_dir_all(staging);
        }
        result
    }

    fn publish(
        &self,
        phase: HarnessUpdatePhase,
        message: &str,
    ) -> DesktopResult<HarnessUpdateStatus> {
        let mut status = self.status()?;
        status.phase = phase;
        status.message = message.to_owned();
        status.downloaded_bytes = 0;
        status.total_bytes = None;
        status.available_version = self
            .lock_available()?
            .as_ref()
            .map(AvailableHarness::available_version);
        status.pending_version =
            read_pointer(&self.store.pending)?.map(|pointer| pointer.harness_version);
        self.set_status(status)
    }

    fn set_status(&self, status: HarnessUpdateStatus) -> DesktopResult<HarnessUpdateStatus> {
        *self.lock_status()? = status.clone();
        let _ = self.app.emit("harness-update://status", &status);
        Ok(status)
    }

    fn lock_status(&self) -> DesktopResult<MutexGuard<'_, HarnessUpdateStatus>> {
        self.status
            .lock()
            .map_err(|_| DesktopError::Other("Harness update status lock is poisoned".to_owned()))
    }

    fn lock_available(&self) -> DesktopResult<MutexGuard<'_, Option<AvailableHarness>>> {
        self.available
            .lock()
            .map_err(|_| DesktopError::Other("Harness update release lock is poisoned".to_owned()))
    }

    fn lock_operation(&self) -> DesktopResult<MutexGuard<'_, ()>> {
        self.operation
            .try_lock()
            .map_err(|_| DesktopError::HarnessBusy)
    }
}

impl HarnessUpdateConfig {
    fn from_build() -> DesktopResult<Self> {
        let manifest_url = match env!("DEEPSEEK_DESKTOP_HARNESS_UPDATE_MANIFEST_URL") {
            "" => None,
            value => Some(Url::parse(value).map_err(|error| {
                DesktopError::InvalidConfiguration(format!(
                    "Harness update manifest URL is invalid: {error}"
                ))
            })?),
        };
        let public_key = match env!("DEEPSEEK_DESKTOP_HARNESS_UPDATE_PUBLIC_KEY") {
            "" => None,
            value => Some(parse_public_key(value)?),
        };
        Ok(Self {
            manifest_url,
            publisher: env!("DEEPSEEK_DESKTOP_HARNESS_UPDATE_PUBLISHER").to_owned(),
            public_key,
            desktop_version: Version::parse(env!("DEEPSEEK_DESKTOP_APP_VERSION")).map_err(
                |error| {
                    DesktopError::InvalidConfiguration(format!(
                        "Desktop version is invalid: {error}"
                    ))
                },
            )?,
            target: env!("DEEPSEEK_DESKTOP_TARGET").to_owned(),
            harness_repository: env!("DEEPSEEK_DESKTOP_HARNESS_REPOSITORY").to_owned(),
            desktop_protocol_version: 1,
            harness_protocol_version: env!("DEEPSEEK_DESKTOP_HARNESS_PROTOCOL_VERSION")
                .parse()
                .map_err(|_| {
                    DesktopError::InvalidConfiguration("Harness protocol is invalid".to_owned())
                })?,
            credential_protocol_version: env!("DEEPSEEK_DESKTOP_CREDENTIAL_PROTOCOL_VERSION")
                .parse()
                .map_err(|_| {
                    DesktopError::InvalidConfiguration("credential protocol is invalid".to_owned())
                })?,
        })
    }

    fn resolved_for(&self, settings: &DesktopSettings) -> DesktopResult<Self> {
        let Some(repository) = settings.harness_update_repository.as_deref() else {
            return Ok(self.clone());
        };

        let mut resolved = self.clone();
        resolved.manifest_url = None;
        resolved.publisher.clear();
        resolved.public_key = None;
        resolved.harness_repository = repository.to_owned();
        Ok(resolved)
    }

    fn is_enabled(&self) -> bool {
        !self.harness_repository.is_empty()
            && (self.manifest_url.is_none()
                || (self.public_key.is_some() && !self.publisher.is_empty()))
    }

    fn uses_repository(&self) -> bool {
        self.manifest_url.is_none() && !self.harness_repository.is_empty()
    }

    fn source_fingerprint(&self) -> [u8; 32] {
        let mut digest = Sha256::new();
        digest.update(
            self.manifest_url
                .as_ref()
                .map(Url::as_str)
                .unwrap_or_default()
                .as_bytes(),
        );
        digest.update([0]);
        digest.update(self.publisher.as_bytes());
        digest.update([0]);
        if let Some(public_key) = &self.public_key {
            digest.update(public_key.as_bytes());
        }
        digest.update([0]);
        digest.update(self.harness_repository.as_bytes());
        digest.finalize().into()
    }
}

fn bundled_location(app: &AppHandle) -> DesktopResult<HarnessLocation> {
    let harness_dir = if cfg!(debug_assertions) {
        std::env::var_os("DEEPSEEK_DESKTOP_HARNESS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../harness/staging")
                    .join(env!("DEEPSEEK_DESKTOP_TARGET"))
            })
    } else {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| DesktopError::Other(error.to_string()))?;
        node_compatible_path(&resource_dir)
            .join("harness/staging")
            .join(env!("DEEPSEEK_DESKTOP_TARGET"))
    };
    let node = bundled_node_binary()?;
    Ok(HarnessLocation {
        harness_dir,
        node,
        entry: env!("DEEPSEEK_DESKTOP_HARNESS_ENTRY").to_owned(),
        version: env!("DEEPSEEK_DESKTOP_HARNESS_VERSION").to_owned(),
        commit: env!("DEEPSEEK_DESKTOP_HARNESS_COMMIT").to_owned(),
        source: "bundled".to_owned(),
    })
}

fn bundled_node_binary() -> DesktopResult<PathBuf> {
    if cfg!(debug_assertions)
        && let Some(path) = std::env::var_os("DEEPSEEK_DESKTOP_NODE_PATH")
    {
        return Ok(PathBuf::from(path));
    }
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let sibling = std::env::current_exe()?.with_file_name(format!("node{suffix}"));
    if sibling.is_file() {
        return Ok(sibling);
    }
    if cfg!(debug_assertions) {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "node-{}{}",
                env!("DEEPSEEK_DESKTOP_TARGET"),
                suffix
            ));
        if development.is_file() {
            return Ok(development);
        }
    }
    Err(DesktopError::HarnessArtifactMissing(
        "Node sidecar".to_owned(),
    ))
}

fn verify_manifest(
    bytes: &[u8],
    config: &HarnessUpdateConfig,
    channel: &str,
) -> DesktopResult<HarnessReleaseManifest> {
    let envelope: SignedManifestEnvelope = serde_json::from_slice(bytes)?;
    if envelope.schema_version != 1 {
        return Err(DesktopError::InvalidConfiguration(
            "unsupported Harness update envelope".to_owned(),
        ));
    }
    let payload_bytes = base64::engine::general_purpose::STANDARD
        .decode(&envelope.signed_payload)
        .map_err(|error| {
            DesktopError::InvalidConfiguration(format!(
                "Harness manifest payload is invalid: {error}"
            ))
        })?;
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(&envelope.signature)
        .map_err(|error| {
            DesktopError::InvalidConfiguration(format!(
                "Harness manifest signature is invalid: {error}"
            ))
        })?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|error| {
        DesktopError::InvalidConfiguration(format!(
            "Harness manifest signature is invalid: {error}"
        ))
    })?;
    config
        .public_key
        .as_ref()
        .ok_or_else(|| {
            DesktopError::InvalidConfiguration(
                "Harness update public key is not configured".to_owned(),
            )
        })?
        .verify(&payload_bytes, &signature)
        .map_err(|_| {
            DesktopError::InvalidConfiguration(
                "Harness manifest signature verification failed".to_owned(),
            )
        })?;
    let payload: HarnessReleaseManifest = serde_json::from_slice(&payload_bytes)?;
    validate_manifest_payload(&payload, config, channel)?;
    Ok(payload)
}

fn validate_manifest_payload(
    payload: &HarnessReleaseManifest,
    config: &HarnessUpdateConfig,
    channel: &str,
) -> DesktopResult<()> {
    validate_manifest_payload_at(payload, config, channel, chrono::Utc::now())
}

fn validate_manifest_payload_at(
    payload: &HarnessReleaseManifest,
    config: &HarnessUpdateConfig,
    channel: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> DesktopResult<()> {
    if payload.schema_version != 1 || payload.publisher != config.publisher {
        return Err(DesktopError::InvalidConfiguration(
            "Harness manifest publisher is not trusted".to_owned(),
        ));
    }
    let issued_at = chrono::DateTime::parse_from_rfc3339(&payload.issued_at).map_err(|error| {
        DesktopError::InvalidConfiguration(format!(
            "Harness manifest issue time is invalid: {error}"
        ))
    })?;
    let expires_at =
        chrono::DateTime::parse_from_rfc3339(&payload.expires_at).map_err(|error| {
            DesktopError::InvalidConfiguration(format!(
                "Harness manifest expiry time is invalid: {error}"
            ))
        })?;
    if expires_at <= issued_at {
        return Err(DesktopError::InvalidConfiguration(
            "Harness manifest expiry must be later than its issue time".to_owned(),
        ));
    }
    if issued_at > now + MANIFEST_CLOCK_SKEW {
        return Err(DesktopError::InvalidConfiguration(
            "Harness manifest issue time is too far in the future".to_owned(),
        ));
    }
    if expires_at <= now {
        return Err(DesktopError::InvalidConfiguration(
            "Harness manifest has expired".to_owned(),
        ));
    }
    if payload.harness_repository != config.harness_repository {
        return Err(DesktopError::InvalidConfiguration(
            "Harness manifest repository does not match the bundled Harness source".to_owned(),
        ));
    }
    let version = Version::parse(&payload.harness_version).map_err(|error| {
        DesktopError::InvalidConfiguration(format!("Harness version is invalid: {error}"))
    })?;
    if payload.channel != channel || !matches!(channel, "stable" | "preview") {
        return Err(DesktopError::InvalidConfiguration(
            "Harness update channel does not match settings".to_owned(),
        ));
    }
    if channel == "stable" && !version.pre.is_empty() {
        return Err(DesktopError::InvalidConfiguration(
            "stable channel rejected a prerelease Harness".to_owned(),
        ));
    }
    let minimum = Version::parse(&payload.minimum_desktop_version).map_err(|error| {
        DesktopError::InvalidConfiguration(format!("minimum Desktop version is invalid: {error}"))
    })?;
    let maximum = Version::parse(&payload.maximum_desktop_version).map_err(|error| {
        DesktopError::InvalidConfiguration(format!("maximum Desktop version is invalid: {error}"))
    })?;
    if minimum > maximum {
        return Err(DesktopError::InvalidConfiguration(
            "Harness Desktop compatibility range is invalid".to_owned(),
        ));
    }
    if config.desktop_version < minimum || config.desktop_version > maximum {
        return Err(DesktopError::InvalidConfiguration(
            "Harness is not compatible with this Desktop version".to_owned(),
        ));
    }
    if payload.desktop_protocol_version != config.desktop_protocol_version
        || payload.harness_protocol_version != config.harness_protocol_version
        || payload.credential_protocol_version != config.credential_protocol_version
    {
        return Err(DesktopError::InvalidConfiguration(
            "Harness protocol compatibility check failed".to_owned(),
        ));
    }
    if payload.harness_commit.len() != 40
        || !payload
            .harness_commit
            .chars()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err(DesktopError::InvalidConfiguration(
            "Harness commit must be a full Git commit".to_owned(),
        ));
    }
    if payload.desktop_commit.len() != 40
        || !payload
            .desktop_commit
            .chars()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err(DesktopError::InvalidConfiguration(
            "Desktop commit must be a full Git commit".to_owned(),
        ));
    }
    if payload.credential_provider_version.trim().is_empty()
        || payload.market_version.trim().is_empty()
        || payload.node_version.trim().is_empty()
        || payload.node_module_abi.trim().is_empty()
    {
        return Err(DesktopError::InvalidConfiguration(
            "Harness compatibility metadata is incomplete".to_owned(),
        ));
    }
    Ok(())
}

fn validate_package_metadata(
    metadata: &HarnessPackageMetadata,
    payload: &HarnessReleaseManifest,
) -> DesktopResult<()> {
    if metadata.schema_version != 1
        || metadata.target != env!("DEEPSEEK_DESKTOP_TARGET")
        || metadata.harness_version != payload.harness_version
        || metadata.harness_commit != payload.harness_commit
        || metadata.node_version != payload.node_version
        || metadata.node_module_abi != payload.node_module_abi
        || metadata.harness_protocol_version != payload.harness_protocol_version
        || metadata.credential_protocol_version != payload.credential_protocol_version
        || metadata.credential_provider_version != payload.credential_provider_version
        || metadata.market_version != payload.market_version
    {
        return Err(DesktopError::InvalidConfiguration(
            "Harness package metadata does not match its signed manifest".to_owned(),
        ));
    }
    validate_relative_file(&metadata.entry)?;
    validate_relative_file(&metadata.node_file)?;
    Ok(())
}

fn validate_harness_files(
    location: &HarnessLocation,
    pointer: &HarnessPointer,
) -> DesktopResult<()> {
    let entry = location.harness_dir.join(&pointer.entry);
    let credential = location
        .harness_dir
        .join("node_modules/deepseek-desktop-credentials-vault/package.json");
    let market = location
        .harness_dir
        .join("node_modules/dshmarket/package.json");
    for path in [&entry, &location.node, &credential, &market] {
        if !path.is_file() {
            return Err(DesktopError::HarnessArtifactMissing(
                path.display().to_string(),
            ));
        }
    }
    let credential_manifest: serde_json::Value = serde_json::from_slice(&fs::read(credential)?)?;
    let market_manifest: serde_json::Value = serde_json::from_slice(&fs::read(market)?)?;
    if credential_manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        != Some(pointer.credential_provider_version.as_str())
        || market_manifest
            .get("version")
            .and_then(serde_json::Value::as_str)
            != Some(pointer.market_version.as_str())
    {
        return Err(DesktopError::InvalidConfiguration(
            "Harness package versions do not match metadata".to_owned(),
        ));
    }
    Ok(())
}

fn smoke_candidate(location: &HarnessLocation, pointer: &HarnessPointer) -> DesktopResult<()> {
    validate_harness_files(location, pointer)?;
    let node_version = run_smoke_command(&location.node, &["--version"], None)?;
    let node_module_abi =
        run_smoke_command(&location.node, &["-p", "process.versions.modules"], None)?;
    validate_node_identity(&node_version, &node_module_abi, pointer)?;
    let entry = location.harness_dir.join(&location.entry);
    run_smoke_command(
        &location.node,
        &[entry.to_string_lossy().as_ref(), "--help"],
        Some(&location.harness_dir),
    )?;
    crate::harness::smoke_harness_service(location)?;
    Ok(())
}

fn validate_node_identity(
    version_output: &str,
    abi_output: &str,
    pointer: &HarnessPointer,
) -> DesktopResult<()> {
    let actual_version = version_output.trim().trim_start_matches('v');
    let actual_abi = abi_output.trim();
    if actual_version != pointer.node_version || actual_abi != pointer.node_module_abi {
        return Err(DesktopError::InvalidConfiguration(
            "Harness Node version or native module ABI does not match signed metadata".to_owned(),
        ));
    }
    Ok(())
}

fn run_smoke_command(
    command: &Path,
    arguments: &[&str],
    cwd: Option<&Path>,
) -> DesktopResult<String> {
    let mut process = Command::new(command);
    process
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear();
    if let Some(cwd) = cwd {
        process.current_dir(cwd);
    }
    configure_hidden_process(&mut process);
    let mut child = process.spawn()?;
    let deadline = Instant::now() + SMOKE_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                let mut output = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    stdout.read_to_string(&mut output)?;
                }
                Ok(output)
            } else {
                Err(DesktopError::Other(format!(
                    "Harness smoke exited with {status}"
                )))
            };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(DesktopError::Other("Harness smoke timed out".to_owned()));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn secure_extract(archive: &Path, destination: &Path) -> DesktopResult<()> {
    if destination.exists() {
        fs::remove_dir_all(destination)?;
    }
    fs::create_dir_all(destination)?;
    let decoder = GzDecoder::new(File::open(archive)?);
    let mut archive = tar::Archive::new(decoder);
    let mut count = 0usize;
    let mut total = 0u64;
    let mut paths = HashSet::new();
    for item in archive
        .entries()
        .map_err(|error| DesktopError::Other(error.to_string()))?
    {
        let mut entry = item.map_err(|error| DesktopError::Other(error.to_string()))?;
        count += 1;
        if count > ENTRY_LIMIT {
            return Err(DesktopError::InvalidConfiguration(
                "Harness archive has too many entries".to_owned(),
            ));
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(DesktopError::InvalidConfiguration(
                "Harness archive contains links or special files".to_owned(),
            ));
        }
        let size = entry
            .header()
            .size()
            .map_err(|error| DesktopError::Other(error.to_string()))?;
        total = total.checked_add(size).ok_or_else(|| {
            DesktopError::InvalidConfiguration("Harness archive size overflow".to_owned())
        })?;
        if total > EXTRACTED_LIMIT {
            return Err(DesktopError::InvalidConfiguration(
                "Harness archive expands beyond the allowed size".to_owned(),
            ));
        }
        let path = entry
            .path()
            .map_err(|error| DesktopError::Other(error.to_string()))?
            .into_owned();
        validate_archive_path(&path)?;
        if !paths.insert(archive_path_key(&path)) {
            return Err(DesktopError::InvalidConfiguration(
                "Harness archive contains duplicate paths".to_owned(),
            ));
        }
        entry
            .unpack_in(destination)
            .map_err(|error| DesktopError::Other(error.to_string()))?;
    }
    Ok(())
}

fn archive_path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn read_url_limited(url: &Url, limit: u64, expected_size: Option<u64>) -> DesktopResult<Vec<u8>> {
    match url.scheme() {
        "file" => {
            let path = url.to_file_path().map_err(|_| {
                DesktopError::InvalidConfiguration("file URL is invalid".to_owned())
            })?;
            let metadata = fs::metadata(&path)?;
            if metadata.len() > limit || expected_size.is_some_and(|size| size != metadata.len()) {
                return Err(DesktopError::InvalidConfiguration(
                    "download size does not match the signed manifest".to_owned(),
                ));
            }
            Ok(fs::read(path)?)
        }
        "https" | "http" => {
            let response = http_client(MANIFEST_TIMEOUT)?
                .get(url.clone())
                .send()
                .map_err(|error| DesktopError::Other(error.to_string()))?;
            read_response_limited(response, limit, expected_size)
        }
        _ => Err(DesktopError::InvalidConfiguration(
            "unsupported Harness update URL scheme".to_owned(),
        )),
    }
}

fn canonical_repository_identity(value: &str) -> DesktopResult<String> {
    let value = value.trim();
    if let Some((user_host, path)) = value.split_once(':')
        && user_host.starts_with("git@")
        && !path.is_empty()
        && !value.contains(char::is_whitespace)
    {
        let path = path
            .trim_end_matches('/')
            .strip_suffix(".git")
            .unwrap_or(path.trim_end_matches('/'));
        return Ok(format!("{user_host}:{path}"));
    }
    let mut url = Url::parse(value.trim()).map_err(|error| {
        DesktopError::InvalidConfiguration(format!("Harness repository URL is invalid: {error}"))
    })?;
    if !matches!(url.scheme(), "https" | "http" | "ssh" | "git" | "file")
        || (matches!(url.scheme(), "https" | "http") && !url.username().is_empty())
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(DesktopError::InvalidConfiguration(
            "Harness repository URL is invalid".to_owned(),
        ));
    }
    let path = url.path().trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).to_owned();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

fn repository_check_failure(error: &DesktopError) -> &'static str {
    if matches!(error, DesktopError::RepositoryCommandTimedOut) {
        "repository-timeout"
    } else {
        "check-failed"
    }
}

fn repository_head(repository: &str) -> DesktopResult<String> {
    canonical_repository_identity(repository)?;
    let output = run_repository_command(
        Path::new("git"),
        &["ls-remote", repository, "HEAD"],
        None,
        REPOSITORY_CHECK_TIMEOUT,
        None,
        true,
        Some(repository),
    )?;
    let mut fields = output.split_whitespace();
    let commit = fields.next().unwrap_or_default();
    let reference = fields.next().unwrap_or_default();
    if commit.len() != 40
        || !commit.chars().all(|value| value.is_ascii_hexdigit())
        || reference != "HEAD"
        || fields.next().is_some()
    {
        return Err(DesktopError::InvalidConfiguration(
            "Harness repository did not return a valid HEAD commit".to_owned(),
        ));
    }
    Ok(commit.to_ascii_lowercase())
}

fn run_repository_command(
    command: &Path,
    arguments: &[&str],
    cwd: Option<&Path>,
    timeout: Duration,
    tools: Option<&Path>,
    capture_output: bool,
    repository: Option<&str>,
) -> DesktopResult<String> {
    let mut process = Command::new(command);
    process
        .args(arguments)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(if capture_output {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .env("CI", "1");
    if let Some(repository) = repository {
        crate::repository_proxy::configure(&mut process, repository);
        process.env("GIT_TERMINAL_PROMPT", "0");
    }
    if let Some(cwd) = cwd {
        process.current_dir(cwd);
    }
    if let Some(tools) = tools {
        let mut paths = vec![tools.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        process.env(
            "PATH",
            std::env::join_paths(paths).map_err(|error| DesktopError::Other(error.to_string()))?,
        );
    }
    configure_hidden_process(&mut process);
    let mut child = process.spawn().map_err(|error| {
        DesktopError::Other(format!(
            "unable to run {}; install Git when using a source Harness repository: {error}",
            command.display()
        ))
    })?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(DesktopError::Other(format!(
                    "Harness repository command exited with {status}"
                )));
            }
            let mut output = String::new();
            if capture_output && let Some(mut stdout) = child.stdout.take() {
                stdout.read_to_string(&mut output)?;
            }
            return Ok(output.trim().to_owned());
        }
        if Instant::now() >= deadline {
            // Git's HTTP/SSH helpers must not keep running after the parent times out.
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                let mut terminate = Command::new("taskkill");
                configure_hidden_process(&mut terminate);
                let _ = terminate
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(DesktopError::RepositoryCommandTimedOut);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn prepare_repository_tool_wrappers(
    tools: &Path,
    node: &Path,
    pnpm_cli: &Path,
) -> DesktopResult<()> {
    fs::create_dir_all(tools)?;
    #[cfg(windows)]
    {
        let pnpm_wrapper = format!(
            "@echo off\r\n\"{}\" \"{}\" %*\r\n",
            node.display(),
            pnpm_cli.display()
        );
        let node_wrapper = format!("@echo off\r\n\"{}\" %*\r\n", node.display());
        fs::write(tools.join("node.cmd"), node_wrapper)?;
        fs::write(tools.join("pnpm.cmd"), &pnpm_wrapper)?;
        fs::write(tools.join("npm.cmd"), pnpm_wrapper)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let pnpm_wrapper = format!(
            "#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n",
            node.display(),
            pnpm_cli.display()
        );
        let wrappers = [
            (
                "node",
                format!("#!/bin/sh\nexec \"{}\" \"$@\"\n", node.display()),
            ),
            ("pnpm", pnpm_wrapper.clone()),
            ("npm", pnpm_wrapper),
        ];
        for (name, wrapper) in wrappers {
            let path = tools.join(name);
            fs::write(&path, &wrapper)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

fn read_package_version(path: &Path) -> DesktopResult<String> {
    let manifest: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
    let version = manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            DesktopError::InvalidConfiguration(format!(
                "Harness package has no version: {}",
                path.display()
            ))
        })?;
    Version::parse(version).map_err(|error| {
        DesktopError::InvalidConfiguration(format!("Harness package version is invalid: {error}"))
    })?;
    Ok(version.to_owned())
}

#[derive(Deserialize)]
struct RepositoryDeployment {
    version: String,
    entry: String,
}

fn deploy_repository_harness(
    staging: &Path,
    source: &Path,
    destination: &Path,
    current: &HarnessLocation,
    tools: &Path,
) -> DesktopResult<RepositoryDeployment> {
    let scripts = staging.join("scripts");
    fs::create_dir_all(scripts.join("lib"))?;
    fs::create_dir_all(scripts.join("harness-update"))?;
    let entry = scripts.join("harness-update/prepare-repository.mjs");
    fs::write(
        &entry,
        include_str!("../../scripts/harness-update/prepare-repository.mjs"),
    )?;
    fs::write(
        scripts.join("lib/harness-deployment.mjs"),
        include_str!("../../scripts/lib/harness-deployment.mjs"),
    )?;
    let result = staging.join("deployment.json");
    run_repository_command(
        &current.node,
        &[
            &entry.to_string_lossy(),
            &source.to_string_lossy(),
            &destination.to_string_lossy(),
            &current.harness_dir.to_string_lossy(),
            &result.to_string_lossy(),
        ],
        Some(source),
        REPOSITORY_COMMAND_TIMEOUT,
        Some(tools),
        false,
        None,
    )?;
    let deployment: RepositoryDeployment = serde_json::from_slice(&fs::read(result)?)?;
    Version::parse(&deployment.version)
        .map_err(|error| DesktopError::InvalidConfiguration(error.to_string()))?;
    validate_relative_file(&deployment.entry)?;
    Ok(deployment)
}

fn read_response_limited(
    mut response: Response,
    limit: u64,
    expected_size: Option<u64>,
) -> DesktopResult<Vec<u8>> {
    if !response.status().is_success() {
        return Err(DesktopError::Other(format!(
            "Harness update server returned {}",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|size| size > limit || expected_size.is_some_and(|expected| expected != size))
    {
        return Err(DesktopError::InvalidConfiguration(
            "download size does not match the signed manifest".to_owned(),
        ));
    }
    let mut bytes = Vec::new();
    let mut limited = response.by_ref().take(limit + 1);
    limited.read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit || expected_size.is_some_and(|size| size != bytes.len() as u64) {
        return Err(DesktopError::InvalidConfiguration(
            "download size does not match the signed manifest".to_owned(),
        ));
    }
    Ok(bytes)
}

fn download_verified(
    url: &Url,
    destination: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> DesktopResult<()> {
    let temporary = destination.with_extension("part");
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    let result = (|| {
        if expected_size == 0 || expected_size > ARCHIVE_LIMIT {
            return Err(DesktopError::InvalidConfiguration(
                "Harness artifact size is outside the allowed range".to_owned(),
            ));
        }
        let mut output = File::create(&temporary)?;
        let (written, digest) = match url.scheme() {
            "file" => {
                let path = url.to_file_path().map_err(|_| {
                    DesktopError::InvalidConfiguration("file URL is invalid".to_owned())
                })?;
                if fs::metadata(&path)?.len() != expected_size {
                    return Err(DesktopError::InvalidConfiguration(
                        "download size does not match the signed manifest".to_owned(),
                    ));
                }
                stream_to_file(File::open(path)?, &mut output, expected_size)?
            }
            "https" | "http" => {
                let response = http_client(DOWNLOAD_TIMEOUT)?
                    .get(url.clone())
                    .send()
                    .map_err(|error| DesktopError::Other(error.to_string()))?;
                if !response.status().is_success() {
                    return Err(DesktopError::Other(format!(
                        "Harness update server returned {}",
                        response.status()
                    )));
                }
                if response
                    .content_length()
                    .is_some_and(|size| size != expected_size)
                {
                    return Err(DesktopError::InvalidConfiguration(
                        "download size does not match the signed manifest".to_owned(),
                    ));
                }
                stream_to_file(response, &mut output, expected_size)?
            }
            _ => {
                return Err(DesktopError::InvalidConfiguration(
                    "unsupported Harness update URL scheme".to_owned(),
                ));
            }
        };
        if written != expected_size {
            return Err(DesktopError::InvalidConfiguration(
                "download size does not match the signed manifest".to_owned(),
            ));
        }
        if !digest.eq_ignore_ascii_case(expected_sha256) {
            return Err(DesktopError::InvalidConfiguration(
                "Harness artifact SHA-256 verification failed".to_owned(),
            ));
        }
        output.sync_all()?;
        fs::rename(&temporary, destination)?;
        Ok(())
    })();
    if result.is_err() && temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn stream_to_file<R: Read>(
    mut reader: R,
    output: &mut File,
    expected_size: u64,
) -> DesktopResult<(u64, String)> {
    let mut digest = Sha256::new();
    let mut written = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        written = written.checked_add(count as u64).ok_or_else(|| {
            DesktopError::InvalidConfiguration("Harness artifact size overflow".to_owned())
        })?;
        if written > expected_size || written > ARCHIVE_LIMIT {
            return Err(DesktopError::InvalidConfiguration(
                "download size does not match the signed manifest".to_owned(),
            ));
        }
        digest.update(&buffer[..count]);
        output.write_all(&buffer[..count])?;
    }
    Ok((written, format!("{:x}", digest.finalize())))
}

fn http_client(timeout: Duration) -> DesktopResult<Client> {
    crate::harness::install_crypto_provider()?;
    Client::builder()
        .timeout(timeout)
        .redirect(Policy::none())
        .user_agent(concat!(
            "DeepSeek-Desktop/",
            env!("DEEPSEEK_DESKTOP_APP_VERSION")
        ))
        .build()
        .map_err(|error| DesktopError::Other(error.to_string()))
}

fn validate_artifact_url(
    manifest: &Url,
    artifact: &str,
    allowed_origins: &[String],
) -> DesktopResult<()> {
    let candidate = manifest
        .join(artifact)
        .map_err(|error| DesktopError::InvalidConfiguration(error.to_string()))?;
    if candidate.username() != ""
        || candidate.password().is_some()
        || candidate.fragment().is_some()
    {
        return Err(DesktopError::InvalidConfiguration(
            "Harness artifact URL contains credentials or a fragment".to_owned(),
        ));
    }
    let origin = url_origin(&candidate)?;
    let manifest_origin = url_origin(manifest)?;
    let mut origin_allowed = origin == manifest_origin;
    for allowed in allowed_origins {
        origin_allowed |= normalize_allowed_origin(allowed)? == origin;
    }
    if !origin_allowed {
        return Err(DesktopError::InvalidConfiguration(
            "Harness artifact origin is not trusted by the signed manifest".to_owned(),
        ));
    }
    if candidate.scheme() == "file" {
        let manifest_path = manifest.to_file_path().map_err(|_| {
            DesktopError::InvalidConfiguration("manifest file URL is invalid".to_owned())
        })?;
        let candidate_path = candidate.to_file_path().map_err(|_| {
            DesktopError::InvalidConfiguration("artifact file URL is invalid".to_owned())
        })?;
        let base = manifest_path.parent().ok_or_else(|| {
            DesktopError::InvalidConfiguration("manifest path has no parent".to_owned())
        })?;
        let canonical_base = base.canonicalize()?;
        let canonical_candidate = candidate_path.canonicalize()?;
        if !canonical_candidate.starts_with(canonical_base) {
            return Err(DesktopError::InvalidConfiguration(
                "Harness artifact escapes the manifest directory".to_owned(),
            ));
        }
    }
    Ok(())
}

fn url_origin(url: &Url) -> DesktopResult<String> {
    match url.scheme() {
        "file" => Ok("file://".to_owned()),
        "http" | "https" => Ok(url.origin().ascii_serialization()),
        _ => Err(DesktopError::InvalidConfiguration(
            "unsupported update URL scheme".to_owned(),
        )),
    }
}

fn normalize_allowed_origin(value: &str) -> DesktopResult<String> {
    let url = Url::parse(value).map_err(|error| {
        DesktopError::InvalidConfiguration(format!("allowed Harness origin is invalid: {error}"))
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || url.username() != ""
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(DesktopError::InvalidConfiguration(
            "allowed Harness origin must be a credential-free HTTP(S) origin".to_owned(),
        ));
    }
    url_origin(&url)
}

fn parse_public_key(value: &str) -> DesktopResult<VerifyingKey> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| {
            DesktopError::InvalidConfiguration(format!("Harness public key is invalid: {error}"))
        })?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| {
        DesktopError::InvalidConfiguration("Harness public key must contain 32 bytes".to_owned())
    })?;
    VerifyingKey::from_bytes(&bytes).map_err(|error| {
        DesktopError::InvalidConfiguration(format!("Harness public key is invalid: {error}"))
    })
}

fn read_pointer(path: &Path) -> DesktopResult<Option<HarnessPointer>> {
    match fs::read(path) {
        Ok(bytes) => {
            let pointer: HarnessPointer = serde_json::from_slice(&bytes)?;
            if pointer.schema_version != 1 {
                return Err(DesktopError::InvalidConfiguration(
                    "unsupported Harness pointer schema".to_owned(),
                ));
            }
            Ok(Some(pointer))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn repository_changed_status(current: HarnessUpdateStatus) -> HarnessUpdateStatus {
    HarnessUpdateStatus {
        phase: if current.pinned_version.is_some() {
            HarnessUpdatePhase::Pinned
        } else {
            HarnessUpdatePhase::Idle
        },
        message: if current.pinned_version.is_some() {
            "pinned"
        } else {
            "idle"
        }
        .to_owned(),
        available_version: None,
        pending_version: None,
        downloaded_bytes: 0,
        total_bytes: None,
        ..current
    }
}

fn version_directory(version: &str, commit: &str) -> DesktopResult<String> {
    Version::parse(version)
        .map_err(|error| DesktopError::InvalidConfiguration(error.to_string()))?;
    if commit.len() != 40 || !commit.chars().all(|value| value.is_ascii_hexdigit()) {
        return Err(DesktopError::InvalidConfiguration(
            "Harness commit must be a full Git commit".to_owned(),
        ));
    }
    Ok(format!("{version}-{}", &commit[..12]))
}

fn validate_pointer(pointer: &HarnessPointer) -> DesktopResult<()> {
    validate_directory_name(&pointer.directory)?;
    validate_relative_file(&pointer.entry)?;
    validate_relative_file(&pointer.node_file)?;
    validate_sha256(&pointer.artifact_sha256)?;
    let expected_directory = version_directory(&pointer.harness_version, &pointer.harness_commit)?;
    if pointer.directory != expected_directory
        || pointer.target != env!("DEEPSEEK_DESKTOP_TARGET")
        || pointer.harness_protocol_version
            != env!("DEEPSEEK_DESKTOP_HARNESS_PROTOCOL_VERSION")
                .parse::<u32>()
                .unwrap_or(0)
        || pointer.credential_protocol_version
            != env!("DEEPSEEK_DESKTOP_CREDENTIAL_PROTOCOL_VERSION")
                .parse::<u32>()
                .unwrap_or(0)
        || Version::parse(&pointer.node_version).is_err()
        || pointer.node_module_abi.parse::<u32>().is_err()
        || Version::parse(&pointer.credential_provider_version).is_err()
        || Version::parse(&pointer.market_version).is_err()
    {
        return Err(DesktopError::InvalidConfiguration(
            "installed Harness pointer is incompatible or inconsistent".to_owned(),
        ));
    }
    Ok(())
}

fn validate_directory_name(value: &str) -> DesktopResult<()> {
    if value.is_empty() || value == "." || value == ".." || value.contains(['/', '\\']) {
        return Err(DesktopError::InvalidConfiguration(
            "Harness directory name is unsafe".to_owned(),
        ));
    }
    Ok(())
}

fn validate_relative_file(value: &str) -> DesktopResult<()> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || path.components().any(|component| match component {
            Component::Normal(name) => unsafe_archive_name(name.to_string_lossy().as_ref()),
            _ => true,
        })
    {
        return Err(DesktopError::InvalidConfiguration(
            "Harness package path is unsafe".to_owned(),
        ));
    }
    Ok(())
}

fn validate_archive_path(path: &Path) -> DesktopResult<()> {
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || path.components().any(|component| match component {
            Component::Normal(name) => unsafe_archive_name(name.to_string_lossy().as_ref()),
            _ => true,
        })
    {
        return Err(DesktopError::InvalidConfiguration(
            "Harness archive path is unsafe".to_owned(),
        ));
    }
    Ok(())
}

fn unsafe_archive_name(name: &str) -> bool {
    if name.is_empty() || name.ends_with([' ', '.']) || name.contains([':', '\0']) {
        return true;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn validate_sha256(value: &str) -> DesktopResult<()> {
    if value.len() != 64 || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(DesktopError::InvalidConfiguration(
            "Harness artifact SHA-256 is invalid".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn configure_hidden_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn configure_hidden_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(windows)]
fn node_compatible_path(path: &Path) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let units = path.as_os_str().encode_wide().collect::<Vec<_>>();
    PathBuf::from(OsString::from_wide(
        &crate::harness::strip_windows_verbatim_prefix(&units),
    ))
}

#[cfg(not(windows))]
fn node_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use tempfile::TempDir;

    fn config(key: &SigningKey) -> HarnessUpdateConfig {
        HarnessUpdateConfig {
            manifest_url: None,
            publisher: "test-publisher".to_owned(),
            public_key: Some(key.verifying_key()),
            desktop_version: Version::parse("1.0.0").unwrap(),
            target: env!("DEEPSEEK_DESKTOP_TARGET").to_owned(),
            harness_repository: "https://example.invalid/harness.git".to_owned(),
            desktop_protocol_version: 1,
            harness_protocol_version: 1,
            credential_protocol_version: 1,
        }
    }

    #[test]
    fn repository_identity_ignores_git_suffix_and_trailing_slash() {
        assert_eq!(
            canonical_repository_identity("https://github.com/example/harness.git").unwrap(),
            canonical_repository_identity("https://github.com/example/harness/").unwrap()
        );
    }

    #[test]
    fn repository_change_clears_candidate_ui_without_changing_the_running_version() {
        for phase in [HarnessUpdatePhase::Available, HarnessUpdatePhase::Staged] {
            let status = repository_changed_status(HarnessUpdateStatus {
                phase,
                current_version: "1.0.0".to_owned(),
                current_commit: "a".repeat(40),
                available_version: Some("1.1.0".to_owned()),
                pending_version: Some("1.1.0".to_owned()),
                downloaded_bytes: 100,
                total_bytes: Some(100),
                message: "restart-to-apply".to_owned(),
                ..HarnessUpdateStatus::default()
            });
            assert_eq!(status.phase, HarnessUpdatePhase::Idle);
            assert_eq!(status.message, "idle");
            assert_eq!(status.current_version, "1.0.0");
            assert_eq!(status.current_commit, "a".repeat(40));
            assert!(status.available_version.is_none());
            assert!(status.pending_version.is_none());
            assert_eq!(status.downloaded_bytes, 0);
            assert!(status.total_bytes.is_none());
            let pinned = repository_changed_status(HarnessUpdateStatus {
                pinned_version: Some("1.0.0".to_owned()),
                ..status
            });
            assert_eq!(pinned.phase, HarnessUpdatePhase::Pinned);
            assert_eq!(pinned.message, "pinned");
        }
    }

    #[test]
    fn repository_check_timeout_has_a_distinct_safe_status() {
        assert_eq!(
            repository_check_failure(&DesktopError::RepositoryCommandTimedOut),
            "repository-timeout"
        );
        assert_eq!(
            repository_check_failure(&DesktopError::Other("private upstream error".to_owned())),
            "check-failed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn repository_timeout_stops_helpers_and_preserves_timeout_classification() {
        let directory = TempDir::new().unwrap();
        let marker = directory.path().join("helper-finished");
        let started = Instant::now();
        let result = run_repository_command(
            Path::new("/bin/sh"),
            &["-c", "(sleep 1; touch helper-finished) & wait"],
            Some(directory.path()),
            Duration::from_millis(100),
            None,
            false,
            None,
        );
        assert!(matches!(
            result,
            Err(DesktopError::RepositoryCommandTimedOut)
        ));
        assert!(started.elapsed() < Duration::from_secs(2));
        thread::sleep(Duration::from_millis(1100));
        assert!(!marker.exists());
    }

    #[test]
    #[ignore = "requires an explicitly selected reachable Git repository"]
    fn repository_head_live_check() {
        let repository = std::env::var("DESKTOP_TEST_HARNESS_REPOSITORY").unwrap();
        let started = Instant::now();
        let head = repository_head(&repository).unwrap();
        println!(
            "Harness repository HEAD: {head}; elapsed: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn repository_build_tools_pin_node_and_pnpm_to_the_bundled_harness() {
        let directory = TempDir::new().unwrap();
        let tools = directory.path().join("tools");
        let node = directory
            .path()
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let pnpm = directory.path().join("pnpm.cjs");

        prepare_repository_tool_wrappers(&tools, &node, &pnpm).unwrap();

        let suffix = if cfg!(windows) { ".cmd" } else { "" };
        let node_wrapper = fs::read_to_string(tools.join(format!("node{suffix}"))).unwrap();
        let pnpm_wrapper = fs::read_to_string(tools.join(format!("pnpm{suffix}"))).unwrap();
        let npm_wrapper = fs::read_to_string(tools.join(format!("npm{suffix}"))).unwrap();
        assert!(node_wrapper.contains(node.to_string_lossy().as_ref()));
        assert!(pnpm_wrapper.contains(node.to_string_lossy().as_ref()));
        assert!(pnpm_wrapper.contains(pnpm.to_string_lossy().as_ref()));
        assert_eq!(pnpm_wrapper, npm_wrapper);
    }

    #[test]
    fn repository_head_reads_the_selected_repository_default_branch() {
        let directory = TempDir::new().unwrap();
        let repository = directory.path().join("harness");
        let run = |arguments: &[&str]| {
            let status = Command::new("git")
                .args(arguments)
                .current_dir(directory.path())
                .status()
                .unwrap();
            assert!(status.success());
        };
        run(&["init", "harness"]);
        fs::write(repository.join("package.json"), "{\"version\":\"1.0.0\"}\n").unwrap();
        let status = Command::new("git")
            .args(["add", "package.json"])
            .current_dir(&repository)
            .status()
            .unwrap();
        assert!(status.success());
        let status = Command::new("git")
            .args([
                "-c",
                "user.name=Harness Test",
                "-c",
                "user.email=harness@example.invalid",
                "commit",
                "-m",
                "test",
            ])
            .current_dir(&repository)
            .status()
            .unwrap();
        assert!(status.success());
        let expected = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&repository)
            .output()
            .unwrap();
        let repository_url = Url::from_file_path(&repository).unwrap().to_string();
        assert_eq!(
            repository_head(&repository_url).unwrap(),
            String::from_utf8(expected.stdout).unwrap().trim()
        );
    }

    #[test]
    fn repository_override_replaces_the_packaged_update_source() {
        let official_key = SigningKey::from_bytes(&[1_u8; 32]);
        let official = config(&official_key);
        let settings = DesktopSettings {
            harness_update_repository: Some(
                "https://git.example.com/harness/harness.git".to_owned(),
            ),
            ..DesktopSettings::default()
        };

        let resolved = official.resolved_for(&settings).unwrap();

        assert!(resolved.is_enabled());
        assert!(resolved.uses_repository());
        assert!(resolved.manifest_url.is_none());
        assert!(resolved.public_key.is_none());
        assert_eq!(
            resolved.harness_repository,
            "https://git.example.com/harness/harness.git"
        );
        assert_ne!(resolved.source_fingerprint(), official.source_fingerprint());
    }

    #[test]
    fn missing_repository_override_uses_the_packaged_default() {
        let key = SigningKey::from_bytes(&[3_u8; 32]);
        let mut official = config(&key);
        official.manifest_url = Some(Url::parse("https://official.example/manifest.json").unwrap());
        let settings = DesktopSettings::default();

        let resolved = official.resolved_for(&settings).unwrap();

        assert!(resolved.is_enabled());
        assert_eq!(resolved.manifest_url, official.manifest_url);
        assert_eq!(resolved.harness_repository, official.harness_repository);
    }

    fn payload(channel: &str, version: &str) -> HarnessReleaseManifest {
        let now = chrono::Utc::now();
        HarnessReleaseManifest {
            schema_version: 1,
            publisher: "test-publisher".to_owned(),
            issued_at: (now - chrono::TimeDelta::minutes(1)).to_rfc3339(),
            expires_at: (now + chrono::TimeDelta::hours(1)).to_rfc3339(),
            harness_version: version.to_owned(),
            channel: channel.to_owned(),
            desktop_protocol_version: 1,
            harness_protocol_version: 1,
            credential_protocol_version: 1,
            minimum_desktop_version: "1.0.0".to_owned(),
            maximum_desktop_version: "2.0.0".to_owned(),
            harness_commit: "a".repeat(40),
            harness_repository: "https://example.invalid/harness.git".to_owned(),
            desktop_commit: "b".repeat(40),
            credential_provider_version: "1.0.0".to_owned(),
            market_version: "1.0.0".to_owned(),
            node_version: "24.20.0".to_owned(),
            node_module_abi: "137".to_owned(),
            allowed_origins: Vec::new(),
            artifacts: HashMap::from([(
                env!("DEEPSEEK_DESKTOP_TARGET").to_owned(),
                HarnessArtifact {
                    url: "harness.tar.gz".to_owned(),
                    size: 1,
                    sha256: "a".repeat(64),
                },
            )]),
        }
    }

    fn signed(payload: &HarnessReleaseManifest, key: &SigningKey) -> Vec<u8> {
        let bytes = serde_json::to_vec(payload).unwrap();
        serde_json::to_vec(&SignedManifestEnvelope {
            schema_version: 1,
            signed_payload: base64::engine::general_purpose::STANDARD.encode(&bytes),
            signature: base64::engine::general_purpose::STANDARD
                .encode(key.sign(&bytes).to_bytes()),
        })
        .unwrap()
    }

    #[test]
    fn verifies_signed_stable_and_preview_manifests() {
        let key = SigningKey::from_bytes(&[7; 32]);
        assert!(
            verify_manifest(
                &signed(&payload("stable", "1.1.0"), &key),
                &config(&key),
                "stable"
            )
            .is_ok()
        );
        assert!(
            verify_manifest(
                &signed(&payload("preview", "1.1.0-beta.1"), &key),
                &config(&key),
                "preview"
            )
            .is_ok()
        );
        assert!(
            verify_manifest(
                &signed(&payload("stable", "1.1.0-beta.1"), &key),
                &config(&key),
                "stable"
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_tampering_wrong_publisher_and_incompatible_protocols() {
        let key = SigningKey::from_bytes(&[9; 32]);
        let mut bytes = signed(&payload("stable", "1.1.0"), &key);
        let last = bytes.len() - 2;
        bytes[last] ^= 1;
        assert!(verify_manifest(&bytes, &config(&key), "stable").is_err());

        let mut wrong = payload("stable", "1.1.0");
        wrong.publisher = "other".to_owned();
        assert!(verify_manifest(&signed(&wrong, &key), &config(&key), "stable").is_err());
        wrong.publisher = "test-publisher".to_owned();
        wrong.harness_protocol_version = 2;
        assert!(verify_manifest(&signed(&wrong, &key), &config(&key), "stable").is_err());

        let mut wrong_repository = payload("stable", "1.1.0");
        wrong_repository.harness_repository = "https://example.invalid/other.git".to_owned();
        assert!(
            verify_manifest(&signed(&wrong_repository, &key), &config(&key), "stable").is_err()
        );
    }

    #[test]
    fn rejects_expired_future_and_replayed_manifests() {
        let key = SigningKey::from_bytes(&[11; 32]);
        let now = chrono::Utc::now();
        let mut expired = payload("stable", "1.1.0");
        expired.issued_at = (now - chrono::TimeDelta::hours(2)).to_rfc3339();
        expired.expires_at = (now - chrono::TimeDelta::hours(1)).to_rfc3339();
        assert!(validate_manifest_payload_at(&expired, &config(&key), "stable", now).is_err());

        let mut future = payload("stable", "1.1.0");
        future.issued_at = (now + chrono::TimeDelta::hours(1)).to_rfc3339();
        future.expires_at = (now + chrono::TimeDelta::hours(2)).to_rfc3339();
        assert!(validate_manifest_payload_at(&future, &config(&key), "stable", now).is_err());

        let temp = TempDir::new().unwrap();
        let root = temp.path().join("harness");
        let versions = root.join("versions");
        fs::create_dir_all(&versions).unwrap();
        let store = HarnessStore {
            current: root.join("current.json"),
            previous: root.join("previous.json"),
            pending: root.join("pending.json"),
            bundled: HarnessLocation {
                harness_dir: temp.path().join("bundled"),
                node: temp.path().join("node"),
                entry: "entry.js".to_owned(),
                version: "1.0.0".to_owned(),
                commit: "b".repeat(40),
                source: "bundled".to_owned(),
            },
            versions,
            root,
        };
        let accepted = payload("stable", "1.2.0");
        store.verify_manifest_acceptance(&accepted).unwrap();
        assert!(
            !store.accepted_manifest_path("stable").exists(),
            "checking a manifest must not record it"
        );
        store.record_manifest_acceptance(&accepted).unwrap();
        let mut replay = payload("stable", "1.1.0");
        replay.issued_at = (now + chrono::TimeDelta::minutes(1)).to_rfc3339();
        replay.expires_at = (now + chrono::TimeDelta::hours(1)).to_rfc3339();
        assert!(store.verify_manifest_acceptance(&replay).is_err());

        let mut recut = payload("stable", "1.2.0");
        recut.harness_commit = "c".repeat(40);
        assert!(store.verify_manifest_acceptance(&recut).is_err());
        store.clear_accepted_manifests().unwrap();
        store.verify_manifest_acceptance(&recut).unwrap();
    }

    #[test]
    fn rejects_malicious_archive_paths_and_links() {
        assert!(validate_archive_path(Path::new("../escape")).is_err());
        assert!(validate_archive_path(Path::new("/absolute")).is_err());
        assert!(validate_archive_path(Path::new("./harness/package.json")).is_err());
        assert!(validate_archive_path(Path::new("harness/CON.txt")).is_err());
        assert!(validate_archive_path(Path::new("harness/name. ")).is_err());
        assert!(validate_archive_path(Path::new("harness/package.json")).is_ok());
        assert_eq!(
            archive_path_key(Path::new("Harness/Package.json")),
            archive_path_key(Path::new("harness/package.json"))
        );

        let temp = TempDir::new().unwrap();
        let archive_path = temp.path().join("link.tar.gz");
        let encoder = GzEncoder::new(File::create(&archive_path).unwrap(), Compression::default());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_cksum();
        archive
            .append_link(&mut header, "link", "../../escape")
            .unwrap();
        archive.finish().unwrap();
        assert!(secure_extract(&archive_path, &temp.path().join("out")).is_err());
    }

    #[test]
    fn normalizes_trusted_origins_and_rejects_origin_paths() {
        let manifest = Url::parse("https://updates.example.com/harness/manifest.json").unwrap();
        assert!(
            validate_artifact_url(
                &manifest,
                "https://cdn.example.com/harness.tar.gz",
                &["https://cdn.example.com:443".to_owned()]
            )
            .is_ok()
        );
        assert!(
            validate_artifact_url(
                &manifest,
                "https://cdn.example.com/harness.tar.gz",
                &["https://cdn.example.com/files".to_owned()]
            )
            .is_err()
        );
    }

    #[test]
    fn validates_the_packaged_node_version_and_module_abi() {
        let pointer = HarnessPointer {
            schema_version: 1,
            directory: "1.1.0-aaaaaaaaaaaa".to_owned(),
            harness_version: "1.1.0".to_owned(),
            harness_commit: "a".repeat(40),
            target: env!("DEEPSEEK_DESKTOP_TARGET").to_owned(),
            entry: "entry.js".to_owned(),
            node_file: "node".to_owned(),
            node_version: "24.20.0".to_owned(),
            node_module_abi: "137".to_owned(),
            harness_protocol_version: 1,
            credential_protocol_version: 1,
            credential_provider_version: "1.0.0".to_owned(),
            market_version: "1.0.0".to_owned(),
            artifact_sha256: "a".repeat(64),
        };
        assert!(validate_node_identity("v24.20.0\n", "137\n", &pointer).is_ok());
        assert!(validate_node_identity("v24.16.1\n", "137\n", &pointer).is_err());
        assert!(validate_node_identity("v24.20.0\n", "138\n", &pointer).is_err());
        assert!(validate_pointer(&pointer).is_ok());
        let mut unsafe_pointer = pointer.clone();
        unsafe_pointer.entry = "../entry.js".to_owned();
        assert!(validate_pointer(&unsafe_pointer).is_err());
        let mut mismatched_pointer = pointer;
        mismatched_pointer.directory = "1.1.0-bbbbbbbbbbbb".to_owned();
        assert!(validate_pointer(&mismatched_pointer).is_err());
    }

    #[test]
    fn streams_verified_downloads_and_removes_partial_files() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source.tar.gz");
        let destination = temp.path().join("harness.tar.gz");
        let bytes = vec![42u8; 128 * 1024];
        fs::write(&source, &bytes).unwrap();
        let url = Url::from_file_path(&source).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        download_verified(&url, &destination, bytes.len() as u64, &hash).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), bytes);

        fs::remove_file(&destination).unwrap();
        assert!(
            download_verified(&url, &destination, bytes.len() as u64, &"0".repeat(64)).is_err()
        );
        assert!(!destination.with_extension("part").exists());
    }

    #[test]
    fn pointer_switch_rolls_back_to_previous_and_then_bundled() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("harness");
        let versions = root.join("versions");
        fs::create_dir_all(&versions).unwrap();
        let store = HarnessStore {
            current: root.join("current.json"),
            previous: root.join("previous.json"),
            pending: root.join("pending.json"),
            bundled: HarnessLocation {
                harness_dir: temp.path().join("bundled"),
                node: temp.path().join("node"),
                entry: "entry.js".to_owned(),
                version: "1.0.0".to_owned(),
                commit: "b".repeat(40),
                source: "bundled".to_owned(),
            },
            versions,
            root,
        };
        let pointer = HarnessPointer {
            schema_version: 1,
            directory: "1.1.0-aaaaaaaaaaaa".to_owned(),
            harness_version: "1.1.0".to_owned(),
            harness_commit: "a".repeat(40),
            target: env!("DEEPSEEK_DESKTOP_TARGET").to_owned(),
            entry: "entry.js".to_owned(),
            node_file: "node".to_owned(),
            node_version: "24.20.0".to_owned(),
            node_module_abi: "137".to_owned(),
            harness_protocol_version: 1,
            credential_protocol_version: 1,
            credential_provider_version: "1.0.0".to_owned(),
            market_version: "1.0.0".to_owned(),
            artifact_sha256: "a".repeat(64),
        };
        fs::create_dir_all(store.versions.join(&pointer.directory)).unwrap();
        let orphan = store.versions.join("0.9.0-cccccccccccc");
        fs::create_dir_all(&orphan).unwrap();
        write_json_atomic(&store.current, &pointer).unwrap();
        store.prune_versions().unwrap();
        assert!(store.versions.join(&pointer.directory).is_dir());
        assert!(!orphan.exists());
        assert!(store.rollback().unwrap());
        assert!(!store.current.exists());
        assert!(!store.versions.join(&pointer.directory).exists());
        assert!(!store.rollback().unwrap());
    }

    #[test]
    fn discarding_a_pending_harness_removes_its_unreferenced_candidate() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("harness");
        let versions = root.join("versions");
        fs::create_dir_all(&versions).unwrap();
        let store = HarnessStore {
            current: root.join("current.json"),
            previous: root.join("previous.json"),
            pending: root.join("pending.json"),
            bundled: HarnessLocation {
                harness_dir: temp.path().join("bundled"),
                node: temp.path().join("node"),
                entry: "entry.js".to_owned(),
                version: "1.0.0".to_owned(),
                commit: "b".repeat(40),
                source: "bundled".to_owned(),
            },
            versions,
            root,
        };
        let pointer = HarnessPointer {
            schema_version: 1,
            directory: "1.1.0-aaaaaaaaaaaa".to_owned(),
            harness_version: "1.1.0".to_owned(),
            harness_commit: "a".repeat(40),
            target: env!("DEEPSEEK_DESKTOP_TARGET").to_owned(),
            entry: "entry.js".to_owned(),
            node_file: "node".to_owned(),
            node_version: "24.20.0".to_owned(),
            node_module_abi: "137".to_owned(),
            harness_protocol_version: 1,
            credential_protocol_version: 1,
            credential_provider_version: "1.0.0".to_owned(),
            market_version: "1.0.0".to_owned(),
            artifact_sha256: "a".repeat(64),
        };
        fs::create_dir_all(store.versions.join(&pointer.directory)).unwrap();
        write_json_atomic(&store.pending, &pointer).unwrap();

        store.discard_pending().unwrap();

        assert!(!store.pending.exists());
        assert!(!store.versions.join(&pointer.directory).exists());
    }
}
