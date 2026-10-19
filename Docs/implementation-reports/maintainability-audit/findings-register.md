# Maintainability Audit — Findings Register (v2)

**Commit:** `6dc9b0499321760f5a0bcd795fb4a9a11a1f87ff` · v1 published 2026-10-19; v2
refinement same day. Production code untouched. **IDs are permanent**: none renumbered or
deleted; reclassifications are marked inline with their changelog entry
(`audit-changelog.md` C1–C7). v1 wording preserved as evidence; corrections documented,
not erased.

**Evidence legend:** **F** = verified fact (executed/inspected), **H** = hypothesis
[INFERENCE], **NE** = not verified. **Consumer-evidence tiers** for deletion candidates:
`in-repo` (grep + construction-site analysis) · `siblings` (read-only inspection of
`aibr-manager`, `aibr-herdr-bridge`, `herdr` this session) · `npm` (registry telemetry —
**unavailable offline; never claimed**). "No in-repository consumer found" is not upgraded
to "no external consumer exists" without sibling **and** npm evidence; items state which
tier they reached.

**Behavioral-equivalence standard (v2):** test-suite success is necessary but not
sufficient evidence for any behavioral claim. False-confidence directions: green suite
through behavior change at untested seams (MNT-210), and red suite without behavior change
(MNT-209 source-text tests). Structural changes carry the differential checks named in
`implementation-backlog.md`.

## Root-cause groups

| RC | Root cause | Findings |
|---|---|---|
| RC1 | Two JS runtimes (Bun prod, Node via tsx/vitest) and two test runners with different behavior | 201, 202, 304, **305**, 313-row1 |
| RC2 | Verification split across two gates that each miss what the other runs | 201, 308, 309, 310 |
| RC3 | Rules/constants duplicated across validators, tests, and code copies; no single owner | 206, 207, 306, 311, 312 |
| RC4 | Phase-6 TUI retirement left live dependencies/docs/binaries behind | 109, 302, 310, 313-TUI, 315, `spike/`, `packages/` |
| RC5 | Milestone reference implementations kept beside production code | 105, 106, 111 |
| RC6 | Silent fallbacks / swallowed errors in failure paths | 203, 204 |
| RC7 | Layering rules enforced by duplicated source-scan tests; enforcement widened ad hoc | 102, 103, 104, 209 |
| RC8 (v2) | Packaging/distribution paths shipped without their wiring | 310, 315, 316 |

## Register — architecture & code

| ID | Finding (falsifiable) | Evidence | Impact | Conf | Decision | Prerequisites / gates | Acceptance criteria (measurable) |
|---|---|---|---|---|---|---|---|
| MNT-101 | `DispatchCoordinator` (`coordinator.ts`, 2,368 lines) combines 18 command planners, roundtable+charter lifecycles, memory write-back, outbox acks in one class; top churn file (2,514 lines/7 commits) | F: line counts, `git log --numstat`, method map (`phase-1` §3) | High change cost in the invariant-dense core | High | SIMPLIFY | B1–B3, B7 landed first (trustworthy verification); one seam per commit | Byte-identical event-sequence diffs on recorded replay fixtures + identical projection snapshots; suite green; each commit reverts cleanly (backlog B16) |
| MNT-102 | Three bidirectional module pairs: memory↔orchestration (`roundtable/memory.ts:27` deep-imports concrete `memory/in-memory-repository.js`), mesh↔orchestration, application↔orchestration | F: import grep + scout (`phase-1` §1.2) | Cycles block independent change | High | SIMPLIFY | Land with a barrel-test update in the same change | Barrel cycle test added and green; `tsc` clean |
| MNT-103 | Enforced layering wider than documented: `routing/types.ts:97` adds `mesh/protocol` edge (docs claim "exactly two"); rules tests widened for `mesh/protocol/bounds` | F (verified imports; `barrel.test.ts:155,312`) | Rules-as-written ≠ rules-as-built | High | SIMPLIFY | Decide first: amend ADR 0007 or revert edges (owner call) | Test list equals the documented edge list afterwards |
| MNT-104 | `orchestration/event-store/sqlite-driver.js` deep-imported by callback/, ingress/, storage/, upgrade/, mesh/fault — shared utility outside every declared layer | F (scout) | Undeclared dependency surface | Med | SIMPLIFY | Pair with MNT-102/103 ADR amendment | All deep imports route through one declared entry; barrel tests green |
| MNT-105 | Reference/orphan modules beside production: `application/service.ts` (test-only construction), `registry/` (test-only construction), `memory/store.ts`+`memory/types.ts` (isolated pair: not in `src/memory/index.ts` barrel, no src importer, migration fixtures write `memory.json` directly) | F: construction greps [Verified]; barrel listing; `tests/integration/memory-migration.test.ts:75` | ~2k lines of false production surface | High | NEED EVIDENCE → MOVE-then-REMOVE | **Consumer gate passed at `siblings` tier (zero hits for all three in aibr-manager/aibr-herdr-bridge/herdr)**; `npm` tier unavailable offline. Prerequisite: move under `tests/` first (published `dist/` may have deep importers); `memory/migration.ts`'s legacy `memory.json` **format** support stays (schema lives in `orchestration/legacy/schemas.ts`, independent of the class) | After move: zero production importers (`git grep`), `verify:all` green; shim removal listed in CHANGELOG next release |
| MNT-106 | Three "who can take work" surfaces (registry/, mesh/registry/, routing/) and three task models (tasks.md, jobs, orchestration Task) | F (scout, `phase-1` §1.3) | Conceptual overhead | Med | NEED EVIDENCE | Determine the surface the Herdr/mesh path uses (aibr-manager talks HTTP `/orchestration/*` + `/v1/mesh/events` — likely mesh/registry+routing [H]) | One documented answer in `Docs/architecture/current-state.md`; unused surface follows MNT-105 process |
| MNT-107 | `router/src/contracts.rs` is a 124,190-line / 4.3 MB committed generated file (+9.8k aibr-ipc); a stale generated schema once shipped before the gate existed | F (headers, `package.json:_contractsCheckWhy`) | Repo/diff weight; reviewability prevents drift | High | KEEP | none | `contracts:check` remains in both gates. **v2 evidence:** `aibr-manager/tests/unit/contract-validation.test.ts:37-67` reads `AIBrigde/contracts/v1` directly — `contracts/v1` is a cross-repo consumed surface; file moves break sibling CI |
| MNT-108 | `BudgetLedgerStore` durable implementation absent although `budgets/recovery.ts` (895 lines) implements recovery for it; ledger instantiated only by `simulation/plan.ts` | F (construction grep) + recorded design rationale | — (see decision) | High | **KEEP — recorded deferral** (v1: NEED EVIDENCE; changelog C2) | none; revisit only when a restart-surviving consumer exists | Informational. Rationale: `src/budgets/ledger.ts:120-138` ("a deferral with a reason": budget state derived from dispatch state; `reserveInTransaction` seam shaped for durable impl); `milestone-6-security-review.md:1147-1151` carries it as a known deferral |
| MNT-109 | `crates/aibr-ipc`/`crates/aibr-pty` have no in-repo production consumer (TUI retired); Rust IPC listener serves tests; `PtySink` unwired | F (grep [Verified]; `CHANGELOG.md:154`) | ~13k lines maintained-but-unused Rust + second codec copy | High | NEED EVIDENCE (decision gate) | **`siblings` tier passed (herdr vendors its own `portable-pty`, zero aibr-crate references).** Gate: owner confirms ADR 0011 Herdr integration timeline. **Default if unanswered: KEEP** (frame-protocol reference impl mirrors the TS codec) | If REMOVE: workspace members reduced, CI green, milestone docs + CHANGELOG updated (backlog B14) |
| MNT-110 | `MemoryRepositoryEngine` ≈1,000-line class in a 1,358-line file | F | Local complexity | Med | SIMPLIFY | None; do after B12 (adjacent module) | memory suite green; class public surface unchanged |
| MNT-111 | Two config parsers: `config/loader.ts:loadConfig`, `host/profile-store.ts:readConfig` | F (scout) | Duplicate error surfaces | Med | SIMPLIFY | Fold into B12 | One loader; existing tests green |

## Register — verification & safety (correctness/security first)

| ID | Finding | Evidence | Impact | Conf | Decision | Prerequisites / gates | Acceptance criteria (measurable) |
|---|---|---|---|---|---|---|---|
| MNT-201 | `bun run test` (vitest, the `test` script) fails 7× at HEAD while CI (`bun test`) is green; failing tests catch a real runtime difference (`BunProcessRunner` silently no-ops under Node) | F (both runners executed; `src/host/runtime.ts` catch branch) | High: non-CI runner red; Node-path bugs invisible | High | SIMPLIFY (backlog B1) | Decision gate: canonical runner — **recommend `bun test`** (CI parity + `bun:sqlite` coverage) | Both documented commands exit 0 on the same set at one commit (summaries pasted); Bun-only tests skip/loud-fail under Node; AGENTS+CONTRIBUTING identical (backlog B1) |
| MNT-202 | Discovery UI prints to stdout ~7× per test run | F (timing log) | Noise hides failures | High | SIMPLIFY | none | Clean run output (B17c) |
| MNT-203 | `getSessionStatus` (`src/opencode/client.ts:53-64`) maps unknown sessions to `"idle"` in two paths | F (code read) | Wrong "completed" jobs (fake success) | High | SIMPLIFY (backlog B2) | Land before B3 | Unknown session fails closed (2 new tests); known-session job transitions byte-identical on replay (backlog B2 differential) |
| MNT-204 | OpenCode wait loop swallows root-cause errors (`monitor.ts:40-43,64-65`); all failures read as `Timed out waiting…` | F (code read) | Recovery/debugging cost | High | SIMPLIFY (backlog B3) | After B2 (same module) | Timeout error carries the last underlying error; test with failing fake asserts cause survives |
| MNT-205 | `scripts/tmux-start.sh` binds opencode `0.0.0.0` (contradicts `AGENTS.md:135`) and interpolates `OPENCODE_SERVER_PASSWORD` into a tmux command string (argv-visible), violating the invariant `tmux.test.ts:192` enforces elsewhere | F (script + test read) | High on shared hosts | High | **SIMPLIFY — fix now** (v1: NEED EVIDENCE; changelog C3) | Usage question resolved enough: documented headless path (`Docs/architecture/current-state.md:257`); residual: actual deployments [NE] | 127.0.0.1 default (env override), password absent from argv (grep test extends the tmux invariant), session/window contract unchanged (backlog B4) |
| MNT-206 | `crates/aibr-ipc/src/lib.rs:78,87` claims `tests/protocol_version.rs` / `tests/socket_path_parity.rs` parity; first file doesn't exist; `PROTOCOL_VERSION`↔`IPC_PROTOCOL_VERSION` untested | F (verified) | Silent drift risk on IPC | High | SIMPLIFY (backlog B5) | none | Parity test exists asserting both constants (mirror `frame_cap_parity.rs` technique) OR doc claim removed; stale filename reference fixed |
| MNT-207 | Backoff/queue constants ≥3 copies (TS policy, `router/src/policy.rs`, `router/src/outbox.rs`); `backoff-parity-vector.json` hand-committed, no generator | F (scout) | Silent cross-language retry divergence | Med | SIMPLIFY (backlog B8) | After B5 | Vector generated and covered by `contracts:check`; one source per constant |
| MNT-208 | Cross-language parity vector covers 1 of 4 schema closures; charter closure parity TS-only | F (inventory) | Drift risk on ingress/IPC families | Med | NEED EVIDENCE | Time-box: cost fixtures per closure before committing to work | Decision recorded in ADR note; if pursued: fixtures + Rust-side parity test per closure |
| MNT-209 | Source-text/wiring tests as behavior (barrel tests ×8, `determinism.test.ts` Date.now scan, `tui-adapter.ts` source read) | F (verified) | Refactor friction; false reds | High | SIMPLIFY (B17a) | Coordinate with first blocked refactor | A no-behavior file move trips no unrelated tests; ADR layering checks retained |
| MNT-210 | Thin/absent direct tests behind fakes: `src/opencode` seam, `src/upgrade`, `src/sdk`, `src/observability`, `host/daemonizer.ts` | F (inventory) | Behavior can change with green suite | Med | NEED EVIDENCE → triage (B17b) | After B2/B3 (their tests are the first seam-level ones) | MNT-203/204 fixes covered without `FakeOpencodeClient` at the seam; triage list recorded |

## Register — tooling, docs & CI

| ID | Finding | Evidence | Impact | Conf | Decision | Prerequisites / gates | Acceptance criteria (measurable) |
|---|---|---|---|---|---|---|---|
| MNT-301 | `pino` direct dep has zero importers | F (grep [Verified]); **`siblings` tier passed** (zero hits) | Tiny | High | REMOVE (B11) | Owner confirms no npm deep-import consumers (npm telemetry unavailable) | Lockfile diff only removes it; `verify:all` green |
| MNT-302 | `@opentui/core` direct dep has zero importers since TUI retirement (8 native optional pkgs) | F (grep [Verified]); **`siblings` tier passed** — aibr-manager declares its **own** `@opentui/core@0.5.11` (`aibr-manager/package.json:13`) and resolves it from npm | Install weight; false TUI signal | High | REMOVE (B11) | Same npm caveat as 301 | As 301 |
| MNT-303 | `ws` used by `tests/integration/terminal-websocket.test.ts:53` but undeclared | F | Fragile transitive coupling | High | SIMPLIFY | none | Explicit devDependency or provider re-export; lockfile diff |
| MNT-304 | `dev` runs tsx/Node while everything else runs Bun | F | Runtime duality (RC1) | High | NEED EVIDENCE | Decide within B1 (does the Node dev path matter?) | Decision recorded in `Docs/guides/development.md` |
| **MNT-305** | **Two test runners: `vitest` devDep + `bun test` gate** — v1 referenced this ID in `phase-3` §1 but omitted the entry (changelog C1) | F | Traceability gap | High | SIMPLIFY — **subsumed by MNT-201** (same RC1, same fix; ID retained, not dropped) | Same as MNT-201 | Same as MNT-201 |
| MNT-306 | `install.sh --version` prints 2.0.0; `CLI_VERSION` = 3.0.0 | F [Verified] | Wrong user-facing version; `milestone-7.yml:226` calls it | High | SIMPLIFY (B6) | none | Output equals `CLI_VERSION`; packaging test asserts the pair |
| **MNT-307** | **`scripts/tmux-start.sh` defects** — v1 referenced this ID in `phase-3` §2 but omitted the entry (changelog C1) | F | Traceability gap | High | **Cross-reference → MNT-205** (same script; extra detail: script runs `bun run dev`/tsx, merged into MNT-205 evidence) | Same as MNT-205 | Same as MNT-205 |
| MNT-308 | `release:check` ≠ CI: docs:check + cargo fmt/clippy/test CI-only; vitest nowhere in CI | F (workflow + script read) | Release can ship failing cargo tests/docs | High | SIMPLIFY (B7) | After B1; decision gate: add the missing checks to the release gate — **recommend yes** | `verify:all` reproduces CI exactly (one deliberate failure per group demonstrated); `release:check` uses it |
| MNT-309 | `milestone-7.yml` (musl matrix + size gate) undocumented in release procedure; runs on every PR | F | CI cost unknown | Med | NEED EVIDENCE (B17d) | Measure first (no CI minutes collected — explicitly unmeasured) | CI minutes recorded in `Docs/operations/`; trigger-scope decision follows |
| MNT-310 | Platform-package pipeline unwired: publish.yml `packages/*` loop can't queue on clean checkout; no `optionalDependencies`; `package-binaries` not run by any workflow; matrix builds 5/6 targets | F (workflow, `.gitignore:22`, manifest, `build-matrix.sh` TARGETS vs `PLATFORM_CONFIGS`) — corrected framing (changelog C4): **unfinished supply chain with runtime consumer `src/host/binaries.ts`** (6 packages in its resolution chain; called from `src/cli.ts`) | Platform packages can't publish from CI; `linux-arm64-gnu` can never be produced | High | NEED EVIDENCE → **decision gate** (B13: complete vs descope) | Owner decision, time-boxed 1 day; `siblings` tier passed for artifacts (no sibling references), operational caveat: siblings depend on the :8787 kernel service whose distribution involves `bin/aibr-router` [H] | (A) clean-checkout dry-run release queues all 6 packages; or (B) publish loop + optional-package layer removed together, `binaries.ts` tests updated, AGENTS.md updated |
| MNT-311 | Same invariants enforced by multiple regex implementations; checker itself needed false-positive fixes (`e04cba1`, `efb3244`) | F (verified) | N coordinated edits per rule change | High | SIMPLIFY (B8) | After B5 | One implementation per rule; changing a rule touches one file |
| MNT-312 | Skill mirrors ×3, manual sync (guarded by `docs:check`) | F | 3-file copy per edit | High | SIMPLIFY (B8) | none | `docs:check` failure message carries the `docs:skills` fix command; mirrors generated |
| MNT-313 | Residual doc drift: runner claims AGENTS vs CONTRIBUTING; skill `--preview` stale; `bun bench/mem.sh` invalid; TUI spec unbannered; `Maintainance/` status; comments naming non-existent tests; stale schema counts | F (spot-checked table, `phase-3` §4) | Contributor trust erosion | High | SIMPLIFY (B9) | After B1/B4/B6 | Drift table empty; new `docs:check` sub-check: mentioned test filenames must exist |
| MNT-314 | Archive/status-marker quarantine works | F | — | High | KEEP | — | — |
| **MNT-315** | `bin/aibr-router-darwin-arm64` byte-identical to `bin/aibr-router` (SHA256 `0aa66db6…`, 1,661,680 B each); referenced by no resolution path (`binaries.ts` resolves only `bin/aibr-router`); **ships in npm tarball** | F (changelog C5): `shasum`, repo grep, executed `bun pm pack --dry-run` (both packed; 317 files total) | 1.66 MB dead weight per install | High | REMOVE (B10) | **`siblings` tier passed** (zero references); confirm no install doc names the file | Tarball listing drops exactly one file; `aibr-router` resolution still works from a packed tarball (temp-dir `aibr verify` smoke) |
| **MNT-316** | `bin/aibr` dev shim targets `src/cli.ts`, which is **not** shipped (`files: ["dist","bin",…]`); ships broken in tarball | F (changelog C5): `bun pm pack --dry-run`, `bin/aibr` contents, manifest `bin` map → `./dist/cli.js` | Confusion; inert | High | SIMPLIFY (B10) | none | File removed or relocated to `scripts/`; tarball diff recorded |

## Cross-repo couplings discovered (v2, from sibling inspection)

1. **`contracts/v1/` is consumed across repos**: `aibr-manager/tests/unit/contract-validation.test.ts:37-67`
   resolves `../../../AIBrigde/contracts/v1` and requires `command`, `roundtable-outcome`,
   `charter-proposal`, `post` schemas. Renaming/moving `contracts/v1` breaks sibling CI.
   [F]
2. **Wire schema pinned by consumers**: `roundtable-outcome` is strict
   `{summary, recommendation, addressedObjections, unresolvedObjections}` and must **not**
   carry `advisoryOnly` (`aibr-manager/src/kernel/types.ts:247-251`,
   `src/roundtable/controller.ts:305-308`). Contract additions here are breaking changes
   there. [F]
3. **HTTP surface is the integration contract**: aibr-manager and aibr-herdr-bridge use
   `POST /orchestration/commands`, `/orchestration/capability-preview`, `GET /v1/mesh/events`
   (SSE) with `AIBRIDGE_TOKEN`/`AIBRIDGE_OPERATOR_TOKEN` on `127.0.0.1:8787`. No npm/Rust
   dependency on AIBridge in any sibling. [F]

## Open questions (v2)

Resolved this pass (evidence in `audit-changelog.md` C2–C5):
1. ~~Memory/migration relationship~~ — migration reads legacy `memory.json` via
   `legacyMemoryDataSchema`, not via `FileMemoryStore`; fixtures write JSON directly. [F]
2. ~~Durable `BudgetLedgerStore` expectation~~ — recorded deferral with rationale
   (`ledger.ts:120-138`; `milestone-6-security-review.md:1147-1151`). [F]
3. ~~`tmux-start.sh` status~~ — documented headless path; not dead code. [F]
4. ~~Sibling consumers of deletion candidates~~ — none found (all three repos inspected). [F]

Remaining (explicitly unverified):
1. npm download/deep-import history for `@nyugennguyen/aibridge` (registry telemetry
   unavailable offline) — gates B11/B12's final delete steps.
2. Whether the six platform packages were ever published to npm (no registry query made) —
   informs B13's decision.
3. Actual deployment usage of `tmux-start.sh` (docs say it's the headless path;
   deployments unknown) — does not defer the B4 fix.
4. `milestone-7.yml` per-PR CI minutes (not measured).
5. Which "who can take work" surface the Herdr/mesh path uses in production (MNT-106).
