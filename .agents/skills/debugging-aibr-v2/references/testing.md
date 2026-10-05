# Testing aibr v2 — runner matrix and suite map

> Mirrored from `.opencode/skills/debugging-aibr-v2/references/testing.md`. Keep in sync.

## Runners

| Command | Runner | Notes |
|---|---|---|
| `bun test` | Bun's built-in | **What CI runs** (`.github/workflows/ci.yml:35`). |
| `bun run test` | vitest | `vitest run`, per `package.json:28`. |
| `bunx vitest run <path>` | vitest | Single file. |
| `bunx vitest run <path> -t "<name>"` | vitest | Substring match on full test name. Imports all 248 files before filtering — slow. |
| `bun run test:unit` / `test:integration` | vitest | Directory scopes. |
| `bun run test:watch` | vitest | Watch mode. |
| `bun run test:installer` | vitest | `shellcheck` + `bash -n` + `tests/unit/installer`. |

**Always run from the repo root.** `tests/unit/installer/install-script.test.ts:131` and
`tests/integration/package-smoke.test.ts:12` invoke `bash -n` / `bun run build` with
CWD-relative paths.

No coverage provider is installed; `vitest --coverage` will fail.

## The two runners are not equivalent

`tests/unit/event-store/outbox-helpers.ts:88-98` skips any SQLite backend whose driver cannot
load. Under vitest only `node:sqlite` loads; under `bun test` both do. The executed test sets
differ. `bun test` is the gate.

## Conditional skips

| Test | Gate |
|---|---|
| `tests/integration/tmux-terminal-backend.test.ts` | `AIBRIDGE_TMUX_INTEGRATION=1` **and** `tmux` on PATH |
| `tests/integration/tui-flow.test.ts:493` | `AIBRIDGE_M1_REAL_AGENT_SMOKE=1` (needs `AIBRIDGE_M1_OPENCODE_URL`, `AIBRIDGE_M1_PROJECT_PATH`) |
| `tests/unit/runtime/{claude,codex}-adapter.test.ts` | `it.skipIf` on the installed binary existing |
| SQLite backend matrix | driver availability (see above) |

No `.only`, no `it.fails` anywhere.

## Flake triage

1. **Concurrent runners.** Two vitest invocations at once produce spurious `timeout`s
   (real occurrence: `Docs/implementation-reports/milestone-6-completion.md:540-552`).
   Re-run serially first.
2. **5s default timeout.** `vitest.config.ts` sets no `testTimeout`. There are no
   `vi.useFakeTimers` calls in the tree — time is faked via `TestClock` / `DeterministicClock`
   / `FakeSleeper`. If a test needs to wait, inject a fake; do not raise the timeout.
3. **Slow files.** `tests/integration/package-smoke.test.ts` (60s `beforeAll` build) and
   `tests/recovery/kill-restart-1000-cycles.test.ts` (1000 synchronous store cycles) are
   legitimately slow. `tests/load/router-rss.test.ts` does 500 admissions.
4. **Golden logs.** `tests/security/golden-logs.test.ts` and
   `tests/security/redaction-audit.test.ts` assert the redaction contract. Adding a log field
   that can carry a token fails here first — that is the intended tripwire.

## Fixtures

| Path | Exports |
|---|---|
| `tests/integration/fixtures.ts` | `buildTestApp(overrides)`, `testConfig()`, `validTrigger()`, `InMemoryJobStore`, `FakeOpencodeClient`, `FakeTaskGraphSyncer` |
| `tests/unit/jobs/fixtures.ts` | `trigger(overrides)`, `triggerWithDeps(deps)` |
| `tests/contracts/helpers.ts` | `DeterministicClock`, `DeterministicIdSource`, `success`, `typedFailure`, `correlation` |
| `tests/contracts/fakes.ts` | `FakeAgentRuntimeAdapter` (deterministic, in-process) |
| `tests/contracts/runtime/` | `ScriptedAgentRuntimeAdapter`, `BrokenAgentRuntimeAdapter`, `LifecycleScriptBuilder`, `describeAdapterSuite` |
| `tests/integration/mesh-fixtures.ts` | real-socket mesh harness (803 lines) |
| `tests/integration/m6-fixtures.ts` | rules/routing/budget/notification builders, `CANARIES`, `auditForCanaries` |
| `tests/unit/host/fixtures.ts` | `FakeProcessRunner`, `FakePrompter`, `FakePlatformInspector`, `FakeHttpProbe`, `FakeSleeper` |

`FakeOpencodeClient` counters: `createdSessions`, `sentPrompts`. Use it to assert whether a
session was ever created — a job that fails with zero `createdSessions` never reached opencode.

## Test rules this repo enforces

- Never run real `tmux`, `sudo`, Homebrew, apt, Tailscale, opencode, or a global install in a
  test. Inject the fake from `tests/unit/host/fixtures.ts`.
- Isolate with `mkdtemp` + `afterEach(rm(...))`.
- `buildTestApp` uses bearer token `"secret"` and `JsonFileJobStore` over a `mkdtemp` dir.

## Contracts and parity

The generated chain: Zod (`src/config/schemas.ts`) → `contracts/v1/*.schema.json` →
typify → `router/src/contracts.rs` → `router/tests/parity-vector.json`.

```bash
bun run generate:contracts        # TS schemas + Rust contracts.rs
bun run generate:parity-vector    # ONLY writer of router/tests/parity-vector.json
```

CI order matters: reproducibility (`git diff --exit-code contracts/ router/src/contracts.rs`)
runs *before* Rust parity, so a moved artifact is not misreported as parity drift.

`scripts/generate-parity-vector.ts` is deliberately the only writer of the parity vector —
a test that rewrites the expectation it asserts against is not a test. Never make a test
regenerate it.

## Full gate

```bash
bun run release:check
```

= `bun install --frozen-lockfile && bun run build && bun test && bun run typecheck && shellcheck scripts/install.sh && bash -n scripts/install.sh && bun dist/cli.js --help && bun pm pack --dry-run`

Plus the Rust half, which `release:check` omits:

```bash
cd router && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```
