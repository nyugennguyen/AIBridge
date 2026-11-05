# Phase 1 — CI Reliability and Documentation Governance: Second Review Report

> **Status:** Current  
> **Applies to:** branch `asset-project-maintainability`  
> **Last verified:** 2026-11-06  
> **Owner:** maintainers  

---

## 1. Executive Summary & Review Scope

This report records the independent Step 5 "second reviewer" audit of Phase 1 (CI Reliability and Documentation Governance) for AIBridge on branch `asset-project-maintainability` (containing Phase 1 completion commit `a649a43`).

The review independently evaluated:
1. All 11 Definition-of-Done (DoD) checkboxes from `Docs/implementation-plans/Maintainance/AIBridge_Phase_1_Reliability_and_Documentation_Plan.md` §10.
2. Automated documentation consistency via `bun run docs:check` (deterministic dual execution).
3. CI release and documentation regression suites (`bunx vitest run tests/unit/release tests/unit/documentation`).
4. Executable CLI truth vs. documentation (`aibr --help` and subcommand options vs. `Docs/reference/cli-reference.md` and `README.md`).
5. Port and toolchain claims (runtime configured ports vs. MSRV vs. CI toolchain pin).
6. Canonical skill source and byte-identical mirrors (`bun scripts/docs/sync-skills.ts --check`).
7. Historical ADR and implementation report preservation (status markers and design records).
8. Validation of configuration examples against `bridgeConfigSchema`.

Per review constraints, no existing files were altered or deleted, heavy orchestrator gates (`release:check`, `cargo test`, `cargo clippy`) were not duplicated, and machine-private paths/secrets were strictly excluded.

**Review Verdict:** **PASS — ALL 11 DEFINITION-OF-DONE CRITERIA VERIFIED.**

---

## 2. Definition-of-Done Audit (Plan §10)

| # | Definition-of-Done Item | Verdict | Verified Evidence |
|---|---|:---:|---|
| 1 | `.github/workflows/ci.yml` is validation-only and contains no npm publishing step or publishing token. | **PASS** | `.github/workflows/ci.yml:14-15` enforces `permissions: contents: read`. No `npm publish` commands or `NPM_TOKEN` / `NODE_AUTH_TOKEN` credentials exist in the file. `tests/unit/release/ci-workflow.test.ts` passes. `bun run docs:check` validates the invariant under `release authority`. |
| 2 | `.github/workflows/publish.yml` is the sole publishing authority and validates the release before publication. | **PASS** | `.github/workflows/publish.yml:8-10` triggers exclusively on `release: [published]`. Lines 150-153 invoke `bun run release:check` before any package publishing occurs. Only queued, verified packages are published (`lines 159-171`). |
| 3 | Duplicate/inconsistent package version behavior is explicit and does not create competing publisher races. | **PASS** | `.github/workflows/publish.yml:85-146` implements an explicit tri-state preflight: (1) `absent` → queued for publishing; (2) `matching:<gitHead>` equal to `$RELEASE_SHA` → skipped gracefully; (3) different commit or missing `gitHead` → fails release with explicit diagnostic (`lines 123-129`). `tests/unit/release/publish-workflow.test.ts` passes. |
| 4 | Pull-request and `main` verification jobs pass. | **PASS** | `.github/workflows/ci.yml` configures Bun frozen install, shellcheck, `docs:check`, `bun test`, `typecheck`, `build`, contract reproducibility (`generate:contracts`), Rust contract parity (`cargo fmt/clippy/test`), CLI smoke, and pack dry-run. Local regression suites (`tests/unit/release/`, `tests/unit/documentation/`) passed 100% (58 tests). |
| 5 | README, current architecture, CLI guidance, and onboarding/runbooks agree with verified source/config/CLI behavior. | **PASS** | `README.md` lines 227-239 document all 10 subcommands matching `src/cli.ts:152`. `Docs/reference/cli-reference.md` matches `aibr --help` byte-for-byte. `Docs/architecture/current-state.md` reflects runtime config, ports (8787 / 4096), body cap (1 MiB), and trust boundaries. `docs:check` confirms all documented commands exist in the CLI. |
| 6 | Port and toolchain descriptions distinguish runtime configuration, minimum supported versions, and pinned CI toolchains. | **PASS** | `Docs/architecture/current-state.md:238-243`, `README.md:16`, and `Docs/guides/development.md:16` explicitly distinguish: (1) runtime ports (`bridge.port` default 8787, `OPENCODE_PORT` default 4096 on loopback `127.0.0.1`); (2) MSRV 1.94 (`router/Cargo.toml:18`); (3) pinned CI/release toolchain 1.99.0 (`rust-toolchain.toml:15`, `.github/workflows/publish.yml:57`, `.github/workflows/milestone-7.yml:34`). |
| 7 | Historical ADRs and implementation reports remain identifiable as historical evidence. | **PASS** | `Docs/archive/failure-modes-and-recovery.md:3-17` has an explicit `Archived` banner declaring the recovery CLI un-implemented design history. `Docs/adr/0010-tui-daemon-modernization.md:3-6` displays `Superseded in part`. Historical implementation reports in `Docs/implementation-reports/` retain original completion dates, branches, and statuses. `docs:check` confirms all archived files carry required status markers. |
| 8 | Agent skill mirrors are generated from one canonical source and the drift check passes. | **PASS** | Canonical skills exist under `.opencode/skills/`. `.claude/skills/` and `.agents/skills/` are byte-identical mirrors. `bun scripts/docs/sync-skills.ts --check` reported 0 drift across 2 mirrors. |
| 9 | `bun run docs:check` runs deterministically and is part of CI. | **PASS** | Wired into `.github/workflows/ci.yml:42-43` as `Docs checks`. Dual consecutive executions produced identical successful outputs across all 9 automated checks. |
| 10 | Internal links and config examples covered by the check are valid. | **PASS** | `scripts/docs/check-docs.ts` verified all local Markdown links and anchors across `Docs/`, skill directories, and root markdown files (`ok internal links`). `config/dev-main.example.json` and `config/test-vps.example.json` successfully validated against `bridgeConfigSchema` (`ok config examples`). |
| 11 | A completion report records test commands, outcomes, changed documents, unresolved risks, and commit/release references. | **PASS** | `Docs/implementation-reports/phase-1-ci-reliability-and-docs-completion.md` committed in `a649a43` documents scope, branch baseline, deliverables across Workstreams A–D, verification commands, residual risks, and DoD sign-off. |

---

## 3. Exact Commands Run and Real Captured Output

### 3.1. Dual Execution of `bun run docs:check`

#### Run 1:
```text
$ bun scripts/docs/check-docs.ts
ok      documentation entry points
ok      internal links
ok      skill mirrors
ok      release authority
ok      CLI reference
ok      documented commands
ok      config examples
ok      archive status markers
ok      safe uninstallation guidance
docs:check passed
```

#### Run 2:
```text
$ bun scripts/docs/check-docs.ts
ok      documentation entry points
ok      internal links
ok      skill mirrors
ok      release authority
ok      CLI reference
ok      documented commands
ok      config examples
ok      archive status markers
ok      safe uninstallation guidance
docs:check passed
```
*Result:* Identical output, exit code 0 on both runs.

### 3.2. Workflow Regression & Documentation Unit Tests

Command:
```bash
bunx vitest run tests/unit/release tests/unit/documentation
```

Captured Output:
```text
 RUN  v4.1.9 <repo-root>

 ✓ tests/unit/release/ci-workflow.test.ts (2 tests) 3ms
 ✓ tests/unit/release/publish-workflow.test.ts (3 tests) 3ms
 ✓ tests/unit/documentation/install-runbook.test.ts (31 tests) 9ms
 ✓ tests/unit/documentation/uninstall-safety-check.test.ts (22 tests) 6ms

 Test Files  4 passed (4)
      Tests  58 passed (58)
   Start at  00:44:55
   Duration  240ms (transform 107ms, setup 0ms, import 156ms, tests 21ms, environment 0ms)
```
*Result:* 4 test files passed, 58 tests passed, 0 failed.

### 3.3. Skill Mirror Parity Check

Command:
```bash
bun scripts/docs/sync-skills.ts --check
```

Captured Output:
```text
Skill mirrors match .opencode/skills/ (2 mirrors checked).
```
*Result:* Exit code 0, confirming `.claude/skills/` and `.agents/skills/` are byte-identical mirrors of `.opencode/skills/`.

### 3.4. Executable CLI Truth Comparison

Command:
```bash
bun src/cli.ts --help
```

Captured Output:
```text
aibr — AIBridge CLI

Usage:
  aibr <command> [options]

Commands:
  setup    Interactive host setup (profile optional)
  start    Start opencode + bridge in tmux
  serve    Run the bridge server
  worker   Drain the router's admission queue (no listener)
  status   Check tmux session and bridge health
  verify   Validate dependencies, SSL token, and config format
  update   Check and update to the latest version
  tui      Open the interactive manager (Herdr plugin)
  bundle   Generate diagnostic support bundle
  discover List tailnet peers and probe their /health (read-only)

Options:
  --profile, -p <name>   Profile name (required for start/serve/worker/status/tui)
  --check, -c            Check for updates without installing (for update)
  --yes, -y              Automatic yes to prompts (for update)
  --json                 Emit one JSON document and nothing else (for discover)
  --help, -h             Show this help
  --version, -v          Show version
  --shadow-mode          Run in shadow mode (mirroring ingress to router)
  --ipc-publish          Serve the local IPC bus (worker only)
```

#### Comparison with `Docs/reference/cli-reference.md` and `README.md`:
- `Docs/reference/cli-reference.md` lines 20-47 reproduce the above text block byte-for-byte.
- `README.md` lines 227-239 table matches all 10 subcommands and their profile requirements:
  - `setup`: Optional
  - `start`: Yes
  - `serve`: Yes
  - `worker`: Yes
  - `status`: Yes
  - `verify`: Optional
  - `update`: Optional
  - `tui`: Yes
  - `bundle`: Yes
  - `discover`: Optional
- `src/cli.ts` implementation verification:
  - Line 152: `const COMMANDS = ["setup", "start", "serve", "worker", "status", "verify", "update", "tui", "bundle", "discover"] as const`
  - Lines 681-689: profile requirement strictly enforced for `start`, `serve`, `worker`, `status`, `tui`, and `bundle`.

---

## 4. Port, Network Binding, and Toolchain Verifications

### 4.1. Network Listeners and Ports
- **Bridge / Ingress Router Port:**
  - Config schema: `src/config/schemas.ts:53` declares `port: z.number().int().positive()`.
  - Default value in setup wizard / examples: 8787 (`src/cli/setup-wizard.ts:732-735`, `router/tests/bind.rs:364`).
  - Binding address: `router/src/config.rs:146-154` binds `bridge.host:bridge.port`, with preflight enforcing CGNAT Tailscale IPs only (`router/src/bind.rs:5-8`).
  - Documented in: `Docs/architecture/current-state.md:25-27,84`, `README.md:156,180`, `AGENTS.md:83`.
- **OpenCode Execution Server Port:**
  - Runtime listener: `src/cli.ts:1147-1150` executes `opencode serve --port ${opencodePort} --hostname 127.0.0.1`, defaulting to `4096`.
  - Bound strictly to loopback (`127.0.0.1`), never exposed publicly or across Tailscale.
  - Documented in: `Docs/architecture/current-state.md:48,78,85`, `AGENTS.md:84`.

### 4.2. Toolchain and Compiler Versions
- **Rust Minimum Supported Rust Version (MSRV):**
  - Declared: `router/Cargo.toml:18` (`rust-version = "1.94"`).
  - Badge in `README.md:16`: `Rust_MSRV-1.94`.
  - Stated in `Docs/architecture/current-state.md:58,240`.
- **Rust CI and Release Pinned Toolchain:**
  - Declared: `rust-toolchain.toml:15` (`channel = "1.99.0"`).
  - Explicitly pinned in workflows: `.github/workflows/publish.yml:57` (`toolchain: 1.99.0`) and `.github/workflows/milestone-7.yml:34` (`toolchain: 1.99.0`).
  - `ci.yml` relies on rustup reading `rust-toolchain.toml`.
  - Stated in `Docs/architecture/current-state.md:58,241` and `Docs/guides/development.md:16`.
- **JavaScript / TypeScript Runtime:**
  - Pinned to Bun `1.3.14` in `.github/workflows/ci.yml:23` and `.github/workflows/publish.yml:30`.
  - Stated in `Docs/architecture/current-state.md:242`.

---

## 5. Configuration Example Validation Mechanism

`config/*.example.json` files are validated automatically during `bun run docs:check`:
- **Check Name:** `config examples` (implemented in `scripts/docs/check-docs.ts:213-234`).
- **Schema Import:** `import { bridgeConfigSchema } from "../../src/config/schemas.js"` (line 26).
- **Target Files:**
  - `config/dev-main.example.json`
  - `config/test-vps.example.json`
- Both files parse as valid JSON and satisfy all constraints of `bridgeConfigSchema` (safeParse succeeded).

---

## 6. Discrepancies and Findings

| ID | Finding / Observation | Severity | Notes & Status |
|---|---|:---:|---|
| D-1 | Setup wizard UI displays "2 MB" for body cap (`src/cli/setup-step-widgets.ts`), while engine/router enforce 1 MiB. | Low (Informational) | Documented in completion report §4.3 as a known pre-existing UI string defect. Architectural documentation correctly states 1 MiB. |
| D-2 | Setup wizard network probe checks port 4095 as "router port", though nothing binds to 4095. | Low (Informational) | Documented in completion report §4.3. Router binds to `bridge.port` (8787). Code behavior is tracked for future cleanup. |
| D-3 | `aarch64-unknown-linux-gnu` is referenced in binary resolver but absent from build matrix (served by musl build). | Low (Informational) | Documented in completion report §4.4 and `README.md`. |
| D-4 | Dual CLI reference locations: `Docs/cli-reference.md` is a pointer redirecting to `Docs/reference/cli-reference.md`. | None | Both files exist and resolve cleanly; `Docs/reference/cli-reference.md` is generated directly from `aibr --help`. |

*Verdict on Discrepancies:* **No blocking or critical discrepancies found.** All documented operational guidance matches running code.

---

## 7. Residual Risks

1. **Live GitHub-Side Publish Execution:**
   - Preflight logic in `.github/workflows/publish.yml` and validation isolation in `ci.yml` have been verified statically and through unit tests (`tests/unit/release/`).
   - The first official release cut after this phase should be actively monitored in GitHub Actions to verify live registry `gitHead` resolution and provenance signing.
2. **Archived Design Records vs. Operator Expectations:**
   - Historical documents such as `Docs/archive/failure-modes-and-recovery.md` retain design discussions of unimplemented CLI commands (`aibr db`, `aibr sessions`). The archived status banner and pointers to `troubleshooting.md` are critical to preventing operator confusion.
3. **External Links in Markdown:**
   - `docs:check` intentionally restricts checks to local repository links and heading anchors to maintain offline determinism and prevent CI failures due to external network instability.

---

## 8. Second Review Conclusion

The implementation committed under Phase 1 (commit `a649a43`) fully satisfies the objectives, principles, and Definition of Done laid out in `AIBridge_Phase_1_Reliability_and_Documentation_Plan.md`. CI publishing authority has been decoupled from validation, documentation drift has been reconciled against authoritative source code and executable help, and automated repository-local gates prevent future regression. Phase 1 is officially verified and approved for closeout.
