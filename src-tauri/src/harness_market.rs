//! DSH Market is a user plugin, managed exclusively by the current Harness CLI.
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::DesktopResult;
use crate::harness_update::run_bounded_command;
use crate::settings::write_json_atomic;

const MARKET_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketSync {
    harness_commit: String,
}

pub(crate) fn is_current(state: &Path, commit: &str) -> bool {
    fs::read(state)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<MarketSync>(&bytes).ok())
        .is_some_and(|saved| saved.harness_commit == commit)
}

/// Only successful CLI completion is remembered. A failed attempt remains retryable.
fn sync_for_commit(
    state: &Path,
    commit: &str,
    install: impl FnOnce() -> DesktopResult<()>,
) -> DesktopResult<bool> {
    if is_current(state, commit) {
        return Ok(false);
    }
    install()?;
    write_json_atomic(
        state,
        &MarketSync {
            harness_commit: commit.to_owned(),
        },
    )?;
    Ok(true)
}

pub(crate) fn sync(
    state: &Path,
    commit: &str,
    node: &Path,
    entry: &Path,
    cwd: &Path,
    environment: &HashMap<String, String>,
) -> DesktopResult<bool> {
    sync_for_commit(state, commit, || {
        let mut command = Command::new(node);
        command
            .arg("--expose-internals")
            .arg(entry)
            // A bare `add dshmarket` retains an already pinned dependency. The explicit
            // registry dist-tag makes the official command upgrade existing installs too.
            .args([
                "plugin",
                "--profile",
                "desktop-web",
                "add",
                "dshmarket@latest",
            ])
            .current_dir(cwd)
            .env_clear()
            .envs(environment)
            .env("CI", "1")
            .stdin(Stdio::null())
            // CLI output can contain user registry configuration. Do not persist it in diagnostics.
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        run_bounded_command(&mut command, MARKET_TIMEOUT, false).map(|_| ())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::DesktopError;
    use tempfile::TempDir;

    #[test]
    fn new_core_syncs_once_and_failed_updates_retry_without_marking_success() {
        let root = TempDir::new().unwrap();
        let state = root.path().join("market.json");
        assert!(sync_for_commit(&state, "core-a", || Ok(())).unwrap());
        assert!(
            !sync_for_commit(&state, "core-a", || panic!(
                "ordinary restart must stay offline"
            ))
            .unwrap()
        );
        assert!(
            sync_for_commit(&state, "core-b", || Err(DesktopError::Other(
                "offline".into()
            )))
            .is_err()
        );
        assert!(is_current(&state, "core-a"));
        assert!(!is_current(&state, "core-b"));
        assert!(sync_for_commit(&state, "core-b", || Ok(())).unwrap());
        assert!(is_current(&state, "core-b"));
    }

    #[test]
    fn first_install_failure_and_corrupt_checkpoint_remain_retryable() {
        let root = TempDir::new().unwrap();
        let state = root.path().join("market.json");
        assert!(
            sync_for_commit(&state, "core-a", || Err(DesktopError::Other(
                "offline".into()
            )))
            .is_err()
        );
        assert!(!state.exists());
        fs::write(&state, "incomplete").unwrap();
        assert!(sync_for_commit(&state, "core-a", || Ok(())).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn official_cli_uses_selected_node_entry_profile_and_environment() {
        use std::os::unix::fs::PermissionsExt;
        let root = TempDir::new().unwrap();
        let node = root.path().join("candidate node");
        fs::write(&node, "#!/bin/sh\nprintf '%s\\n' \"$@\" > args\nprintf '%s' \"$DSH_HOME\" > home\nexit \"$RESULT\"\n").unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
        let state = root.path().join("state.json");
        let entry = root.path().join("candidate entry.js");
        let mut environment = HashMap::from([
            ("DSH_HOME".into(), "desktop-home".into()),
            ("RESULT".into(), "1".into()),
        ]);
        assert!(sync(&state, "core", &node, &entry, root.path(), &environment).is_err());
        assert!(!state.exists());
        environment.insert("RESULT".into(), "0".into());
        assert!(sync(&state, "core", &node, &entry, root.path(), &environment).unwrap());
        assert_eq!(
            fs::read_to_string(root.path().join("home")).unwrap(),
            "desktop-home"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("args"))
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            [
                "--expose-internals",
                entry.to_str().unwrap(),
                "plugin",
                "--profile",
                "desktop-web",
                "add",
                "dshmarket@latest"
            ]
        );
        // Removing the executable proves an ordinary restart does not launch another process.
        fs::remove_file(&node).unwrap();
        assert!(!sync(&state, "core", &node, &entry, root.path(), &environment).unwrap());
    }
}
