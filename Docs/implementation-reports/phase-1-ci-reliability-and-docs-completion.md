# Phase 1 — CI Reliability and Documentation Governance: Completion Report

> **Status:** Current
> **Applies to:** branch `maintenance/phase-1-ci-docs` (this change set)
> **Last verified:** 2026-10-15 against this branch, base `d012119`
> **Owner:** maintainers

## 1. Scope and branch

Executes `Docs/implementation-plans/Maintainance/AIBridge_Phase_1_Reliability_and_Documentation_Plan.md`
(Workstreams A–D, Steps 1–5) in a dedicated worktree on branch
`maintenance/phase-1-ci-docs`, base `d012119` (`main`, 2026-10-14 baseline named
in the plan).

Non-goals held: no product/runtime code changes (`src/`, `router/`, `crates/`),
no security-policy changes, no version bumps, no npm publishing, no releases.

## 2. Delivered

### Workstream A — CI and release reliability

- `.github/workflows/ci.yml` is validation-only: the competing `publish` job and
  its `NPM_TOKEN`/`id-token`/`contents: write` grants are gone; top-level
  `permissions: contents: read`. A `bun run docs:check` step was added.
- `.github/workflows/publish.yml` is the sole npm publisher and now has an
  explicit per-package preflight with three outcomes:
  1. version not published → queued; validated (`bun run release:check`) then published;
  2. version already published with registry `gitHead` equal to the release
     commit → "already published; skipped" (safe re-run);
  3. version already published but from a different commit or with no `gitHead`
     to verify → the release FAILS with a diagnostic requiring a new version.
- Platform packages (`packages/*`, installed via `optionalDependencies`) no
  longer swallow publish failures (`|| true` removed): a failed publish fails
  the release explicitly. Publishing order and the `--access public` /
  `id-token: write` provenance design are unchanged.
- Regression tests: `tests/unit/release/ci-workflow.test.ts` fails if `ci.yml`
  reintroduces publish commands or npm credentials, or if any workflow other
  than `publish.yml` publishes; `tests/unit/release/publish-workflow.test.ts`
  pins the preflight contract (gitHead proof, unverifiable-duplicate failure,
  validate-before-publish, no swallowed failures).

### Workstream B — documentation reconciliation

Verified against source (not other prose) and corrected:

- README: router bind description (`bridge.host`:`bridge.port` CGNAT literal,
  default 8787; `tailscale0` is error text only), wizard port-probe wording
  (4095 binds nothing), body cap 2 MB → 1 MiB, Rust badge relabeled MSRV 1.94
  with the pinned 1.99.0 toolchain stated separately, present-tense N-node mesh
  topology, complete 10-command CLI table with scoped flags and a link to
  `Docs/cli-reference.md`, `auth_mode` enum, install behavior of
  `scripts/install.sh`, 5-target build matrix with the missing
  `aarch64-unknown-linux-gnu` gap stated.
- AGENTS.md: `bun test` vs `bun run test` runners, `OPENCODE_PORT` override,
  corrected required/optional env-var list (`AIBRIDGE_CONFIG`,
  `AIBRIDGE_BEARER_TOKEN`, `AIBRIDGE_INGRESS_OUTBOX` required), job-state path
  (`<stateDir>/jobs/`), release procedure rewritten to the single-publisher
  design, nonexistent `doctor` command removed.
- `Docs/architecture/current-state.md` (new): as-built architecture guide with
  claim-to-source evidence matrix (plan §C4 structure).
- `Docs/cli-reference.md` (new, generated from `aibr --help`).
- `Docs/runbooks/failure-mode-recovery.md` →
  `Docs/architecture/failure-modes-and-recovery.md`, banner
  **Status: Needs revalidation**: it documents an operator CLI that does not
  exist in this tree; the body is preserved unchanged as a design record and
  the banner points to current triage guidance.
- `Docs/runbooks/part-b-manual-testing.md` deleted (version-pinned 2.1.6-era
  guide; mirrors the operator's own uncommitted deletion in the main checkout;
  recoverable from git history).
- Skills (`.opencode/skills/`, canonical): corrected router-port and body-cap
  claims, removed the stale `--preview`-broken warning, refreshed `src/cli.ts`
  anchors and version framing, fixed the cargo workspace-root guidance and the
  `release:check` expansion, replaced machine-absolute `file:///` links with
  repo-relative paths; `.claude/skills/` and `.agents/skills/` regenerated to
  byte-identical mirrors.

### Workstream C — governance

- `Docs/CONTRIBUTING.md` (new): documentation principles, style rules, required
  metadata, structure by document type, verification gates, PR checklist.
- `Docs/templates/` (new): current-state guide, runbook, ADR, implementation
  report templates.
- Status banners added to 20 historical/superseded documents (milestone plans
  0–8, TUI/daemon plans and reports, superpowers plans/specs, ADR 0010
  amendment note); ADR 0008's dead `src/tui/` links de-linked without altering
  its decision text. Historical bodies preserved verbatim.

### Workstream D — automated checks

- `bun run docs:check` (`scripts/docs/check-docs.ts`): required entry points,
  internal links and anchors, skill-mirror byte-identity, CI single-publisher
  invariant, generated CLI reference freshness, documented `aibr` commands vs
  executable help, `config/*.example.json` validated with
  `bridgeConfigSchema`. Deterministic and offline (no external link crawling).
- `bun scripts/docs/sync-skills.ts [--check]`: canonical `.opencode/skills/` →
  mirrors, with drift check.
- `bun scripts/docs/generate-cli-reference.ts`: regenerates the CLI reference.

## 3. Verification — commands run and results (2026-10-15)

| Command | Result |
|---|---|
| `bun run release:check` (frozen install, build, `bun test`, typecheck, shellcheck, `contracts:check`, CLI smoke, `bun pm pack --dry-run`) | PASS — full chain reached the final pack step |
| `bun test` | 5950 pass, 5 skip, 0 fail (5955 tests, 277 files) |
| `bun run typecheck` | PASS |
| `bun run docs:check` | PASS (all 7 checks ok) |
| `bun scripts/docs/sync-skills.ts --check` | PASS (mirrors byte-identical) |
| `cargo fmt --all --check` | PASS |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS |
| `cargo test --workspace` | PASS — all suites ok, 0 failed |
| `bunx vitest run tests/unit/documentation/install-runbook.test.ts` | PASS (31 tests) |
| Workflow YAML parse (`ci.yml`, `publish.yml`) | PASS |

## 4. Known limitations, residual risks, deferred discrepancies

1. **CI runs not yet observed.** The plan's Step 5 items "no npm publish on a
   `main` push" and "a test release reaches the preflight/publish path" can only
   be confirmed on GitHub after this branch is pushed/merged. Verified locally
   by workflow content and the regression tests instead. A first real release
   should be watched through `publish.yml`'s preflight.
2. **`failure-modes-and-recovery.md` is a design record, not a working runbook.**
   A failure-mode runbook written from the real recovery surface remains future
   work; current triage guidance lives in `Docs/architecture/current-state.md`,
   `Docs/cli-reference.md`, and the `debugging-aibr-v2` skill.
3. **Product-side defects found but out of scope** (docs now state the truth;
   the code still misbehaves): the setup wizard UI prints "2 MB" for the body
   cap (`src/cli/setup-step-widgets.ts`), probes port 4095 as a router-port
   label although nothing binds it, and the support bundle's router-version
   probe always yields `routerVersion: null` (`src/diagnostics/bundle.ts`).
4. **`aarch64-unknown-linux-gnu` platform package** is referenced by the binary
   resolver (`src/host/binaries.ts`) but absent from the build matrix; aarch64
   Linux is served by the musl static build. Documented as a limitation.
5. **External link checking** intentionally not in the required gate (network
   flakiness); eligible for a scheduled/optional job per the plan.
6. **`Docs/runbooks/part-b-manual-testing.md` was deleted** to mirror the
   operator's own staged deletion in the main checkout. Restore from git history
   if it should instead be kept as marked history.

## 5. Sign-off

Delivered versus plan Definition of Done: all eleven boxes addressed with the
evidence above. Status: complete on this branch; two Step-5 confirmations
(§4.1) require the GitHub-side run after push/merge.

## 6. Re-verification and closeout (2026-11-06)

Phase 1 landed on `asset-project-maintainability` via `a649a43`; later
documentation-audit commits on the branch did not change the Phase 1 contract.
Step 5 was completed against the current tree:

- **Second-reviewer pass executed.** An independent reviewer agent (Antigravity
  CLI, working only from the plan and the source tree) audited all eleven DoD
  items and recorded evidence in
  `Docs/implementation-reports/phase-1-second-review.md` — verdict **PASS** on
  all eleven, with four non-blocking informational findings (D-1..D-4) that
  match the known limitations already listed in §4 above.
- **Gates re-run on the current tree (2026-11-06):**

| Command | Result |
|---|---|
| `bun run release:check` | PASS (exit 0; frozen install, build, `bun test`, typecheck, shellcheck, `contracts:check`, CLI smoke, `bun pm pack --dry-run`) |
| `bun test` | 6019 pass, 3 skip, 0 fail (278 files) |
| `bun run generate:parity-vector` + `cargo fmt --all --check` + `cargo clippy --workspace --all-targets -- -D warnings` + `cargo test --workspace` | PASS (exit 0, all suites) |
| `bun scripts/docs/sync-skills.ts --check` | PASS — "Skill mirrors match .opencode/skills/ (2 mirrors checked)" |
| `bun run docs:check` | PASS — all 9 checks, deterministic across repeated runs |
| `bunx vitest run tests/unit/release tests/unit/documentation` | PASS — 58 tests (second reviewer's run; recorded in `phase-1-second-review.md` §3.2) |
| `bun src/cli.ts --help` vs `Docs/reference/cli-reference.md` | byte-identical (orchestrator diff) |

- **Corrections applied in this pass:**
  - `Docs/architecture/current-state.md` toolchain citations fixed: the
    previous citation `.github/workflows/ci.yml:68` named a workflow step that
    pins no toolchain (`ci.yml` resolves Rust through rustup and
    `rust-toolchain.toml`); replaced with `rust-toolchain.toml:15` plus the
    explicit workflow pins `publish.yml:57` and `milestone-7.yml:34`. Bun pin
    citation `publish.yml:26` corrected to `publish.yml:30`.
  - The plan document's status line updated from "Proposed implementation
    plan" to "Implemented" with a pointer to this report (plan §C3: facts vs.
    intent).
  - **Closeout incident, recorded for traceability:** at 2026-11-06 00:48:43
    the second-reviewer agent's session cleanup restored tracked files to
    `HEAD` (single `git restore`-style sweep; file mtimes 0.5 ms apart). This
    discarded the two in-flight doc corrections above and a pre-existing
    uncommitted `package.json` authoring change (`\u00a7` → `§` in
    `_contractsCheckWhy`). All three changes were re-applied verbatim and
    verified by diff before commit. The lesson for future delegated review
    runs: instruct the agent to leave the working tree untouched and verify
    `git status` immediately after a delegated session ends.

- **Still unverified (unchanged from §4.1):** live GitHub-side behavior —
  that a `main` push publishes nothing and that a real release reaches the
  preflight/publish path — remains confirmable only after push/merge. Static
  content, least-privilege permissions, and the regression tests
  (`tests/unit/release/`) are the local evidence.
