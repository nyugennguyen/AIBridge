# Maintainability Audit — Prioritized Implementation Backlog (v2)

**Commit audited:** `6dc9b04` · **Date:** 2026-10-19 · Source findings: `findings-register.md`
(same IDs). Ordering principle (per review instruction): **correctness and security
findings first** (MNT-201, 203, 204, 205, 206), then gate/rule consolidation, then
evidence-gated cleanup, then structural refactoring last.

**Global verification standard (applies to every item):** a green test suite is necessary
but **not** sufficient evidence of behavioral equivalence. Structural or behavioral items
(B1, B2, B3, B7, B16) additionally require the differential checks named in their rows.
Cosmetic-test failures (MNT-209 source-text tests) must be judged as test noise — fix the
test, don't infer behavior change. Untested seams (MNT-210) can change behavior with a
green suite — the named counters/replays are the mitigation.

---

## Tier 0 — Correctness & security (start immediately; no cross-dependencies)

### B1 · Unify the test runners (MNT-201, MNT-305, part MNT-304)
- **Prerequisites:** none. Decision gate: which runner is canonical —
  **recommendation: `bun test`** (it is what CI and `release:check` execute, and it covers
  `bun:sqlite` driver paths vitest cannot). Counter-option: make vitest canonical and move
  CI to it — rejected unless a vitest-only capability (watch/UI) justifies keeping both.
- **Acceptance criteria:**
  1. The documented dev-test command and the CI gate run the same file set **and** exit 0
     at the same commit (execute both, paste summaries into the PR).
  2. `tests/unit/host/runtime.test.ts` Bun-only tests skip (not fail) under Node, or the
     Node path raises loudly instead of returning `{exitCode: null}`.
  3. AGENTS.md + CONTRIBUTING.md contain one identical statement of the runner.
- **Behavioral-equivalence evidence:** none needed for script/doc changes; the
  `BunProcessRunner` behavior change (loud failure vs silent null) needs one unit test
  asserting the new error path.
- **Rollback criteria:** if any suite becomes un-runnable under the chosen runner (e.g. a
  vitest-only API is discovered), revert `package.json` + docs in one commit; the CI
  workflow is unchanged by this item, so `main` stays protected.

### B2 · Kill the fake-success path (MNT-203)
- **Prerequisites:** none. Owner: whoever owns `src/opencode`.
- **Acceptance criteria:**
  1. `getSessionStatus` returns a distinguishable `unknown`/throws for sessions absent from
     both status sources; a job is never marked `completed` on that path.
  2. New unit tests: unknown session (status API) and unknown session (`session.get`
     fallback) both fail closed.
  3. `monitorSession` timeout paths still land on `failed` (existing tests).
- **Behavioral-equivalence evidence:** run the recorded-session replay fixtures
  (`tests/unit/orchestration/fixtures/recorded-events.ts` consumers) and diff job-state
  transitions before/after for **known** sessions — the fix must only change the
  unknown-session branch. `FakeOpencodeClient` counters (`createdSessions`, `sentPrompts`)
  must be identical on `tests/integration` runs.
- **Rollback criteria:** revert the single PR; the change is additive-fail-closed, and the
  old behavior (silent idle) is never required by a caller.

### B3 · Preserve root-cause errors in the OpenCode wait loop (MNT-204)
- **Prerequisites:** B2 (same module; land B2 first to avoid merge churn).
- **Acceptance criteria:** the `Timed out waiting for OpenCode session <id>` error carries
  the last stream/poll error as `cause` (or in the message); a test with a failing
  `FakeOpencodeClient` asserts the cause survives.
- **Behavioral-equivalence evidence:** error-message shape is asserted by existing tests
  that match substrings — run `tests/unit/opencode` + integration trigger-flow before/after
  and diff message assertions.
- **Rollback criteria:** revert PR; no state transitions change.

### B4 · Harden `scripts/tmux-start.sh` (MNT-205, detail via MNT-307)
- **Prerequisites:** none (usage question resolved enough: documented headless path per
  `Docs/architecture/current-state.md:257`).
- **Acceptance criteria:**
  1. `opencode serve` binds `127.0.0.1` (override via env), matching `AGENTS.md:135`.
  2. `OPENCODE_SERVER_PASSWORD` never appears in a command string/argv — pass via
     environment export in the tmux session, mirroring `src/host/tmux.ts`.
  3. A test greps the script for `--hostname 0.0.0.0` and `PASSWORD='` (extends the
     existing `tests/unit/host/tmux.test.ts:192` invariant to the ops script).
- **Behavioral-equivalence evidence:** the script's observable contract (creates
  `aibridge-<id>` session with `opencode` + `aibridge` windows) unchanged; verify by
  reading the diff, not by running tmux in CI.
- **Rollback criteria:** script is operator-run, zero coupling — revert commit.

### B5 · Protocol-version mirror: test it or stop claiming it (MNT-206)
- **Prerequisites:** none.
- **Acceptance criteria:** either (a) `crates/aibr-ipc/tests/protocol_version.rs` exists
  and asserts `PROTOCOL_VERSION == 1` against the value parsed from `src/ipc/schemas.ts`
  (mirror the `frame_cap_parity.rs` source-read technique), or (b) the doc comments at
  `lib.rs:78,87` are corrected and the parity claim removed. Plus fix the
  `socket_path_parity.rs` reference to name `frame_cap_parity.rs`.
- **Rollback criteria:** trivial revert.

### B6 · Single-source installer version (MNT-306)
- **Prerequisites:** none. **Acceptance:** `scripts/install.sh --version` output equals
  `src/version.ts` `CLI_VERSION`; a packaging test asserts the pair (or the script reads
  the constant at release time); `milestone-7.yml` step unchanged and green.
- **Rollback criteria:** trivial revert.

---

## Tier 1 — Verification gates & rule ownership

### B7 · One gate that equals CI (MNT-308)
- **Prerequisites:** B1 (a broken second runner must not leak into the unified gate).
  Decision gate: does `release:check` gain `docs:check` + `cargo fmt/clippy/test`?
  **Recommendation: yes** — the release gate must not be weaker than CI.
- **Acceptance criteria:**
  1. `verify:all` runs the exact CI step list (`ci.yml` order), locally, exit codes equal
     (demonstrate with one deliberate failure per major step group: docs, cargo test).
  2. `release:check` = frozen install + `verify:all` + CLI smoke + pack dry-run.
  3. A test asserts `ci.yml` step names ⊆ `verify:all` script text (extends the existing
     release-workflow tests instead of adding a new regex owner — see B8).
- **Rollback criteria:** keep the previous `release:check` definition in git history; the
  publish workflow calls `release:check` by name, so rollback is one package.json commit.

### B8 · One owner per rule (MNT-207, MNT-311, MNT-312)
- **Prerequisites:** B5 (protocol-version rule must exist before consolidating owners).
- **Acceptance criteria:**
  1. `tests/unit/release/*` imports helpers from `scripts/docs/check-docs.ts` for the
     validation-only/single-publisher rule; exactly one implementation of each regex.
  2. `router/tests/backoff-parity-vector.json` is generated by
     `scripts/generate-parity-vector.ts` (or a sibling script) and covered by
     `contracts:check`.
  3. Skill mirrors are written by `docs:skills` in the failure message of `docs:check`
     (edit-one-copy workflow becomes copy-paste-free).
- **Rollback criteria:** per-rule git revert; rules remain test-enforced throughout
  (never delete a guard before its replacement is green).

### B9 · Documentation drift sweep (MNT-313)
- **Prerequisites:** B1 (runner statements), B6 (version), B4 (AGENTS safety text).
- **Acceptance criteria:** the phase-3 §4 drift table is empty; new cheap check: every
  `tests/**/*.rs|.ts` filename mentioned in source comments and `Docs/` exists (a `docs:check`
  sub-check); `Docs/tui/*` carry `Status: Historical` banners; `Maintainance/` plan status
  corrected.
- **Rollback criteria:** docs-only; revert.

---

## Tier 2 — Evidence-gated cleanup (deletions require the named evidence)

> Deletion standard: distinguish **"no in-repository consumer found"** (verified by grep
> and construction-site analysis) from **"no external consumer exists"** (requires sibling
> and npm evidence). Items below list the evidence tier reached and the gate still needed.

### B10 · Packaging waste: duplicate/broken `bin/` entries (MNT-315, MNT-316)
- **Evidence tier:** in-repo absence verified (no reference to `aibr-router-darwin-arm64`;
  `binaries.ts` resolves only `bin/aibr-router`; `bin/aibr` target `src/` not shipped).
  Tarball impact verified by executed `bun pm pack --dry-run` (both files packed).
  External-consumer risk: none plausible for the duplicate (identical bytes to the
  referenced binary) — but the npm tarball contents change, so this is a **publish-visible**
  change.
- **Decision gate:** confirm no install script or downstream doc references
  `bin/aibr-router-darwin-arm64` by name (grep siblings — see register) before deleting.
- **Acceptance criteria:** `bun pm pack --dry-run` lists exactly the previously listed
  files minus the two; `aibr-router` resolution still works via `bin/aibr-router`
  (`aibr verify` smoke on the packed tarball in a temp dir).
- **Rollback criteria:** restore the two files; they are inert.

### B11 · Vestigial dependencies (MNT-301 `pino`, MNT-302 `@opentui/core`, MNT-303 `ws`)
- **Evidence tier:** zero importers inside AIBridge (verified, incl. `dist/` comment-only
  hit). External: pending sibling evidence (aibr-manager ships its own OpenTUI stack
  [verify]); npm deep-import evidence unavailable offline.
- **Decision gate:** sibling-consumer verdict (register MNT-302 row) + owner confirmation
  that no downstream tool consumes `@nyugennguyen/aibridge` for these modules.
- **Acceptance criteria:** lockfile diff shows only the removed entries;
  `verify:all` green; `ws` becomes an explicit devDependency or the test imports the
  transitive provider's re-export.
- **Rollback criteria:** re-add the exact pinned versions (pins preserved in the changelog
  of the removal commit).

### B12 · Reference/orphan modules (MNT-105: `application/service.ts`, `registry/`,
`memory/store.ts` + `memory/types.ts`; MNT-111 config loaders)
- **Evidence tier:** in-repo — construction sites only in tests (verified);
  `memory/store.ts` additionally excluded from the `src/memory/index.ts` barrel and unused
  by migration fixtures (they write `memory.json` directly). External —
  `memory/index.ts` **does** export `./migration.js`, so the legacy-format migration is a
  published surface; `FileMemoryStore` itself is not in any barrel, but `dist/` deep
  imports by npm consumers cannot be ruled out offline.
- **Decision gate:** sibling + npm evidence (register open question 1). **Move before
  delete**: relocate `application/service.ts` and `registry/` under `tests/` first (a
  moving commit that leaves re-export shims for one release is acceptable here because the
  published surface may have consumers; the shims are removed in the follow-up release).
  `memory/store.ts`: delete outright only after confirming no sibling imports it; its
  legacy `memory.json` **format** stays supported via `legacyMemoryDataSchema` regardless.
- **Acceptance criteria:** after the move, `verify:all` green; `git grep` shows zero
  production importers; if shims were used, the follow-up release removes them and the
  removal is listed in CHANGELOG.
- **Rollback criteria:** revert the move commit (shims make this trivial); never combine
  the move with behavior changes.

### B13 · Platform-package pipeline decision (MNT-310) — **decision gate item**
- **Evidence tier:** supply-chain halves all verified (see audit-changelog C4): runtime
  resolver + packager exist; matrix covers 5/6 targets; no workflow step; no
  `optionalDependencies`; local v2.1.1 staging remnant.
- **Decision gate (owner decision, time-box 1 day):** **(A) complete the pipeline** — add
  `optionalDependencies`, run `build-matrix.sh` → `package:binaries` in `milestone-7.yml`,
  wire publish.yml to stage `packages/` before its publish loop, and close the
  `linux-arm64-gnu` target gap; or **(B) descope** — remove the publish.yml `packages/*`
  loop and the optional-package resolution layer from `src/host/binaries.ts` together,
  documenting `bin/aibr-router` + PATH as the supported distribution.
- **Acceptance criteria (A):** a dry-run release on a branch publishes/queues all 6
  platform packages from a clean checkout; `aibr verify` finds the router via
  `require.resolve`. **(B):** `binaries.ts` resolution chain shrinks to
  env → bundled bin → workspace → PATH with tests; publish.yml loop deleted; AGENTS.md
  release procedure updated.
- **Rollback criteria:** (A) the workflow additions are additive — disable the job;
  (B) revert restores the loop (it is inert without the optional packages).

### B14 · Rust crate decision (MNT-109: `crates/aibr-ipc`, `crates/aibr-pty`) — **decision gate item**
- **Evidence tier:** in-repo absence of production consumers verified (grep). External:
  sibling evidence pending (register MNT-109 row); ADR 0011 Herdr-orchestration plans make
  near-future use plausible [INFERENCE].
- **Decision gate:** owner states whether the Herdr integration milestone will consume
  these crates within the next release cycle. **Default if unanswered: KEEP** (they are
  small, gated by `cargo test`, and removing them destroys the frame-protocol reference
  implementation the TS side mirrors).
- **Acceptance criteria (if REMOVE):** workspace members reduced, `contracts:check` still
  covers `crates/aibr-ipc/src/contracts.rs` removal from its diff list, milestone docs
  updated, CHANGELOG entry.
- **Rollback criteria:** crates are self-contained; git revert restores the workspace.

### B15 · Stray artifacts (`spike/`, `.gemini/skills/`, local `packages/`, `bin/` remnant)
- **Evidence tier:** `spike/` self-declares throwaway (`spike/README.md`), not in npm
  tarball; `.gemini/skills/` empty and unmanaged; `packages/`+`dist-bin/` are gitignored
  local state (stale v2.1.1 staging — delete locally, add a `package:binaries` freshness
  note).
- **Acceptance criteria:** repo tree without the stray entries; `docs:check`, `verify:all`
  green; npm tarball bytes unchanged (verify with `bun pm pack --dry-run` diff).
- **Rollback criteria:** trivial revert; `spike/` history preserved in git anyway.

---

## Tier 3 — Structural (behavioral-equivalence standard applies; last)

### B16 · `DispatchCoordinator` extraction step 1 (MNT-101)
- **Prerequisites:** B1–B3 green (the verification story must be trustworthy before
  touching the kernel); B7 lands first (stronger gate).
- **Scope (deliberately small):** extract the roundtable lifecycle
  (`coordinator.ts:1340-1552`) behind the existing `RoundtableRepository` port. No
  signature changes to `DispatchCoordinator`'s public API; no event-shape changes.
- **Acceptance criteria (beyond green suite):**
  1. Byte-identical event sequences on every recorded-events replay fixture (diff the
     appended event JSON before/after).
  2. Projection snapshots over the same fixtures byte-identical (`reduceEvent` purity
     harness).
  3. `FakeOpencodeClient`/notification-consumer counters identical across integration runs.
  4. One seam per commit; each commit reverts cleanly.
- **Rollback criteria:** per-commit revert; the extraction is additive delegation, so
  reverting restores the monolith without data migration. **Stop condition:** any event
  diff, however small, halts the extraction until explained.
- **Explicitly deferred:** charter lifecycle, memory write-back, planner-split — separate
  proposals after step 1 proves the differential harness.

### B17 · Measurement & triage (MNT-209, MNT-210, MNT-202, MNT-309)
- B17a: demote/split the cosmetic source-text tests (keep ADR layering checks) — done in
  the same PR as the first refactor they block; acceptance: a no-behavior file move does
  not trip unrelated tests.
- B17b: direct tests for `src/opencode` failure paths and the thin suites (sdk/upgrade/
  observability) — acceptance: MNT-203/204 fixes are covered without fakes at the seam.
- B17c: silence discovery UI in tests (MNT-202); acceptance: clean run output.
- B17d: measure `milestone-7.yml` CI minutes (GitHub Actions run summary) and record in
  `Docs/operations/`; decision on PR-trigger scope follows the measurement (MNT-309).
