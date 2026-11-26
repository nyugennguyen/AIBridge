# AIBridge - Agent Instructions

Job dispatch between agent machines (Claude Code and OpenCode workers today, Codex planned) over a Tailscale network: signed requests, operator approval on the worker, and a durable outbox for reports. Claude Code with the AIBridge plugin is the operator interface (ADR 0014).

## Commands

```bash
# Dependencies & Build
bun install                  # install dependencies
bun run build                # compile TypeScript to dist/ (tsc -p tsconfig.build.json)
bun run typecheck            # typecheck without emit (tsc -p tsconfig.json --noEmit)

# Development & Server
bun run dev                  # start development bridge server (tsx src/index.ts)
bun run start                # run compiled bridge server from dist/ (bun dist/index.js)
bun run aibr -- <args>       # run local CLI entrypoint (bun src/cli.ts)

# Testing
bun test                     # run tests via Bun's built-in test runner (vitest is `bun run test`)
bun run test:unit            # run unit tests only (tests/unit)
bun run test:integration     # run integration tests only (tests/integration)
bun run test:installer       # shellcheck, bash syntax, and installer tests

# Run a single test file
bun test tests/unit/jobs/manager.test.ts
bun test tests/integration/trigger-flow.test.ts

# Code Generation & Parity Checks
bun run generate:contracts   # regenerate JSON schemas and Rust contracts
bun run contracts:check      # verify parity between TS schemas, JSON schemas, and Rust crates

# Release Verification Gate
bun run release:check        # full pre-release gate (frozen install, build, test, typecheck, lint, pack)
```

## Architecture

The system dispatches jobs between machines. **Claude Code (or another MCP-capable agent) dispatches and follows work; humans approve in the `aibr` CLI on the worker.** What actually runs is the Fastify bridge (`aibr serve`), the job manager and runner, the approval ledger, signed requests and the MCP server. Roughly 11,000 of the 50,000 lines in `src/` are not reachable from `src/cli.ts` or `src/index.ts`, all of it kept on purpose with deadlines (see "Not yet wired" below); `bun run docs:reachability` measures this.

```
src/
  cli.ts, cli/       - `aibr` commands: init, doctor, ping, send, start/stop/serve, logs, approve,
                       enroll, plugin, mcp, update, setup wizard, verify, discover
  index.ts, bridge.ts- Bridge process entry point and wiring (`createApp()` dependencies)
  server/            - Fastify HTTP bridge (port 8787): routes trigger, report, jobs, job-api
                       (list, events, cancel), operator (approve/reject), health, enroll;
                       claude-dispatch and opencode-dispatch
  jobs/              - JobManager, JsonFileJobStore (`<stateDir>/jobs/`), job event log
                       (`<sha256(id)>.events.jsonl`, `JobEventLog`), cancel, approval ledger,
                       report handling
  runtime/           - Claude Code job runner and adapter, OpenCode adapter, repo-workspace
                       (job pinned to repo@sha in its own git worktree), script runner,
                       result sanitizer
  opencode/          - OpenCode SDK client, session monitor, tool permission policy
  security/          - Bearer auth, source authorization, project allowlists, operator token
  mesh/              - What is left of the mesh after 3.2.0 D4: `identity/` (ed25519 node keys,
                       peer key pins, request signing, replay guard), `protocol/{envelope,
                       bounds,identifiers}` (wire ids, replay window), `outbox/policy.ts`
                       (delivery backoff shared by the egress outbox, the ingress drainer and
                       the Rust router)
  pairing/           - `aibr enroll` pairing codes and peer store
  mcp/               - `aibr mcp` MCP server (`bridge_*` tools); the Claude Code plugin in
                       `plugins/aibridge` uses it
  ingress/           - Router-mode drain worker (`aibr worker`) for the Rust router outbox
  callback/          - `/report` reporter and durable egress outbox
  planning/          - Plan approval provider
  config/            - Zod schemas (`schemas.ts`), inferred types (`types.ts`), profile loader
  host/              - Host probes, binary detection, service (launchd/systemd) generators, paths
  diagnostics/       - Diagnostics bundle and health probes
  tasks/             - Task file parser and syncer
  orchestration/     - What is left after 3.2.0 D5: the Zod schemas behind `contracts/v1`
                       (`schemas.ts`), identifiers, errors, digests, session transitions,
                       role snapshot digests used by `runtime/binder.ts`, and the event
                       store (`event-store/`, not yet wired; `sqlite-driver.ts` is shared
                       with the egress outbox and the drain worker)
  notifications/     - Bus, store and payload types; not yet wired (V5, 3.5.0)
```

### Rust Workspace (`router/`)

- `router/` is the optional ingress router (`aibr-router`), written in Rust for sub-millisecond commit-before-202 admission. It is enabled with `bridge.ingress_mode: "router"`; router mode admits on the bearer token only (no request signing, no Claude Code runtime).
- *(The `aibr-ipc` and `aibr-pty` crates, `aibr-tui` and the TUI were removed in 3.1.1, ADR 0014.)*

### Not yet wired

Code that is built and tested but not reachable from the entry points. Decisions and deadlines are in [ADR 0016](Docs/adr/0016-keep-selected-unwired-code-with-deadlines.md); the exemption list is `scripts/docs/reachability-exemptions.json`. A kept path that misses its wire deadline is deleted at its delete deadline.

| Path | Serves | Wire by | Delete by |
|---|---|---|---|
| `src/memory` (redaction is wired in 3.2.0) | V4 handoff, V3 project memory | 3.3.0 | 3.4.0 |
| `src/orchestration/event-store` | V4 job event log (ADR 0003) | 3.3.0 | 3.4.0 |
| `src/runtime/codex-adapter.ts`, `src/runtime/discovery.ts` | V1 Codex runtime | 3.3.0 | 3.4.0 |
| `src/context` | V3 context snapshot | 3.4.0 | 3.5.0 |
| `src/notifications` | V5 Discord and Telegram | 3.5.0 | 3.6.0 |

Removed in 3.2.0 (blocks D1 to D5, ADR 0016): the orchestration kernel (coordinator, scheduler, projections, charter and roundtable runtime, policy evaluation and immutable core, legacy translation and migration, `POST /orchestration/*`) and the notification consumer in D5; the dead part of `src/mesh` (leases, inbox, registry, gateway, outbox transport, record families, fault harness, protocol negotiation) in D4 and D5; `src/rules` in D2; `src/budgets`, `src/workflows`, `src/simulation`, `src/routing`, `src/registry`, `src/sdk` and `src/upgrade` in D1. The design stays in the `archive/kernel-mesh-3.1.1` tag. `src/orchestration/schemas.ts` still holds the kernel's command, event, charter and roundtable schemas because `contracts/v1` is generated from it; nothing running uses those record types.

## Key Patterns

- **ESM only**: `"type": "module"`. All local imports MUST use `.js` extension: `import { foo } from "./bar.js"`.
- **Zod-first config**: Types are inferred from Zod schemas in `config/schemas.ts`, not hand-written. `config/types.ts` re-exports `z.infer<>` types.
- **Job state is the JSON job store**: a job's lifecycle lives in `JsonFileJobStore` (`<stateDir>/jobs/`) and its event log; the approval ledger records approvals, decisions and kill-switch use (ADR 0013). The SQLite event store is not wired yet (V4).
- **Humans approve**: no agent, peer or trigger field (e.g. `metadata.plan_status`) can approve a job; only an operator on the worker can (`aibr approve`, operator token, same-host check).
- **Deterministic prompt binding**: the runtime adapters build the prompt and tool policy through `RoleBinder` (`src/runtime/binder.ts`): byte-identical output for the same inputs, digest-stamped. Capability envelopes are a strict intersection ($\text{allowed} \cap \text{roleAllowed} \cap \neg\text{denied}$, `computeCapabilityEnvelope`).
- **Interface adapters**: External services (runtimes, network probes) are wrapped behind interfaces defined in `types.ts`. Tests use fakes.
- **Dependency injection**: `createApp()` takes an `AppDependencies` object. No global state in routes.
- **Fastify inject**: Integration tests use `app.inject()` — no real HTTP server needed.

## Debugging

**Load the `debugging-aibr-v2` skill before debugging anything in this repo.** It records
where the docs and the source disagree — commands the runbook documents that do not exist,
`aibr bundle --preview` being broken, where the one log file is (`aibr logs`), and why `aibr status` reporting
`healthy` proves almost nothing. Located at `.opencode/skills/debugging-aibr-v2/`
(mirrored to `.claude/skills/` and `.agents/skills/`).

## Testing

- **Unit tests**: `tests/unit/{module}/` — test individual modules, aggregators, policies, and algorithms in isolation.
- **Integration tests**: `tests/integration/` — test end-to-end flows through Fastify routes via `app.inject()`.
- **Contract parity tests**: `tests/contracts/` — verify schema parity between TypeScript schemas (`src/config/schemas.ts`, `src/orchestration/schemas.ts`), generated JSON Schemas (`contracts/v1/`), and Rust contracts (`router/src/contracts.rs`).
- **Security tests**: `tests/security/` — verify token redaction pipelines, secret filtering (`canary-token-audit.test.ts`), and permission boundaries.
- **Test helpers**: `tests/integration/fixtures.ts` has `buildTestApp()`, `testConfig()`, `validTrigger()`.

## Config & Environment

JSON config files in `config/` or stored in platform profile directories via `aibr setup`. Example configs: `dev-main.example.json`, `test-vps.example.json`.

Environment variables:
- Required:
  - `AIBRIDGE_CONFIG` — path to config JSON (`src/index.ts`, `router/src/config.rs`)
  - `AIBRIDGE_BEARER_TOKEN` — shared secret token for router (`router/src/config.rs`) and engine in bearer mode (`src/index.ts`)
  - `AIBRIDGE_INGRESS_OUTBOX` — path to router admission store SQLite database (`router/src/outbox.rs`, `src/ingress/worker.ts`)
- Optional / conditional:
  - `AIBRIDGE_AGENT_ID` — identifier required only by `scripts/tmux-start.sh` (forwarded when set in `src/host/tmux.ts`)
  - `OPENCODE_SERVER_PASSWORD` — for opencode serve auth; falls back to secrets file `secrets/opencode_password` (`src/cli.ts`)
  - `AIBRIDGE_OPERATOR_TOKEN` — operator credential for `aibr approve`, reject, `aibr stop --all-jobs` and reading any job (`src/bridge.ts`, `src/security/operator-auth.ts`)
  - `OPENCODE_PORT` — port for opencode serve (defaults to 4096; prompted by setup wizard)
## Operational

- Process management: `aibr start` installs a per-profile user service (launchd `com.aibridge.<profile>` / systemd `aibridge-<profile>.service`) running `aibr serve`; `aibr start --foreground` runs the same in tmux for development; `aibr stop` stops both. Logs: `<stateDir>/logs/aibridge.log` (`aibr logs -f`).
- Terminal supervision is tmux. The `terminal` config key was removed in 3.2.0 (a profile that still has it loads and warns).
- Presentation: there is no TUI. Claude Code with the AIBridge plugin is the main interface; operator actions (`aibr jobs pending`, `aibr approve`, `aibr stop --all-jobs`, `aibr logs`) run on the worker. `aibr tui` was removed in 3.2.0.
- Job state persisted as JSON files under `<stateDir>/jobs/` (by default `~/.local/state/aibridge/<profile>/jobs/` in profile deployments, or `.aibridge/jobs/` in local legacy dev runs). Each job's events (`GET /jobs/:id/events`) are appended next to it as `<sha256(id)>.events.jsonl`, redacted and capped per job; neither file is ever pruned.
- Bridge port (8787) must be Tailscale-only. Never expose opencode serve publicly.
- opencode serve defaults to port 4096 (`OPENCODE_PORT` or setup wizard prompt).

## Release Procedure & Automated CI/CD Publishing

AIBridge uses `.github/workflows/ci.yml` for pull request and branch validation only. Automated npm package publishing is handled exclusively by `.github/workflows/publish.yml` triggered on GitHub Release published events.

### 1. Pre-Release Verification

Run the full verification gate locally:

```bash
bun run release:check
```

This verifies:
1. Frozen lockfile installation
2. TypeScript compilation (`dist/`)
3. Bun test suite execution
4. Typecheck (`tsc --noEmit`)
5. Shellcheck and syntax validation of install scripts
6. Contract parity (`contracts:check`) and CLI smoke checks
7. Package tarball dry-run packaging (`bun pm pack --dry-run`)

### 2. Version Bump

Update the version number across the repository:
- `package.json`: `"version": "x.y.z"`
- `src/version.ts`: `CLI_VERSION` — the single source of truth every version report in the CLI reads (splash banner, `--version`, `aibr update`, diagnostics bundle)
- `CHANGELOG.md`: document new features, fixes, and changes under `## [x.y.z]`

The publishing workflow verifies that the release tag matches `format('v{0}', package.version)`.

### 3. Merge or Push to `main`

```bash
git add package.json src/version.ts CHANGELOG.md
git commit -m "chore(release): prepare vx.y.z"
git push origin main
```

Pushes to `main` run `.github/workflows/ci.yml` (validation only: build, test, typecheck, contract checks). CI does not publish packages.

### 4. Tagging and Publishing via GitHub Release

To publish to npm, create a git tag matching the bumped version and publish a GitHub Release:

```bash
git tag vx.y.z
git push origin vx.y.z
gh release create vx.y.z --title "AIBridge vx.y.z" --notes "Release notes..."
```

When a GitHub Release is published:
1. `.github/workflows/publish.yml` triggers on `release: [published]`.
2. It verifies the release tag matches `v<version>` from `package.json`.
3. A duplicate-version preflight inspects npm registry state per package via `gitHead`:
   - Skips packages already published from this exact release commit.
   - Fails if a version is already published from a different commit.
4. Runs `bun run release:check` gate before publishing.
5. Publishes queued packages to npm with provenance/OIDC or `NPM_TOKEN`.
