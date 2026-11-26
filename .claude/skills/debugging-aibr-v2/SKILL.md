---
name: debugging-aibr-v2
description: Use when debugging, diagnosing, or testing the aibr / AIBridge v2 app in this repo — job stuck or timed_out, 401/403/404/409/503 from /trigger or /report, "aibr status says healthy but requests fail", missing log files, tmux session or port 8787/4096 issues, Tailscale connectivity, router or worker not draining, or a failing/flaky vitest or cargo test. Also use when a doc, runbook, or AGENTS.md instruction about aibr does not match observed behaviour.
---

# Debugging aibr v2

> **Canonical copy:** `.opencode/skills/debugging-aibr-v2/`. Mirrored to
> `.claude/skills/` and `.agents/skills/` for Claude Code and Codex. If you edit one
> copy, copy the change to the other two — they are byte-identical by convention.

## Overview

**The documentation lies. The source is the only truth.**

`README.md`, `AGENTS.md`, and `Docs/archive/failure-modes-and-recovery.md` describe commands,
flags, and file paths that do not exist in v3.0.0. Every trap below was confirmed by reading
`src/`. Before you repeat an instruction found in a doc, grep for it.

```bash
cd /Users/mac/Projects/AIBrigde
bun src/cli.ts --help          # authoritative command + flag list
grep -n "COMMANDS = " src/cli.ts   # line 152 — the real command table
```

## Non-existent commands — never suggest these

`Docs/archive/failure-modes-and-recovery.md` documents all of these. **None are implemented.**
Each returns `Error: unknown command` / `unknown flag`.

| Documented but fake | Real substitute |
|---|---|
| `aibr db status\|check\|backup\|repair\|restore\|migrate\|quarantine\|export` | `sqlite3` on the store file; library fns in `src/storage/` |
| `aibr sessions list\|reassign` | none — read job JSON |
| `aibr lease status\|renew` | none |
| `aibr preflight` | `aibr-router --preflight` (Rust binary only) |
| `aibr config get` | read `~/.config/aibridge/<profile>/config.json` |
| `aibr worker --drain-only` | `aibr worker -p <profile>` (no flag) |
| `aibr logs\|doctor\|tail\|inspect` | none — see "Where output actually goes" |

## Triage ladder

Run in order. Stop at the first failure.

```bash
aibr doctor  -p <profile>    # verify + status + a signed ping of every agents[] peer, with fixes
aibr verify  -p <profile>    # deps, tailscale, config Zod, secret perms. Exit 0/1.
aibr status  -p <profile>    # user service (launchd/systemd) or tmux, + <bridge host>:<port>/health
aibr ping <peer> -p <profile> # signed no-op /trigger, waits for completion and the /report callback
aibr logs    -p <profile>    # <state>/logs/aibridge.log (-f to follow)
aibr bundle  -p <profile>    # JSON: integrity, config shape, redacted errors
```

`aibr status` states: `healthy` (with what runs it: `launchd`, `systemd`, `tmux`, `unmanaged`),
`not_running`, `bridge_unavailable`, `no_bridge` (orchestrator) — `decideStatus` in
`src/cli/service.ts`. `session_missing` is only the tmux-only answer of `src/host/tmux.ts`.

**`healthy` proves almost nothing.** The probe hits `/health`, which has **no auth hook** and
calls into opencode. It cannot detect a token mismatch, a bad allowlist, or a dead worker.
A green `status` plus a failing `/trigger` is the normal signature of a credential or
authorization problem — see below. **`aibr ping` is the check that proves it**: capability
`aibr.ping` (`src/jobs/ping.ts`) goes through the bearer, the node signature and the
`allowed_sources` lookup, completes without a runtime, and reports back; its output names the
stage that failed (`dispatch`, `job`, `callback`).

## Status code → cause

From `src/server/routes/`. Auth is per-route; there is no global hook.

| Code | Route | Meaning |
|---|---|---|
| 401 | `/trigger`, `/report` | Bearer mismatch. **Only** source. `BearerAuthProvider` is an exact byte compare. |
| 400 | `/trigger`, `/report` | Auth passed, Zod/dependency parse failed. |
| 403 | `/trigger` | Source not authorized, project not allowlisted, or plan approval missing. |
| 404 | `/trigger`, `/report` | `target_agent_id` ≠ this host's `agent_id`. |
| 409 | `/trigger` | Duplicate `job_id` already exists. |
| 503 | `/trigger` | opencode unhealthy, or (router) admission store unavailable. |

Probe auth without creating a job — `400` proves auth worked, `401` proves mismatch:

```bash
read -rs TOK; printf '\n'
curl -i -X POST http://<peer>.tailnet:8787/trigger \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{}'
unset TOK
```

### Token rotation

Secrets are **write-once** (`src/host/profile-store.ts:188-198`) — re-running setup over an
existing file fails with `Secret already exists`. To rotate, stop, delete, re-setup, restart.
Editing the file alone does nothing: the token is read once at `serve` boot.

Write tokens with `printf '%s'`, never `echo` — a trailing newline becomes part of the token.

## Where output actually goes

**One log file per profile:** `~/.local/state/aibridge/<profile>/logs/aibridge.log`
(`src/host/logs.ts`), printed by `aibr logs`. `aibr serve` writes startup, the listen address,
startup failures and one line per request (method, path, status, duration — no headers, no
bodies); the user service (`aibr start`) appends the process's stdout/stderr, so crashes land
there too. Fastify's own logger stays off and `StructuredLogger` is still test-only. The
runbook's `~/.aibridge/profiles/<profile>/logs/worker.log` is fiction.

Other sources of truth:

```bash
aibr logs -p <profile> -f                                     # the bridge log
tmux capture-pane -p -t aibridge-<profile>:bridge -S -2000   # --foreground only (remain-on-exit)
tmux capture-pane -p -t aibridge-<profile>:opencode          # --foreground, opencode serve
cat ~/.local/state/aibridge/<profile>/jobs/<job_id>.json     # authoritative job record
grep -n "<session_id>" ~/.local/share/opencode/log/opencode.log   # opencode's own log
```

`aibr bundle` is weak here: `health.overallOk` and `bindPreflight.ok` are hardcoded `true`,
`recentRedactedErrors` is always empty, `agentId` is always `unknown-agent`, and `routerVersion`
is always `null` (it shells out to `aibr-router --version`, which does not exist). Trust it for
SQLite integrity only.

## State on disk

XDG paths, **not** the repo-local `.aibridge/` (`src/host/paths.ts:75-115`):

```
config   ~/.config/aibridge/<profile>/config.json
secrets  ~/.local/share/aibridge/<profile>/secrets/{bearer_token,opencode_password}  (0600)
state    ~/.local/state/aibridge/<profile>/{jobs/*.json,tasks.md,egress_outbox.db,aibridge.lock}
```

`aibridge.lock` (`src/host/state-lock.ts`) is held by the one `aibr serve` / `aibr worker` of the
profile for its lifetime: JSON with `pid`, `start` (`ps -o lstart=`) and a token. It counts as held
only while that PID is alive **with the same start time**; a crashed holder or a PID reused after a
reboot is replaced automatically. A second process exits with "Another AIBridge process (PID n) is
already running on this profile" and touches no job. Manual recovery, only if PID n is not AIBridge:

```bash
aibr stop -p <profile>                                   # stops the service and the tmux session
cat ~/.local/state/aibridge/<profile>/aibridge.lock      # {"pid":…,"start":…,"token":…}
ps -o pid=,lstart=,command= -p <pid>                     # is it really an AIBridge process?
rm ~/.local/state/aibridge/<profile>/aibridge.lock       # only if it is not
```

Repo `.aibridge/` is only used by the legacy `bun run dev` entrypoint (`src/index.ts:11`).

To reset: `aibr stop -p <profile>` first (service and tmux), then `rm -rf ~/.local/state/aibridge/<profile>`.
Never delete terminal outbox rows to clear a backlog — they are forensic evidence and retention
is enforced in `src/storage/outbox-repair.ts`.

## `timed_out` and stuck jobs

`Timed out waiting for OpenCode session <id>` is thrown from `src/opencode/monitor.ts` and is
almost never a network problem. The event loop's `catch` **swallows the original error** and
silently falls back to polling, so a permission-reply failure surfaces as a timeout.

Check in this order:

1. **Did opencode actually run the turn?** `grep "<session_id>" ~/.local/share/opencode/log/opencode.log`.
   An `ERROR` line here (a failing opencode plugin, a bad model) means the turn died before any
   message was stored — aibr is innocent.
2. **Fake-success trap.** `getSessionStatus` returns `state?.type ?? "idle"` (`src/opencode/client.ts:57-58`).
   An unknown session reads as `idle`, so a job can be marked `completed` with zero messages.
   Always confirm with `curl -u opencode:$PW http://127.0.0.1:4096/session/<id>/message`.
3. **Permission deadlock.** Tools in `permissions.require_plan_approval_for_tools` (by default
   `bash`/`edit`/`write`) are answered `reject` unless an operator approved **this job** with
   `aibr approve` (`job.approval.status === "approved"`, `src/opencode/permissions.ts`). A job whose
   capability is not approval-gated can never use them, which looks identical to a broken session.
   Since 3.1.2 the caller's `metadata.plan_status` grants nothing, so setting it is not a workaround:
   gate the capability (`planning.require_approval_for`) and approve the job, or move the tool to
   `permissions.allow_tools`.
4. **Terminal vs failed.** `Timed out waiting for OpenCode session …` always lands on status
   **`failed`**. Status `timed_out` with message `Job timed out` comes from `sweepExpiredJobs`
   (`src/jobs/manager.ts`), which runs at startup and every 60 s; the deadline counts from
   `launchStartedAt`, else the approval, else creation. Jobs a live runner drives are skipped.
   If a report pairs them, the reporting peer is wrong.
5. **Restart.** `interrupted: bridge restarted` = the job was running (or its launch had begun,
   `launchStartedAt` set) when the bridge restarted; never retried. `not relaunched after restart:
   <reason> (never started)` = an approved job that never started and may not launch now. Rules:
   `src/jobs/reconcile.ts`.

## The Rust router

Tier 1 admission filter on `tailscale0:8787`. `aibr worker` is Tier 2 and the **sole
authorization authority**.

```bash
aibr-router --init-store   # provision (idempotent, never overwrites)
aibr-router --preflight    # load config, open store, check bind address. Binds nothing.
aibr-router                # serve
aibr-router --bogus-flag   # exit 78 (EX_CONFIG)
```

Two facts that cause most confusion:

- **Admission ≠ authorization.** The router is a *structural* filter by design
  (`router/src/lib.rs:12-45`). It will admit a structurally valid trigger from an unauthorized
  source. "The router accepted it" tells you nothing about legitimacy.
- **`deny_unknown_fields` on config.** Adding a key to `config.json` **stops the router from
  starting** until `bun run generate:contracts` regenerates the contracts. CI enforces this
  with `git diff --exit-code` over **both** generated outputs: `router/src/contracts.rs` and
  `contracts/` (the IPC crate and its contracts were removed in 3.1.1, ADR 0014).
- **Cargo runs from the repository root.** The workspace root moved out of `router/` so that
  `crates/*` could be siblings (Cargo refuses a member above its workspace root). Since 3.1.1
  the workspace only contains `router/` (and its `contract-gen`).

The router's `/health` **requires** bearer auth and does **not** call opencode. The engine's
`/health` does neither. Same path, opposite semantics.

## Testing

See `references/testing.md` for the full runner matrix. The two that matter:

```bash
bun test                              # Bun's runner — what CI runs
bunx vitest run <path> -t "<name>"    # targeted
```

Both must run **from the repo root** — `tests/unit/installer/install-script.test.ts` and
`tests/integration/package-smoke.test.ts` shell out with CWD-relative paths.

A `timeout` in a passing suite is usually **two vitest invocations running concurrently**
(a real false-positive in `Docs/implementation-reports/milestone-6-completion.md:540-552`).
Re-run serially before investigating. Default per-test timeout is 5s; there is no
`testTimeout` override and no `vi.useFakeTimers` anywhere — timing is faked via `TestClock`.

`bun test` and `bun run test` (vitest) **do not execute the same set**: the SQLite backend
matrix in `tests/unit/event-store/outbox-helpers.ts` skips the `bun` driver under vitest.
A green vitest run is not a green CI run.

## Rust tests

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`cargo test` passing on macOS proves nothing about Linux — a `cfg(target_os = "linux")` arm
shipped broken this way (`Docs/implementation-reports/milestone-7-progress.md:101`). Verify with
`bash scripts/build-matrix.sh x86_64-unknown-linux-musl`.

## Red flags

- Repeating a command found in `Docs/architecture/failure-modes-and-recovery.md` without grepping `src/cli.ts:152` first.
- Suggesting `aibr db *`, or a `logs/` path other than `<state>/logs/aibridge.log`.
- Treating `aibr status: healthy` as proof auth or authorization works.
- Concluding "opencode is unreachable" from a job timeout without grepping opencode's own log.
- Concluding the router rejected an unauthorized request — that is by design.

## Common mistakes

| Mistake | Correct |
|---|---|
| `aibr db check` | `sqlite3 <state>/egress_outbox.db "PRAGMA integrity_check;"` |
| `tail -f .../logs/worker.log` | `aibr logs -p <p> -f` |
| `ls .aibridge/jobs/` | `ls ~/.local/state/aibridge/<profile>/jobs/` |
| `echo "$TOK" > secrets/bearer_token` | `printf '%s' "$TOK" > ...` (write-once; delete first) |
| `bunx vitest run` from a subdir | run from repo root |
| Adding a config key and restarting the router | run `bun run generate:contracts` first |
