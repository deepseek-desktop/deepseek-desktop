# Security Policy

## Supported versions

Security fixes are applied to the latest community release. Pre-release and older builds may require an upgrade before a fix can be provided.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository, or contact the project maintainers privately through the repository owner profile.

Include the affected version, platform, reproduction steps, impact, and any suggested mitigation. Do not include real API keys, OAuth grants, workspace content, or other secrets.

## Security boundaries

- Model credentials must remain in the authenticated encrypted vault under the user-scoped application data directory.
- The application must fail closed when the credential vault is unavailable, corrupted, or fails authentication.
- Credential storage must never fall back to `.env`, YAML, browser storage, logs, diagnostics, or another plaintext file.
- Runtime and diagnostic output must not expose credentials or short-lived helper sessions.
- Community artifacts without a publisher identity or notarization must not be represented as authenticated Stable releases.
