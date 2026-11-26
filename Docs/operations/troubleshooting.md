# Operational Troubleshooting Guide

> **Status:** Current  
> **Applies to:** AIBridge 3.2.0  
> **Owner:** Maintainers  

This guide provides an executable triage ladder, root-cause resolutions for HTTP error codes, and practical remediation steps for common operational issues.

---

## 1. The Triage Ladder

When diagnosing an issue with an AIBridge node, execute these commands in sequence. Stop at the first failure.

```bash
# 1. Validate environment dependencies, config schemas, and file permissions
aibr verify --profile <profile>

# 2. Check tmux process session and local /health probe
aibr status --profile <profile>

# 3. Generate a redacted diagnostic bundle
aibr bundle --profile <profile> --preview
```

---

## 2. Common Fictional Commands Warning

> [!CAUTION]
> Historical design proposals described commands that were **never implemented**. Using these commands returns `Error: unknown command`.

| Non-Existent Command | Actual Operational Alternative |
|---|---|
| `aibr db check\|repair\|backup` | Use standard `sqlite3` CLI or inspect WAL database directly. |
| `aibr sessions list\|reassign` | Inspect job JSON files in `~/.local/state/aibridge/<profile>/jobs/`. |
| `aibr lease status\|renew` | Managed automatically by the worker; inspect `ingress_outbox.db`. |
| `aibr preflight` | Use `aibr-router --preflight` (native Rust binary). |
| `aibr config get` | Inspect `~/.config/aibridge/<profile>/config.json`. |
| `aibr worker --drain-only` | Run `aibr worker --profile <profile>`. |
| `aibr tail` | `aibr logs --profile <profile> -f` (the bridge log, `<state dir>/logs/aibridge.log`). `aibr logs` and `aibr doctor` exist since 3.1.0. |

---

## 3. HTTP Status Codes & Root Causes

### `HTTP 400 Bad Request`
- **Cause:** Payload failed JSON Schema / Zod validation, or payload exceeded the 1 MiB body cap.
- **Resolution:** Verify that the request body matches the `triggerRequestSchema` structure and contains all required fields (`job_id`, `source_agent_id`, `target_agent_id`, `capability`, `project_dir`, `prompt`).

### `HTTP 401 Unauthorized`
- **Cause:** Bearer token is missing, malformed, or differs from the token stored on the peer.
- **Resolution:**
  1. Verify the shared secret in `~/.local/share/aibridge/<profile>/secrets/bearer_token` on both machines.
  2. Send a test curl verification request to confirm token matching:
     ```bash
     read -rs TOKEN
     curl -i -X POST http://<peer-ip>:8787/trigger \
       -H "Authorization: Bearer $TOKEN" \
       -H 'Content-Type: application/json' -d '{}'
     ```
     An `HTTP 400` response confirms that authentication succeeded.

### `HTTP 403 Forbidden`
- **Causes:**
  1. **Source Agent Not Allowed:** Caller's `source_agent_id` is missing from the target node's `security.allowed_sources` list.
  2. **Capability Denied:** The requested capability is not in the caller's allowed `capabilities` list.
  3. **Path Traversal / Containment Violation:** The requested `project_dir` does not resolve to an allowlisted path in `projects[].path`.
  4. **Unapproved Plan:** The capability requires plan approval, but valid approved Plan Annotator metadata was omitted.
- **Resolution:** Update `~/.config/aibridge/<profile>/config.json` to allow the source agent, capability, or project path.

### `HTTP 404 Not Found`
- **Cause:** The requested route does not exist, or the specified `job_id` was not found in the job store.
- **Resolution:** Verify URL path spelling (`/trigger`, `/report`, `/jobs/:id`).

### `HTTP 409 Conflict`
- **Cause:** Idempotency conflict. A command with the same `job_id` or `dispatch_id` was submitted with differing payload parameters. Since 3.2.0 also a `job_id` that differs from an existing job's only in letter case (the two would be one file on a case-insensitive filesystem).
- **Resolution:** Ensure retry requests maintain exact payload identity, or assign a unique `job_id` for new work.

### `HTTP 503 Service Unavailable`
- **Cause:** The native router could not commit admissions to disk (`ingress_outbox.db`), or the local OpenCode daemon is unreachable.
- **Resolution:** Verify filesystem permissions and disk space in `~/.local/state/aibridge/<profile>/`, and ensure OpenCode is running on `127.0.0.1:4096`.

---

## 4. Specific Operational Scenarios

### Status reports "healthy", but all requests return HTTP 401
- **Root Cause:** The `/health` endpoint is intentionally unauthenticated to support discovery. A healthy status only confirms that the network listener is up; it does not validate token configuration.
- **Fix:** Update the secret bearer token file on the sending and receiving nodes so that they match exactly.

### Ingress router fails with exit code 78 (`EX_CONFIG`)
- **Root Cause:** Layer-1 network bind preflight detected that the configured `bridge.host` is not a provisioned Tailscale address on this host.
- **Fix:** Run `tailscale ip -4` and update `bridge.host` in `config.json` with the assigned Tailscale coordinate (`100.64.0.0/10`).

### `aibr serve` / `aibr worker` exits: "Another AIBridge process (PID n) is already running on this profile"
- **Root Cause:** Only one bridge or worker may run per profile. Each holds `~/.local/state/aibridge/<profile>/aibridge.lock` (its PID and that PID's start time) for its whole life, because on startup it ends every job the store says is in flight as `interrupted: bridge restarted`. A second process, typically `aibr start --foreground` while the launchd/systemd service is running, would interrupt the live bridge's jobs, so it refuses to start and touches no job.
- **How the lock is checked:** the lock is stale, and replaced automatically, only when its PID is dead, or when the PID's start time was read both when the lock was taken and now and the two differ (a PID reused after a crash or a reboot). The start time is read without depending on time zone or locale (Linux: boot id and `/proc/<pid>/stat`; macOS: `ps` under `TZ=UTC`). If the PID is alive but its start time cannot be verified (unreadable now, or missing from a lock written by an older version), the lock counts as **held**: two bridges on one profile would interrupt each other's jobs, so AIBridge errs on the side of a manual recovery.
- **Fix:** Stop the other process (`aibr stop -p <profile>` stops both the service and the tmux session), then start again. If the PID named in the message is alive but is not AIBridge, remove the lock by hand:
```bash
aibr stop -p <profile>                                   # stops the service and the tmux session
cat ~/.local/state/aibridge/<profile>/aibridge.lock      # {"pid":…,"start":…,"token":…}
ps -o pid=,lstart=,command= -p <pid>                     # is it really an AIBridge process?
rm ~/.local/state/aibridge/<profile>/aibridge.lock       # only if it is not
```

### Jobs fail with `interrupted: bridge restarted` or `not relaunched after restart: … (never started)`
- **Root Cause:** The bridge restarted. A job that may have started (it was `running`, or its launch had begun) ends as `interrupted: bridge restarted` and is never retried automatically: it may already have changed files or run commands. An approved job that had not started is relaunched once; if it may no longer run (approval now required, source or project no longer allowlisted, no free slot, OpenCode unavailable) it ends as `not relaunched after restart: <reason> (never started)`. Both are reported to the requester.
- **Fix:** Nothing on the worker. The orchestrator decides whether to dispatch the job again.
- `interrupted: bridge stopped` is the same for a bridge that was stopped normally (SIGTERM, SIGINT, SIGHUP; Ctrl-C in `aibr start --foreground`, or `aibr stop` ending its tmux session): it stopped its running jobs (their whole process groups) and reported them before exiting.

### A Claude Code or script process of an interrupted job "could not be verified"
- **Root Cause:** The bridge died without cleaning up (SIGKILL, crash). Each runtime process it spawned is recorded in `~/.local/state/aibridge/<profile>/runtime-processes/` (job id, PID, the PID's start time, process group). At the next start the bridge stops a recorded process only when its PID is alive **and** its start time, read now the same way as for the state lock, equals the recorded one: then SIGTERM to its process group, SIGKILL after 5 s. If the PID is alive but the start time cannot be read, was not recorded (outside Linux it is added a moment after the spawn, so a bridge killed in that moment leaves none), or was read another way (`linux:` vs `ps:`), it cannot tell that process from an unrelated one that got the same PID, so it does **not** signal it and logs:
  ```text
  claude process <pid> of job <job_id> left by the previous bridge could not be verified (…); NOT stopped.
  ```
  The record is then removed; the job itself is reported `interrupted: bridge restarted` as usual.
  If instead the log says `not acting on the runtime process records: their directory cannot be trusted`, the `runtime-processes` directory is a symlink, not a directory, or owned by another user: nothing in it was signalled or removed. Check who created it, stop the processes it names by hand as below, then remove the directory.
- **Fix:** Check the process by hand and stop it only if it is the job's:
  ```bash
  aibr logs -p <profile> | grep 'could not be verified'      # job id and PID
  ps -o pid,pgid,lstart,command -p <pid>                    # is it claude, or the job's script, in the job's directory?
  ps -A -o pid,pgid,command | awk '$2 == <pgid>'            # what else is in its group (tools it started)
  kill -TERM -<pgid>                                        # the whole group; kill -KILL -<pgid> if it ignores SIGTERM
  ```
  Tools or shells that outlived their Claude Code process (it exited before the restart) are never stopped automatically; find them by the job's worktree (`~/.local/state/aibridge/<profile>/worktrees/`) or project directory (`lsof +D <dir>`).

### Port conflict on 8787 or 4096
- **Root Cause:** A lingering background process or previous tmux session is holding the socket.
- **Fix:** Identify the conflicting process:
  ```bash
  lsof -i :8787
  lsof -i :4096
  ```
  Terminate stale processes before restarting the bridge.
