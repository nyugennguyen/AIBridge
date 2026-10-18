# Monitoring & Diagnostics Guide

> **Status:** Current  
> **Applies to:** AIBridge 3.0.0  
> **Owner:** Maintainers  

This guide covers operational monitoring, health probe endpoints, diagnostic support bundle generation, and queue telemetry.

---

## 1. Process Health & Probes

### 1.1 CLI Status Probe (`aibr status`)

Check the health of a running profile:

```bash
aibr status --profile <profile>
```

`aibr status` queries the local tmux session and sends a `GET /health` request to the local HTTP listener. It returns one of three states:

| Status Code | Description | Next Step |
|---|---|---|
| `healthy` | Tmux session exists and `/health` returned `200 OK`. | System is running normally. |
| `session_missing` | The `aibridge-<profile>` tmux session is not running. | Run `aibr start --profile <profile>`. |
| `bridge_unavailable` | The tmux session exists, but `/health` failed to respond. | Inspect tmux session logs (`tmux attach -t aibridge-<profile>`). |

### 1.2 The `/health` Endpoint

The `/health` endpoint on port `8787` is deliberately **unauthenticated** to allow peer discovery and health checks before secret exchange:

```json
{
  "ok": true,
  "opencode": true,
  "agent_id": "test-vps",
  "capabilities": ["code", "testing", "review"]
}
```

> [!WARNING]
> A `healthy` response indicates that the HTTP server and local OpenCode runtime are responding. It **does not** verify that bearer tokens match, that projects are allowlisted, or that remote callers are authorized.

---

## 2. Diagnostics Support Bundles (`aibr bundle`)

When diagnosing complex issues or preparing support information, generate a diagnostic bundle:

```bash
aibr bundle --profile <profile>
```

To preview the diagnostic summary without exporting JSON:

```bash
aibr bundle --profile <profile> --preview
```

### Automated Secret Redaction
Diagnostic bundles automatically pass through the secret redaction pipeline (`src/memory/sanitizer.ts`). The bundle scrubs:
- Bearer tokens and authorization headers.
- Passwords and secret file contents.
- Absolute private home directory paths.
- Agent prompt text and model transcripts.

---

## 3. Admission Queue & Store Telemetry

Under polyglot ingress mode, admissions commit to `ingress_outbox.db` in SQLite write-ahead log (WAL) mode.

### Inspecting Queue Depth
To safely inspect pending tasks without modifying store locks:

```bash
sqlite3 ~/.local/state/aibridge/<profile>/ingress_outbox.db "SELECT status, count(*) FROM ingress_outbox GROUP BY status;"
```

Typical statuses:
- `pending`: Admitted by router, waiting for worker lease acquisition.
- `processing`: Claimed under active worker lease (30-second lease window).
- `completed`: Successfully executed and terminal status recorded.
- `failed`: Terminal failure recorded with error code and forensic evidence.

> [!IMPORTANT]
> **Outbox Rows are Evidence:** Terminal failed rows are preserved for forensic review. Operators must never delete outbox rows directly to "clear a backlog."
