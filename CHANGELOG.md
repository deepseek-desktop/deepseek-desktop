# Changelog

All notable changes to DSH Desktop are documented in this file.

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
