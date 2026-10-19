# Maintainability Audit — Change Log (refinement pass)

**Date:** 2026-10-19 · **Audited commit:** `6dc9b0499321760f5a0bcd795fb4a9a11a1f87ff`
(second pass; production code untouched). Original findings and evidence remain traceable:
IDs are never renumbered or deleted — corrections are recorded here and reflected inline in
`findings-register.md` and `final-report.md`.

## Corrections (v1 → v2)

### C1 — Missing finding IDs reconciled (MNT-305, MNT-307)

Cross-reference sweep (`grep -oE "MNT-[0-9]{3}"` over all six v1 reports vs register row
definitions) found exactly two referenced-but-undefined IDs:

- **MNT-305** — referenced only in `phase-3-tooling-docs.md` §1 toolchain table ("Two test
  runners (`vitest` devDep vs `bun test` gate) — see Phase 2 MNT-201"). Now defined in the
  register as a first-class entry; its subject is subsumed by MNT-201 (same root cause
  RC1, same fix). ID retained for traceability; not silently dropped.
- **MNT-307** — referenced only in `phase-3-tooling-docs.md` §2 (`scripts/tmux-start.sh`
  defects). Its subject duplicates MNT-205 (same script; MNT-205 covers (a) `0.0.0.0`
  bind + (b) password-in-argv; MNT-307 additionally notes (c) `bun run dev`/tsx runtime).
  Now defined in the register as a cross-reference to MNT-205; detail (c) merged into
  MNT-205's evidence.

### C2 — MNT-108 reclassified: NEED EVIDENCE → KEEP (documented deferral)

New evidence found in-repo (answers former open question 2):
- `src/budgets/ledger.ts:120-138` ("Persistence: an in-memory store, and why that is a
  recorded deferral") — the in-memory store is deliberate: budget state is DERIVED from
  dispatch state, recovery is "ask the dispatcher", ADR 0007 §16 requires a fail-closed
  fake for the dry run, and `reserveInTransaction(draft, decide)` is shaped so a durable
  impl gets `BEGIN IMMEDIATE` for free.
- `Docs/implementation-reports/milestone-6-security-review.md:1147-1151` carries "A
  durable-store `BudgetLedgerStore`" as a recorded deferral ("that claim is untested
  because no durable store exists"), not as an omission.

The finding stays in the register (retained, not removed): it documents a known deferral
with a defined seam and pre-built recovery tests. No action until a restart-surviving
consumer exists.

### C3 — MNT-205 upgraded: NEED EVIDENCE → SIMPLIFY (fix now)

Former open question 1 (is `tmux-start.sh` used?) partially answered:
`Docs/architecture/current-state.md:257` names `scripts/tmux-start.sh` as the headless
operations path alongside the Herdr backend, and `AGENTS.md:131` documents it. No
packaging unit (systemd/launchd) invokes it — it is a documented operator tool, not dead
code. Residual unknown (actual deployments) no longer justifies deferring the security
fix; the fix is cheap and invariant-aligned (G6). Script-level risk (password in tmux
command argv, `--hostname 0.0.0.0`) is verified in source.

### C4 — MNT-310 corrected: "dead publish loop" → "unfinished platform-package supply chain"

The v1 wording ("dead on a clean checkout") is factually right but incomplete. Verified
evidence chain:
- `src/host/binaries.ts` (called from `src/cli.ts`) is a **runtime consumer of the design**:
  `resolveNativeBinary("aibr-router")` walks env override → 6 `SUPPORTED_PLATFORM_PACKAGES`
  (`@nyugennguyen/aibridge-<platform>`, resolved via `require.resolve` → `<pkg>/bin/aibr-router`)
  → package-bundled `bin/aibr-router` → workspace `target/{release,debug}` → PATH.
- `scripts/package-binaries.ts` stages those 6 packages from `dist-bin/`;
  `scripts/build-matrix.sh` builds **5 of 6** targets (no `aarch64-unknown-linux-gnu` —
  matching the self-noted gap at `Docs/architecture/current-state.md:272`).
- No workflow runs `package:binaries`; `/packages/` and `/dist-bin/` are gitignored; root
  `package.json` declares **no `optionalDependencies`** (verified), so npm would never
  install platform packages automatically even if published.
- Local state corroborates a manual v2.1.1-era staging run: `packages/aibridge-darwin-arm64`
  (gitignored) is at version 2.1.1 while the root is 3.0.0.

Decision therefore becomes an explicit **decision gate** (complete the pipeline vs
formally descope it and remove the resolution layer + publish loop together), not a
gratuitous deletion.

### C5 — New findings MNT-315, MNT-316 (packaging waste, verified by execution)

Executed `bun pm pack --dry-run` (read-only): the npm tarball (317 files) packs
`bin/aibr` (66 B), `bin/aibr-router` (1.66 MB), **`bin/aibr-router-darwin-arm64` (1.66 MB)**,
`dist/**`.

- **MNT-315** — `bin/aibr-router-darwin-arm64` is **byte-identical** to `bin/aibr-router`
  (SHA256 `0aa66db6…`, both 1,661,680 bytes). No code references that filename (repo-wide
  grep); `binaries.ts` only resolves `bin/<NativeBinaryName>` = `aibr-router`. Every npm
  install ships a 1.66 MB duplicate. REMOVE candidate (tarball check is the acceptance
  test).
- **MNT-316** — `bin/aibr` is a dev shim (`exec bun "$(dirname "$0")/../src/cli.ts"`) whose
  target `src/` is **not** in the tarball (`files: ["dist","bin",…]`); harmless because
  `package.json` `bin.aibr` → `./dist/cli.js`, but it ships broken. SIMPLIFY.

### C6 — Behavioral-equivalence standard added to all refactor validations (MNT-201 fix, P5/MNT-101, any structural change)

v1 validations leaned on "tests green". Corrected standard: **suite success is necessary
but not sufficient**. Two documented false-confidence directions:
- tests can stay green through behavior change at untested seams (MNT-210: `src/opencode`
  behind `FakeOpencodeClient`, `src/sdk`, `src/upgrade`, `src/observability`);
- tests can fail on cosmetic change without behavior change (MNT-209: source-text/wiring
  tests).
Structural changes therefore require differential evidence beyond the suite: byte-identical
event-log replay on recorded fixtures, projection/snapshot comparison, structured-log and
side-effect counters (the existing `FakeOpencodeClient.createdSessions`/`sentPrompts`
counters and command-log replay harness are the available instruments), and staged
landing (one seam per commit). Recorded in the register preamble and in
`implementation-backlog.md` per item.

### C7 — Sibling-repository consumer evidence added (deletion gates)

Read-only inspection of `aibr-manager`, `aibr-herdr-bridge`, `herdr`
(`/Users/mac/Projects/`); no builds/tests run there. Verdicts (detail + citations in
`findings-register.md`):

- `@opentui/core` — aibr-manager declares its **own** `@opentui/core@0.5.11`
  (`aibr-manager/package.json:13`, resolved from npm); no sibling consumes AIBridge's
  copy. Removal breaks no sibling.
- `pino`, `aibr-ipc`/`aibr-pty`, `src/application/`, `src/registry/`,
  `memory/store.ts`, `memory/migration.ts`, `src/simulation/`, `spike/`, `bench/`,
  `bin/aibr-router-darwin-arm64` — zero references in all three siblings (herdr vendors
  its own `portable-pty`, `herdr/Cargo.toml:26-52`). "No external consumer" is claimed at
  the **`siblings` tier only** — npm deep-import telemetry remains unavailable offline
  and is never claimed.
- **Coupling discovered:** `aibr-manager/tests/unit/contract-validation.test.ts:37-67`
  reads `AIBrigde/contracts/v1` **from this checkout** and requires 4 schema files; the
  `roundtable-outcome` wire shape is pinned strict in
  `aibr-manager/src/kernel/types.ts:247-251`. `contracts/v1/` is a cross-repo surface
  (strengthens MNT-107 KEEP).
- **Operational caveat on binary removal [INFERENCE]:** both TS siblings depend on the
  kernel service at `127.0.0.1:8787`; whether the exact binary `bin/aibr-router-*` is the
  deployment vehicle is not determinable from the siblings. The v1 duplicate-binary
  recommendation (MNT-315) is unaffected: the duplicate is byte-identical to the
  referenced `bin/aibr-router`, which stays.

## Evidence-method notes (v2)

- Newly executed this pass (read-only): `bun pm pack --dry-run` (tarball listing),
  `shasum bin/*` (binary identity), repo-wide consumer greps, `git check-ignore`, reads of
  `src/host/binaries.ts`, `src/memory/{store,migration,index}.ts`, `src/budgets/ledger.ts`,
  `scripts/{build-matrix,package-binaries}.ts`,
  `Docs/implementation-reports/milestone-6-security-review.md`.
- NOT executed: builds, tests, workflows (no re-runs claimed), npm registry queries
  (published-package consumer history remains unknown — see open questions).
- Sibling-repository consumer evidence (`aibr-manager`, `aibr-herdr-bridge`, `herdr`):
  read-only scout inspection (C7); verdicts recorded in `findings-register.md` rows
  MNT-105/109/301/302/315 and the cross-repo couplings section.

## Unresolved after v2 (see register "Open questions")

1. npm download/consumer history for `@nyugennguyen/aibridge` deep imports (no registry
   telemetry available offline) — gates the final delete steps of B11/B12.
2. Whether the six platform packages were ever published to npm (no registry query made)
   — informs B13's decision.
3. Actual deployment usage of `tmux-start.sh` beyond documentation (docs designate it as
   the headless path; does not defer the B4 fix).
4. `milestone-7.yml` per-PR CI cost (not measured) — B17d.
5. Which "who can take work" surface the Herdr/mesh path uses in production (MNT-106).
