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
bun test                     # run all tests via vitest
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
  cli/             - CLI command implementations (setup wizard, verify, discover, doctor)
  jobs/            - JobManager, JsonFileJobStore (file-backed in .aibridge/jobs/)
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

Required env vars at runtime:
- `AIBRIDGE_AGENT_ID` — this machine's agent identifier
- `AIBRIDGE_CONFIG` — path to config JSON
- `OPENCODE_SERVER_PASSWORD` — for opencode serve auth
- `AIBRIDGE_OPERATOR_TOKEN` — operator credential token granting user-kind `actor` claims for charter approval authority, human roundtable injection, and emergency intervention

## Operational

- Process management: headless via `tmux` or interactive via Herdr workspace manager. `scripts/tmux-start.sh` starts background services for headless environments.
- Terminal backend: selected via `terminal.backend` in config (`"tmux"` for headless VPS nodes, `"herdr"` for interactive operator workstations).
- Presentation: `aibr-tui` is retired; `aibr tui` checks Herdr availability and launches/links the `aibr-manager` Herdr plugin.
- Job state persisted as JSON files in `.aibridge/jobs/` (gitignored), with orchestration state managed in SQLite event stores.
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
