# npm Trusted Publishing Design

## Goal

Publish a validated AIBridge release to npm automatically after its GitHub Release is published.

## Scope

- Add a dedicated GitHub Actions workflow at `.github/workflows/publish.yml`.
- Trigger publishing only for `release: published` events.
- Use npm trusted publishing through GitHub Actions OIDC.
- Verify the release tag is exactly `v<package.json version>` before validation or publication.
- Document the one-time npm trusted-publisher configuration.

## Non-goals

- Publishing existing GitHub Releases retroactively.
- Token-based npm authentication.
- Changing the validation workflow that runs for pushes and pull requests.

## Workflow

The publish workflow grants only `contents: read` and `id-token: write`. It checks out the release tag, prepares Bun for the existing release checks, prepares Node 24 for an npm client that supports OIDC, reads the package version, fails if the GitHub Release tag differs from `v<version>`, runs `bun run release:check`, and runs `npm publish`.

The npm package must be configured on npmjs.com with trusted publisher values for GitHub owner `nyugennguyen`, repository `AIBridge`, and workflow filename `publish.yml`. No `NPM_TOKEN` is stored in GitHub.
