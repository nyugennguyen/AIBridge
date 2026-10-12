# Manual Testing Guide — Part B (Optional Auth & Tailscale Discovery)

**Version under test:** `dev-2.2.0` branch, `CLI_VERSION 2.1.6`
**Audience:** an operator validating this build on real hardware before the 2.2.0 release
**Time:** ~45 minutes for the single-machine path (T1–T5), ~90 minutes with two nodes (T6–T8)

Every command below has been run at least once on this machine. Where output is
shown, it is **real output**, not a mockup.

---

## 0. Before You Start

### 0.1 What is being tested

| Phase | Feature | Risk level |
|---|---|---|
| B1 | Optional bearer authentication (`auth_mode`) | **Security-sensitive** |
| B2 | Tailscale peer discovery + `/health` identity | Medium |
| B3 | `aibr discover`, setup enrolment, `verify` check | Medium |

### 0.2 The single most important property

> **A `none`-mode node accepts `/trigger` and `/report` from anyone who can
> reach its port. Discovery proves reachability, never trust.**

If you test nothing else, test that **`none` mode cannot be turned on by
accident** (T3) and that **a discovered peer cannot enrol itself** (T7.4).

### 0.3 Prerequisites

```bash
git checkout dev-2.2.0
bun install --frozen-lockfile
bun run build
bun src/cli.ts --version        # expect: aibr 2.1.6
```

You also need:

- Tailscale **joined and Running** (`tailscale status | head -3`) — most tests
  degrade without it, which is itself worth observing.
- At least one other node on the same tailnet for the discovery tests.
- A **scratch profile** so you never touch a working deployment. Always:
  `aibr <cmd> --profile partb-test`.

### 0.4 Know your rollback

```bash
# Everything lives under these paths (XDG). Remove the profile to reset.
rm -rf ~/.config/aibridge/partb-test \
       ~/.local/share/aibridge/partb-test \
       ~/.local/state/aibridge/partb-test
```

> ⚠️ `writeSecret` is **write-once**. Re-running setup over an existing profile
> throws `Secret already exists`. To change secrets you must delete the file
> first — there is no rotation path in this build.

---

## T1 — Baseline: nothing has regressed

**This is the first test to run.** If T1 fails, stop; the rest is meaningless.

### T1.1 Automated suite

```bash
bun run typecheck          # expect: exit 0, no output
bun test                   # expect: 5597 pass / 6 skip / 0 fail
bun run contracts:check    # expect: exit 0
```

**Known non-issues.** `bun run test` (the *vitest* runner) reports **7 failures in
`tests/unit/host/runtime.test.ts`**. These are **pre-existing**, reproduced on a
pristine checkout of the base commit, and unrelated to Part B. `bun test` uses
Bun's runner and is clean. Judge `bun test`, not `vitest run`.

### T1.2 `aibr bundle --preview` was broken before

```bash
bun src/cli.ts bundle --preview --profile partb-test
```

- **Before Part B:** `Error: unknown flag --preview`
- **Now:** a support-bundle preview (fails later, on a missing profile — that is expected)

```bash
bun src/cli.ts bundle --nonsense --profile partb-test
# expect: Error: unknown flag --nonsense   (the guard still works)
```

---

## T2 — Setup wizard, unchanged path

### T2.1 Default run (bearer token)

```bash
aibr setup --profile partb-test
```

At **Step 2**, press Enter to generate a token. Record the secret it shows — you
will need it on the peer.

**Expected:** persists a profile; a 64-hex `bearer_token` secret is written.

```bash
# both must exist, both 0600
ls -l ~/.local/share/aibridge/partb-test/secrets/
python3 -m json.tool ~/.config/aibridge/partb-test/config.json | grep -A3 '"security"'
# expect: "auth_mode": "bearer-token"
```

### T2.2 Paste-your-own still works

Re-run and answer **`n`** at Step 2, then paste a known token.

**Expected:** `n` is **not** interpreted as "no auth" — it means "paste my own".
This is deliberate: `n` has meant "don't generate" since the prompt existed, and
rebinding it to no-auth would turn an old muscle memory into an open bridge.
Only an explicit `none` disables authentication.

### T2.3 Empty tailnet is not a dead end

Stop Tailscale (`tailscale down`) and run setup on a fresh profile.

**Expected:** discovery finds nothing and setup **falls back to the manual peer
prompts** (`Enter peer agent ID [peer]:`). This must never be bricked by an
absent tailnet. Run `tailscale up` afterwards.

---

## T3 — Optional authentication (`auth_mode: "none"`)

> **Read §0.2 before running this.** This turns off authentication.

### T3.1 Setup refuses `none` on a non-CGNAT host

Hard to trigger naturally, since setup uses your Tailscale IP. To force it, the
guard is: `bridge.host` must be in `100.64.0.0/10`. If your `tailscale ip -4` is
ever outside that range, setup must refuse:

**Expected:** `kind: "blocked"` with a reason containing
`not a Tailscale CGNAT address`. **This refusal is the security control.**

### T3.2 Setup refuses `none` over an existing secret

```bash
aibr setup --profile partb-test     # complete it normally (writes a token)
aibr setup --profile partb-test     # answer `none` at Step 2
```

**Expected:** blocked, with a reason containing `already exists`.

*Why this matters:* `writeSecret` is write-once and the secret is never re-read
against config. A leftover token would be **silently ignored** while you believed
the node was protected.

### T3.3 Enabling `none` — the real test

```bash
rm -rf ~/.local/share/aibridge/partb-test   # clear the secret
aibr setup --profile partb-test
# Step 2: type exactly:  none
# Confirm the exposure warning with: y
```

**Expected:**
- `auth_mode: "none"` in the config
- **No** `bearer_token` secret file
- An `opencode_password` secret still written (unrelated)

```bash
ls ~/.local/share/aibridge/partb-test/secrets/    # expect: only opencode_password
```

### T3.4 `none` mode really is unauthenticated

```bash
aibr serve --profile partb-test &
sleep 2
curl -s -X POST http://$(tailscale ip -4):8787/trigger \
  -H 'content-type: application/json' \
  -d '{"job_id":"manual1","source_agent_id":"anyone","target_agent_id":"partb-test",
       "capability":"development","project_dir":"/tmp","prompt":"say hi",
       "callback_url":"http://127.0.0.1:1/none","timeout_seconds":60}'
```

- **Expected:** `202` with `accepted: true` — **no `Authorization` header sent.**
- A `401` means the mode is not active. Stop and report it.

### T3.5 `verify` warns rather than fails

```bash
aibr verify --profile partb-test
```

**Expected — note this carefully:**

```
  [!] Node runs with security.auth_mode "none": /trigger and /report accept
      unauthenticated requests. Only safe on a Tailscale CGNAT bind.
      bridge.host is 100.x.y.z
  [✓] ... everything else
Status: PASSED (N/M checks passed, 1 warning)
```

The node must **PASS with a warning**, not FAIL. A missing secret on a
`none`-mode profile is the mode you chose, not a fault. If it says `FAILED`,
re-open §4.4 of the implementation report.

### T3.6 Roll back to a token

```bash
rm -rf ~/.local/share/aibridge/partb-test
aibr setup --profile partb-test   # Enter to generate
aibr verify --profile partb-test  # expect "Bearer token secret valid"
```

---

## T4 — `/health` identity

```bash
curl -s http://$(tailscale ip -4):8787/health | python3 -m json.tool
```

**Expected:**
```json
{
  "ok": true,
  "opencode": true,
  "agent_id": "partb-test",
  "capabilities": ["development", "orchestration"]
}
```

**And check what is NOT there** — this is the security-relevant part:

```bash
curl -s http://$(tailscale ip -4):8787/health | grep -E 'source_agent_id|requires_plan_approval'
# expect: NO MATCH
```

A peer identity must not leak through an unauthenticated route.

> **Note:** `/health` is unauthenticated **by design** — it is what a peer probes
> before any secret has been exchanged. Both fields are already visible in
> `bridge.public_url` and in every `/trigger` response as `target_agent_id`, and
> `/jobs/:id` is already unauthenticated and returns strictly more.

---

## T5 — `aibr discover`

### T5.1 Human output

```bash
aibr discover --profile partb-test
```

**Expected:** one row per tailnet peer — hostname, IP, reachable/unreachable, the
`agent_id` it claimed, capability count, enrolled or not. The closing line must
state that reachability is not authentication.

### T5.2 JSON output

```bash
aibr discover --profile partb-test --json | python3 -m json.tool
```

**Expected top-level keys** (this is the contract the Herdr plugin codes against):

| Key | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `ok` | `true` on success |
| `enrolledSource` | profile name, or `null` |
| `peers` | array, per-peer fields below |
| `peersFound` / `reachableCount` / `enrolledCount` | integers |
| `notice` | the reachability-is-not-authentication caveat |

**Per peer:** `ip`, `hostname`, `os`, `online`, `bridgeUrl`, `reachable`,
`agentId`, `capabilities`, `opencodeReachable`, `enrolled`.

**Checks:**
- Exactly **one** JSON document on stdout, nothing else.
- No `tskey-` string anywhere.
- An unreachable peer has `agentId: null`, `capabilities: []`,
  `opencodeReachable: null` — **`null`, never collapsed to `false`.**

```bash
aibr discover --profile partb-test --json | grep -c tskey    # expect: 0
```

### T5.3 Empty tailnet is success, not failure

```bash
tailscale down && aibr discover --json; echo "exit=$?"
# expect: {"peers":[],...} and exit=0
tailscale up
```

### T5.4 A peer that answers but does not identify

Point a peer at a non-AIBridge port, or test against a random service on 8787.

**Expected:** `reachable: true, agentId: null`, rendered as **unidentified**.
`reachable` means "something answered HTTP" — **not** "an AIBridge bridge is
there". This is intentional and is the operator's signal to investigate.

---

## T6 — Two-node discovery (needs a second machine)

On **machine B** (the peer), complete setup and start its bridge. Then on
**machine A**:

```bash
aibr discover --profile partb-test          # B should appear, reachable, with its agent_id
aibr discover --profile partb-test --json | grep -A3 worker
```

Verify B's `agent_id` matches **what B says it is**:

```bash
# on machine B
python3 -m json.tool ~/.config/aibridge/<b-profile>/config.json | grep agent_id
```

**If they disagree, that is the mis-routed-address case the roster exists to
surface.** Stop and investigate before enrolling.

---

## T7 — Enrolment in `aibr setup`

### T7.1 Setup shows the roster

```bash
aibr setup --profile partb-enrol
# Step 2: Enter (generate a token)
# Step 4: observe the roster, then press Enter for "nothing"
```

**Expected:** the roster renders, then the caveat paragraph.

### T7.2 Default enrols nobody

**Expected:** `agents[]` and `security.allowed_sources[]` are **both empty**.

```bash
python3 -m json.tool ~/.config/aibridge/partb-enrol/config.json | grep -A4 'allowed_sources'
# expect: "allowed_sources": []
```

### T7.3 Enrolling one peer

At Step 4 enter the peer's **number**, then **hostname**, then its **IP** — all
three work. Confirm the capability prompt, then the final confirmation.

**Expected:** it lands in **BOTH** arrays, with the **same id and the same
capabilities**:

```bash
python3 -m json.tool ~/.config/aibridge/partb-enrol/config.json | grep -E 'allowed_sources|agents|source_agent_id|"id"|capabilities'
```

Half-writing one array is the failure this prevents: a peer in `agents[]` but
not in `allowed_sources[]` gets **403 on `/trigger`**.

### T7.4 A discovered peer is NOT authorised until enrolled

With machine B discovered but **not** enrolled:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://<B-IP>:8787/trigger \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"source_agent_id":"<B-agent-id>","target_agent_id":"partb-test",
       "capability":"development","project_dir":"/tmp","prompt":"x",
       "callback_url":"http://127.0.0.1:1/none","timeout_seconds":60}'
# expect: 403
```

### T7.5 Manual fallback still works

At Step 4 type **`m`**, and also run setup while Tailscale is down.

**Expected:** the released prompts — `Enter peer agent ID [peer]:` and
`Enter peer agent URL [http://100.64.0.2:8787]:` — with their original defaults.

---

## T8 — `aibr verify` discovery check

```bash
aibr verify --profile partb-test
```

**Expected:**
```
  [✓] Tailnet discovery: N peers reachable, M enrolled
      Enrolled in this profile: <peer> (<ip>). Reachability only: a peer
      answering /health is not enrolled or trusted by this check.
```

**Rules to confirm:**

| Condition | Expected |
|---|---|
| No Tailscale / empty tailnet | `[✓]` pass, **`ok` unchanged** |
| Peers present, none answering | `[✓]` pass |
| Peers answering, none enrolled | `[!]` warn |
| Probe could not run | `[!]` warn |
| **Anything** | **Never `[✗]` fail** |

Time the command on a large tailnet — discovery is sequential with a per-peer
timeout (1500 ms), so it is bounded but measurably slower.

---

## T9 — Regression sweep

```bash
# The four HTTP routes still behave for a bearer-token profile
aibr start --profile partb-test      # start + bridge
curl -s http://127.0.0.1:8787/health                        # 200
curl -s -X POST http://127.0.0.1:8787/trigger -d '{}'       # 401, no token
curl -s -X POST http://127.0.0.1:8787/trigger \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
# expect 400 (invalid payload), NOT 401 — the token was accepted

aibr status --profile partb-test
aibr bundle --profile partb-test
```

Confirm `401` happens **before** `400`: an unauthenticated caller must never
reach payload validation.

---

## T10 — Known issues (do not report as regressions)

| Symptom | Status |
|---|---|
| `bun run test` / `vitest run` → 7 failures in `tests/unit/host/runtime.test.ts` | **Pre-existing.** Reproduced on the base commit. Use `bun test`. |
| Re-running setup throws `Secret already exists` | **By design** — `writeSecret` is write-once. Delete the file first. |
| Setup asks for a peer URL even with peers visible | You answered Enter/`m`, which means "enrol nobody" / "manual". |
| `aibr setup` shows no roster | Tailscale not Running, or zero peers. Falls back to manual. |
| Discovery feels slow on a big tailnet | Sequential by design, 2000 ms/peer. |

---

## Reporting

For each test record: **PASS / FAIL / BLOCKED**, plus:

- OS + `aibr --version`
- `tailscale status | head -1`
- Full command and **complete output** (not a paraphrase)
- If FAIL: what you expected, and what the code did instead

Security-relevant failures (T3, T7.4, T4's "not there" check) should be reported
immediately rather than batched.

---

## Sign-off

Part B is **not released**. B4 (the `2.2.0` version bump and release) awaits an
explicit decision after this testing pass.

**Outstanding risk, stated plainly:** the enrolment flow has never run against a
live two-node tailnet in CI. T6 and T7 are the tests that close that gap, and
they are the ones most worth doing carefully.
