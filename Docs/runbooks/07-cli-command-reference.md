# Operational Guide 07: CLI Command Reference & Troubleshooting

> **Topic:** Comprehensive CLI syntax, flag specifications, non-existent commands, and HTTP status code troubleshooting.  
> **Source of Truth:** `src/cli.ts:93`, `src/server/routes/`, `.agents/skills/debugging-aibr-v2/SKILL.md`.

---

## 1. CLI Usage & Global Flags

```bash
aibr <command> [options]
```

### 1.1 Global Flags

| Flag | Shorthand | Purpose |
|---|:---:|---|
| `--profile <name>` | `-p` | Profile name. Required for `start`, `serve`, `worker`, `status`, and `tui`. |
| `--help` | `-h` | Display help output and syntax options. |
| `--version` | `-v` | Display the installed `aibr` version. |
| `--preview` | | Preview diagnostic bundle summary without raw JSON (with `bundle`). |
| `--json` | | Emit pure machine-readable JSON document (with `discover`). |
| `--shadow-mode` | | Run bridge server mirroring requests to router (with `serve`). |
| `--ipc-publish` | | Expose local Unix domain socket IPC bus (with `worker`). |
| `--check` | `-c` | Check for newer releases on npm without installing (with `update`). |
| `--yes` | `-y` | Automatically confirm update installation prompts (with `update`). |

---

## 2. Command Reference Matrix

### `aibr setup [options]`
* **Purpose:** Runs the interactive 5-step onboarding wizard.
* **Profile Flag:** Optional (`--profile <name>`); prompts for profile name if omitted.
* **Environment:** Rejects non-TTY environments.

### `aibr start --profile <name>`
* **Purpose:** Launches OpenCode and the AIBridge daemon inside a managed tmux session (`aibridge-<profile>`).
* **Profile Flag:** **Required**.
* **Exit Behavior:** Exits `0` if already running.

### `aibr serve --profile <name> [options]`
* **Purpose:** Runs the Fastify bridge HTTP server directly in the foreground.
* **Options:** Supports `--shadow-mode`.
* **Profile Flag:** **Required**.

### `aibr worker --profile <name> [options]`
* **Purpose:** Starts the Tier 2 background worker that drains admitted tasks from `ingress_outbox.db`.
* **Options:** Supports `--ipc-publish` to serve the local IPC bus on a Unix domain socket.
* **Profile Flag:** **Required**.

### `aibr status --profile <name>`
* **Purpose:** Checks tmux session state and probes the local `/health` endpoint.
* **Profile Flag:** **Required**.
* **Returns:** `healthy`, `session_missing`, or `bridge_unavailable`.

### `aibr verify [options]`
* **Purpose:** Validates system dependencies, Tailscale network status, configuration Zod schemas, and secret file permissions (`0600`).
* **Profile Flag:** Optional.

### `aibr update [options]`
* **Purpose:** Checks npm registry for updates to `@nyugennguyen/aibridge` and installs newer versions.
* **Options:** `--check` (dry run), `--yes` (non-interactive).

### `aibr tui --profile <name>`
* **Purpose:** Connects to the interactive Herdr workspace and links the `aibr-manager` plugin.
* **Profile Flag:** **Required**.
* **Requirement:** Requires `herdr` on `$PATH`.

### `aibr bundle --profile <name> [options]`
* **Purpose:** Generates a sanitized diagnostic support bundle.
* **Options:** `--preview` displays an ASCII overview; omitting it streams JSON to stdout.
* **Profile Flag:** **Required**.

### `aibr discover [options]`
* **Purpose:** Performs read-only peer discovery across the local Tailscale network and probes each peer's `/health`.
* **Options:** `--json` outputs raw JSON for automation.
* **Profile Flag:** Optional.

---

## 3. Fake Commands — Never Suggest These

The following commands appeared in speculative runbooks or third-party drafts and **do not exist in AIBridge**:

| Non-Existent Command | Real Substitute / Alternative |
|---|---|
| `aibr db status\|check\|repair` | Run `sqlite3` directly on `ingress_outbox.db` or `egress_outbox.db`. |
| `aibr sessions list\|reassign` | Read JSON files in `~/.local/state/aibridge/<profile>/jobs/`. |
| `aibr lease status\|renew` | Handled automatically by the kernel event store. |
| `aibr preflight` | Run `aibr-router --preflight`. |
| `aibr config get` | Inspect `~/.config/aibridge/<profile>/config.json`. |
| `aibr worker --drain-only` | Run `aibr worker --profile <name>` (drain is default). |
| `aibr logs` / `aibr tail` | Run `tmux capture-pane -p -t aibridge-<profile>:bridge -S -2000`. |

---

## 4. HTTP Status Code Root-Cause Troubleshooting

All `/trigger` and `/report` routes are handled with strict error taxonomy:

| HTTP Code | Trigger / Report Cause | Root Cause & Resolution |
|---|---|---|
| **`400 Bad Request`** | Zod schema validation failed. | Payload structure does not match expected schema. (If sent with empty `{}` during testing, this confirms auth passed). |
| **`401 Unauthorized`** | Bearer authentication failed. | Bearer token in header does not match recipient's `bearer_token` secret. Check token synchronization. |
| **`403 Forbidden`** | Semantic authorization failed. | Calling `source_agent_id` is missing from `security.allowed_sources`, lacks required capability, target directory is outside allowlisted roots, or required plan approval was missing. |
| **`404 Not Found`** | Unknown target agent. | `target_agent_id` in request body does not match the receiving node's configured `agent_id`. |
| **`409 Conflict`** | Duplicate job identifier. | A job with the specified `job_id` has already been recorded in the state store. |
| **`503 Service Unavailable`** | Runtime or admission store down. | Loopback OpenCode (`127.0.0.1:4096`) is unreachable, or Tier 1 router cannot write to `ingress_outbox.db`. |

---

## 5. Job Execution Issues

### 5.1 Job Marked `timed_out`
* **Root Cause:** A job left in `running` state across a bridge restart is swept at boot time by `sweepExpiredJobs` (`src/bridge.ts`) and marked `timed_out`.
* **Resolution:** Normal recovery behavior. Re-dispatch the task.

### 5.2 Job Stuck in `running`
* **Step 1:** Check if OpenCode actually executed the turn:
  ```bash
  grep "<session_id>" ~/.local/share/opencode/log/opencode.log
  ```
* **Step 2:** Check for plan approval deadlock:
  If a task performs file edits or bash operations, permissions require `metadata.plan_status === "approved"`. Tasks without this metadata will stall in waiting states.
