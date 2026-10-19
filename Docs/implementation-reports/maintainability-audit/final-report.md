# AIBridge Maintainability Audit — Final Report

**Commit under audit:** `6dc9b0499321760f5a0bcd795fb4a9a11a1f87ff` (branch
`asset-project-maintainability`, 2026-10-19) · **Environment:** macOS arm64, Bun 1.3.14
(= CI pin), Cargo 1.99.0 (= `rust-toolchain.toml` pin) · **Method:** plan
`Docs/implementation-plans/aibridge-maintainability-audit-plan.md`; 4 read-only scout
sub-agents mapped `src/`, Rust/contracts, tests, and docs/CI/deps; every sharp claim was
re-verified by the lead reviewer; verification commands were actually executed (§5).
No production code was modified.

**Report set:** `phase-0-baseline.md` (baseline + measurements) ·
`phase-1-architecture-code.md` (architecture & dependency map, runtime flows, hotspots) ·
`phase-2-verification-safety.md` (verification matrix, guarantees G1–G10, risk register) ·
`phase-3-tooling-docs.md` (toolchain, CI/CD, documentation) · `findings-register.md`
(all findings, root causes, open questions) · `audit-changelog.md` (v1→v2 corrections) ·
`implementation-backlog.md` (prioritized backlog with decision gates & rollback) ·
this file (synthesis).

**v2 revision (same day):** finding IDs reconciled (MNT-305/307 defined), four
classifications corrected or upgraded on new evidence (MNT-108, MNT-205, MNT-310,
plus new MNT-315/316), sibling-repository consumer evidence added (all three sibling
repos inspected), and every recommendation given explicit prerequisites and measurable
acceptance criteria. Corrections are recorded in `audit-changelog.md`; v1 evidence is
retained inline in the register. Nothing was silently dropped.

## 1. Executive summary

**AIBridge is an unusually well-governed codebase whose complexity is mostly paid for.**
The kernel invariants (immutable core, advisory-only roundtable, budget ceilings,
commit-before-202, capability envelopes, secret handling) are each backed by named,
anti-vacuous tests; contracts are single-sourced in Zod and diff-gated across two
languages; every risky design choice carries its incident rationale in comments and ADRs.
That is the main strength and it must be preserved (guarantees G1–G10,
`phase-2` §4).

The maintenance cost is concentrated in four places:

1. **Verification duality (highest priority).** Two test runners and two JS runtimes.
   `bun test` (what CI and `release:check` run) is green while `bun run test` (vitest —
   the `test` script) **fails 7 tests at HEAD**, and `release:check` ≠ CI (each gate misses
   what the other runs). Verified by executing both. (MNT-201, MNT-308)
2. **Rule duplication across guards.** The same invariants are re-implemented as regexes in
   `check-docs.ts`, in `tests/unit/release/*`, in cross-language constant copies, and in
   mirrored skill text; the checker itself has required false-positive fix commits. (MNT-206,
   207, 306, 311, 312)
3. **Retirement leftovers and reference code beside production.** Unused deps (`pino`,
   `@opentui/core`), unused crates (`aibr-ipc`/`aibr-pty` have no in-repo production
   consumer), test-only modules (`application/service.ts`, `registry/`, orphan
   `FileMemoryStore`), `spike/`, and docs for the retired TUI. (MNT-105, 109, 301, 302)
4. **Silent failure paths.** `getSessionStatus` maps unknown sessions to `"idle"` (fake
   success), the OpenCode wait loop discards root-cause errors, and `BunProcessRunner`
   silently no-ops under Node. (MNT-203, 204, 201)

Nothing found justifies an architectural rewrite. The kernel's god class
(`DispatchCoordinator`, 2,368 lines) is the one structural simplification worth doing,
carefully, behind existing seams (MNT-101).

**Critical exceptions (reported separately from the average):**
MNT-201 (red non-CI runner) · MNT-203 (fake-success path) · MNT-205
(`tmux-start.sh` password-in-argv + `0.0.0.0` bind) · MNT-206 (contract constant untested).

**v2 evidence updates (details in `audit-changelog.md`):**
- **MNT-108 → KEEP.** The missing durable `BudgetLedgerStore` is a *recorded deferral*
  with written rationale (`src/budgets/ledger.ts:120-138`,
  `milestone-6-security-review.md:1147-1151`), not an omission.
- **MNT-205 → fix now.** `scripts/tmux-start.sh` is the documented headless path
  (`Docs/architecture/current-state.md:257`), not dead code; the security fix is no
  longer gated on deployment evidence.
- **MNT-310 corrected.** The platform-package path is an *unfinished supply chain*, not a
  dead loop: `src/host/binaries.ts` resolves `aibr-router` through six
  `@nyugennguyen/aibridge-<platform>` packages at runtime; the build matrix produces 5 of
  6 targets; nothing stages or publishes them. Now a decision gate (complete vs descope).
- **MNT-315/316 new (verified by executing `bun pm pack --dry-run`):** the npm tarball
  ships a 1.66 MB byte-identical duplicate router binary (`bin/aibr-router-darwin-arm64`)
  and a broken 66 B `bin/aibr` shim.
- **Sibling evidence:** `aibr-manager`, `aibr-herdr-bridge`, `herdr` inspected read-only —
  none consumes `@opentui/core`/`pino`/the Rust crates/the orphan TS modules through
  AIBridge (aibr-manager ships its own `@opentui/core`), but `aibr-manager` reads
  `contracts/v1/` **from this checkout** and pins the `roundtable-outcome` wire shape —
  contract files are a cross-repo surface.

## 2. Maintainability scorecard

Scale 1–5 per plan §5 (1 = poor/high change risk … 5 = low change friction). Weights as
specified. Scores are evidence-backed by the phase reports.

| Area | Weight | Score | Rationale (evidence) |
|---|---|---|---|
| Architecture & design | 15% | 3 | Documented ADR layering + source-scan enforcement, clear state ownership, but 3 bidirectional module pairs, an enforced-vs-declared edge gap, a god class in the core, orphan modules beside production (`phase-1` §1.2–4) |
| Code maintainability | 15% | 3 | Cohesive subsystems (rules engine "one evaluator", contract chain) but churn×complexity hotspots in `coordinator.ts`, `cli.ts`, `schemas.ts`; oversized classes (`phase-1` §3) |
| Runtime & operational | 15% | 3 | Clean boundaries (router/SQLite/worker/IPC), crash-recovery suites; but silent error paths, no log files/structured logging in production paths, observability untested directly (`phase-2` §5) |
| Testing & verification | 15% | 4 | 5,982 tests, invariant-named, anti-vacuity guards, cross-language parity vectors, 1,000-cycle durability suite; minus runner duality, brittle source-text tests, fakes over the opencode seam (`phase-2` §2, §6) |
| Security & reliability | 15% | 4 | Threat-model discipline, constant-time auth, canary/redaction audits, write-once secrets, WS fencing; minus MNT-205 and the untested `tmux-start.sh` path (`phase-2` §4–5) |
| Dependencies & toolchain | 8% | 4 | Exact pins + written rationales both languages, pinned toolchains verified against workflows; minus 2 vestigial deps + 1 undeclared test dep (`phase-3` §1) |
| Documentation | 7% | 3 | Canonical-source system, generated CLI reference, archive quarantine, doc gate in CI; but validator rule duplication and residual drift in AGENTS/CONTRIBUTING/skills/comments (`phase-3` §4) |
| Developer experience & CI/CD | 5% | 3 | Fast suite (22s), warm verification ~2 min total, deeply commented workflows; but two asymmetric gates, undocumented heavy workflow, contradictory runner docs (`phase-3` §3, §5) |
| Change history & economics | 5% | 3 | Small history (179 commits), rationale-rich; coarse feature commits and hotspot concentration make representative changes costlier than needed (`phase-0` §8) |

**Weighted score: 3.4 / 5** (Σ score×weight = 0.45+0.45+0.45+0.60+0.60+0.32+0.21+0.15+0.15
= 3.38). Interpretation: acceptable with localized inefficiencies, trending to "good
boundaries, reliable verification" in the areas where invariants live — the deficit is in
DX/tooling consistency and cleanup, not in correctness protection.

## 3. Simplification proposals (plan §10.5)

### P1 — One runner, one truth (fixes RC1; MNT-201, 304, 305)

- **Current:** `test` = `vitest run` (red at HEAD), gate = `bun test`; docs disagree which
  is authoritative; bun-only SQLite drivers silently skip under vitest.
- **Alternative:** make `bun test` the single documented runner; either delete the vitest
  path or make `bun run test` an alias that fails clearly; keep `vitest` only if watch mode
  is needed (it is `test:watch`). Ensure the `BunProcessRunner` tests skip (not fail) under
  Node, or raise loudly there.
- **Cost:** small (scripts + docs + 1 test file). **Risk:** low.
- **Validation:** both documented commands exit 0 and run the same test set; runner
  disagreement impossible without CI noticing.
- **Prerequisites · gates · rollback (backlog B1):** no prerequisites; decision gate =
  canonical runner (**recommend `bun test`** — CI parity + `bun:sqlite` coverage);
  rollback = revert `package.json` + docs in one commit (CI workflow untouched).
  Behavioral note: the `BunProcessRunner` error-path change needs its own unit test;
  suite-green alone is not the acceptance bar.

### P2 — One verification gate ≙ CI (fixes RC2; MNT-308, 309, 310)

- **Current:** `release:check` misses `docs:check` + `cargo fmt/clippy/test`; CI misses
  vitest; publish's `packages/*` loop is unreachable on a clean checkout; `milestone-7.yml`
  undocumented.
- **Alternative:** a single `verify:all` script that runs exactly the CI steps in CI order;
  `release:check` = frozen install + `verify:all` + pack dry-run; document `milestone-7.yml`
  in the release procedure; decide the platform-package story (wire `package:binaries` or
  drop the loop).
- **Cost:** small–medium. **Risk:** low (gate only gets stronger).
- **Validation:** running `verify:all` locally produces the same pass/fail as a CI run of
  the same commit; a deliberate `cargo test` or docs failure blocks `release:check`.
- **Prerequisites · gates · rollback (backlog B7):** prerequisite = B1; decision gate =
  does the release gate gain `docs:check` + cargo checks (**recommend yes** — the release
  gate must not be weaker than CI); rollback = one `package.json` commit restoring the old
  `release:check` (publish.yml calls it by name).

### P3 — One owner per rule (fixes RC3; MNT-206, 207, 306, 311, 312)

- **Current:** release-authority rule in 3 places; protocol-version parity in 0 places but
  documented as 1; backoff constants in 3+ copies with an ungenerated golden vector;
  installer version hardcoded; skills mirrored ×3 by hand.
- **Alternative:** rules live in one exported helper each; `tests/unit/release/*` imports
  `check-docs.ts` helpers instead of re-scanning YAML with private regexes; add the 5-line
  `PROTOCOL_VERSION` parity test (or delete the claim); generate
  `backoff-parity-vector.json` like `parity-vector.json`; single-source `install.sh
  --version`; `docs:skills` writes mirrors during `docs:check` failures.
- **Cost:** small. **Risk:** low.
- **Validation:** changing one rule touches one file; the false-positive fix churn seen in
  `e04cba1`/`efb3244` becomes unnecessary.
- **Prerequisites · gates · rollback (backlog B8):** prerequisite = B5 (the
  protocol-version rule must exist before consolidating owners); invariant = never delete
  a guard before its replacement is green; rollback = per-rule git revert.

### P4 — Quarantine retirement leftovers & reference code (fixes RC4/RC5; MNT-105, 109, 301, 302, 313)

- **Current:** unused deps, unused crates maintained and gated, test-only modules read as
  production, `spike/`/stale `packages/`/`bin/aibr-router-darwin-arm64`/`.gemini/skills/`
  present, TUI docs unmarked.
- **Alternative (v2 — 4 of the 6 register open questions are now answered by evidence):**
  remove `pino`+`@opentui/core` (sibling tier passed — aibr-manager ships its own OpenTUI
  dep); **move before delete** `application/service.ts`, `registry/`, `memory/store.ts`
  under `tests/` (sibling tier passed; npm deep-import tier unverifiable offline, so one
  release with re-export shims precedes removal; the legacy `memory.json` format support
  stays — it lives in `orchestration/legacy/schemas.ts`, not in `FileMemoryStore`);
  decide `aibr-ipc`/`aibr-pty` (siblings clean; KEEP default unless ADR 0011 consumers are
  named); archive `spike/`; delete `bin/aibr-router-darwin-arm64` + fix `bin/aibr`
  (MNT-315/316); add status banners to `Docs/tui/*`.
- **Cost:** medium (decisions + moves). **Risk:** medium only for crates with external
  consumers — hence the evidence gate.
- **Validation:** suite green; `docs:check` green; npm pack contents diff recorded per
  deletion (executed `bun pm pack --dry-run` is the instrument).
- **Prerequisites · gates · rollback (backlog B10–B15):** deletion standard = state the
  consumer-evidence tier reached (`in-repo` / `siblings` / `npm`) — "no in-repo consumer"
  alone never justifies a delete; gates = owner decision for crates (B14) and the
  platform-package pipeline (B13); rollback = git revert restores every item (moves land
  alone, never mixed with behavior changes).

### P5 — Decompose `DispatchCoordinator` (fixes MNT-101)

- **Current:** 2,368-line class owning 18 command planners + roundtable + charter +
  memory write-back + outbox acks.
- **Alternative:** extract roundtable lifecycle, charter lifecycle, and memory write-back
  into collaborating classes behind existing ports (`CommandLog`, `MemoryRepository`,
  repositories already injected); keep the command→plan switch as the single dispatcher.
- **Cost:** large; **risk:** highest in the audit — the file is the invariant core.
- **Validation:** byte-identical event sequences on `tests/unit/orchestration/fixtures/recorded-events.ts`
  replays; full kernel + integration + mesh-fault suites green at every step; land as a
  sequence of no-behavior-change commits.
- **Prerequisites · gates · rollback (backlog B16):** prerequisites = B1–B3 + B7 green
  (the verification story must be trustworthy before touching the kernel);
  **behavioral-equivalence standard:** suite-green is necessary, not sufficient —
  additionally require byte-identical event-sequence diffs, identical projection
  snapshots, and identical side-effect counters (`FakeOpencodeClient.createdSessions`/
  `sentPrompts`, notification-consumer counts) between pre/post runs; **stop condition:**
  any event diff halts the extraction until explained; rollback = per-commit revert
  (extraction is additive delegation; no data migration), step 1 = roundtable lifecycle
  only, everything else explicitly deferred.

### Explicitly NOT proposed

- Rewriting the contract chain or un-committing generated artifacts (MNT-107 KEEP): the
  committed-diff gate is incident-proven to prevent drift.
- Merging mesh/orchestration or the rules engine: cohesion is deliberate and tested
  ("NO SECOND EVALUATOR. EVER.").
- Reducing dependencies "on principle": the remaining set is minimal and pinned.

## 4. Prioritized 30-day roadmap (v2 — with decision gates & rollback)

Detailed per-item prerequisites/acceptance/rollback live in `implementation-backlog.md`
(B-items); this table is the schedule view. **Tier 0 is correctness/security
(MNT-201/203/204/205/206) and must land before any cleanup or structural work.**
Acceptance criteria are observable; every item has a named rollback.

| # | Day | Tier / item (backlog) | Decision gate · prerequisite | Acceptance criteria | Rollback |
|---|---|---|---|---|---|
| R1 | 1–3 | T0 runner unification (B1 · MNT-201, 305) | Gate: canonical runner — **recommend `bun test`** | Both documented commands exit 0 on the same set at one commit (summaries pasted); AGENTS/CONTRIBUTING identical | Revert `package.json`+docs; CI untouched |
| R2 | 1–3 | T0 fake-success fix (B2 · MNT-203) | none | Unknown session fails closed (2 tests); known-session transitions byte-identical on replay | Single-PR revert |
| R3 | 1–3 | T0 error attribution (B3 · MNT-204) | after R2 (same module) | Timeout error carries last underlying error (test) | Revert; no state change |
| R4 | 1–3 | T0 `tmux-start.sh` hardening (B4 · MNT-205) | none (usage question resolved: documented headless path) | 127.0.0.1 default; password absent from argv (grep test); session contract unchanged | Script revert (zero coupling) |
| R5 | 1–3 | T0 protocol-version parity (B5 · MNT-206) | none | Parity test asserts both constants **or** doc claim removed; stale filename refs fixed | Revert |
| R6 | 3–5 | T0 installer version (B6 · MNT-306) | none | `--version` == `CLI_VERSION`; test asserts; `milestone-7.yml` green | Revert |
| R7 | 4–8 | T1 `verify:all` ≙ CI (B7 · MNT-308) | after R1; gate: release gate gains docs+cargo — **recommend yes** | One command reproduces CI (deliberate failures demonstrated); `release:check` uses it | One `package.json` commit |
| R8 | 6–10 | T1 rule single-ownership (B8 · MNT-206/207/311/312) | after R5 | One implementation per rule; backoff vector generated; mirrors machine-written | Per-rule revert; never remove a guard before its replacement is green |
| R9 | 8–12 | T1 doc drift sweep (B9 · MNT-313) | after R1/R4/R6 | Drift table empty; mentioned-test-filenames check green; `Docs/tui/*` banners | Docs revert |
| R10 | 10–15 | T2 tarball waste (B10 · MNT-315/316) | gate: no doc names the duplicate binary | `bun pm pack --dry-run` diff = exactly 2 files; router resolution smoke from tarball | Restore files (inert) |
| R11 | 10–15 | T2 vestigial deps (B11 · MNT-301/302/303) | gate: sibling verdict ✅ passed + owner confirms no npm deep-imports (npm telemetry unavailable — stated) | Lockfile diff only; `verify:all` green | Re-add exact pins |
| R12 | 12–18 | T2 reference-code quarantine (B12 · MNT-105/106/111) | gate: sibling verdict ✅ passed; **move before delete**; one release with shims | Zero production importers; `verify:all` green; shims removed next release + CHANGELOG | Revert the move (shims make it trivial) |
| R13 | 15–22 | T2 pipeline decision (B13 · MNT-310) + crate decision (B14 · MNT-109) | **Owner decisions, time-boxed 1 day each**; defaults: pipeline = decide A/B explicitly; crates = KEEP if unanswered | (A) clean-checkout dry-run queues 6 packages, or (B) loop+resolution layer removed together with docs; crate decision recorded ADR-style | (A) disable job; (B)/(removal) git revert restores |
| R14 | 18–25 | T2 stray artifacts (B15) + measurements (B17d · MNT-309/210/202) | measure before deciding `milestone-7.yml` trigger scope | Tree clean; CI minutes recorded in `Docs/operations/`; opencode seam tests exist | Trivial revert |
| R15 | 22–30 | T3 `DispatchCoordinator` step 1 (B16 · MNT-101) | after R1–R3 + R7 green; **stop on any event diff** | Roundtable extracted; event sequences + projection snapshots byte-identical; counters identical; one seam per commit | Per-commit revert (additive delegation) |

Sequencing note: R1–R6 are mutually independent (parallelizable); R7 needs R1;
R8 needs R5; R10–R12 are evidence-gated deletions (gates mostly cleared this pass —
see `findings-register.md` tiers); R13 is decision-gated (owner); R15 starts only on a
trustworthy verification base. Unresolved questions can delay R11–R13 but never Tier 0.

## 5. Verification performed (this session, this host)

| Check | Result |
|---|---|
| `bun test` (CI runner) | ✅ 5,977 pass / 5 skip, 21.8s |
| `bun run test` (vitest) | ❌ 7 failed (MNT-201), 20.5s |
| `bun run typecheck` | ✅ 6s |
| `bun run build` | ✅ 3s |
| `bun run docs:check` | ✅ <1s |
| `bun run contracts:check` | ✅ 4s (regenerate + diff clean) |
| `cargo fmt --all --check` / `clippy -D warnings` / `cargo test --workspace` | ✅ 1s / 16s / 51s |

Not executed (recorded as unknown): CI runs on GitHub, `milestone-7.yml` timings,
`bun install --frozen-lockfile` from cold cache, `scripts/install.sh` end-to-end,
live mesh/Tailscale flows, `aibr-*` binaries on Linux targets.

**v2 refinement pass (read-only):** executed `bun pm pack --dry-run` (tarball listing:
317 files incl. both `bin/` router copies and the `bin/aibr` shim), `shasum bin/*`
(proving `bin/aibr-router` == `bin/aibr-router-darwin-arm64`), `git check-ignore`
(`packages/`, `dist-bin/` are local state), repo-wide consumer greps, and source reads of
`src/host/binaries.ts`, `src/memory/{store,migration,index}.ts`, `src/budgets/ledger.ts`,
`scripts/{build-matrix,package-binaries}.ts`, `Docs/implementation-reports/milestone-6-security-review.md`.
A read-only sub-agent inspected sibling repos `aibr-manager`, `aibr-herdr-bridge`, `herdr`
(no builds/tests run there either). **Not executed in v2:** any build, test, or workflow;
npm registry queries (no telemetry claimed anywhere).

## 6. Completion criteria check (plan §11)

| Criterion | Status | Where |
|---|---|---|
| Major runtime flows and architecture boundaries mapped | ✅ | `phase-1` §1–2, `phase-0` §9 |
| Complexity hotspots evidence-backed | ✅ | `phase-1` §3 (line counts, churn, method maps) |
| Critical tests mapped to requirements | ✅ | `phase-2` §2 matrix + G1–G10 table |
| Baseline timings and representative-change costs recorded | ✅ | `phase-0` §7–8 (measured; representative changes from history, live experiments not performed) |
| High-impact findings have decisions/actions/validation | ✅ | `findings-register.md` + §3–4 above |
| Unknowns explicitly recorded | ✅ | register "Open questions" (6 items) |
| Prioritized backlog with measurable acceptance criteria | ✅ | §4 |
| No production code modified during audit | ✅ | only `Docs/implementation-reports/maintainability-audit/*` added |
| (v2) Finding IDs reconciled; corrections documented, not erased | ✅ | `audit-changelog.md` C1–C7; MNT-305/307 defined; MNT-108/205/310 reclassified inline |
| (v2) Every recommendation has evidence, confidence, prerequisites, measurable acceptance | ✅ | `findings-register.md` columns + `implementation-backlog.md` per-item rows |
| (v2) Deletion candidates carry consumer-evidence tiers (`in-repo`/`siblings`/`npm`) | ✅ | register rows MNT-105/109/301/302/315; `npm` tier explicitly unavailable |
| (v2) Roadmap has decision gates and rollback criteria; correctness/security first | ✅ | §4 tiers T0–T3; backlog B1–B17 |
| (v2) Behavioral-equivalence standard recorded (suite-green ≠ proof) | ✅ | register preamble; backlog global standard; P5/B16 differential checks |
| (v2) Deliverables: revised report, revised register, change log, implementation backlog | ✅ | this file · `findings-register.md` · `audit-changelog.md` · `implementation-backlog.md` |
