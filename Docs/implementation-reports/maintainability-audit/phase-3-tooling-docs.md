# Maintainability Audit — Phase 3: Tooling & Documentation

> **v2 note:** this report preserves the v1 evidence. Its MNT-305/307 mentions are now
> defined in `findings-register.md` (v2), and MNT-310's framing is corrected in
> `audit-changelog.md` (C1, C4).

**Date:** 2026-10-19 · **Commit:** `6dc9b04` · Sources: `DocsCiDepsMap` scout (reviewed),
lead-reviewer spot-verification. [Verified] = re-checked first-hand this session.

## 1. Toolchain inventory

**npm** (all exact pins — enforced by `tests/integration/package-smoke.test.ts`; `bun.lock`
hashes): deps `@fastify/websocket`, `@opencode-ai/sdk` (via `@opencode-ai/sdk/v2`),
`@opentui/core`, `fastify`, `pino`, `zod`; devDeps `@types/node`, `ajv`, `tsx`,
`typescript`, `vitest`, `yaml`. Every one except the flags below has a verified importer.

**Rust** (workspace root; members `router`, `router/contract-gen`, `crates/aibr-ipc`,
`crates/aibr-pty`): exact `=x.y.z` pins with written justifications in `router/Cargo.toml`
(`regress` load-bearing for typify patterns; axum without `ws` deliberately; `rusqlite`
bundled-only; `syn =2.0.119` pin records a past wrong pin). `rust-toolchain.toml` pins
1.99.0 + clippy/rustfmt; both workflows repeat the pin and
`tests/unit/packaging/supervision.test.ts` asserts agreement. This is a strength.

**Toolchain flags:**

| Finding | Evidence | Class |
|---|---|---|
| MNT-301 `pino` direct dep has **zero importers** in `src/`, `tests/`, `scripts/` (fastify already depends on it) | repo grep [Verified] | REMOVE |
| MNT-302 `@opentui/core` direct dep has **zero importers** (TUI retired Phase 6; brings 8 native optional packages); `tests/unit/rules/tui-barrel.test.ts:396` even forbids importing it | repo grep [Verified] | REMOVE |
| MNT-303 `ws` imported by `tests/integration/terminal-websocket.test.ts:53` but **undeclared** (satisfied transitively via `@fastify/websocket`) | import grep | SIMPLIFY (declare or import from dep) |
| MNT-304 Two JS runtimes in play: `dev` = `tsx src/index.ts` (Node), everything else Bun; `tsx` also used by `generate:*` scripts and one test harness | `package.json` scripts | NEED EVIDENCE |
| MNT-305 Two test runners (`vitest` devDep vs `bun test` gate) — see Phase 2 MNT-201 | measured | SIMPLIFY |

## 2. Scripts & auxiliary tooling

| Item | Purpose | Wiring | Class |
|---|---|---|---|
| `scripts/generate-contracts.ts`, `generate-parity-vector.ts` | contract chain | `generate:*`, `contracts:check`, CI | KEEP |
| `scripts/docs/{check-docs,generate-cli-reference,sync-skills}.ts` | doc gates | `docs:check` (CI), `docs:skills` | KEEP (see §4 for rule-cost analysis) |
| `scripts/install.sh` | curl\|bash installer | CI + `test:installer` + `milestone-7.yml` + tests | KEEP |
| `scripts/build-matrix.sh` | musl/gnu cross-builds | `milestone-7.yml` | KEEP |
| `scripts/package-binaries.ts` | stage `packages/<platform>` | **no workflow runs it** — publish.yml's `packages/*` loop can never queue on a clean checkout (`/packages/` gitignored) [Verified `.gitignore:22`, workflow read] | NEED EVIDENCE → SIMPLIFY |
| `scripts/m0-contract-signoff.sh` | M0 digest re-approval tool | referenced only in milestone-4 plan | NEED EVIDENCE → REMOVE/ARCHIVE |
| `scripts/tmux-start.sh` | headless ops starter | `AGENTS.md:131`; **untested**; defects below | SIMPLIFY |
| `bench/` | bash measurement harness + committed baselines | manual; `bench/baseline/capture-config.json` reused by `milestone-7.yml` | KEEP (as tooling) |
| `spike/` | M7.1 throwaway measurement ("NOT production code"), own `router-stub` crate + committed results | none | REMOVE/ARCHIVE candidate (H5) |
| `bin/aibr-router-darwin-arm64` | prebuilt binary | **referenced by nothing** [Verified] | NEED EVIDENCE → REMOVE |
| `.gemini/skills/` | empty dir | in neither mirror list nor scan dirs | REMOVE (placeholder) |
| `packages/` (gitignored working tree) | stale staged output at v2.1.1 still naming retired `aibr-tui` bin | local only | REMOVE (local artifact, not source) |

MNT-306 `scripts/install.sh:12` `--version` prints hardcoded **`2.0.0`** while
`src/version.ts` `CLI_VERSION = "3.0.0"` and `package.json` = 3.0.0 [Verified].
`milestone-7.yml:226` invokes this flag. No test asserts the value. → SIMPLIFY (single
source of truth; the repo already mandates `src/version.ts` as such).

MNT-307 `scripts/tmux-start.sh:16` [Verified]:
(a) starts `opencode serve --hostname 0.0.0.0` contradicting `AGENTS.md:135` "Never expose
opencode serve publicly"; (b) interpolates `OPENCODE_SERVER_PASSWORD` into the tmux
command string — visible in process argv of the spawned shell — while
`tests/unit/host/tmux.test.ts:192` enforces "never places secrets in argv" for the
programmatic backend; (c) uses `bun run dev` (Node/tsx) rather than the Bun path. The
script sits outside every tested surface. → SIMPLIFY (and align with G6).

## 3. CI & release workflows

Three workflows: `ci.yml` (validation-only), `publish.yml` (sole publishing authority),
`milestone-7.yml` (musl matrix + packaging verification, runs on **every PR** and
`workflow_dispatch`). The ci/publish split is a documented, test-enforced design
(`tests/unit/release/*`); the workflows are unusually well commented with incident
rationale.

Gaps and costs:

- **MNT-308 Gate asymmetry** [Verified from workflow + package.json]:
  `release:check` (the publish-side gate) never runs `docs:check` nor
  `cargo fmt/clippy/test --workspace`; CI runs them but its `bun test` never runs vitest.
  A `cargo test` regression or a docs violation cannot block a release (only a green CI on
  `main` can), while a broken `bun run test` blocks nothing at all. The two gates together
  cover everything, but no single command does. → SIMPLIFY (one local gate ≙ CI).
- **MNT-309 `milestone-7.yml` is undocumented** in the release procedure
  (`AGENTS.md` release section omits it) and re-runs the musl matrix on every PR; the
  binary-size gate (2,359,296 B) lives only there. Cost per PR is the cross-build of 5
  targets with cargo-zigbuild. → NEED EVIDENCE (measure CI minutes before changing).
- **MNT-310 Publish `packages/*` loop is dead on a clean checkout** (see §2
  `package:binaries`) — either the platform-package publishing path is unfinished or it
  relies on undocumented pre-staged artifacts. → NEED EVIDENCE.
- `contracts:check` shell depends on `rg` being installed (unusual for a package script;
  CI installs nothing extra — ubuntu runners happen to ship it) [Verified script text].
  → SIMPLIFY (use `grep`, or document).

## 4. Documentation: source of truth & validators

**Canonical map** (from `Docs/README.md` + `check-docs.ts`): architecture
(`Docs/architecture/current-state.md`), decisions (`Docs/adr/` 0001–0011 with explicit
amendment chain), CLI reference (**generated** from `aibr --help` — staleness fails CI),
security (`Docs/security/security-model.md`), operations (`Docs/operations/*`), config
(`Docs/guides/configuration.md`, examples schema-validated), skills (`.opencode/skills/`
canonical, `.claude`+`.agents` byte-identical mirrors enforced by `docs:check`). This is
a mature, thought-through doc system — recent PR #3 (HEAD) restructured it.

**Validator inventory** (`scripts/docs/check-docs.ts`, 519 lines, 9 checks + an
uninstall-safety rule engine exported to `tests/unit/documentation/uninstall-safety-check.test.ts`
398 lines). Plus `tests/unit/release/*` (132 lines) re-pinning workflow YAML, plus
`tests/unit/packaging-ci.test.ts` pinning packaging spec strings.

**MNT-311 Rule duplication across validators** [Verified]:
"ci.yml is validation-only / single publisher" is enforced by **three** independent
mechanisms — `check-docs.ts:checkCiValidationOnly`, `tests/unit/release/ci-workflow.test.ts`
(2 tests), and the workflow header comments. `aibr <command> exists` is enforced by
`check-docs.ts` only for fenced blocks; docs command reality is additionally "enforced"
by the `debugging-aibr-v2` skill's manual list. Same invariant, multiple regex
implementations, each of which must be updated together (recent commits `e04cba1`,
`efb3244` were false-positive fixes **in the checker itself** — measured cost).
→ SIMPLIFY: keep one owner per rule; make tests import the checker's helpers instead of
re-implementing regexes.

**MNT-312 Skill mirrors are a manual-sync surface with an automated guard** — 3 copies ×
2 skills (`SKILL.md` + `references/testing.md`), byte-equality enforced by `docs:check`
(the guard is good; the failure mode is "edit one, run docs:check, copy"). The skill
content itself has drifted from HEAD (see below). → SIMPLIFY (generate mirrors via
`docs:skills` in CI or drop mirrors).

**MNT-313 Doc/source drift remaining at HEAD** (spot-checked, all [Verified]):

| Doc claim | Reality |
|---|---|
| `AGENTS.md:19` "bun test is Bun's runner (vitest is `bun run test`)" vs `CONTRIBUTING.md:91` "bun test # Vitest test suite" | contradictory; see measured MNT-201 |
| `AGENTS.md:102` skill covers "`aibr bundle --preview` being broken" | fixed in 3.0.0 per CHANGELOG; skill text stale |
| `debugging-aibr-v2` skill: "README.md, AGENTS.md describe commands that do not exist" | HEAD docs carry the fictional-commands warning table (`Docs/operations/troubleshooting.md:27-41`) — skill partially stale |
| `Docs/implementation-plans/milestone-7-polyglot-ingress.md:446` `bun bench/mem.sh …` | invalid invocation (bash script); docs:check only verifies `aibr <cmd>` |
| `milestone-7.yml:226` `install.sh --version` | prints 2.0.0 ≠ 3.0.0 (MNT-306) |
| `Docs/tui/TUI_UX_SPEC.md` + `aibridge-tui-redesign.html` | describe retired `aibr-tui`, no status banner, dead `127.0.0.1:55715` links |
| `Docs/implementation-plans/Maintainance/` (misspelled) Phase-1 plan | still "Proposed" although `phase-1-ci-reliability-and-docs-completion.md` reports it complete |
| `crates/aibr-ipc/src/lib.rs:78,87` | names `tests/protocol_version.rs`, `tests/socket_path_parity.rs` — first doesn't exist (Phase 2 MNT-206) |
| `Cargo.toml`/`router/Cargo.toml` comments | "27 committed schemas", "milestone-7.yml" is fine but schema counts stale (48 now) |
| `Docs/security/milestone-0-threat-model.md` | historical artifact living in the current security folder (self-declares) |

**MNT-314 Historical documents are correctly quarantined** — `Docs/archive/` markers are
enforced by `check-docs.ts` (status-banner exemption `UNVERIFIED_STATUS`), and the
fictional-commands table is now explicit. The doc system's design is sound; the residue is
in non-archive surfaces listed above.

## 5. Measured command durations (this host, warm caches)

| Command | Duration | In `release:check`? | In CI? |
|---|---|---|---|
| `bun install --frozen-lockfile` | not measured separately | ✅ | ✅ |
| `bun run build` | 3s | ✅ | ✅ |
| `bun test` | 22s | ✅ | ✅ |
| `bun run test` (vitest) | 21s (fails — MNT-201) | ❌ | ❌ |
| `bun run typecheck` | 6s | ✅ | ✅ |
| shellcheck + `bash -n` | <1s | ✅ | ✅ |
| `bun run docs:check` | <1s | ❌ | ✅ |
| `bun run contracts:check` | 4s | ✅ | ✅ (split in 2 steps) |
| `cargo fmt --all --check` | 1s | ❌ | ✅ |
| `cargo clippy --workspace --all-targets` | 16s | ❌ | ✅ |
| `cargo test --workspace` | 51s | ❌ | ✅ |
| CLI smoke + `bun pm pack --dry-run` | <1s | ✅ | ✅ |

Total local verification ≈ **124s sequential**; a single "everything CI runs" command does
not exist (MNT-308). Fast feedback is already separable: `bun test` (22s) is the cheapest
meaningful gate; the expensive parts are Rust (68s total) and the musl matrix
(unmeasured, CI-only).

## 6. Phase 3 conclusions

1. Dependency hygiene is strong (exact pins, written rationales, lockfiles, pinned
   toolchains) except two vestigial deps (MNT-301/302) and one undeclared test dep (303).
2. The contract chain and doc gates are genuinely valuable and incident-hardened; their
   cost is **rule duplication across validators** (311) and **manual mirror sync** (312).
3. CI/CD has one structural inconsistency: two gates that each miss what the other runs
   (308), one heavy workflow nobody documented (309), and one publish path that cannot
   execute (310).
4. Documentation is ~90% trustworthy at HEAD; the drift that remains is concentrated in
   AGENTS/CONTRIBUTING/skills and code comments naming non-existent tests (313).
