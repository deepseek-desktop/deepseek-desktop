//! The environment the user configured, for launches that never inherit it.
//!
//! An application started from Finder, the Dock or a desktop launcher is not the child of
//! any shell, so the operating system hands it a skeleton environment. On macOS that is
//! `PATH=/usr/bin:/bin:/usr/sbin:/sbin` plus a handful of LaunchServices entries, and
//! nothing at all from the user's shell profile: no Homebrew, no nvm, no rustup or pyenv,
//! no `LANG`, no `SSL_CERT_FILE`.
//!
//! ADR-025 stopped the desktop from *filtering* the environment on the way to the kernel,
//! but an unfiltered copy of a skeleton is still a skeleton. The kernel's Bash tool then
//! reports `node` missing on a machine whose Terminal answers `node --version` without
//! hesitating, and the desktop shell is once again the reason a kernel feature does not
//! work. So the desktop asks the user's own login shell what their environment is, which is
//! what editors have done about this same defect for over a decade.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::sync::OnceLock;

/// What the user's login shell answered, and what to write in the diagnostics log about it.
#[derive(Debug, Default)]
pub struct LoginShell {
    /// The variables it reported. Empty when the probe did not run or did not answer; the
    /// caller then keeps the launch environment it already had.
    pub variables: HashMap<String, String>,
    /// The outcome, success included. A silently dropped environment is exactly what made
    /// the old allowlist so hard to diagnose, so this is always recorded.
    pub report: String,
}

/// The login shell environment for this run, resolved at most once.
pub fn login_shell() -> &'static LoginShell {
    static RESOLVED: OnceLock<LoginShell> = OnceLock::new();
    RESOLVED.get_or_init(resolve)
}

/// The search path the user actually has, in the order they chose.
///
/// The login shell's ordering is the user's own precedence — Homebrew ahead of `/usr/bin` is
/// a deliberate choice, and reversing it would hand a different `python3` to the kernel than
/// to the Terminal. So it leads, and the entries only the launch context carries are
/// appended rather than dropped.
pub fn search_paths() -> Vec<PathBuf> {
    let login = login_shell()
        .variables
        .get("PATH")
        .map(|path| OsString::from(path.as_str()));
    ordered_paths([login.as_deref(), std::env::var_os("PATH").as_deref()])
}

fn ordered_paths(sources: [Option<&OsStr>; 2]) -> Vec<PathBuf> {
    let mut ordered: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for source in sources.into_iter().flatten() {
        for entry in std::env::split_paths(source) {
            if entry.as_os_str().is_empty() {
                continue;
            }
            if seen.insert(entry.clone()) {
                ordered.push(entry);
            }
        }
    }
    ordered
}

/// Windows processes started from Explorer receive the user's environment from the registry,
/// so there is no shell profile left to consult and nothing to recover.
#[cfg(windows)]
fn resolve() -> LoginShell {
    LoginShell {
        variables: HashMap::new(),
        report: "login shell environment: not applicable on Windows".to_owned(),
    }
}

#[cfg(unix)]
use probe::resolve;

#[cfg(unix)]
mod probe {
    use super::LoginShell;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    /// The profile being sourced is the user's own: it can be slow, broken, or wait on a
    /// network share. One bounded attempt per run, after which the launch proceeds without
    /// it.
    const RESOLVE_TIMEOUT: Duration = Duration::from_secs(8);
    /// A profile is free to print banners, version notices and warnings. Fencing the dump
    /// means none of that has to be told apart from an environment entry.
    const BEGIN_MARKER: &str = "__DEEPSEEK_DESKTOP_ENV_BEGIN__";
    const END_MARKER: &str = "__DEEPSEEK_DESKTOP_ENV_END__";
    /// Exported for the duration of the probe so a profile that must not run its expensive
    /// or interactive half twice can branch on it. It is dropped from the result.
    const RESOLVING_VARIABLE: &str = "DEEPSEEK_DESKTOP_RESOLVING_ENVIRONMENT";
    /// Bookkeeping the probe shell writes about its own session, not configuration the user
    /// chose. Carrying `PWD` in particular would tell a tool the kernel runs that it sits in
    /// the home directory when it does not. Dropping these is not a filter on the user's
    /// environment — it removes what running the probe itself produced.
    const PROBE_ARTIFACTS: [&str; 5] = [RESOLVING_VARIABLE, "PWD", "OLDPWD", "SHLVL", "_"];

    pub(super) fn resolve() -> LoginShell {
        let shell = user_shell();
        match capture(&shell) {
            Ok(variables) => LoginShell {
                report: format!(
                    "login shell environment: {} variables from {}",
                    variables.len(),
                    shell.display()
                ),
                variables,
            },
            Err(error) => LoginShell {
                variables: HashMap::new(),
                report: format!(
                    "login shell environment: {} did not answer ({error}); continuing with the launch environment",
                    shell.display()
                ),
            },
        }
    }

    fn user_shell() -> PathBuf {
        match std::env::var_os("SHELL") {
            Some(shell) if !shell.is_empty() => PathBuf::from(shell),
            _ => PathBuf::from("/bin/sh"),
        }
    }

    fn capture(shell: &Path) -> Result<HashMap<String, String>, String> {
        let (result, timed_out) = attempt(shell, true);
        if timed_out {
            return result;
        }
        match result {
            Ok(variables) => Ok(variables),
            // A strictly POSIX shell (dash, ash) rejects `-l` and `-i` and exits at once, so
            // the plain form costs nothing measurable and still picks up whatever `$ENV`
            // names.
            Err(login) => attempt(shell, false)
                .0
                .map_err(|plain| format!("{login}; {plain}")),
        }
    }

    /// Run one probe. The second element reports a timeout, which must not be retried.
    fn attempt(shell: &Path, login: bool) -> (Result<HashMap<String, String>, String>, bool) {
        use std::os::unix::process::CommandExt;

        // `-l` sources the profile and `-i` the rc file. Users split their exports across
        // both and neither alone covers the common setups, so a login *and* interactive
        // shell is the only form that sees everything they see in a terminal.
        let script = format!("echo '{BEGIN_MARKER}'; /usr/bin/env -0; echo '{END_MARKER}'");
        let mut command = Command::new(shell);
        if login {
            command.args(["-l", "-i"]);
        }
        command
            .args(["-c", &script])
            .env(RESOLVING_VARIABLE, "1")
            // An rc file that reads from standard input sees end of file instead of
            // blocking, and its own chatter is discarded rather than mixed into the dump.
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // Its own process group, so an interactive shell started from a terminal cannot
            // stop the desktop on the job-control signals it would otherwise raise.
            .process_group(0);
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => return (Err(error.to_string()), false),
        };
        let pid = child.id();
        let (sender, receiver) = mpsc::channel();
        // Collected on its own thread: a profile verbose enough to fill the pipe buffer
        // would deadlock against a parent that waits before it reads.
        thread::spawn(move || {
            let _ = sender.send(child.wait_with_output());
        });
        match receiver.recv_timeout(RESOLVE_TIMEOUT) {
            Ok(Ok(output)) => (parse(&output.stdout), false),
            Ok(Err(error)) => (Err(error.to_string()), false),
            Err(_) => {
                // The whole group: a profile that started helpers of its own must not
                // outlive the probe that ran it.
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
                (
                    Err(format!("no answer within {}s", RESOLVE_TIMEOUT.as_secs())),
                    true,
                )
            }
        }
    }

    fn parse(stdout: &[u8]) -> Result<HashMap<String, String>, String> {
        let text = String::from_utf8_lossy(stdout);
        let body = text
            .find(BEGIN_MARKER)
            .map(|begin| begin + BEGIN_MARKER.len())
            .and_then(|start| {
                text[start..]
                    .find(END_MARKER)
                    .map(|end| &text[start..start + end])
            })
            .ok_or("no complete environment dump in the output")?;
        let mut variables = HashMap::new();
        for entry in body.split('\0') {
            let entry = entry.trim_start_matches(['\r', '\n']);
            let Some((name, value)) = entry.split_once('=') else {
                continue;
            };
            if name.is_empty() || PROBE_ARTIFACTS.contains(&name) {
                continue;
            }
            variables.insert(name.to_owned(), value.to_owned());
        }
        if variables.is_empty() {
            return Err("the environment dump was empty".to_owned());
        }
        Ok(variables)
    }

    #[cfg(test)]
    mod tests {
        /// A profile prints banners, deprecation notices and progress; none of it is an
        /// environment entry, and the fence is what keeps the two apart.
        #[test]
        fn only_the_fenced_block_is_read_as_the_environment() {
            let dump = format!(
                "nvm: now using node v24.20.0\n{}\nPATH=/opt/homebrew/bin:/usr/bin\0LANG=zh_CN.UTF-8\0{}\nall done\n",
                super::BEGIN_MARKER,
                super::END_MARKER
            );
            let variables = super::parse(dump.as_bytes()).unwrap();
            assert_eq!(variables.len(), 2);
            assert_eq!(
                variables.get("PATH").map(String::as_str),
                Some("/opt/homebrew/bin:/usr/bin")
            );
            assert_eq!(
                variables.get("LANG").map(String::as_str),
                Some("zh_CN.UTF-8")
            );
        }

        /// A value may itself contain newlines or `=`; splitting on the first `=` only,
        /// inside a NUL-delimited dump, is what makes that safe.
        #[test]
        fn a_multiline_value_survives_the_dump() {
            let dump = format!(
                "{}\nLS_COLORS=a=1:b=2\0SCRIPT=line one\nline two\0{}",
                super::BEGIN_MARKER,
                super::END_MARKER
            );
            let variables = super::parse(dump.as_bytes()).unwrap();
            assert_eq!(
                variables.get("LS_COLORS").map(String::as_str),
                Some("a=1:b=2")
            );
            assert_eq!(
                variables.get("SCRIPT").map(String::as_str),
                Some("line one\nline two")
            );
        }

        #[test]
        fn a_truncated_dump_is_refused_rather_than_half_read() {
            let dump = format!("{}\nPATH=/usr/bin\0", super::BEGIN_MARKER);
            assert!(super::parse(dump.as_bytes()).is_err());
        }

        /// End to end against a real shell, without `-l`/`-i` so no profile on the build
        /// machine is sourced: the fence, the NUL dump and the probe marker's removal all
        /// hold.
        #[test]
        fn a_posix_shell_answers_with_its_environment() {
            let (result, timed_out) = super::attempt(std::path::Path::new("/bin/sh"), false);
            assert!(!timed_out, "a plain `sh -c` must not need the full budget");
            let variables = result.unwrap();
            assert!(
                variables.contains_key("PATH"),
                "the shell reported no PATH: {variables:?}"
            );
            for artifact in super::PROBE_ARTIFACTS {
                assert!(
                    !variables.contains_key(artifact),
                    "the probe's own {artifact} leaked into the resolved environment"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::path::PathBuf;

    /// The user put Homebrew ahead of `/usr/bin` on purpose. Appending the launch context
    /// instead of leading with it is what keeps the kernel and the Terminal agreeing on
    /// which `python3` they mean.
    #[test]
    fn the_login_shells_own_order_leads_the_search_path() {
        let merged = super::ordered_paths([
            Some(OsStr::new("/opt/homebrew/bin:/usr/bin:/bin")),
            Some(OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin")),
        ]);
        assert_eq!(
            merged,
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
                PathBuf::from("/usr/sbin"),
                PathBuf::from("/sbin"),
            ]
        );
    }

    /// Nothing the launch context carries may be dropped on the way, including when the
    /// login shell never answered at all.
    #[test]
    fn the_launch_context_is_kept_when_the_login_shell_is_silent() {
        let merged =
            super::ordered_paths([None, Some(OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin"))]);
        assert_eq!(merged.len(), 4);
        assert_eq!(merged[0], PathBuf::from("/usr/bin"));
    }
}
