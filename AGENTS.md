# Agent Guide

## Scope

This repository contains only DeepSeek Desktop. Generated Runtime staging, build output, local toolchains, upstream audit checkouts, credentials, and user workspace data must never be committed.

## Source of truth

- `runtime/runtime-lock.json` owns upstream Runtime versions, checksums, target triples, and desktop patches.
- `src-tauri/` owns native lifecycle, the encrypted credential vault, diagnostics, settings, and updater boundaries.
- `src/` owns the Vue desktop Shell and typed IPC contracts.
- `README.md`, `docs/`, `SECURITY.md`, and `CONTRIBUTING.md` define public behavior and contribution rules.

## Change rules

- Keep user-visible text complete in `zh-CN`, `zh-TW`, and `en-US`.
- Keep the Harness WebView isolated from generic Tauri shell, filesystem, and IPC capabilities.
- Never add plaintext credential fallback storage.
- Do not claim signing, notarization, platform support, or external Provider compatibility without real verification.
- Keep changes focused and preserve the locked Runtime unless an intentional upgrade updates checksums, notices, SBOM expectations, tests, and documentation together.

## Verification

Run the smallest relevant checks during development. Before a release-oriented change, run:

```bash
corepack pnpm@11.7.0 verify
corepack pnpm@11.7.0 test:e2e
corepack pnpm@11.7.0 runtime:smoke
```

`verify` stages and verifies the target Runtime before invoking Rust so a clean checkout never depends on a previously generated sidecar.
