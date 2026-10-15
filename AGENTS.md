# AIBridge - Agent Instructions

Distributed multi-agent orchestration runtime connecting OpenCode, Claude Code, and Codex agents across machines via Tailscale mesh networking, governed by an event-sourced kernel, versioned charters, immutable safety policies, and Herdr workspace presentation.

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
bun test tests/unit/orchestration/roundtable.test.ts
bun test tests/integration/herdr-roundtable.test.ts

# Code Generation & Parity Checks
bun run generate:contracts   # regenerate JSON schemas and Rust contracts
bun run contracts:check      # verify parity between TS schemas, JSON schemas, and Rust crates

# Release Verification Gate
bun run release:check        # full pre-release gate (frozen install, build, test, typecheck, lint, pack)
```

## Architecture

The system coordinates multi-agent workloads across machines with a strict separation of concerns:
**Herdr owns the terminal; the AIBridge kernel owns the intent.**

```
src/
  orchestration/   - Kernel: Event store (SqliteEventStore), coordinator, charter repository
                     & proposal lifecycle, RoleAssignment & RoleBinder, advisory roundtable
                     deliberation, fan-out scheduler, policy & immutable core validator
  mesh/            - Distributed mesh protocol: 11 record types, controller leases, epochs,
                     SSE total-order event gateway, terminal WebSocket gateway, in/outbox
  notifications/   - Advisory-only notification bus, store, quieting rules, and orchestration
                     event consumer (zero upward dependencies, isolated per ADR 0007 §17)
  terminal/        - TerminalBackend abstraction: TmuxTerminalBackend (headless VPS / default)
                     and HerdrTerminalBackend (interactive Herdr workstation integration)
  ingress/         - Durable ingress admission queue, commit-before-202 WAL, router client
  rules/           - Layered rule engine, expression evaluator, SAFETY_FLOOR, limit checks
  budgets/         - Budget ledgers tracking agent concurrency and fan-out as separate counters
  memory/          - Scoped memory storage, redaction pipelines (secret scrub), write-back
  runtime/         - RoleBinder (deterministic prompt compile), runtime adapters (OpenCode,
                     Claude Code, Codex), capability intersection, conformance kit
  context/         - Deterministic context assembler and workspace isolation auditor
  server/          - Fastify HTTP bridge (port 8787), SSE streams, routes (trigger, report,
                     jobs, health, orchestration, charter, roundtable, discovery)
  security/        - Bearer auth (BearerAuthProvider, OpenAuthProvider), source authorization,
                     project allowlists, actor claims, operator tokens (AIBRIDGE_OPERATOR_TOKEN)
  config/          - Zod schemas (schemas.ts), inferred types (types.ts), profile loader
  host/            - Host environment probes, binary detection, platform supervisor generators
  cli/             - CLI command implementations (setup wizard, verify, discover)
  jobs/            - JobManager, JsonFileJobStore (file-backed in `<stateDir>/jobs/`, e.g. `~/.local/state/aibridge/<profile>/jobs/`)
  opencode/        - Legacy OpenCode SDK adapter, session monitor, permission policies
  planning/        - Plan approval provider
  callback/        - Report callback reporter and egress outbox
  registry/        - Mesh-aware agent registry and capability router
  diagnostics/     - Diagnostics bundle generator and system health probes
```

### Rust Workspace (`crates/` and `router/`)

- `router/` — High-performance polyglot ingress router (`aibr-router`) built in Rust for sub-millisecond commit-before-202 admission.
- `crates/aibr-ipc` — Wire contracts (generated from `src/ipc/schemas.ts`), 4-byte framing, and Unix domain socket transport.
- `crates/aibr-pty` — Headless PTY child process supervision using `portable-pty`.
- *(Note: `crates/aibr-tui` and `src/tui/` are retired in Phase 6 in favor of the Herdr manager plugin).*

### Sibling Repositories & Presentation

- **Herdr Fork (`herdrdev/herdr` branch `aibr-orchestration`)**: Thin fork providing F1 atomic input-ownership fencing (`pane.claim_input` / `pane.release_input`) and F2 first-class `role` fields on pane/agent records.
- **`aibr-manager`**: Herdr plugin pane (Bun + OpenTUI) embedding Role Grid, Charter Editor, Roundtable Live Transcript, Multi-Machine Grid, and Approval Queue.
- **`aibr-herdr-bridge`**: Herdr plugin subscribing to remote Tailscale mesh nodes and projecting remote agents into the local Herdr workspace.

## Key Patterns

- **ESM only**: `"type": "module"`. All local imports MUST use `.js` extension: `import { foo } from "./bar.js"`.
- **Zod-first config**: Types are inferred from Zod schemas in `config/schemas.ts`, not hand-written. `config/types.ts` re-exports `z.infer<>` types.
- **Kernel as Single Source of Truth**: All orchestration lifecycle changes are committed to the append-only event store (`SqliteEventStore`). External tools, TUIs, and presentation plugins consume read-only projections from the total-order SSE gateway.
- **The Immutable Core**: `assertCharterDoesNotRelaxCore` strictly refuses any charter proposal attempting to modify the safety floor, input fencing, security perimeter, advisory roundtable invariant, budget limits, or kernel authority.
- **Advisory-Only Deliberation & Notifications**: Roundtable deliberations and notifications are strictly advisory. `roundtable.closed` appears in zero `COMMAND_EVENT_ALLOWLIST` entries; deliberation produces recommendations, never direct state transitions. Notifications never throw into or branch orchestration logic.
- **Deterministic Prompt & Capability Compilation**: Prompts are deterministically compiled and digest-stamped: $\text{Charter} + \text{primaryRole} + \sum\text{secondaryRole.addenda} + \text{policy} + \text{taskPrompt}$. Capability envelopes enforce strict intersection ($\text{allowed} \cap \text{roleAllowed} \cap \neg\text{denied}$).
- **Interface adapters**: External services (runtimes, terminal backends, network probes) are wrapped behind interfaces defined in `types.ts`. Tests use fakes.
- **Dependency injection**: `createApp()` takes an `AppDependencies` object. No global state in routes.
- **Fastify inject**: Integration tests use `app.inject()` — no real HTTP server needed.

## Debugging

**Load the `debugging-aibr-v2` skill before debugging anything in this repo.** It records
where the docs and the source disagree — commands the runbook documents that do not exist,
`aibr bundle --preview` being broken, there being no log files, and why `aibr status` reporting
`healthy` proves almost nothing. Located at `.opencode/skills/debugging-aibr-v2/`
(mirrored to `.claude/skills/` and `.agents/skills/`).

## Testing

- **Unit tests**: `tests/unit/{module}/` — test individual modules, aggregators, policies, and algorithms in isolation.
- **Integration tests**: `tests/integration/` — test end-to-end flows through Fastify routes via `app.inject()`, including roundtable loops and mesh relays.
- **Contract parity tests**: `tests/contracts/` — verify schema parity between TypeScript schemas (`src/config/schemas.ts`, `src/orchestration/schemas.ts`), generated JSON Schemas (`contracts/v1/`), and Rust contracts (`router/src/contracts.rs`, `crates/aibr-ipc/src/contracts.rs`).
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
  - `AIBRIDGE_OPERATOR_TOKEN` — operator credential token granting user-kind `actor` claims for charter approval authority (`src/bridge.ts`)
  - `OPENCODE_PORT` — port for opencode serve (defaults to 4096; prompted by setup wizard)
## Operational

- Process management: headless via `tmux` or interactive via Herdr workspace manager. `scripts/tmux-start.sh` starts background services for headless environments.
- Terminal backend: selected via `terminal.backend` in config (`"tmux"` for headless VPS nodes, `"herdr"` for interactive operator workstations).
- Presentation: `aibr-tui` is retired; `aibr tui` checks Herdr availability and launches/links the `aibr-manager` Herdr plugin.
- Job state persisted as JSON files under `<stateDir>/jobs/` (by default `~/.local/state/aibridge/<profile>/jobs/` in profile deployments, or `.aibridge/jobs/` in local legacy dev runs), with orchestration state managed in SQLite event stores.
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
