# Operational Guide 01: Installation & Host Setup

> **Topic:** Host preparation, prerequisites, platform installation, profile creation, and onboarding wizard.  
> **Source of Truth:** `src/cli/setup.ts`, `src/host/profile-store.ts`, `src/host/paths.ts`.

---

## 1. Prerequisites & Supported Platforms

### 1.1 Supported Operating Systems
* **macOS:** Apple Silicon (`aarch64`) and Intel (`x86_64`).
* **Linux:** Debian and Ubuntu (`x86_64` and `aarch64`).
* *Unsupported platforms (e.g. Windows, Alpine/musl standalone) are refused at install and setup time.*

### 1.2 System Dependencies
* **Bun:** Version `>= 1.3.0` required (`bun --version`).
* **Tailscale:** Active, authenticated, and in `Running` state (`tailscale status`).
* **tmux:** Required for background process multiplexing (`tmux -V`).
* **Agent Runtimes:** Local OpenCode, Claude Code, or Codex instance bound strictly to loopback (`127.0.0.1:4096`).
* **Optional:** Herdr workspace manager (`herdrdev/herdr` branch `aibr-orchestration`) for interactive workstation presentation.

---

## 2. Installation Procedures

### 2.1 Automated One-Liner (macOS / Linux)
```bash
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash
```

For automated provisioning or CI without interactive prompts:
```bash
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash -s -- --yes
```

The script will:
1. Validate platform compatibility.
2. Check `bun`, `tmux`, `opencode`, and `tailscale`.
3. Install `@nyugennguyen/aibridge` globally via `bun install -g`.
4. Validate `aibr --version` on `$PATH`.

### 2.2 Global Bun Installation
```bash
bun install -g @nyugennguyen/aibridge
```

Ensure Bun's global bin directory is exposed on your `$PATH`:
```bash
export PATH="$(bun pm bin -g):$PATH"
```

Verify installation:
```bash
aibr --version
```

---

## 3. Directory Layout & XDG Profile Storage

AIBridge profiles are stored according to XDG specifications, completely decoupled from repository checkouts:

| Component | Path Location | Permissions | Purpose |
|---|---|:---:|---|
| **Config** | `~/.config/aibridge/<profile>/config.json` | `0600` | Profile settings, network bindings, and allowlists. |
| **Secrets Directory** | `~/.local/share/aibridge/<profile>/secrets/` | `0700` | Owner-only restricted secrets root. |
| **Bearer Secret** | `.../secrets/bearer_token` | `0600` | Shared constant-time bearer token. |
| **Runtime Password** | `.../secrets/opencode_password` | `0600` | Local loopback runtime auth password. |
| **Operator Token** | `.../secrets/operator_token` | `0600` | High-privilege operator claim token. |
| **State Directory** | `~/.local/state/aibridge/<profile>/` | `0700` | Databases, job files, and run logs. |
| **Job Records** | `.../jobs/<job_id>.json` | `0600` | Authoritative persisted job metadata. |
| **Ingress Queue** | `.../ingress_outbox.db` | `0600` | SQLite WAL durable ingress store. |
| **Egress Outbox** | `.../egress_outbox.db` | `0600` | SQLite WAL durable callback store. |
| **Orchestration Store**| `.../orchestration.db` | `0600` | Event-sourced kernel state store. |

> [!CAUTION]
> Secrets are **write-once** (`src/host/profile-store.ts`). Re-running setup over an existing profile will fail with `Secret already exists`. To change or rotate secrets, delete the existing secret file manually before re-running setup.

---

## 4. Interactive Setup Wizard (`aibr setup`)

To initialize a new profile, execute the 5-step onboarding wizard:

```bash
aibr setup --profile <profile-name>
```

Example for a development workstation:
```bash
aibr setup --profile dev-main
```

Example for a remote test node:
```bash
aibr setup --profile test-vps
```

### 4.1 Step 1: Network & Preflight
* Confirms Tailscale daemon is running.
* Resolves the local Tailscale IPv4 (`100.64.0.0/10`) and MagicDNS hostname.
* Verifies ports `4095` (router), `4096` (OpenCode), and `8787` (bridge) are unallocated.

### 4.2 Step 2: Security & Authentication Mode
* **Mode: `"bearer-token"` (Default, Recommended):**
  - Generates a cryptographically secure 32-byte hex CSPRNG token (`openssl rand -hex 32`).
  - Press `r` to regenerate a new value.
  - Press `p` to paste an existing shared token.
* **Mode: `"none"` (Unauthenticated):**
  - Disables authentication on `/trigger` and `/report`.
  - **Guardrail:** Refused unless bound strictly to a Tailscale CGNAT address (`100.64.0.0/10`).
  - Produces a standing warning in `aibr verify`.

### 4.3 Step 3: Project Allowlists
* Select directory trees agents are authorized to access and modify.
* **Enforcement:** Containment is **fail-closed**. Accessing paths outside configured roots is refused with `HTTP 403`.

### 4.4 Step 4: AI Runtimes & Tailnet Peer Discovery
* Probes the local loopback runtime (`http://127.0.0.1:4096/global/event`).
* Discovers reachable peers across your tailnet via `aibr discover`.
* Enrolling a peer executes **dual-enrolment**: adds the peer to both `agents[]` (outbound target) and `security.allowed_sources[]` (inbound caller) simultaneously.

### 4.5 Step 5: Platform Supervisor & Audit
* Writes a supervisor service unit:
  - macOS: `~/Library/LaunchAgents/com.aibridge.<profile>.plist`
  - Linux: `~/.config/systemd/user/aibridge-<profile>.service`
* Executes an immediate preflight configuration audit.
