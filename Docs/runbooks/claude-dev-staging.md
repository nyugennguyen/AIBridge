# Runbook: Claude Code dev → staging

> **Status:** Current
> **Applies to:** AIBridge 3.2.0
> **Owner:** Maintainers

This runbook is for the operator of a two-node setup: a **dev** machine where Claude Code acts as the orchestrator through the AIBridge plugin, and a **staging** worker (a VPS or cloud VM) that runs Claude Code jobs under capability profiles. It is Phase 7 of the [Claude adapter & plugin plan](../implementation-plans/claude-adapter-and-plugin.md).

Every `aibr` command below was checked against `aibr <command> --help` on this tree. Background: [Pairing nodes](../guides/pairing.md), [Claude Code as orchestrator](../guides/claude-code-orchestrator.md), [ADR 0012](../adr/0012-request-signing-and-pairing.md) (signing), [ADR 0013](../adr/0013-operator-approval-ledger.md) (approval ledger).

Profile names used here: `staging` on the worker, `dev` on the orchestrator. Paths use the default XDG locations for a profile `<p>`:

| Placeholder | Default path | Holds |
|---|---|---|
| `<config>` | `~/.config/aibridge/<p>/` | `config.json` |
| `<data>` | `~/.local/share/aibridge/<p>/` | `secrets/` (bearer, operator and peer tokens, all 0600) |
| `<state>` | `~/.local/state/aibridge/<p>/` | `jobs/`, `approvals.jsonl`, `identity/`, `worktrees/` |

`XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME` move them. The safety floor only protects the default locations (see [Capability profiles](#capability-profiles)), so keep the defaults on a worker.

## Contents

1. [Network policy](#network-policy)
2. [Install a worker](#install-a-worker)
3. [Install an orchestrator](#install-an-orchestrator)
4. [Pair nodes](#pair-nodes)
5. [Require signed requests](#require-signed-requests)
6. [Create the operator token](#create-the-operator-token)
7. [Approve and reject jobs](#approve-and-reject-jobs)
8. [Kill switch](#kill-switch)
9. [Audit: approval ledger and job records](#audit-approval-ledger-and-job-records)
10. [Rotate keys and tokens](#rotate-keys-and-tokens)
11. [Capability profiles](#capability-profiles)
12. [Troubleshooting](#troubleshooting)

## Network policy

The bridge listens on the node's Tailscale address, port 8787. Use Tailscale ACLs so that:

- `tag:aibr-dev` reaches `tag:aibr-staging:8787` (dispatch, job polling, pairing);
- `tag:aibr-staging` reaches `tag:aibr-dev:8787` (report callbacks; only needed when the dev node runs its own bridge);
- staging has **no** rule to `tag:prod` (Tailscale denies by default, so the absence of a rule is the control);
- Tailscale SSH is off for `tag:aibr-staging`.

The full example, with `tagOwners` and policy `tests` that fail the policy save if someone later opens staging → prod: [`tailscale-policy.example.hujson`](tailscale-policy.example.hujson). The core rules:

```jsonc
{"action": "accept", "src": ["tag:aibr-dev"],     "dst": ["tag:aibr-staging:8787"]},
{"action": "accept", "src": ["tag:aibr-staging"], "dst": ["tag:aibr-dev:8787"]}
// no rule from tag:aibr-staging to tag:prod; no "ssh" rule for tag:aibr-staging
```

Tag each node and turn off the Tailscale SSH server on the worker:

```bash
# on the worker
sudo tailscale up --advertise-tags=tag:aibr-staging
sudo tailscale set --ssh=false

# on the dev machine
sudo tailscale up --advertise-tags=tag:aibr-dev
```

`tailscale up` with new flags may ask you to repeat flags you set earlier; follow its prompt.

**Operator access to the worker.** Approval and the kill switch run on the worker itself, so operators need a shell there. The example policy allows `group:aibr-operators` → `tag:aibr-staging:22` (the worker's own OpenSSH with key authentication, not Tailscale SSH) from the operators' personal devices. It deliberately does **not** allow `tag:aibr-dev` → staging port 22: Claude Code runs on the dev machine, and a path from it to a shell on staging would bypass every capability profile.

## Install a worker

On the staging VM, as an administrator:

```bash
sudo useradd --create-home --shell /bin/bash aibr  # dedicated OS user for jobs
```

The worker's OS user is the real security boundary: jobs run repository code from dev (tests, scripts), so the `aibr` user must not be able to read production secrets, other users' files, or cloud credentials. Install Claude Code for that user and sign it in (run `claude` once as that user) before continuing.

Then, as the `aibr` user (`sudo -u aibr -i`):

```bash
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash -s -- --role worker --runtime claude --profile staging
```

Quickstart (at most four questions; `aibr init --help` lists the flags):

```bash
aibr init --profile staging --role worker --runtime claude --project /srv/app --new
aibr doctor --profile staging
```

`--new` creates the network: `aibr init` prints a one-time pairing code (`aibr1-…`), granting by default the capabilities that need no operator approval. Hand the code to the orchestrator ([Install an orchestrator](#install-an-orchestrator)). The bearer token is generated and never shown. A worker's bridge is started as a user service (`aibr start`) unless you pass `--no-start`.

Use the full wizard instead when you need to change an existing profile or answer every question (`--advanced` adds the ports):

```bash
aibr setup --profile staging
aibr verify --profile staging
aibr start --profile staging
aibr status --profile staging
```

Either way a new Claude worker profile gets:

- the capability profiles `investigate` (read-only) and `run-tests` (may run the test command, may not edit);
- `security.request_signing: "required"`.

`aibr start` installs a per-profile user service (a systemd user unit `aibridge-staging.service` on Linux, a launchd agent `com.aibridge.staging` on macOS), which runs `aibr serve`, restarts it on failure and at login, and waits until `/health` answers. Re-running it restarts the bridge with the current config. **On a Linux server, enable lingering** so the service survives logout (`aibr doctor` flags it when it is off). Run this as root or another admin, naming the user the bridge runs as (`aibr` in this runbook), because that user usually has no sudo:

```bash
sudo loginctl enable-linger "aibr"
```

`aibr verify` checks `claude` and `tailscale` for a Claude worker (`tmux` is optional: a missing one is a warning, and only `aibr start --foreground` uses it), the config schema, the project directories and the bearer-token secret. `aibr doctor` runs the `verify` checks plus `aibr status` and a signed ping of every peer in `agents[]`, and prints the fix for each failure. `aibr status` printing `healthy` only proves `/health` answers, which is unauthenticated: it says nothing about whether peers can authenticate. `aibr doctor` or `aibr ping <peer>` does.

Logs: `aibr logs --profile staging` prints the last 100 lines of `<state>/logs/aibridge.log` (`-f` follows, `-n <count>` sets the length). The service's stdout and stderr go there too, so a crash at startup is in this file.

Add approval-gated or write-capable profiles (for example `fix-on-branch`, see [Capability profiles](#capability-profiles)) by editing `<config>/config.json`, then restart the bridge (re-running `aibr start` restarts the service with the current config):

```bash
aibr start --profile staging
```

## Install an orchestrator

On the dev machine, with Claude Code installed:

```bash
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash -s -- --role orchestrator --profile dev
```

On the worker, issue a pairing code ([Pair nodes](#pair-nodes)) with the capabilities this orchestrator may request, or reuse the one `aibr init` printed. Then on the dev machine:

```bash
aibr init --profile dev --role orchestrator --join aibr1-...
```

An orchestrator needs no bridge of its own and gets no token prompt: pairing delivers the worker's bearer token. (`aibr setup --profile dev` with the `orchestrator` role also works; paste the code when Step 4 asks for it.) Then install the plugin and check the whole path:

```bash
aibr plugin install claude
aibr plugin status claude
aibr doctor --profile dev
aibr ping staging --profile dev
```

`aibr verify` for an orchestrator checks `claude` and `tailscale` only (it does not look for `tmux`). `aibr ping <peer>` takes an `agents[]` id, signs a no-op job to the worker and waits for the result, which proves the path a real job takes.

`aibr plugin install claude` defaults to `--scope user`. Exit code `2` means `claude` is not on `PATH`; `3` means Claude Code is too old for `claude plugin` and the manual steps are printed instead. Start a new Claude Code session: its first lines are a peer and job summary from the plugin's SessionStart hook. Usage: [Claude Code as orchestrator](../guides/claude-code-orchestrator.md).

## Pair nodes

Pairing exchanges ed25519 public keys once and pins them on both sides, so no token is copied by hand. The worker's bridge must be running.

On the **worker**, grant the capabilities the orchestrator may request:

```bash
aibr enroll issue --profile staging --capabilities investigate,run-tests,fix-on-branch --ttl 10m
```

It prints a one-time code (`aibr1-…`), valid for `--ttl` (default 10 minutes, at most 24 hours). On the **orchestrator**, redeem it, either in `aibr setup` (Step 4) or directly:

```bash
aibr enroll join aibr1-... --profile dev
```

Afterwards the worker has the orchestrator in `security.allowed_sources[]` with exactly the granted capabilities (no restart needed), the orchestrator has the worker in `agents[]` with its bearer token in `<data>/secrets/peers/<worker>.bearer_token` (0600, never printed), and both pinned each other's key in `<state>/identity/peers.json`. A code pairs one node; a used or expired code is refused.

Inspect and remove pairings:

```bash
aibr enroll list --profile staging
aibr enroll revoke dev-main --profile staging
```

`revoke` takes the peer's `agent_id`. It unpins the key, so the peer's signed requests are refused immediately, and removes its `allowed_sources[]` / `agents[]` entries from the file. Restart the bridge (`aibr start --profile staging`) so the running process drops those entries too:

```bash
aibr start --profile staging
```

A revoked peer can only come back through a fresh code (`aibr enroll issue`, then `aibr enroll join`).

## Require signed requests

`security.request_signing` in `<config>/config.json` on the worker:

| Value | `/trigger` and `/report` | `GET /jobs/:id` (since 3.2.0) |
|---|---|---|
| `off` (or absent) | Signatures ignored; bearer token only. Profiles created before Phase 3. | Bearer (or operator credential) required; any bearer holder reads any job. Anonymous reads are refused (401). |
| `optional` | Signed requests are verified; unsigned ones still pass on the bearer. | Unsigned bearer reads any job; a signed request reads only the signer's own jobs (`403 not_job_requester`). |
| `required` | Unsigned → `401 signature_required`; unpinned or revoked key → 403; replay → 401; `source_agent_id` must match the signing key (`403 identity.source_mismatch`). New profiles from `aibr setup`. | Signed requests only, and only the signer's own jobs. |

The operator credential (rules of `aibr approve`, from this host by default) reads every job on every mode. `GET /jobs`, `GET /jobs/:id/events` and `POST /jobs/:id/cancel` always need a signature or the operator credential.

To move an older profile to `required`:

1. Pair every orchestrator that dispatches to this worker (`aibr enroll list --profile staging` shows who is pinned).
2. Optionally set `"request_signing": "optional"` first and restart, to see unsigned callers keep working while you pair.
3. Set `"request_signing": "required"` inside `"security"` and restart the bridge.

`aibr enroll issue` prints a reminder while the profile is not yet `required`. Signing cannot be combined with `bridge.ingress_mode: "router"`; the config is rejected at load. The bearer token is still checked as well while `auth_mode` is `bearer-token`.

## Create the operator token

Approvals, rejections and the kill switch need the **operator token**. The peer bearer token is refused for these endpoints (403), so a peer can never approve its own work. By default the endpoints also accept only requests from the worker itself (`security.approval_from_loopback_only`, default `true`).

Create it on the worker, as the user that runs the bridge:

```bash
umask 077
mkdir -p ~/.local/share/aibridge/staging/secrets
openssl rand -hex 32 | tr -d '\n' > ~/.local/share/aibridge/staging/secrets/operator_token
chmod 600 ~/.local/share/aibridge/staging/secrets/operator_token
```

The bridge reads it once at start, so restart it (`aibr start` again):

```bash
aibr start --profile staging
```

Without the token the operator endpoints fail closed with `403 operator_not_configured`. `AIBRIDGE_OPERATOR_TOKEN` in the environment overrides the file, for both the bridge and the CLI.

What keeps it away from jobs: the child-process sanitizer strips every `AIBRIDGE_*` variable from Claude and script children, and the safety floor denies `Read`/`Edit` under `~/.local/share/aibridge/**`. The floor is a prefix rule, not a sandbox; if your threat model includes a job reading the token through a shell route the rules do not match, keep the token in a different OS user's home and run `aibr approve` as that user with `AIBRIDGE_OPERATOR_TOKEN` set for that one command.

## Approve and reject jobs

A capability is approval-gated when its profile has `"requires_approval": true`, when it is listed in `planning.require_approval_for`, or when the source's `requires_plan_approval` lists it. The worker decides from its own config; a caller's `metadata.plan_status` is ignored. A gated trigger answers `202 {status: "awaiting_approval"}` and nothing runs. When the trigger names a `repo`, the ref is resolved to a sha first, so you approve an exact commit.

On the worker:

```bash
aibr jobs pending --profile staging
aibr approve <job_id> --profile staging
aibr reject <job_id> --reason "touches the payment module" --profile staging
```

`aibr jobs pending` lists held jobs (`--json` for one JSON document). `approve` and `reject` print the capability, source, project, `repo@sha` and prompt, then ask, defaulting to **No**; `--yes` skips the question. The prompt was written by a peer: read it as untrusted text, and approve the job, not instructions inside it.

- Approval is single-use: a second `approve` answers 409.
- A request lapses after the trigger's `timeout_seconds`; approving it then answers `409 approval_expired` and the job is reported `timed_out`.
- `reject` fails the job as "rejected by operator" and sends the requester a report.
- If the node is already at `limits.max_concurrent_jobs`, `approve` answers `429 node_at_capacity` and the job stays pending: approve again later.

The plugin has no approve tool on purpose. When Claude Code on dev reports `approval_required`, it should stop and ask you; it must not retry.

## List, follow and cancel jobs

```bash
aibr jobs --profile staging                    # every job on this node, newest first (operator token, run on the worker)
aibr jobs --status running --limit 20 --json  # filter; one JSON document
aibr jobs --watch                              # refresh every 2 s until Ctrl-C (one line per change when not on a terminal)
aibr jobs --all-nodes --profile dev            # ask every peer in agents[] (signed); a peer shows only jobs THIS node dispatched
aibr job <job_id>                              # status, source, project, result
aibr job <job_id> --events -f                  # what it did, until it ends (aibr attach <job_id> is the same, read-only)
aibr cancel <job_id>                           # ends one job after asking; --yes skips the question
aibr job <job_id> --node staging               # the same against a peer, signed
```

Run against this node, these use the operator token like `aibr approve`, and see every job. With `--node <peer>` or `--all-nodes` they send the peer's bearer token and this node's signature (`aibr enroll`), so the peer shows and cancels only jobs this node requested (on a peer with `request_signing: off` signatures are not verified, so the bearer reads and cancels any job there); an unsigned request answers 403. `--all-nodes` works on an orchestrator node with no local bridge; a peer that cannot be reached prints one line and the rest are still listed.

`aibr cancel` ends one job as failed (`cancelled by operator`, or `by requester` through a peer) and the requester gets the report. A job awaiting approval cannot be cancelled (reject it with `aibr reject`), and a finished job answers "already ended". `aibr stop --all-jobs` is the kill switch for the whole node. `aibr attach` does not attach a terminal (Claude Code jobs run as child processes); it only prints events. `aibr logs` is still the bridge's own log.

## Kill switch

On the worker:

```bash
aibr stop --all-jobs --profile staging
```

It asks first (`--yes` to skip), then terminates every **running** Claude and script job on the node. Each is failed with "stopped by operator", its requester gets a report, and a `jobs.stopped` entry listing the job ids goes into the approval ledger. It needs the operator token and must run on the worker.

It does not touch jobs still awaiting approval (reject those) and does not stop the bridge, so new triggers are still accepted. To stop intake as well, stop the service. This is a different command, it needs no operator token, and it writes no ledger entry:

```bash
aibr stop --profile staging
```

Without `--all-jobs`, `aibr stop` unloads and removes the profile's user service (and kills the tmux session `aibridge-staging` if you started with `--foreground`); jobs the bridge was running die with it. To cut off one orchestrator instead, revoke it (`aibr enroll revoke <agent_id>`) and restart the bridge.

## Audit: approval ledger and job records

### Approval ledger

`<state>/approvals.jsonl` (0600) records every approval request, grant, rejection, expiry and kill-switch use, appended **before** the decision takes effect. One JSON object per line:

| Field | Meaning |
|---|---|
| `seq` | 1, 2, 3, … with no gaps |
| `prev` | sha256 (hex) of the previous line's exact text; `"0"` on the first line |
| `type` | `approval.requested`, `approval.granted`, `approval.rejected`, `approval.expired`, `jobs.stopped` |
| `jobId` / `jobIds` | the job; `jobIds` only on `jobs.stopped` |
| `capability`, `sourceAgentId`, `sha` | what was asked, by whom, at which commit |
| `reason` | the operator's reason, if any |
| `actor` | `trigger` for a request a peer caused, `operator` for decisions |
| `at` | ISO timestamp |

It never contains a token. Read it with `jq`:

```bash
jq -c '{seq, type, jobId, capability, sourceAgentId, sha, reason, at}' ~/.local/state/aibridge/staging/approvals.jsonl
jq -c 'select(.type == "approval.granted")' ~/.local/state/aibridge/staging/approvals.jsonl
```

Check the hash chain (a deleted or edited line breaks it):

```bash
prev=0; n=0
while IFS= read -r line; do
  n=$((n + 1))
  [ "$(printf '%s' "$line" | jq -r .seq)" = "$n" ] || { echo "seq gap at line $n"; break; }
  [ "$(printf '%s' "$line" | jq -r .prev)" = "$prev" ] || { echo "chain broken at line $n"; break; }
  prev=$(printf '%s' "$line" | sha256sum | cut -d' ' -f1)
done < ~/.local/state/aibridge/staging/approvals.jsonl
echo "checked $n lines"
```

On macOS use `shasum -a 256` instead of `sha256sum`. The ledger is local to the worker: it is not replicated, so back it up with the node.

### Job records

Each job is one file, `<state>/jobs/<job_id>.json`, and is the authoritative record. Since 3.2.0 a new `job_id` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` (anything else is a 400 on `/trigger` and `/report`), and an id that differs from an existing one only in letter case is refused with 409. Jobs stored by older releases keep their ids and stay readable:

```bash
ls -t ~/.local/state/aibridge/staging/jobs/ | head
jq '{id, status, error, runtime, checkout, approval,
     summary: .runtimeResult.summary,
     findings: (.runtimeResult.findings | length),
     usage: .runtimeResult.usage,
     scripts: [.runtimeResult.scriptResults[]? | {phase, script, exit_code, timed_out}]}' \
  ~/.local/state/aibridge/staging/jobs/<job_id>.json
```

- `status`: `awaiting_approval`, `running`, `completed`, `failed`, `timed_out`, `callback_failed`, …
- `checkout`: `repo`, the requested `ref`, and the `sha` the job ran at.
- `approval`: `pending` / `approved` / `rejected`, with `decidedAt` and `reason`.
- `runtimeResult.usage`: `totalCostUsd`, `numTurns`, `durationMs`, `resultSubtype`, and `permissionDenials`. A non-zero `permissionDenials` with a failed or empty result usually means the profile is too narrow (see below).
- `callbackDelivery`: whether the report reached the requester.

The bridge log is `<state>/logs/aibridge.log` (startup, listen address, one line per request with method, path, status and duration; never headers or bodies). Read it with:

```bash
aibr logs --profile staging -n 200
aibr logs --profile staging -f
```

Job output itself is in the job record, not the log.

## Rotate keys and tokens

**Bearer token (worker).** Re-run `aibr setup --profile staging` and answer `g` (generate) at the token prompt; Enter keeps the current token. Restart the bridge. Every orchestrator still holds the old token in `secrets/peers/<worker>.bearer_token` and now gets 401, so re-pair each one: `aibr enroll issue` on the worker, `aibr enroll join <code>` on the orchestrator. Pairing replaces the stored token and the pins in one step.

**Operator token.** Write a new value to `<data>/secrets/operator_token` as in [Create the operator token](#create-the-operator-token) and restart the bridge. Nothing else holds it.

**Node keys.** There is no rotate command. A node's private key is `<state>/identity/self.node-key.json` (0600); it is created when missing and never overwritten in place. To rotate one:

1. Move the old key aside on that node (do not delete it until the new pairing works):

   ```bash
   mv ~/.local/state/aibridge/staging/identity/self.node-key.json ~/self.node-key.json.retired
   ```

2. Restart that node's bridge if it runs one (`aibr start`), so it signs with the new key.
3. Pair again: `aibr enroll issue` on the worker (creates the new worker key when the worker is the one rotating), then `aibr enroll join` on every orchestrator. Re-pairing replaces the pin for that `agent_id` and clears any earlier revocation; requests signed with the old key are refused from then on.
4. Confirm with `aibr enroll list` on both sides (fingerprints changed), then shred the retired key.

Rotate the worker key on every orchestrator it pairs with; an orchestrator still pinning the old key refuses the worker's signed `/report` callbacks.

## Capability profiles

A profile in `capability_profiles` is the whole permission set of a job. A capability that is not a key there is refused with 403. Fields: `allow`, `deny`, `max_budget_usd`, `max_turns`, `timeout_s`, `requires_approval`, `script`, `pre`, `post`, `model`, `append_system_prompt`. Example of an approval-gated write profile:

```jsonc
"fix-on-branch": {
  "allow": ["Read", "Grep", "Glob", "Edit", "Write", "Bash(npm test)", "Bash(npm test *)",
            "Bash(git add *)", "Bash(git commit *)", "Bash(git push origin aibr/*)"],
  "deny":  ["Bash(git push origin main*)", "Bash(git push --force*)"],
  "requires_approval": true,
  "max_budget_usd": 3,
  "timeout_s": 1800,
  "append_system_prompt": "Run each shell command on its own, never chained with ;, &&, || or pipes."
}
```

Every launch is `claude -p` with `--permission-mode dontAsk`, the profile's rules as `--allowedTools` / `--disallowedTools`, `--setting-sources user` and `--strict-mcp-config` (from the node's `claude` block), so a repository's own `.claude/settings.json`, hooks and `.mcp.json` cannot widen what a job may do. Design rules:

- **The safety floor always applies.** `CLAUDE_SAFETY_FLOOR_DENY` in [`src/runtime/claude-job-runner.ts`](../../src/runtime/claude-job-runner.ts) is unioned into every profile's `deny`, and Claude Code evaluates deny before allow, so no `allow` entry (not even a bare `Bash` or `Read`) re-opens it. It denies reading `.env*` files, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc` and Claude Code's credentials file; reading or editing AIBridge's config, data and state directories (default XDG paths only); editing `~/.claude/**`; and `curl`, `wget`, `ssh`, `scp` and `sudo` in the shell. It is defence in depth, not a sandbox: the OS user is the boundary.
- **A chained shell command is denied as a whole.** Claude Code checks every sub-command of a line, so `npm test; echo $?` or `npm test && cat out.log` is refused when only `npm test` is allowed. Do not "fix" that by allowing `cat` or `echo`: a shell that can `cat` reads files the `Read(...)` denies protect. Tell the job how to work instead (`append_system_prompt`, as the default `run-tests` profile does) and let it use the `Read`/`Grep`/`Glob` tools.
- **`dontAsk` fails silently on a narrow profile.** Anything outside `allow` is refused without a prompt. Watch `usage.permissionDenials` in the job record and widen the profile deliberately, one rule at a time.
- **`max_budget_usd` is a soft cap.** It becomes `--max-budget-usd`, a client-side cost estimate (subagents included) that Claude Code checks after each turn. A run stops at the first turn boundary past the cap, so it can overshoot by up to one turn's cost; check `totalCostUsd`. `timeout_s` is the hard stop.
- **Tests run untrusted code.** `run-tests` executes the repository's test command, which came from dev. Grant it only on a worker whose OS user has nothing worth stealing.
- **Prefer `script` for deterministic steps.** A profile with `script` (and `pre`/`post`) runs that file directly, without a shell and without the LLM; deploy-style steps belong there, behind `requires_approval`.
- **Grant per orchestrator.** `aibr enroll issue --capabilities` sets what a peer may request. A profile existing on the worker does not mean every peer may use it.

## Troubleshooting

Start with `aibr doctor --profile staging` (checks, status and a signed ping of every peer, each failure with its fix), then `aibr logs --profile staging`. From an orchestrator, `aibr ping <peer>` tests one worker end to end. The `debugging-aibr-v2` skill in this repository covers general bridge debugging.

### 401 `signature_required`

The worker has `request_signing: "required"` and the request carried no node signature. Causes:

- the orchestrator was never paired, or was set up before pairing existed (it has no `<state>/identity/self.node-key.json`);
- you are calling the bridge with `curl` and only a bearer token;
- the orchestrator's profile is not the one the plugin uses (plugin option `profile`, then `AIBR_PROFILE`, then the only profile on disk).

Fix: pair (`aibr enroll issue` on the worker, `aibr enroll join <code>` on the orchestrator). Related refusals: **403** with "not pinned on this node (or was revoked)" means the key is unknown or revoked, so pair again; **403 `identity.source_mismatch`** means the body's `source_agent_id` is not the signing node.

### 403 `unknown_capability_profile`

The requested capability is not a key of the worker's `capability_profiles`. Check spelling, or add the profile to `<config>/config.json` and restart the bridge. A different 403, from the source check, means the capability exists but this orchestrator was not granted it: issue a new code with the capability in `--capabilities` and join again.

### 429 `node_at_capacity`

The worker is already running `limits.max_concurrent_jobs` jobs (default 2). The trigger is refused, nothing is queued, and the caller should retry later. On `aibr approve`, the job stays pending; approve again later. Raise the limit in `config.json` (`"limits": {"max_concurrent_jobs": N}`) only if the VM has the memory and CPU for N concurrent Claude Code processes plus their test runs. A job that hangs keeps its slot until `timeout_s`; the kill switch frees all slots.

### `bridge_unavailable`

`aibr status` found the service (or, with `--foreground`, the tmux session `aibridge-staging`) but the bridge's `/health` did not answer (the probe status is printed). The other states are `healthy` (it also says whether the service or tmux runs the bridge) and `not_running`. Check, in order:

1. The log: `aibr logs --profile staging`. A config error or a crash on start is printed there. (With `--foreground`, the live output is also in the tmux window: `tmux capture-pane -p -t aibridge-staging:bridge -S -2000`.)
2. Tailscale is up and the address the bridge binds still belongs to this node: `tailscale status`, `tailscale ip -4`, compared with `bridge.host` in `config.json`.
3. Nothing else holds port 8787: `ss -ltnp | grep 8787`.
4. The config still validates: `aibr verify --profile staging`.
5. On Linux, the service dies at logout while lingering is off: `sudo loginctl enable-linger <user>` (`aibr doctor` reports it).

Then restart (this reloads the service with the current config):

```bash
aibr start --profile staging
```

`session_missing` appears only for a `--foreground` run: the tmux session is gone (after a reboot, for example) and `aibr start --foreground` brings it back. A service-managed bridge comes back by itself at login. From the orchestrator, `aibr discover --profile dev` shows whether the worker's `/health` is reachable over the tailnet, and `aibr ping staging --profile dev` whether it also authenticates and completes a job; if discover works, `aibr status` on the worker is `healthy` and the ping fails, check the Tailscale ACLs, then pairing and signing.
