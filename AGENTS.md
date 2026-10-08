# AIBridge - Agent Instructions

TypeScript POC connecting opencode agents across machines via Tailscale.

## Commands

```bash
bun install          # install deps
bun run dev          # dev server (tsx src/index.ts)
bun test             # run all tests (vitest run)
bun run typecheck    # tsc --noEmit
bun run build        # tsc to dist/
```

Run a single test file: `bun test tests/unit/security/auth-provider.test.ts`

## Architecture

Fastify HTTP bridge on port 8787, talks to local `opencode serve` on port 4096.

```
src/
  server/       - Fastify app + routes (trigger, report, jobs, health)
  config/       - Zod schemas (schemas.ts), types (types.ts), loader
  security/     - Bearer auth, source authorization, project allowlist
  jobs/         - JobManager + JsonFileJobStore (file-backed in .aibridge/jobs/)
  opencode/     - SDK client adapter, session monitor, permission policy
  planning/     - Plan approval provider
  callback/     - Report callback reporter
  registry/     - Agent registry + router
```

Each module has `types.ts` (interfaces), implementation files, and mirrors in `tests/unit/`.

## Key Patterns

- **ESM only**: `"type": "module"`. All local imports MUST use `.js` extension: `import { foo } from "./bar.js"`.
- **Zod-first config**: Types are inferred from Zod schemas in `config/schemas.ts`, not hand-written. `config/types.ts` re-exports `z.infer<>` types.
- **Interface adapters**: External services (opencode SDK, fetch) are wrapped behind interfaces defined in `types.ts`. Tests use fakes (see `FakeOpencodeClient` in `tests/integration/fixtures.ts`).
- **Dependency injection**: `createApp()` takes `AppDependencies` object. No global state in routes.
- **Fastify inject**: Integration tests use `app.inject()` — no real HTTP server needed.

## Debugging

**Load the `debugging-aibr-v2` skill before debugging anything in this repo.** It records
where the docs and the source disagree — commands the runbook documents that do not exist,
`aibr bundle --preview` being broken, there being no log files, and why `aibr status` reporting
`healthy` proves almost nothing. Located at `.opencode/skills/debugging-aibr-v2/`
(mirrored to `.claude/skills/` and `.agents/skills/`).

## Testing

- Unit tests: `tests/unit/{module}/` — test individual classes/functions in isolation.
- Integration tests: `tests/integration/` — test full request flows through Fastify routes.
- Test helpers: `tests/integration/fixtures.ts` has `buildTestApp()`, `testConfig()`, `validTrigger()`.
- Unit test fixtures: `tests/unit/jobs/fixtures.ts` has shared job test data.

## Config

JSON config files in `config/`. Two example configs: `dev-main.example.json`, `test-vps.example.json`.

Required env vars at runtime:
- `AIBRIDGE_AGENT_ID` — this machine's agent identifier
- `AIBRIDGE_CONFIG` — path to config JSON
- `OPENCODE_SERVER_PASSWORD` — for opencode serve auth

## Operational

- Process management via tmux. `scripts/tmux-start.sh` starts both opencode serve and aibridge.
- Job state persisted as JSON files in `.aibridge/jobs/` (gitignored).
- Bridge port (8787) must be Tailscale-only. Never expose opencode serve publicly.
- opencode serve must use port 4096 explicitly.


## Release Procedure & Automated CI/CD Publishing

AIBridge uses automated CI/CD to validate and publish releases to npm whenever a new version is released on `main`.

### 1. Pre-Release Verification

Run the full verification gate locally:

```bash
bun run release:check
```

This verifies:
1. Frozen lockfile installation
2. TypeScript compilation (`dist/`)
3. Vitest test suite execution
4. Typecheck (`tsc --noEmit`)
5. Shellcheck and syntax validation of install scripts
6. Contract parity and CLI smoke checks
7. Package tarball dry-run packaging

### 2. Version Bump

Update the version number across the repository:
- `package.json`: `"version": "x.y.z"`
- `src/version.ts`: `CLI_VERSION` — the single source of truth every version report in the CLI reads (splash banner, `--version`, `aibr update`, diagnostics bundle)
- `CHANGELOG.md`: document new features, fixes, and changes under `## [x.y.z]`

`publish.yml` refuses a release tag that does not match `package.json`, which catches the mismatch in the direction that matters. The reverse drift is not caught automatically, which is why the version lives in one place rather than being written out at each use site.

### 3. Merge or Push to `main`

```bash
git add package.json src/version.ts CHANGELOG.md
git commit -m "chore(release): prepare vx.y.z"
git push origin main
```

### 4. Automated Publishing

Whenever code is pushed to `main`:
- The **CI** workflow (`.github/workflows/ci.yml`) runs the full `verify` gate (tests, typecheck, build, contract parity).
- The automated **`publish`** job inspects the repository version against the latest published version on the npm registry (`npm view @nyugennguyen/aibridge version`).
- If the version has been bumped, it validates the release package and publishes `@nyugennguyen/aibridge` to npm automatically.
- Authentication supports npm Automation Tokens (`NPM_TOKEN` stored in GitHub repository secrets) and npm OIDC Trusted Publishing with cryptographic provenance.

### 5. Tagging the Release

Create the corresponding git tag and GitHub Release:

```bash
git tag vx.y.z
git push origin vx.y.z
gh release create vx.y.z --title "AIBridge vx.y.z" --notes "Release notes..."
```
