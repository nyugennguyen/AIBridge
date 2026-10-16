# Operational Troubleshooting Guide

> **Status:** Current  
> **Applies to:** AIBridge 3.0.0  
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
| `aibr logs\|doctor\|tail` | Inspect tmux session output (`tmux attach`) or systemd journal (`journalctl --user`). |

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
- **Cause:** Idempotency conflict. A command with the same `job_id` or `dispatch_id` was submitted with differing payload parameters.
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

### Port conflict on 8787 or 4096
- **Root Cause:** A lingering background process or previous tmux session is holding the socket.
- **Fix:** Identify the conflicting process:
  ```bash
  lsof -i :8787
  lsof -i :4096
  ```
  Terminate stale processes before restarting the bridge.
