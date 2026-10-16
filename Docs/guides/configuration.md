# Configuration Guide

> **Status:** Current  
> **Applies to:** AIBridge 3.0.0  
> **Owner:** Maintainers  

AIBridge configurations define network binding, security credentials, project boundaries, agent permissions, and routing policies. Configurations are validated against strict Zod schemas (`src/config/schemas.ts`) and serialized to XDG profile directories.

---

## 1. Profile Architecture & Storage Locations

AIBridge profiles separate non-sensitive configuration, credentials, and volatile execution state:

| Content | Path | Permissions | Purpose |
|---|---|:---:|---|
| **Configuration** | `~/.config/aibridge/<profile>/config.json` | `0600` | Node topology, allowlists, and execution parameters. |
| **Secrets** | `~/.local/share/aibridge/<profile>/secrets/bearer_token` | `0600` | Cryptographic bearer token (separated from JSON config). |
| **State** | `~/.local/state/aibridge/<profile>/` | `0700` | SQLite WAL databases (`ingress_outbox.db`, `events.db`), jobs, and locks. |

Override root directories using standard XDG environment variables: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME`.

---

## 2. Configuration Schema Reference

Below is a complete specification of fields in `config.json`, derived directly from `bridgeConfigSchema`:

```json
{
  "bridge": {
    "host": "100.64.0.1",
    "port": 8787,
    "ingress_mode": "router"
  },
  "security": {
    "auth_mode": "bearer-token",
    "allowed_sources": [
      {
        "source_agent_id": "dev-main",
        "capabilities": ["code", "testing", "review"],
        "requires_plan_approval": false
      }
    ]
  },
  "projects": [
    {
      "id": "project-web",
      "path": "/srv/apps/web-app",
      "allowed_roles": ["implementer", "reviewer"]
    }
  ],
  "planning": {
    "require_approval_for": ["deployment", "database_migration"]
  },
  "permissions": {
    "auto_approve": ["read_file", "search_files"],
    "require_human_confirmation": ["execute_bash", "write_file"]
  },
  "terminal": {
    "backend": "tmux"
  },
  "agents": [
    {
      "id": "test-vps",
      "url": "http://100.64.0.2:8787",
      "capabilities": ["testing", "qa"]
    }
  ]
}
```

### 2.1 `bridge`
- **`host`** *(string, required)*: The IPv4 address to which the bridge or ingress router binds. Must belong to the Tailscale CGNAT range (`100.64.0.0/10`). Wildcard binding (`0.0.0.0`) is rejected fail-closed during preflight.
- **`port`** *(integer, default: `8787`)*: Port for incoming HTTP requests (`/health`, `/trigger`, `/report`).
- **`ingress_mode`** *(enum, default: `"router"`)*:
  - `"router"`: High-performance native Rust admission router (`aibr-router`) with commit-before-202 WAL.
  - `"engine"`: Direct Fastify HTTP engine handling requests synchronously in TypeScript.

### 2.2 `security`
- **`auth_mode`** *(enum, default: `"bearer-token"`)*:
  - `"bearer-token"`: All protected routes require a matching `Authorization: Bearer <token>` header verified using constant-time comparison. Token is read from the secrets file.
  - `"none"`: Disables token authentication. Allowed only when bound to a validated Tailscale CGNAT address.
- **`allowed_sources`** *(array of objects)*: Declares which remote agents are authorized to trigger tasks on this node.
  - `source_agent_id` *(string)*: Identifier of the remote calling agent.
  - `capabilities` *(array of strings)*: Work kinds this caller may request (e.g. `["testing", "code"]`).
  - `requires_plan_approval` *(boolean, optional)*: When `true`, requests from this caller must include approved Plan Annotator metadata.

### 2.3 `projects`
Array of directories that agents are authorized to access.
- **`id`** *(string)*: Symbolic identifier for the project workspace.
- **`path`** *(string)*: Canonical filesystem path. At startup and before task execution, symlinks are resolved via `realpath`. Any task referencing paths outside these configured directories is rejected with `HTTP 403 Forbidden`.
- **`allowed_roles`** *(array of strings, optional)*: Explicit list of orchestration roles permitted to modify this project.

### 2.4 `planning`
- **`require_approval_for`** *(array of strings)*: List of sensitive capabilities that mandate human or coordinator plan approval before execution proceeds.

### 2.5 `permissions`
Policy mapping specifying how the local OpenCode runtime responds to automated tool use requests (e.g., auto-approving read actions while gating bash execution).

### 2.6 `terminal`
- **`backend`** *(enum, default: `"tmux"`)*:
  - `"tmux"`: Detached headless sessions (standard for headless VPS and daemon setups).
  - `"herdr"`: Interactive presentation substrate utilizing the Herdr manager plugin.

### 2.7 `agents`
Outbound registry listing remote peers that this node is authorized to trigger.
- `id`: Target agent identifier.
- `url`: Tailscale HTTP endpoint of the peer (e.g., `http://100.64.0.2:8787`).
- `capabilities`: Work kinds supported by the remote peer.

---

## 3. Environment Variables Reference

| Variable | Description |
|---|---|
| `AIBRIDGE_CONFIG` | Path to the active `config.json` file. |
| `AIBRIDGE_BEARER_TOKEN` | In-memory token override (used primarily in containerized or CI environments). |
| `AIBRIDGE_INGRESS_OUTBOX` | Path to the SQLite ingress queue database (`ingress_outbox.db`). |
| `OPENCODE_PORT` | Port for the local OpenCode daemon (default: `4096`). |
| `OPENCODE_SERVER_PASSWORD` | Password for OpenCode loopback authentication. |
| `AIBRIDGE_OPERATOR_TOKEN` | Operator credential granting user-kind actor claims for charter approvals. |

---

## 4. Secret Management & Token Rotation

The bearer token is saved in `~/.local/share/aibridge/<profile>/secrets/bearer_token`. To rotate a token:

1. Stop AIBridge on all participating nodes:
   ```bash
   tmux kill-session -t aibridge-<profile>
   ```
2. Remove the existing secret file:
   ```bash
   rm ~/.local/share/aibridge/<profile>/secrets/bearer_token
   ```
3. Re-run `aibr setup --profile <profile>` and enter the new shared token on both machines.
4. Restart the bridge on both hosts and verify connectivity.
