# Contributing

Thank you for helping improve DSH Desktop.

## Before opening a change

1. Search existing issues and pull requests.
2. Keep changes focused on one behavior or engineering concern.
3. Never commit credentials, local workspaces, generated Runtime staging, build output, or upstream audit checkouts.
4. Preserve the locked Runtime contract unless the change explicitly upgrades it with matching checksums, licenses, tests, and documentation.

## Development setup

```bash
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 --dir runtime install --frozen-lockfile
corepack pnpm@11.7.0 verify
corepack pnpm@11.7.0 test:e2e
```

`verify` stages the target Runtime before Rust checks. The repository-local scripts install Rust under `target/dsh-desktop-toolchain/`; they do not modify the global Rust installation.

## Pull requests

- Explain the user-visible behavior and security impact.
- Add or update `zh-CN`, `zh-TW`, and `en-US` together for visible text.
- Run the checks relevant to the changed area and include the results.
- Keep the Harness WebView isolated from generic Tauri shell, filesystem, and IPC capabilities.
- Do not claim signing, notarization, platform support, or external Provider compatibility without real evidence.

By contributing, you agree that your contribution is licensed under Apache-2.0.
