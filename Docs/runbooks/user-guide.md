# AIBridge User & Operator Guide (v3.0.0)

> **Audience:** Operators, platform engineers, and developers deploying, configuring, and orchestrating multi-agent networks with AIBridge.  
> **Source of Truth:** Corresponds to AIBridge v3.0.0 and ADR 0011 (`/Users/mac/Projects/AIBrigde/AGENTS.md`).

---

## 1. System Overview & Architecture

AIBridge is a distributed multi-agent orchestration runtime connecting OpenCode, Claude Code, and Codex execution agents across machines over private Tailscale networks.

### 1.1 Inviolable Invariant
> **Herdr owns the terminal. AIBridge owns the intent. Never both, never either.**
- **Herdr Workspace Presentation:** Terminal windows, tabs, pane tiling, truecolor VT parsing, process supervision, and input fencing.
- **AIBridge Kernel Authority:** Append-only event store (`SqliteEventStore`), versioned charters, role binding, advisory roundtables, budget ledgers, and dispatch scheduling.

```
                      Private Tailscale Network (100.64.0.0/10)
                                       │
                          HTTP/JSON POST /trigger
                                       ▼
              ┌─────────────────────────────────────────────────┐
              │       Tier 1: aibr-router (Native Rust)         │
              │─────────────────────────────────────────────────│
              │ • Binds tailscale0:8787 (4-layer preflight)     │
              │ • Constant-time Bearer authentication (subtle)  │
              │ • Structural validation & 1 MiB payload ceiling │
              │ • Bounded concurrency (cap: 64 inflight)        │
              └───────────────────────┬─────────────────────────┘
                                      │ Commit before 202 (SF-08)
                                      ▼
                       ┌──────────────────────────────┐
                       │    Durable SQLite Queue      │
                       │  (ingress_outbox, WAL mode)  │
                       └──────────────┬───────────────┘
                                      │ Drain via claim lease
                                      ▼
              ┌─────────────────────────────────────────────────┐
              │       Tier 2: aibr worker (Bun / TypeScript)    │
              │─────────────────────────────────────────────────│
              │ • Sole semantic authorization authority         │
              │ • Source authorization & project allowlists     │
              │ • Charter governance & Immutable Core checks    │
              │ • Scoped memory & automated secret redaction    │
              │ • RoleBinder prompt compilation & dispatch      │
              └───────────────────────┬─────────────────────────┘
                                      │ Loopback only (127.0.0.1:4096)
                                      ▼
              ┌─────────────────────────────────────────────────┐
              │       Local Agent Runtime (OpenCode / etc.)     │
              └─────────────────────────────────────────────────┘
```

### 1.2 Two-Tier Polyglot Separation
* **Tier 1 — Admission Ingress (`aibr-router`):** Native Rust daemon for sub-millisecond, fail-closed structural filtering and atomic disk commit (`ingress_outbox.db`, `synchronous=FULL`). Emits `HTTP 202 Accepted` only after durable disk write.
* **Tier 2 — Execution Worker (`aibr worker`):** Bun/TypeScript daemon that polls the durable queue, performs semantic authorization, applies charter policies, and communicates with local runtimes.

---

## 2. Platform Requirements & Installation

### 2.1 Supported Platforms
* **macOS:** Apple Silicon (`aarch64`) and Intel (`x86_64`).
* **Linux:** Debian and Ubuntu (`x86_64` and `aarch64`).
* *Other platforms are rejected at install and setup time.*

### 2.2 System Dependencies
* **Bun:** `>= 1.3.0` installed on `PATH`.
* **Tailscale:** Installed, logged in, and in `Running` state.
* **tmux:** Required for background headless process supervision.
* **OpenCode / Claude Code / Codex:** Bound strictly to loopback (`127.0.0.1:4096`).
* **Herdr (Optional for Interactive Stations):** Herdr fork (`herdrdev/herdr` branch `aibr-orchestration`) for interactive operator management.

### 2.3 Installation

#### Automated One-Liner (macOS / Linux)
```bash
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash
```

For non-interactive CI/CD installations:
```bash
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash -s -- --yes
```

#### Manual Installation via Bun
```bash
bun install -g @nyugennguyen/aibridge
```

Verify binary availability:
```bash
aibr --version
```

If `aibr` is missing from `PATH`, export Bun's global bin directory in your shell profile (`~/.zshrc` or `~/.bashrc`):
```bash
export PATH="$(bun pm bin -g):$PATH"
```

---

## 3. Directory Layout & State on Disk

AIBridge strictly adheres to the XDG Base Directory specification. **There are no state files or logs stored in the repository root for production profiles.**

| Data Tier | Path Pattern | Permissions | Description |
|---|---|:---:|---|
| **Configuration** | `~/.config/aibridge/<profile>/config.json` | `0600` | Profile settings, network bindings, and allowlists. |
| **Secrets** | `~/.local/share/aibridge/<profile>/secrets/` | `0700` | Write-once secret storage directory. |
| **Bearer Secret** | `.../secrets/bearer_token` | `0600` | CSPRNG bearer authentication token. |
| **Runtime Password**| `.../secrets/opencode_password` | `0600` | Loopback runtime authentication password. |
| **Operator Token** | `.../secrets/operator_token` | `0600` | Token for user-level governance actions. |
| **State Storage** | `~/.local/state/aibridge/<profile>/` | `0700` | Durable databases and job artifacts. |
| **Job Records** | `.../jobs/<job_id>.json` | `0600` | Authoritative persisted job metadata and state. |
| **Ingress Outbox** | `.../ingress_outbox.db` | `0600` | SQLite WAL durable ingress queue. |
| **Egress Outbox** | `.../egress_outbox.db` | `0600` | SQLite WAL durable egress callback outbox. |
| **Orchestration** | `.../orchestration.db` | `0600` | Append-only event store for charters and roundtables. |

> [!WARNING]
> Secrets are **write-once**. The CLI will not overwrite an existing secret file. To change a token, you must stop the service, remove the file manually, run `aibr setup`, and restart.

---

## 4. Host Setup & Onboarding (`aibr setup`)

To configure a machine, run the interactive 5-step wizard with a target profile name:

```bash
aibr setup --profile dev-main
```

### 4.1 The 5 Setup Steps

1. **Step 1: Network Interface & Preflight**
   * Verifies Tailscale is running.
   * Extracts Tailscale IPv4 (`100.64.0.0/10`) and MagicDNS hostname.
   * Confirms ports `4095` (router), `4096` (OpenCode loopback), and `8787` (bridge) are unallocated.

2. **Step 2: Authentication Mode Selection**
   * **Bearer Token (`"bearer-token"`, Recommended):** Generates a 32-byte hex CSPRNG token (`r` to regenerate, or `p` to paste a shared secret).
   * **Unauthenticated (`"none"`):** Accepted **only** when bound to Tailscale CGNAT addresses. Sets `security.auth_mode: "none"`. Produces a standing warning in `aibr verify`.

3. **Step 3: Project Allowlists**
   * Sets allowed project directories that agents may access.
   * Path containment is **fail-closed**: requests targeting paths outside these roots are rejected with `HTTP 403`.

4. **Step 4: AI Runtimes & Tailnet Peer Discovery**
   * Probes local OpenCode loopback (`127.0.0.1:4096`) and verifies CLI availability for `claude` and `codex`.
   * Queries Tailscale peers and displays available nodes.
   * Enrolling a peer executes **dual-enrolment**: writes the peer simultaneously to `agents[]` (outbound) and `security.allowed_sources[]` (inbound).

5. **Step 5: Supervisor Unit Installation & Audit**
   * Generates a platform supervisor unit: `launchd` plist on macOS (`~/Library/LaunchAgents/`) or `systemd` user service on Linux (`~/.config/systemd/user/`).
   * Performs an immediate configuration preflight check.

---

## 5. Service Operations & Process Supervision

### 5.1 Headless Mode (Standard Production)
Start the runtime and bridge inside managed tmux windows:

```bash
aibr start --profile dev-main
```

This creates a detached session `aibridge-<profile>` with two windows:
* `opencode`: Runs `opencode serve --port 4096 --hostname 127.0.0.1`.
* `aibridge`: Runs the AIBridge daemon bound to the Tailscale IPv4 address.

Attach to inspect:
```bash
tmux attach -t aibridge-dev-main
```
*(Detach with `Ctrl+B, D`)*

### 5.2 Direct Service Execution
For custom system supervisors, run components directly:

```bash
# Initialize Tier 1 SQLite ingress store
aibr-router --init-store

# Run Tier 1 Router
aibr-router

# Run Tier 2 Worker (drains ingress queue)
aibr worker --profile dev-main

# Run Bridge Server directly
aibr serve --profile dev-main
```

---

## 6. Tailscale Peer Discovery & Mesh Operations

AIBridge provides native discovery across Tailscale networks without leaking secrets or trust boundaries.

### 6.1 Discovering Peers
Query all reachable AIBridge nodes on the tailnet:

```bash
aibr discover --profile dev-main
```

For programmatic consumption or integration with external tools:
```bash
aibr discover --profile dev-main --json
```

Output format:
```json
{
  "schemaVersion": 1,
  "ok": true,
  "enrolledSource": "dev-main",
  "peersFound": 2,
  "reachableCount": 1,
  "enrolledCount": 1,
  "peers": [
    {
      "ip": "100.64.0.9",
      "hostname": "test-vps",
      "os": "linux",
      "online": true,
      "bridgeUrl": "http://100.64.0.9:8787",
      "reachable": true,
      "agentId": "test-vps",
      "capabilities": ["code", "test"],
      "opencodeReachable": true,
      "enrolled": true
    }
  ],
  "notice": "Reachability is not authentication. A peer answering /health is not enrolled or trusted."
}
```

### 6.2 Discovery Principles
* **Reachability $\ne$ Authentication:** An answer on `/health` proves only that a process is listening. It does not confer authorization or trust.
* **Unauthenticated `/health`:** Returns `ok`, `opencode`, `agent_id`, and `capabilities` (aggregated from `security.allowed_sources`). Does not leak authorized source IDs or access rules.
* **Credential Scrubbing:** Tokens and node keys (`tskey-`) are never surfaced or accepted as identity claims.

### 6.3 Verifying Cross-Host Authentication
Test bearer authentication against a peer without recording secrets in shell history:

```bash
read -rs TOK; printf '\n'
curl -i -X POST http://<peer-ip>:8787/trigger \
  -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{}'
unset TOK
```
* **`HTTP 400 Bad Request`:** Authentication succeeded; the empty payload was rejected by structural validation.
* **`HTTP 401 Unauthorized`:** Bearer token mismatch or missing.

---

## 7. Interactive Workspace Presentation with Herdr

AIBridge integrates with the **Herdr** workspace manager to provide rich interactive presentation for multi-agent workloads.

### 7.1 The Herdr Manager Cutover
To launch or connect to the management pane:

```bash
aibr tui --profile dev-main
```

When Herdr is present, `aibr tui` links the `aibr-manager` plugin via `herdr plugin link` and embeds:
* **Role Grid:** Live matrix of agents $\times$ roles with active capability envelope calculations.
* **Charter Editor:** Versioned system prompt review with inline Immutable Core validation.
* **Roundtable Live Transcript:** SSE stream of pre-execution debates with human input injection.
* **Multi-Machine Grid:** Distributed agent status projected across Tailscale nodes.
* **Approval Queue:** Pending charter proposals and plan authorizations.

### 7.2 Safety Invariants in Herdr
* **F1: Input-Ownership Fencing:** Managed via `pane.claim_input` and `pane.release_input`. Prevents human keystroke interleaving into active agent panes; unauthorized inputs are refused with `input_fenced`.
* **F2: First-Class Role Tagging:** Panes carry a durable `role` attribute bound to the kernel's `RoleSnapshot` digest, preserved across pane moves and window splits.
* **Decoupled Lifecycle:** Exiting Herdr does not stop background agents or terminate active tmux sessions.

---

## 8. Multi-Agent Governance & Deliberation

### 8.1 Charter Governance & The Immutable Core
System behavior is governed by a versioned, cryptographically stamped **Charter**.

#### Charter Proposal Lifecycle
1. **Proposal (`charter.propose`):** Agents submit revisions with rationale and evidence links.
2. **Core Verification:** The kernel automatically evaluates `assertCharterDoesNotRelaxCore`.
3. **Operator Approval (`charter.approve` / `charter.reject`):** Pending proposals require operator authorization via `AIBRIDGE_OPERATOR_TOKEN`.
4. **Activation (`charter.revise`):** The new charter version takes effect with a new digest.

#### The Six Inviolable Core Constraints
No charter proposal may relax:
1. `SAFETY_FLOOR` policy layer.
2. Input-ownership fencing requirements (F1).
3. Security perimeter (`security.allowed_sources`, project allowlists).
4. Advisory-only roundtable invariant.
5. Hard budget ceilings (`concurrency`, `fan_out`).
6. Kernel event store authority.

### 8.2 Composite Roles & Deterministic Prompts
Agents are assigned roles dynamically:
* **Primary Role:** Exactly one primary instruction set.
* **Secondary Roles:** Bounded addenda (`addendum`).
* **Deterministic Compilation (`RoleBinder`):**
  $$\text{Prompt} = \text{Charter}.\text{globalRules} + \text{primaryRole} + \sum \text{secondaryRole}.\text{addenda} + \text{communicationPolicy} + \text{taskPrompt}$$
* **Capability Envelope Intersection:** Permissions are strictly intersected:
  $$\text{effectivePermissions} = \text{allowed} \cap \text{roleAllowed} \cap \neg\text{denied}$$

### 8.3 Governed Deliberation (Roundtable)
Complex actions require pre-execution debate:
* **Lifecycle:** `roundtable.open` $\to$ `roundtable.post` $\to$ `roundtable.close` $\to$ `roundtable.outcome_recorded`.
* **Advisory-Only Invariant:** Deliberation produces audited recommendations and objections. `roundtable.closed` never triggers automatic dispatch.
* **Execution Gating:** Workflows marked `objectionRequiredBefore` reject direct dispatch attempts with `roundtable_required` until consensus or closure is recorded.

---

## 9. Verification, Diagnostics & Logs

### 9.1 Verification Ladder
Run diagnostic commands in order:

```bash
# 1. Validate dependencies, Tailscale, config schema, and token file permissions
aibr verify --profile dev-main

# 2. Check process health and endpoint responsiveness
aibr status --profile dev-main

# 3. Export redacted diagnostic support bundle (JSON to stdout)
aibr bundle --profile dev-main
```

### 9.2 Understanding `aibr status`
`aibr status` returns three distinct states:
* `healthy`: tmux session exists and the unauthenticated `/health` endpoint responds.
* `session_missing`: tmux session is not running.
* `bridge_unavailable`: tmux session exists, but HTTP `/health` is unresponsive.

> [!IMPORTANT]
> A status of `healthy` **does not** verify bearer authentication, project allowlists, or worker queue drains. Use cross-host probe testing (Section 6.3) to test security paths.

### 9.3 Locating Real Logs
There are no log files in `~/.aibridge/profiles/.../logs/worker.log`. Inspect runtime logs through their real outputs:

```bash
# Capture bridge process output
tmux capture-pane -p -t aibridge-dev-main:bridge -S -2000

# Capture OpenCode process output
tmux capture-pane -p -t aibridge-dev-main:opencode -S -2000

# Read authoritative job state
cat ~/.local/state/aibridge/dev-main/jobs/<job_id>.json

# Read OpenCode engine log
grep "<session_id>" ~/.local/share/opencode/log/opencode.log
```

### 9.4 Token Rotation Procedure
Tokens are write-once. To rotate:
```bash
# 1. Stop services
tmux kill-session -t aibridge-dev-main

# 2. Remove the existing secret
rm ~/.local/share/aibridge/dev-main/secrets/bearer_token

# 3. Re-run setup to author new secret
aibr setup --profile dev-main

# 4. Repeat on all peer nodes, then restart
aibr start --profile dev-main
```

---

## 10. CLI Command & Flag Reference

### Authoritative Command Matrix

| Command | Purpose | Profile Flag |
|---|---|:---:|
| `aibr setup` | Interactive 5-step onboarding wizard. | Optional |
| `aibr start` | Starts opencode and bridge in tmux. | **Required** |
| `aibr serve` | Runs the bridge HTTP server directly. | **Required** |
| `aibr worker` | Starts the Tier 2 ingress queue drain worker. | **Required** |
| `aibr status` | Checks process health and health probe. | **Required** |
| `aibr verify` | Validates dependencies, Tailscale, and config. | Optional |
| `aibr update` | Checks or installs the latest package version. | Optional |
| `aibr tui` | Opens the Herdr management plugin workspace. | **Required** |
| `aibr bundle` | Emits a redacted diagnostic support bundle. | **Required** |
| `aibr discover` | Probes tailnet peers and reports `/health`. | Optional |

### Global Flags

* `--profile, -p <name>`: Target profile name.
* `--preview`: Used with `aibr bundle` for terminal preview.
* `--json`: Emits pure JSON document (used with `aibr discover`).
* `--shadow-mode`: Runs engine in shadow mode, mirroring traffic to router.
* `--ipc-publish`: Enables local Unix domain socket IPC bus on `worker`.
* `--check, -c`: Checks for updates without applying (with `update`).
* `--yes, -y`: Automatically accepts update prompts.
* `--help, -h`: Displays command options.
* `--version, -v`: Displays CLI version.

### Non-Existent Commands (Do Not Use)
The following commands were proposed in early drafts or third-party forks and **are not implemented**:
* `aibr db *` $\to$ *Use `sqlite3` on database files directly.*
* `aibr sessions *` $\to$ *Inspect job JSON files in state directory.*
* `aibr lease *` $\to$ *Handled automatically via event store.*
* `aibr preflight` $\to$ *Use `aibr-router --preflight`.*
* `aibr logs` / `aibr tail` $\to$ *Use `tmux capture-pane`.*

---

## 11. Troubleshooting & Remediation Matrix

| Symptom / Code | Root Cause | Remediation |
|---|---|---|
| **`HTTP 401 Unauthorized`** | Bearer token mismatch between hosts. | Ensure `secrets/bearer_token` is identical on caller and recipient. Remember secrets are write-once. |
| **`HTTP 400 Bad Request`** | Auth succeeded; payload failed Zod schema. | Validate request body format against OpenAPI schema (`/trigger`). |
| **`HTTP 403 Forbidden`** | Source not in `allowed_sources`, or path not under allowed project roots. | Verify `security.allowed_sources` contains calling `source_agent_id` with required capability; confirm path is inside allowlisted root. |
| **`HTTP 404 Not Found`** | `target_agent_id` in payload does not match host's configured `agent_id`. | Verify peer `agent_id` in recipient's `config.json`. |
| **`HTTP 409 Conflict`** | Duplicate `job_id` already exists in store. | Generate a fresh UUID for new job dispatches. |
| **`HTTP 503 Service Unavailable`** | OpenCode loopback unreachable or admission store locked. | Check OpenCode process via `tmux capture-pane`; check SQLite WAL lock on `ingress_outbox.db`. |
| **Job status `timed_out`** | Job was left running across a daemon restart. | Expected recovery behavior from `sweepExpiredJobs` at startup. |
| **Job stuck in `running`** | OpenCode session failed permission reply or plugin error. | Inspect `~/.local/share/opencode/log/opencode.log` for unhandled session errors or unapproved plans. |
| **Router fatal exit `78`** | Missing or corrupt `ingress_outbox.db`. | Run `aibr-router --init-store` to provision queue schema. |
| **`input_fenced` in Herdr** | Keystroke attempted while agent holds pane lock. | Await task completion or invoke `pane.release_input` with appropriate operator token. |
