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

AIBridge validates every profile's `config.json` against strict Zod schemas (`src/config/schemas.ts`) at load time.

Canonical, fully validated reference profiles are maintained and verified in CI:
- [**`config/dev-main.example.json`**](../../config/dev-main.example.json) — Workstation configuration (`dev-main`), using Fastify engine ingress and local workspace boundaries.
- [**`config/test-vps.example.json`**](../../config/test-vps.example.json) — Remote execution node (`test-vps`), using native Rust ingress router and plan approval guardrails.

These canonical configuration files are continuously validated against `bridgeConfigSchema` by `bun run docs:check`.

Below are focused, schema-conforming partial examples illustrating each major section.

### 2.1 `bridge` (Ingress & Network Binding)

```json
{
  "bridge": {
    "host": "100.64.0.1",
    "port": 8787,
    "public_url": "http://dev-main.tailnet:8787",
    "ingress_mode": "router"
  }
}
```

- **`host`** *(string, required)*: The IPv4 address to which the bridge or ingress router binds. Must belong to the Tailscale CGNAT range (`100.64.0.0/10`). Wildcard binding (`0.0.0.0`) is rejected fail-closed during preflight.
- **`port`** *(integer, default: `8787`)*: Port for incoming HTTP requests (`/health`, `/trigger`, `/report`).
- **`public_url`** *(string, URL)*: Accessible base URL advertised to peers across the Tailscale mesh.
- **`ingress_mode`** *(enum, default: `"engine"`)*:
  - `"router"`: High-performance native Rust admission router (`aibr-router`) with commit-before-202 WAL.
  - `"engine"`: Direct Fastify HTTP engine handling requests synchronously in TypeScript.

> [!NOTE]
> AIBridge production traffic listens on `bridge.port` (default `8787`) and OpenCode loopback on `opencode.server_port` (default `4096`). The setup wizard network probe includes port `4095` as a legacy preflight check from early router ingress designs, but no production runtime service binds to 4095.

### 2.2 `security` & `allowed_sources`

```json
{
  "security": {
    "auth_mode": "bearer-token",
    "allowed_sources": [
      {
        "source_agent_id": "test-vps",
        "capabilities": ["testing", "qa"],
        "requires_plan_approval": ["deployment", "multi-agent-fanout"]
      }
    ]
  }
}
```

- **`auth_mode`** *(enum, default: `"bearer-token"`)*:
  - `"bearer-token"`: All protected routes require a matching `Authorization: Bearer <token>` header verified using constant-time comparison. Token is read from the secrets file (`~/.local/share/aibridge/<profile>/secrets/bearer_token`).
  - `"none"`: Disables token authentication. Allowed only when bound to a validated Tailscale CGNAT address.
- **`allowed_sources`** *(array of objects)*: Declares which remote agents are authorized to trigger tasks on this node.
  - `source_agent_id` *(string)*: Identifier of the remote calling agent.
  - `capabilities` *(array of strings)*: Work kinds this caller may request (e.g. `["testing", "code"]`).
  - `requires_plan_approval` *(array of strings, default: `[]`)*: Capabilities that require approved Plan Annotator metadata before execution proceeds.

### 2.3 `projects` (Workspace Boundaries)

```json
{
  "projects": [
    {
      "id": "app-under-test",
      "path": "/srv/apps/app-under-test",
      "capabilities": ["testing", "qa"]
    }
  ]
}
```

- **`id`** *(string)*: Symbolic identifier for the project workspace.
- **`path`** *(string)*: Canonical filesystem path. At startup and before task execution, symlinks are resolved via `realpath`. Any task referencing paths outside these configured directories is rejected with `HTTP 403 Forbidden`.
- **`capabilities`** *(array of strings)*: Work kinds permitted within this specific project directory.

### 2.4 `opencode` & `permissions`

```json
{
  "opencode": {
    "base_url": "http://127.0.0.1:4096",
    "server_port": 4096,
    "username": "opencode",
    "password_env": "OPENCODE_SERVER_PASSWORD"
  },
  "permissions": {
    "default_response": "reject",
    "allow_tools": ["read", "grep", "glob"],
    "require_plan_approval_for_tools": ["bash", "edit", "write"]
  }
}
```

- **`opencode.base_url`** *(string, URL)*: Loopback URL for the local OpenCode daemon (must be `127.0.0.1` or `localhost`).
- **`opencode.server_port`** *(integer, default: `4096`)*: Loopback port for OpenCode.
- **`permissions.default_response`** *(enum: `"reject"` | `"once"` | `"always"`)*: Fallback action when a tool request does not match explicit permission rules.
- **`permissions.allow_tools`** *(array of strings)*: Runtime tools automatically permitted without interactive confirmation.
- **`permissions.require_plan_approval_for_tools`** *(array of strings)*: Runtime tools requiring approved plan metadata before invocation.

### 2.5 `planning`

```json
{
  "planning": {
    "plan_annotator_enabled": true,
    "require_approval_for": ["deployment", "destructive", "multi-agent-fanout"]
  }
}
```

- **`plan_annotator_enabled`** *(boolean)*: Enables Plan Annotator verification on incoming trigger requests.
- **`require_approval_for`** *(array of strings)*: List of sensitive capabilities that mandate human or coordinator plan approval before execution proceeds.

### 2.6 `agents` (Outbound Peer Registry)

```json
{
  "agents": [
    {
      "id": "dev-main",
      "url": "http://dev-main.tailnet:8787",
      "capabilities": ["development", "orchestration"]
    }
  ]
}
```

- **`id`** *(string)*: Target peer agent identifier.
- **`url`** *(string, URL)*: Tailscale HTTP endpoint of the peer (e.g., `http://100.64.0.1:8787`).
- **`capabilities`** *(array of strings)*: Work kinds supported by the remote peer.

### 2.7 `terminal` & `timeouts`

```json
{
  "terminal": {
    "backend": "tmux"
  },
  "timeouts": {
    "default_job_seconds": 1800,
    "callback_retry_attempts": 3
  }
}
```

- **`terminal.backend`** *(enum, default: `"tmux"`)*:
  - `"tmux"`: Detached headless sessions (standard for headless VPS and daemon setups).
  - `"herdr"`: Interactive presentation substrate utilizing the Herdr manager plugin.
- **`timeouts.default_job_seconds`** *(integer)*: Maximum allowed execution duration before a job times out.
- **`timeouts.callback_retry_attempts`** *(integer)*: Number of retry attempts for reporting completion callbacks to remote peers.

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
