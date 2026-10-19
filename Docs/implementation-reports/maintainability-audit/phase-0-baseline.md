# Maintainability Audit — Phase 0: Baseline

> **v2 note:** this report preserves the v1 evidence. Classification corrections and
> reconciled finding IDs live in `audit-changelog.md` (C1–C7) and `findings-register.md`
> (v2).

**Status:** COMPLETE (v1; all four scout maps merged — see §11)
**Date:** 2026-10-19
**Auditor:** omp coding assistant (lead reviewer) + read-only scout sub-agents

## 1. Target commit and environment (verified)

| Item | Value |
|---|---|
| Commit | `6dc9b0499321760f5a0bcd795fb4a9a11a1f87ff` |
| Subject | Merge pull request #3 — "docs/refactor project document" |
| Commit date | 2026-10-19 00:16:46 +0700 |
| Branch | `asset-project-maintainability` |
| Remote | `https://github.com/nyugennguyen/AIBridge.git` |
| Working tree | clean except untracked `Docs/implementation-plans/aibridge-maintainability-audit-plan.md` (the audit plan itself) and this audit output |
| History | 179 commits; latest tags `v2.1.5`, `v2.2.0`, `v3.0.0` |
| Host | macOS (darwin 27.0.0), arm64 |
| Bun | 1.3.14 — matches CI matrix pin (`ci.yml` `bun-version: ["1.3.14"]`) |
| Cargo | 1.99.0 (5f94df478) — matches `rust-toolchain.toml` pin (`channel = "1.99.0"`) |
| Node | v26.10.0 (not used by the project's own scripts; `engines.bun >= 1.3.0`) |
| Other tools on PATH | `rg`, `shellcheck` present (both required by repo scripts/gates) |

The HEAD commit is a large documentation refactor merged the same day as the audit.
Any claim that "documentation is stale" MUST be re-verified against HEAD, not against
historical reports (verified example in §5).

## 2. Repository inventory (verified counts)

| Area | Count |
|---|---|
| TypeScript source (`src/**/*.ts`) | 312 files, 104,950 lines |
| Tests (`tests/**/*.ts`) | 320 files (unit 264 / integration 26 / contracts 19 / load 4 / recovery 3 / security 3), ~132k lines incl. fixtures |
| Rust (`router/`, `crates/`) | 33 `.rs` files, 133,431 lines — of which **124,190 lines are the single generated file `router/src/contracts.rs`** and 9,806 are generated `crates/aibr-ipc/src/contracts.rs` (headers marked `@generated — DO NOT EDIT`) |
| Documentation (`Docs/**/*.md`) | 80 files; plus top-level `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CHANGELOG.md` |
| Workflows | `.github/workflows/{ci.yml, publish.yml, milestone-7.yml}` |
| Scripts | `scripts/` (10 files incl. `scripts/docs/`), `bench/`, `spike/`, `packaging/`, `bin/` |

TypeScript source by module (lines, descending):

```
mesh 28,234 | orchestration 19,254 | rules 10,798 | memory 7,140 | runtime 3,926
simulation 3,460 | budgets 3,411 | cli 3,232 | notifications 3,076 | host 2,834
context 2,578 | terminal 2,414 | workflows 2,101 | ipc 1,837 | application 1,673
routing 1,415 | server 948 | ingress 912 | storage 812 | observability 610
callback 601 | sdk 466 | upgrade 347 | diagnostics 314 | jobs 308 | opencode 250
registry 232 | config 177 | tasks 144 | security 97 | planning 14
```

Largest individual files (lines):

```
2,368 src/orchestration/coordinator/coordinator.ts
2,032 src/rules/evaluate.ts
1,559 src/orchestration/schemas.ts
1,478 src/rules/compile.ts
1,470 src/rules/preview.ts
1,425 src/mesh/gateway/terminal/gateway.ts
1,368 src/rules/types.ts
1,358 src/memory/in-memory-repository.ts
1,265 src/simulation/plan.ts
1,224 src/cli/setup-step-widgets.ts
```

## 3. Entry points and runtime topology (first-hand)

- `src/index.ts` (19 lines) — legacy dev entry: requires `AIBRIDGE_CONFIG`, optional
  `AIBRIDGE_BEARER_TOKEN`, boots `startBridge()` with repo-local `.aibridge` state.
- `src/bridge.ts` (129 lines) — `startBridge()` composition root: ingress runtime +
  Fastify app + optional shadow ingress mirror + notification bus/store/consumer.
  `attachNotificationConsumerToCommandLog()` decorates the CommandLog append path
  (event-driven, no polling).
- `src/cli.ts` (1,175 lines) — command table at line 152:
  `setup | start | serve | worker | status | verify | update | tui | bundle | discover`
  (+ hidden `_opencode`). `package.json` `bin`: `aibr -> dist/cli.js`, `aibr-router -> bin/aibr-router`.
- Rust: `router/` (aibr-router, tier-1 admission on tailscale0:8787),
  `crates/aibr-ipc` (wire codec + daemon/client bus), `crates/aibr-pty` (PTY supervision).
  Cargo workspace root is the repository root; `router/contract-gen` is a generator
  excluded from `default-members` (rationale documented in `Cargo.toml`).

## 4. Contract pipeline (verified from artifacts)

Canonical source: Zod schemas in `src/config/schemas.ts`, `src/orchestration/schemas.ts`,
`src/ipc/schemas.ts` (headers of generated files name these as single source of truth, ADR 0008 §2.3).

Chain: Zod → `z.toJSONSchema()` (`scripts/generate-contracts.ts`) → committed
`contracts/v1/*.schema.json` (48 files) → `typify` via `aibr-contract-gen`
(`router/contract-gen/src/main.rs`) → committed `router/src/contracts.rs` (35-file
admission partition) and `crates/aibr-ipc/src/contracts.rs` (13-file IPC partition).
`scripts/generate-parity-vector.ts` → committed `router/tests/parity-vector.json`
(cross-language accept/reject vector).

Gate: `bun run contracts:check` = regenerate + `git diff --exit-code` over all four
generated outputs + untracked-artifact check. CI (`ci.yml`) runs the same
regenerate-and-diff step plus `cargo fmt --check`, `cargo clippy -D warnings`,
`cargo test --workspace`. `package.json:_contractsCheckWhy` records a past incident
where `release:check` did not run the diff and a stale `bridge-config.schema.json`
shipped with a green local gate; release:check now includes `contracts:check`.

## 5. Documentation & validators (first-hand samples)

- `scripts/docs/check-docs.ts` (519 lines) — `bun run docs:check` gate with 8 checks:
  required entry points, internal links/anchors, mirrored skill trees
  (`.opencode/skills` canonical → `.claude`, `.agents` mirrors), `ci.yml` stays
  validation-only, `Docs/reference/cli-reference.md` matches `aibr --help`, every
  documented `aibr <command>` exists in the CLI, example configs parse with the real
  Zod schema, archive docs carry status markers.
- `tests/unit/documentation/uninstall-safety-check.test.ts` (398 lines) tests
  `validateMarkdownUninstallSafety`, `parseMarkdownSections`, `extractMarkdownAlerts`
  exported from `check-docs.ts` (regex-driven rule: broad `rm -rf` needs a `[!CAUTION]`/
  `[!WARNING]` alert). Two commits at HEAD (`e04cba1`, `efb3244`) fix false positives
  in this checker — observed maintenance cost of the validator itself.
- Rule duplication observed: "ci.yml is validation-only" is enforced BOTH by
  `check-docs.ts` check 4 and by `tests/unit/release/ci-workflow.test.ts`
  ("release authority — exactly one workflow may publish", 2 tests). [Verified duplication]
- The `debugging-aibr-v2` skill (mirrored ×3) states "the documentation lies" and lists
  commands that don't exist. At HEAD, `Docs/operations/troubleshooting.md` §2 now carries
  a "Fictional Commands Warning" table with real alternatives, and
  `Docs/architecture/current-state.md` marks the recovery runbook historical. The skill's
  framing is therefore itself partially stale as of HEAD. [Verified; skill text vs HEAD docs]
- Real CLI commands (`src/cli.ts:152`) confirmed against the skill's claim table.

## 6. CI / release workflows (first-hand)

- `ci.yml` — push/PR to `main`; single `verify` job: frozen install → shellcheck+`bash -n`
  installer → `docs:check` → `bun test` → typecheck → build → contract regenerate+diff →
  Rust fmt/clippy/test + parity vector → CLI smoke → `bun pm pack --dry-run`.
- `publish.yml` — sole publishing authority; triggers on GitHub Release published;
  tag↔version check; per-package npm registry preflight via `gitHead`;
  `bun run release:check` before publish; publish loop with explicit failure.
- `milestone-7.yml` — "Milestone 7 CI": musl cross-build matrix (cargo-zigbuild),
  readelf NEEDED check, systemd/nftables verification; runs on push/PR to `main`
  **and** `workflow_dispatch`.
- `release:check` (local) ≈ CI verify job with one difference noted in §7.

## 7. Test-runner duality — MEASURED (2026-10-19, this host)

| Command | Result | Duration |
|---|---|---|
| `bun run typecheck` | exit 0 | 6s |
| `bun run test` (vitest 4.1.9, Node) | **exit 1 — 7 failed**, 5,970 passed, 5 skipped, 278 files | 20.5s |
| `bun test` (Bun 1.3.14 built-in runner, what CI/release:check run) | **exit 0** — 5,977 pass, 5 skip, 0 fail, 278 files | 21.8s |
| `bun run docs:check` | exit 0 | <1s |
| `bun run build` | exit 0 | 3s |
| `bun run contracts:check` | exit 0 (regenerate + diff clean) | 4s |
| `cargo fmt --all --check` | exit 0 | 1s |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 | 16s (warm `target/`) |
| `cargo test --workspace` | exit 0 | 51s (warm `target/`) |

Verified facts:

- **The documented `bun run test` command is RED at HEAD** while the CI gate is green.
  All 7 failures are `tests/unit/host/runtime.test.ts > ProcessRunner > BunProcessRunner`
  (`exitCode` null, empty stdout). Root cause verified in `src/host/runtime.ts`:
  `BunProcessRunner.exec` calls `Bun.spawn`; under Node (vitest) `Bun` is undefined and the
  `catch` branch returns `{exitCode: null, stdout: "", stderr: <error>}` instead of failing
  loudly. Under `bun test` the same 7 tests pass. The production CLI is safe
  (`src/cli.ts`, `dist/cli.js` shebang `#!/usr/bin/env bun`; consumers of `BunProcessRunner`
  are `src/cli.ts`, `src/cli/verify.ts`, `src/cli/update.ts` only) — but `bun run dev`
  (`tsx src/index.ts`) runs the engine under Node, and the class silently no-ops there.
- Both runners executed the same 5,982 tests across 278 files at HEAD; the difference is
  runtime (Bun vs Node), not file selection. The skill's "different set" claim holds in a
  subtler sense: `tests/unit/event-store/outbox-helpers.ts` exercises `BACKENDS = ["node","bun"]`
  and `describe.skip`s the `bun:sqlite` driver under vitest ("driver unavailable in this
  runtime"), so bun-only SQLite paths are covered only by `bun test`.
- Test noise: "Tailnet Agent Discovery" UI output is printed ~7× during test runs under both
  runners (tests exercising discovery print interactive UI to stdout).
- `bun run dev`/`dev` script uses `tsx` (Node) while every other path runs Bun — runtime duality
  beyond the test runners.

Baseline wall time for the full local verification set (sequential, warm caches): **~124s**.
Cold-cache CI cost is dominated by install + musl matrix (`milestone-7.yml`, runs on every PR).

## 8. Baseline change-history facts (verified)

- 179 commits; feature commits are coarse (e.g. `19325ef` "Part A kernel — phases P0–P5"
  touched 30 contract files at once).
- Churn hotspots in `src/` (Σ added+deleted, commits touching):
  `orchestration/coordinator/coordinator.ts` 2,514/7, `rules/evaluate.ts` 2,036/2,
  `orchestration/schemas.ts` 1,595/6, `rules/compile.ts` 1,506/3, `cli.ts` 1,381/17.
  Note most hotspots are "large file created once" (churn == size, 1–3 commits); only
  `cli.ts` (17), `orchestration/projections/reducer.ts` (8), `orchestration/invariants.ts` (7),
  `coordinator.ts` (7) show repeated change.
- Docs churn is dominated by one-off plan/report documents
  (`Docs/superpowers/plans/*` appear in history; not in the tree at HEAD).

### Representative changes (plan §8 — approximated from history; live experiments not performed)

| Representative change | Commit | Footprint |
|---|---|---|
| 1. Small bug fix in a core flow ("restart-safe memory write-back sweep") | `7f34d8a` | 5 files: `coordinator.ts` +354, `coordinator/types.ts`, `event-store/outbox-store.ts`, `event-store/types.ts`, new 323-line test. A "small fix" in the 2,368-line coordinator costs hundreds of lines in the hottest file. |
| 2. Add a contract/config field (`bridge.ingress_mode`) | `5638d19` (+ `3f71790`, `42aba80` series) | 8 files in the closing commit: 7 × `contracts/v1/*.schema.json` + `router/src/contracts.rs` +77; fully mechanical after the Zod edit, gate-checked by `contracts:check`. Change cost is pipeline knowledge, not edit volume. |
| 3. Process-lifecycle/policy hardening ("post-review hardening + stranded phase work") | `50e6913` | 16 files spanning `scripts/generate-contracts.ts`, `src/bridge.ts`, `src/cli/verify.ts`, `coordinator.ts` +240, `server/app.ts`, `server/routes/orchestration.ts`, 6 test files (+2,300 lines), docs. Cross-module coordinated edit: kernel + CLI + server + contracts + docs. |

## 9. TS/Rust runtime boundary (from RustContractsMap scout; claims spot-verified)

1. **Network ingress (external → router):** `aibr-router` (axum HTTP/1; WebSocket deliberately
   unsupported so `/v1/mesh/terminal` cannot 101) parses bodies into **generated** contract
   types with `deny_unknown_fields`, 1 MiB body cap, `MAX_INFLIGHT = 64`, constant-time bearer
   compare (`router/src/auth.rs`, `subtle`). Commits to SQLite **before** returning 202
   (`IngressOutbox::admit`, `router/src/outbox.rs`) — commit-before-202 invariant.
2. **Router ↔ TS engine:** shared SQLite file (`AIBRIDGE_INGRESS_OUTBOX`), **no socket**.
   `aibr worker` (`src/ingress/worker.ts`, `src/ingress/drainer.ts`) claims rows and re-runs
   full Zod validation — Tier 2 is the sole authorization authority
   (`router/src/lib.rs:22-45` says admission ≠ authorization).
3. **Local IPC bus:** Unix socket `/tmp/aibr/aibrd.sock` (0700 dir), 4-byte BE length prefix +
   JSON, 8 MiB frame cap. TS listener `src/ipc/publisher.ts`; Rust twin `crates/aibr-ipc`
   (`frame.rs`, `message.rs`, `server.rs`). The Rust listener currently serves only tests.
4. **PTY:** `crates/aibr-pty` (`portable-pty`) emits `PtyChunk`/`PtyExit` via `PtySink`;
   **not wired to the bus** (no `PtySink` forwards to a listener; `EngineWorldSource`
   publishes `panes: []`; pane commands return `not_allowed`).

Spot-verified this session:
- `crates/aibr-ipc/src/lib.rs` doc comments reference `tests/protocol_version.rs` and
  `tests/socket_path_parity.rs`; **neither file exists** (`crates/aibr-ipc/tests/` holds
  `frame_cap_parity.rs`, `frame_codec.rs`, `server_listener.rs`). No test asserts
  `PROTOCOL_VERSION` ↔ `IPC_PROTOCOL_VERSION` (both are `1` by hand). [Verified]
- `aibr-ipc`/`aibr-pty` have **no production consumer in this repo**: grep shows only their
  own tests and `aibr-pty`'s use of `aibr_ipc::contracts` — the TUI that consumed them was
  retired in Phase 6. [Verified]

## 10. Initial hypotheses to test in later phases

| # | Hypothesis | Where tested |
|---|---|---|
| H1 | Docs/validator rule duplication (check-docs vs release tests vs skill mirrors) costs more than the drift it prevents | Phase 3 |
| H2 | `bun test` vs `vitest run` duality hides coverage gaps and confuses contributors | Phase 2 |
| H3 | Generated 124k-line `router/src/contracts.rs` committed to git inflates review/repo cost without proportional value | Phase 1/3 |
| H4 | `mesh/` (28k lines) and `orchestration/` (19k) hide overlapping state ownership (inbox/outbox, jobs/tasks, memory/storage) | Phase 1 |
| H5 | `simulation/`, `spike/`, `bench/` have no production consumers and are candidate REMOVE/ARCHIVE | Phase 1/3 |
| H6 | `src/security/` (97 lines) is a thin façade; security enforcement is scattered (mesh/identity, server routes, bridge) | Phase 2 |
| H7 | `milestone-7.yml` runs expensive musl matrix on every PR; possible CI cost reduction | Phase 3 |

## 11. Remaining Phase 0 work

- [x] Rust/contract boundary map merged (§9)
- [x] Tests map merged (Phase 2 inputs; inventory in §2)
- [x] Measured command durations (§7)
- [x] TS architecture map merged (entry points §3; module/layering/state/hotspot detail in `phase-1-architecture-code.md`)
- [x] Docs/CI/deps map merged (`phase-3-tooling-docs.md`; CI facts §6)

**Phase 0 complete.** Runtime flows traced in Phase 1 (`phase-1-architecture-code.md` §2).
