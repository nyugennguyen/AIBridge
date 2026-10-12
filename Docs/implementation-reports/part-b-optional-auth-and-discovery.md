# Part B (B1–B3) — Optional Auth & Tailscale Discovery: Implementation Report

- **Branch:** `dev-2.2.0`
- **Base:** `64f642b`
- **Commits:** `b2f5c00`, `a68c579`, `7223df1`, `5613826`
- **Scope:** B1, B2, B3 of `Docs/aibridge-herdr-orchestration.md`. **B4 (the 2.2.0 release) is deliberately not started.**
- **Diff:** 48 files changed, 5443 insertions, 102 deletions
  (src 18 · tests 13 · contracts 10 · router 2)

---

## 1. Executive Summary & Delivery Verdict

Part B makes two things possible that were previously impossible: a node can run
with **no bearer authentication at all**, and an operator can **discover their
peers** instead of hand-typing `http://100.64.0.2:8787` into a prompt.

Both shipped with the property that mattered most: **neither can weaken the
system by accident.** A missing token file cannot become an open bridge, because
`createAuthProvider` throws rather than degrading. A reachable peer cannot
enrol itself, because the default answer in `aibr setup` is to enrol nobody. A
`tskey-` node-enrollment credential cannot reach a terminal, because the one
rule that strips it lives in one module both surfaces import.

| Gate | Result |
|---|---|
| `bun run typecheck` | clean, 0 diagnostics |
| `bun test` | **5597 pass / 6 skip / 0 fail** (5603 tests, 259 files) |
| `bun run build` | clean |
| `bun run contracts:check` | exit 0 |
| `bun run release:check` | exit 0 |
| `cargo test -p aibr-router` | 37 pass / 0 fail |

---

## 2. Task Delivery Inventory

### B1 — Optional bearer authentication

| Item | Status | Where |
|---|---|---|
| `security.auth_mode` accepts `"bearer-token"` \| `"none"` | ✅ | `src/config/schemas.ts:45` |
| `AuthMode` type exported | ✅ | `src/config/types.ts:20` |
| `OpenAuthProvider` | ✅ | `src/security/auth-provider.ts:35` |
| `createAuthProvider` factory, fails closed | ✅ | `src/security/auth-provider.ts:51` |
| `BearerAuthProvider` refuses empty token | ✅ | `src/security/auth-provider.ts:9` |
| Routes select provider by mode at registration | ✅ | `src/server/routes/{trigger,report}.ts` |
| `bearerToken` nullable across 6 call sites | ✅ | `AppDependencies`, `RuntimeOptions`, `CallbackReporter`, `EgressOutboxStore`, `cli.ts`, `index.ts` |
| Setup three-way choice + 3 guards | ✅ | `src/cli/setup-wizard.ts` |
| `aibr verify` warns instead of fails | ✅ | `src/cli/verify.ts` |
| `ok` = "nothing failed" not "everything passed" | ✅ | `src/cli/verify.ts` |

### B2 — Tailscale peer discovery + `/health` identity

| Item | Status | Where |
|---|---|---|
| `discoverTailscalePeers` | ✅ | `src/host/tailscale-discovery.ts` |
| `Peer` map + plain-text fallback, Self excluded | ✅ | same |
| `/health` reports `agent_id` + `capabilities` | ✅ | `src/server/routes/health.ts` |
| Contracts regenerated (TS + Rust mirror) | ✅ | `contracts/v1/`, `router/src/contracts.rs` |
| `contracts:check` added to `release:check` | ✅ | `package.json` |
| Rust toolchain in both publish jobs | ✅ | `.github/workflows/{ci,publish}.yml` |

### B3 — `aibr discover`, enrolment, verify, docs

| Item | Status | Where |
|---|---|---|
| `probeDiscoveredAgents` + `renderAgentDiscoveryProbe` | ✅ | `src/cli/setup-step-widgets.ts:892+` |
| `aibr discover [--json]` | ✅ | `src/cli.ts` |
| Setup enrolment flow (explicit selection) | ✅ | `src/cli/setup-wizard.ts` |
| `tailscale-discovery` verify check | ✅ | `src/cli/verify.ts` |
| Shared `tskey-` guard | ✅ | `src/cli/discovery-safety.ts` |
| README + CHANGELOG | ✅ | `README.md`, `CHANGELOG.md` |

---

## 3. Design Decisions & Their Reasons

### 3.1 `auth_mode` is `.default()`ed, not just widened

```ts
auth_mode: authModeSchema.default("bearer-token")
```

Widening `z.literal("bearer-token")` to an enum **without** a default would have
turned every stored profile into a parse failure. That is the wrong way for an
operator to discover an old file, and it would have made B1 a breaking change
underneath a widening that should not have been one.

### 3.2 `createAuthProvider` throws; it never degrades

`bearer-token` mode with no secret is a broken profile, **not** an open one.
Falling back to `OpenAuthProvider` would convert "the secret file is missing"
into "every request is authorized" — the precise failure the bearer check
exists to prevent. It throws at `createApp` time, so the process refuses to
start rather than starting and serving an open bridge.

This is asserted directly in `tests/integration/auth-mode.test.ts`, which builds
the app and expects the throw.

### 3.3 `n` at setup Step 2 still means "paste my own token"

Only an explicit `none` disables authentication. `n` has meant "don't
generate" since that prompt existed; rebinding it to no-auth would turn an old
muscle memory into an unauthenticated bridge. Pinned by
`parseBearerTokenChoice` tests.

### 3.4 The `Authorization` header is omitted, not sent as `"Bearer null"`

A `none`-mode node still delivers callbacks. Sending `Bearer null` produces a
request that looks like a broken client; sending no header produces one that
honestly says "I am not authenticating". A peer that requires a token answers
401 either way — but only one of those looks like a bug in the log.

### 3.5 `/health` carries capabilities from `allowed_sources`, not `agents[]`

`agents[]` describes who this node can *call* (outbound). Projecting it would
turn a discovery probe into **topology disclosure**. `allowed_sources` is the
inbound half and answers the question discovery actually asks.

`source_agent_id` and `requires_plan_approval` are deliberately dropped. A probe
learns *what work this node accepts*, not *which tailnet peers it has authorised*.
Asserted in `tests/unit/server/health.test.ts:99`.

### 3.6 Discovery proposes; the operator decides

`aibr setup` Step 4 branches on an explicit selection whose **default is skip**.
There is no code path from a reachable `/health` to a config write. This is
structural, not documentary.

### 3.7 Enrolment writes both arrays from one object

The released wizard wrote two separately-typed ids and **two different
capability lists** — inbound `["development","orchestration"]` against outbound
`["testing","qa"]`. That is a config in which the two halves describe different
grants for the same peer, which is exactly the drift `assertSourceAuthorized`
refuses with a 403. Both arrays now derive from a single `enrolledPeer`, and
selecting nobody leaves both empty and consistent.

### 3.8 `aibr verify` never emits `fail` for discovery

No Tailscale, an empty tailnet, and all-peers-offline all **pass**. A machine
alone on its tailnet is a normal install, not a fault. `warn` is reserved for
"peers answer but this profile enrols none of them" and "the probe could not
run".

---

## 4. Bugs Found & Fixed Along the Way

### 4.1 The contract gate did not exist locally

CI ran `generate:contracts && git diff --exit-code`; `bun run release:check` did
not. B1 therefore **shipped a stale artifact** — `contracts/v1/bridge-config.schema.json`
still said `"const": "bearer-token"` while the schema said `enum`. Fixed by
adding `contracts:check` to `release:check`, matching CI.

**Both failure modes were then verified directly:**
- A stale committed artifact (the exact B1 bug, re-created) → exits 1.
- A generated artifact present but never committed → exits 1.

### 4.2 `aibr bundle --preview` was rejected as an unknown flag

`parseArgs` pushed `--preview` onto **both** `knownFlags` and `unknownFlags`, so
the unknown-flag guard rejected it before the bundle branch could read it. A
documented, implemented flag that was **unreachable in every released version**.

```diff
} else if (arg === "--preview") {
   knownFlags.push("--preview")
-  unknownFlags.push(arg)
```

### 4.3 The `tskey-` guard existed twice

`src/cli.ts` and `src/cli/setup-wizard.ts` each carried their own `TSKEY_PREFIX`
and scrub function. Duplicated redaction logic reads as deliberate in either
copy — which is exactly what makes it likely one is edited and the other is not.
The rule now lives once in `src/cli/discovery-safety.ts`, a leaf module that
imports nothing, so the wizard shares it without depending on the command layer.

### 4.4 `aibr verify` scored warnings as failures

`ok = checks.every(c => c.status === "pass")`. A `warn` therefore made
`report.ok === false`, so the first `none`-mode node would have reported FAILED
through no fault of its own. Corrected to `ok = failCount === 0`.

### 4.5 A stale citation in hand-written Rust docs

`router/src/routes.rs` quoted the old `/health` shape and pointed at
`health.ts:5`, a line that moved. It is hand-written, so **regeneration would
not have fixed it**.

---

## 5. Security & Privacy Audit Findings

| # | Finding | Disposition |
|---|---|---|
| S-1 | A missing `bearer_token` file could become an open bridge | **Closed** — `createAuthProvider` throws (`B1`) |
| S-2 | A `none`-mode node could be bound to a non-CGNAT host | **Closed** — setup refuses (`B1`) |
| S-3 | A stale secret could be silently ignored in `none` mode | **Closed** — setup refuses; `verify` warns (`B1`, `B3`) |
| S-4 | `agent_id` on an unauthenticated route is new disclosure | **Accepted & bounded** — a strict subset of what `/jobs/:id` already returns unauthenticated; both values already appear in `public_url` and `/trigger` responses |
| S-5 | Capability list could leak tailnet topology | **Closed** — inbound list only; `source_agent_id` and `requires_plan_approval` dropped (§3.5) |
| S-6 | A discovered peer could self-enrol | **Closed** — explicit selection, default skip (§3.6) |
| S-7 | A `tskey-` credential could reach a terminal | **Closed** — one shared guard; raw `tailscale status --json` never leaves `discoverTailscalePeers` |
| S-8 | An unreachable peer could hang the CLI forever | **Not a shipped bug** — `AbortSignal.timeout` is passed; a demo harness dropped the `init` and the footgun is now documented (`5613826`) |

**Reachability is not authentication** is stated at every surface: the widget,
the JSON payload's `notice` field, the wizard roster, the `verify` check, the
README, and the CHANGELOG. `Docs/security/milestone-0-threat-model.md` is cited
from each.

---

## 6. Gate Verification Evidence

### 6.1 Full Test Suite

```
$ bun test
 5597 pass
 6 skip
 0 fail
 95052 expect() calls
Ran 5603 tests across 259 files. [22.12s]
```

| Layer | Files | Tests |
|---|---|---|
| `tests/unit/<module>/` | 220 | 4546 |
| `tests/integration/` | 19 | 291 |
| `tests/contracts/` | 10 | 63 |
| `tests/recovery/` | 3 | 21 |
| `tests/security/` | 3 | 11 |
| `tests/load/` | 4 | 6 |

Tests added by Part B: **193** (161 new files/locations + extensions).

### 6.2 Typecheck

```
$ bun run typecheck
$ tsc -p tsconfig.json --noEmit
# exit 0, 0 diagnostics
```

### 6.3 Contract Reproducibility

```
$ bun run contracts:check
generate:contracts wrote 40 schemas to contracts/v1/
aibr-contract-gen: router admission contracts -> already up to date
aibr-contract-gen: local IPC bus contracts -> already up to date
generate:parity-vector: 15/15 fixtures accepted
# exit 0
```

The Rust mirror types `auth_mode` as a real enum defaulting to `BearerToken`, so
the structural gate accepts both values.

### 6.4 Rust

```
$ cargo test -p aibr-router
test result: ok. 37 passed; 0 failed
```

`auth_mode` is never read by the router, so the `String` → enum change is
behaviourally inert there.

---

## 7. Known Issues & Carry-Forward

### 7.1 Pre-existing, not introduced here

- **`tests/unit/host/runtime.test.ts` fails 7/28 under the `vitest` runner.**
  `BunProcessRunner` returns empty stdout for `pwd`/`echo`. Verified against a
  pristine `HEAD` worktree before any Part B work, so it predates this branch.
  `bun test` uses Bun's runner and is unaffected. `bun run test` / `vitest run`
  will show these.
- **`src/host/setup.ts` is dead code.** `src/cli.ts` imports `runSetup` and never
  calls it; the live path is `src/cli/setup-wizard.ts`. Part B changed **only**
  the live path. The dead module still duplicates the config literal and would
  benefit from a follow-up `@deprecated` marker plus a test asserting the CLI
  never imports it.
- **`bridge.tailscale_bind_host`** is read by `src/diagnostics/bundle.ts` but is
  not in `bridgeConfigSchema`, so `writeConfig` strips it.

### 7.2 Accepted design debt

- **Duplicated capability defaults** in `StepperFSM` and `runHeadlessWizard` —
  two code paths for one wizard, one of them unreachable in production.
- **`_contractsCheckWhy`** is a non-standard top-level `package.json` key
  (`package.json` has no comments). Everything ignores it and the suite is green;
  it could move to `Docs/` if the team prefers.
- **Discovery is sequential** with a per-peer timeout (2000ms default, 1500ms in
  `verify`). A large tailnet makes `aibr setup` Step 4 and `aibr verify`
  measurably slower. Bounded, and it degrades to empty rather than hanging.
- **The manual peer's `100.64.0.2` default still rots.** Preserved verbatim so
  the fallback path is unchanged; it is simply no longer the path you land on.

### 7.3 Not done

- **B4 — the `2.2.0` release.** Version bump, `[Unreleased]` → `[2.2.0]`,
  final `release:check`. `package.json` and `src/version.ts` currently read
  `2.1.6`, kept in agreement by `tests/integration/package-smoke.test.ts`.
- **ADR 0011** superseding ADR 0009 (planned for Part A).
- **The enrolment flow has never run against a live two-node tailnet.** Every
  verification was single-machine or simulated. See the manual testing guide.

---

## 8. Verdict

B1, B2 and B3 are **complete against their stated gates**, with every security
boundary in §5 closed or explicitly and defensibly accepted. The work has not
been exercised on real multi-node hardware; §7.3 records that as the outstanding
risk rather than claiming a validation that did not happen.

**Not released.** B4 awaits an explicit decision.
