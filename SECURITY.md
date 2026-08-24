# Security Policy

## Supported versions

Security fixes are applied to the latest community release. Pre-release and older builds may require an upgrade before a fix can be provided.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository, or contact the SpringOpen maintainers privately through the organization profile.

Include the affected version, platform, reproduction steps, impact, and any suggested mitigation. Do not include real API keys, OAuth grants, workspace content, or other secrets.

## Security boundaries

- Model credentials must remain in the operating-system keychain.
- The application must fail closed when the keychain is unavailable.
- Runtime and diagnostic output must not expose credentials or short-lived helper sessions.
- Community artifacts without a publisher identity or notarization must not be represented as authenticated Stable releases.
