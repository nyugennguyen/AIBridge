# Changelog

## [1.1.0] - 2026-08-25

### Added

- curl|bash one-line installer at `scripts/install.sh` with OS detection, prereq prompts, and `bun install -g` for `@nyugennguyen/aibridge`.

## [1.0.1] - 2026-07-20

### Changed

- Improved bearer-token installation, verification, troubleshooting, and rotation guidance.
- Added regression coverage for authenticated invalid triggers and installation documentation.
- Made release validation build the package before CLI smoke tests and aligned the CLI version with package metadata.
- Updated the GitHub Actions checkout action to v5.
- Removed internal `.omo` workspace state from the repository.

## [1.0.0] - 2026-07-19

### Added

- First stable AIBridge release for coordinating OpenCode agents over a private Tailscale network.
- Two-host CLI profile setup, secure bearer-token authentication, remote job execution, and callback reporting.
- Release CI validation and package smoke tests.
