# AIBridge v1.0.1 Release and Changelog Design

## Goal

Publish the existing AIBridge `1.0.1` package version as a GitHub release and establish a concise, repository-owned changelog for the released versions `v1.0.0` and `v1.0.1`.

## Scope

- Create `CHANGELOG.md` at the repository root.
- Document `v1.0.0` as the initial stable release and `v1.0.1` as the patch release.
- Create lightweight Git tag `v1.0.1` from the final `main` release commit.
- Create a non-draft, non-prerelease GitHub Release named `AIBridge v1.0.1` with notes matching the changelog entry.
- Keep `dev` divergent from `main`; do not merge, rebase, reset, or force-push it.

## Release Content

### v1.0.0

Describe the first stable public AIBridge release: the private Tailscale bridge, two-host CLI profile workflow, bearer-token authentication, job execution/reporting, and release CI validation.

### v1.0.1

Describe the user-visible and reliability changes since `v1.0.0`:

- clearer bearer-token installation, verification, troubleshooting, and rotation guidance;
- regression coverage for authenticated invalid triggers and documentation requirements;
- a release check that builds before package smoke tests, with the CLI version aligned to `package.json`;
- GitHub Actions checkout upgrade to v5; and
- internal `.omo` workspace cleanup.

## Branch and Tag Policy

`main` is the only release source. Before tagging, the implementation must fetch and fast-forward/reconcile local `main` with `origin/main`, then add the changelog in a new commit on `main`. The `v1.0.1` tag must target that changelog commit so the tagged source contains the release record.

`dev` intentionally remains divergent. Do not push, reset, merge, rebase, or otherwise rewrite `dev` as part of this release.

The untracked `.github/workflows/ci.yml.bak` file is excluded from staging, commits, tags, and release assets. This release does not broaden `.gitignore` solely to cover that unrelated local artifact.

## Validation

Before creating the tag and GitHub Release:

- verify `package.json` and `aibr --version` both report `1.0.1`;
- run `bun run release:check` successfully;
- verify the changelog text agrees with the commits from `v1.0.0` through the final `main` release commit; and
- confirm `main` is clean and synchronized with `origin/main`.

After publication:

- confirm `refs/tags/v1.0.1` resolves to the intended `main` commit locally and on `origin`;
- verify the GitHub Release uses tag `v1.0.1`, title `AIBridge v1.0.1`, and the approved release notes; and
- verify no changes were made to `dev` or `.github/workflows/ci.yml.bak`.

## Non-Goals

- No npm publication.
- No generated release artifacts or binaries attached to GitHub.
- No retroactive change to the lightweight `v1.0.0` tag or release.
- No Unreleased changelog section.
