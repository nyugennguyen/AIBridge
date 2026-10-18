# Integrations Guide

> **Status:** Current  
> **Applies to:** AIBridge 3.0.0  
> **Owner:** Maintainers  

AIBridge integrates distributed agent runtimes, presentation substrates, and private networking layers into a unified orchestration mesh. This guide details integrations with OpenCode, Claude Code, Codex, Herdr, and Tailscale.

---

## 1. OpenCode Runtime Integration

OpenCode serves as the primary local language-model execution runtime.

### Loopback Isolation Boundary
The OpenCode daemon (`opencode serve`) is strictly bound to localhost:
- **Host:** `127.0.0.1` (never exposed across network or Tailscale interfaces)
- **Port:** `OPENCODE_PORT` (default: `4096`)
- **Authentication:** Authenticated via `OPENCODE_SERVER_PASSWORD` environment variable or the profile secret file at `~/.local/share/aibridge/<profile>/secrets/opencode_password`.

### Permission Interception
AIBridge intercepts OpenCode permission requests and evaluates them against the configured `permissions` policy. Automated actions (e.g. read tools) can be allowed while risky shell commands or modifications require explicit authorization.

---

## 2. Multi-Runtime Adapters (Claude Code & Codex)

AIBridge supports heterogeneous agent runtimes through normalized adapter interfaces:

- **Claude Code Adapter ([ADR 0005](../adr/0005-claude-code-runtime-adapter.md)):** Provides non-interactive process supervision, prompt framing, output redaction, and tool capability intersection for Anthropic's Claude Code CLI.
- **Codex Adapter ([ADR 0006](../adr/0006-codex-runtime-adapter.md)):** Coordinates OpenAI Codex models, managing sub-agent role dispatching and JSON-RPC protocol translation.

All runtimes execute within the strict capability envelope:
$$\text{allowed} \cap \text{roleAllowed} \cap \neg\text{denied}$$

---

## 3. Herdr Workspace Presentation

AIBridge delegates terminal rendering and user input management to [Herdr](https://github.com/herdrdev/herdr).

### Core Invariant
> **Herdr owns the terminal; the AIBridge kernel owns the intent. Never both, never either.**

- **Herdr Responsibilities:** Terminal multiplexing, tabs, pane layout, truecolor VT emulation, PTY process hosting, and input fencing.
- **AIBridge Responsibilities:** Append-only event store (`SqliteEventStore`), versioned charters, role binding, advisory roundtables, and dispatch scheduling.

### Input-Ownership Fencing
Herdr provides atomic input fencing (`pane.claim_input` / `pane.release_input`). When an autonomous agent is executing, human keyboard input to that pane is fenced to prevent accidental command corruption. When human-in-the-loop (HITL) review is required, input ownership transitions explicitly.

### Manager Plugin (`aibr tui`)
To launch or link the `aibr-manager` plugin inside Herdr:

```bash
aibr tui --profile <profile>
```

This links the plugin to Herdr and provides direct access to the Role Grid, Charter Editor, Roundtable Live Transcript, and Approval Queue.

---

## 4. Tailscale Mesh Networking

AIBridge relies on Tailscale WireGuard private networks for secure multi-node communication.

### Network Binding
Ingress endpoints bind exclusively to Tailscale CGNAT IPv4 coordinates (`100.64.0.0/10`). During Layer-1 preflight, the router inspects local OS network interfaces and aborts with `EX_CONFIG` (exit code 78) if the configured `bridge.host` is not a verified Tailscale address.

### Peer Discovery (`aibr discover`)
Enumerate and probe other AIBridge nodes on your private tailnet:

```bash
aibr discover --profile <name>
```

`aibr discover` is a read-only query:
1. Calls `tailscale status --json` locally to discover tailnet peers.
2. Makes an unauthenticated `GET /health` request to each peer on port `8787`.
3. Reports peer status, agent IDs, and advertised capabilities.

For programmatic consumers (such as the Herdr manager plugin), `--json` emits pure, machine-readable JSON:

```bash
aibr discover --profile <name> --json
```

### Peer Enrollment
Discovery proposes reachable peers; it does not automatically trust them. To authorize a peer:
- Add the remote peer to inbound `security.allowed_sources` in `config.json`.
- Add the remote peer to outbound `agents[]` in `config.json`.
- Ensure both nodes share the identical secret bearer token.
