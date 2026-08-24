# Changelog

All notable changes to DSH Desktop are documented in this file.

## 0.1.0-community.2 - 2026-08-25

- Replace platform keychains with one cross-platform authenticated encrypted credential vault, removing repeated system authorization prompts.
- Stop describing every Provider authentication failure as an invalid API key, and keep model-facing sandbox policy text out of the ordinary conversation view.
- Fix Credential Provider calls when Cordis wraps the service in a Proxy.
- Roll back a newly created custom Provider when its credential cannot be stored.
- Clarify sandbox and approval policy context shown to the model.
- Retry early Runtime failures from the persisted workspace, make repeated starts idempotent, and suppress duplicate actions during transitions.
- Clear page-specific operation notices when navigating between Shell views.
- Disable spelling, automatic correction, automatic capitalization, and writing suggestions in managed Harness inputs without changing entered values.
- Add packaged credential-vault helper, plaintext-leak checks, Runtime patch, and provider regression checks.

## 0.1.0-community.1 - 2026-08-24

- Added the standalone Vue 3 and Tauri 2 desktop Shell.
- Added the locked DeepSeek Harness and Node.js Runtime staging pipeline.
- Added Runtime supervision, recovery, process-tree cleanup, and loopback readiness checks, including explicit Rustls provider initialization, panic recovery, and Windows verbatim-path normalization for Node module loading.
- Added the operating-system keychain Credential Provider and redacted diagnostics.
- Added `zh-CN`, `zh-TW`, and `en-US` Shell localization.
- Added macOS, Windows, and Linux community build workflows.
- Replaced the Shell, favicon, application, installer, and platform icons with the DeepSeek Harness sidebar fish mark and primary ink color from the locked upstream commit.
- Verified the macOS arm64 DMG with a complete ad-hoc Bundle signature, isolated installation, real window launch, graceful exit, and 100 Runtime start/stop cycles.
- Verified the Windows x64 NSIS installer on Windows 11 ARM64 through the operating system x64 compatibility layer, including checksum parity, install, launch, responsive window, graceful exit, orphan-process cleanup, uninstall, reinstall, and relaunch.
