# DeepSeek Harness Desktop

[![Community Build](https://github.com/spring-open/deepseek-harness-desktop/actions/workflows/community-build.yml/badge.svg)](https://github.com/spring-open/deepseek-harness-desktop/actions/workflows/community-build.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

DeepSeek Harness Desktop is an independent, unofficial community distribution built on the locked DeepSeek Harness Runtime. It does not require a separate Node.js, pnpm, Rust, or framework application installation at runtime. This project is not endorsed by or affiliated with DeepSeek.

Version `0.1.0-community.5` is the community edition. The macOS artifact uses a complete ad-hoc signature but has no Apple Developer ID identity or notarization; other current artifacts are unsigned. The desktop-owned source is Apache-2.0, while the packaged Harness, Node.js, and npm dependencies retain their own license notices.

Installers are published on the [GitHub Releases page](https://github.com/spring-open/deepseek-harness-desktop/releases). Verify the downloaded file against the accompanying `SHA256SUMS` before installation.

## Architecture

```text
Vue desktop shell
  -> one native window with isolated Shell and Harness webviews
  -> typed Tauri commands and redacted runtime events
Rust runtime supervisor
  -> target-specific Node sidecar
  -> locked Harness production closure
  -> http://127.0.0.1:<random-port>
Harness CredentialProvider
  -> short-lived session + JSON over stdin/stdout
  -> desktop helper
  -> local encrypted credential vault
```

The desktop uses one native window. When the Runtime is ready, Harness fills the window content area in an isolated child WebView above the resident Shell surface instead of reserving a duplicate in-window toolbar. The native **View** menu switches between **Workbench** (`Cmd/Ctrl+1`) and **Desktop Management** (`Cmd/Ctrl+2`). Settings, diagnostics, updates, and Runtime recovery therefore remain available without opening another operating-system window or covering Harness content. Capability matching is scoped to the `main` Shell WebView label, so the embedded Harness WebView receives no Tauri capability. It may navigate only within a managed loopback origin. A per-Runtime credential session is delivered through the Runtime standard input and is required by every helper request. Only its SHA-256 authorization digest is stored in the application data directory; the token and model credentials are never passed through command arguments, environment values, WebView IPC, or diagnostic exports. macOS, Windows, and Linux use the same XChaCha20-Poly1305 encrypted vault in the user-scoped application data directory. The vault uses authenticated encryption, atomic replacement, cross-process locking, and private Unix file modes; it never falls back to `.env`, YAML, browser storage, or plaintext credential files.

## Toolchain

- Node.js `24.16.0`
- pnpm `11.7.0`
- Rust `1.98.0`
- Tauri CLI `2.11.4`
- DeepSeek Harness `0.1.1-rc.2` at `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`

Rust is installed under the repository `target/deepseek-harness-desktop-toolchain/` by `scripts/with-rust.mjs`; no global Rust installation is changed.

## Development

```bash
git clone git@github.com:spring-open/deepseek-harness-desktop.git
cd deepseek-harness-desktop
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 --dir runtime install --frozen-lockfile
corepack pnpm@11.7.0 check:i18n
corepack pnpm@11.7.0 test
corepack pnpm@11.7.0 test:e2e
corepack pnpm@11.7.0 runtime:test-locale
corepack pnpm@11.7.0 runtime:stage
corepack pnpm@11.7.0 runtime:verify aarch64-apple-darwin
corepack pnpm@11.7.0 runtime:smoke
corepack pnpm@11.7.0 rust:test
corepack pnpm@11.7.0 rust:clippy
corepack pnpm@11.7.0 tauri:dev
```

`runtime/runtime-lock.json` is the source of truth for upstream artifacts. Runtime staging is generated on the native target and is never committed.

The staging command downloads the target-specific official Node.js archive into the repository `target/` cache, verifies its locked SHA-256, removes install-only wall-clock metadata and non-target native artifacts, and emits deterministic `runtime-manifest.json`, `licenses.json`, and `sbom.spdx.json` files. The allowed `node-pty` and Koffi native assets for every target are pinned in `runtime/runtime-lock.json`. Set `DEEPSEEK_HARNESS_DESKTOP_SMOKE_CYCLES=100` when running `runtime:smoke` for the release stability gate; the smoke also verifies parent-death cleanup on Unix.

`DEEPSEEK_HARNESS_DESKTOP_DATA_DIR` may be set for an isolated launch test. End users do not need it; without the override, Tauri's platform application-data directory is used.

The Desktop Shell ships `zh-CN`, `zh-TW`, and `en-US`. The locked Harness release currently ships only `zh` and `en`, so the startup bridge maps both Chinese desktop locales to upstream `zh` and English to `en`. It atomically updates the Harness settings document without discarding unrelated settings or comments. This is an explicit upstream capability boundary, not an untracked patch to generated Harness assets.

## One-command packaging

Run the following command from the repository root to verify the project and build an installer for the current operating system and architecture:

```bash
corepack pnpm@11.7.0 package:community
```

The command installs the locked root and Runtime dependencies, runs the community release gate, unit and end-to-end tests, Runtime verification and smoke checks, builds the native installer, validates the macOS signature and DMG when applicable, and writes the final files to `release/<version>/` with `BUILD-INFO.json` and `SHA256SUMS`.

One host builds only its native target. Cross-platform GitHub Releases are created from a matching annotated version tag such as `v0.1.0-community.5`; the release workflow publishes only after the macOS arm64/x64, Windows x64, and Linux x64 jobs all succeed.

## Release Boundary

Current community builds do not carry a trusted publisher identity and automatic updates are disabled. macOS artifacts use a complete ad-hoc Bundle signature but are not signed with Apple Developer ID and are not notarized. `pnpm release:check community` documents that boundary. A future stable build must pass `pnpm release:check stable`, provide updater, Apple, and Windows signing material, and complete native clean-machine acceptance before it may be published.

The CI matrix builds macOS arm64/x64, Windows x64, and Linux x64 artifacts. macOS arm64 and Windows x64 have also passed real installation, launch, graceful-exit, orphan-process, uninstall, and reinstall acceptance on local test systems; the Windows x64 acceptance ran on Windows 11 ARM64 through its system compatibility layer. A successful build on one platform is not evidence that another platform has passed installation acceptance.

The fish mark uses the exact DeepSeek Harness sidebar geometry and primary ink color from the locked upstream commit. It is used only to identify the bundled Runtime. DeepSeek Harness and its brand assets belong to their respective owner; this community distribution does not imply official endorsement.

Chinese installation, configuration, data-directory, security, and troubleshooting guidance is available in [docs/zh-CN/getting-started.md](docs/zh-CN/getting-started.md).
