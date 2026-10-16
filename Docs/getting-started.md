# Getting Started with AIBridge

> **Status:** Current  
> **Applies to:** AIBridge 3.0.0  
> **Owner:** Maintainers  

AIBridge is a distributed multi-agent orchestration runtime connecting OpenCode, Claude Code, and Codex execution agents across machines over private Tailscale networks.

This guide walks you through system prerequisites, installation, initial node onboarding, service launch, and sending your first cross-machine task.

---

## 1. Prerequisites

Before installing AIBridge, verify that each participating machine meets the following requirements:

| Component | Minimum Version | Purpose |
|---|---|---|
| [Bun](https://bun.sh) | `>= 1.3.0` | Runtime for AIBridge CLI and worker daemon. |
| [tmux](https://github.com/tmux/tmux) | `>= 3.0` | Process supervision for headless background sessions. |
| [OpenCode](https://opencode.ai) | Latest | Agent execution runtime. Bound strictly to `127.0.0.1:4096`. Install with `bun install -g opencode-ai`. |
| [Tailscale](https://tailscale.com) | Running | Private WireGuard mesh network (`100.64.0.0/10`). Never exposed to public internet. |

---

## 2. Installation

### Automated Installer

Run the official one-liner script (macOS, Debian, Ubuntu):

```bash
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash
```

For non-interactive or CI environments, pass `--yes`:

```bash
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash -s -- --yes
```

The installer verifies prerequisites, prompts for missing system tools, installs the `@nyugennguyen/aibridge` package via Bun, and validates that `aibr` is available on your `$PATH`.

### Manual Package Installation

Alternatively, install the package directly via Bun:

```bash
bun install -g @nyugennguyen/aibridge
```

Verify that `aibr` resolves correctly:

```bash
aibr --version
```

If `aibr` is not found, add Bun's global binary directory to your shell configuration (`~/.zshrc` or `~/.bashrc`):

```bash
export PATH="$(bun pm bin -g):$PATH"
```

---

## 3. Node Onboarding (`aibr setup`)

AIBridge profiles encapsulate network configuration, security credentials, and project boundaries for each node.

Run the interactive setup wizard on your machine:

```bash
aibr setup --profile <name>
```

For a typical two-machine setup:
- On your workstation: `aibr setup --profile dev-main`
- On your remote runner or VPS: `aibr setup --profile test-vps`

### The 5-Step Setup Stepper

The setup wizard guides you through five configuration steps:

1. **Network Configuration:** Probes local `tailscaled` socket, retrieves your Tailscale IPv4 coordinate (`100.64.0.0/10`), and verifies port availability: `8787` (Fastify bridge and ingress router endpoint), `4096` (OpenCode loopback runtime), and `4095` (a legacy wizard preflight probe retained from early ingress designs; no production service listens on 4095).
2. **Security & Authentication:** Generates a cryptographically secure 128-bit bearer token (or allows pasting an existing token). Tokens are saved with strict `0600` permissions.
3. **Project Allowlists:** Declares absolute canonical project directories that agents are authorized to access. Containment is enforced fail-closed: any path outside configured roots is rejected.
4. **AI Runtimes & Peer Discovery:** Probes the local OpenCode loopback daemon and detects installed `claude` and `codex` CLIs. Scans reachable tailnet peers and allows configuring inbound (`allowed_sources`) and outbound (`agents[]`) peer routing.
5. **Supervisor Unit & Preflight Audit:** Generates platform supervisor service files (launchd on macOS, systemd on Linux) and runs an end-to-end preflight validation.

### Profile Storage & XDG Locations

Profile data is stored under owner-only (`0700` / `0600`) XDG directories:

| Content | Path |
|---|---|
| **Configuration** | `~/.config/aibridge/<profile>/config.json` |
| **Secrets (Bearer Token)** | `~/.local/share/aibridge/<profile>/secrets/bearer_token` |
| **State (Jobs, Task WAL)** | `~/.local/state/aibridge/<profile>/` |

---

## 4. Starting the Bridge (`aibr start`)

Start the OpenCode runtime and AIBridge daemon inside a managed tmux session:

```bash
aibr start --profile <name>
```

This launches a detached tmux session named `aibridge-<profile>` containing two windows:
- **`opencode`**: Runs `opencode serve --port 4096 --hostname 127.0.0.1` (strictly loopback).
- **`aibridge`**: Runs the bridge daemon bound exclusively to your Tailscale IP on port `8787`.

To attach to the running session:

```bash
tmux attach -t aibridge-<name>
```

To detach from tmux without stopping services, press `Ctrl+B`, followed by `D`.

### Check Health Status

Verify that the bridge is running and responsive:

```bash
aibr status --profile <name>
```

`aibr status` reports:
- `healthy`: Session exists and `/health` probe succeeded.
- `session_missing`: Tmux session is not running.
- `bridge_unavailable`: Tmux session exists but the bridge endpoint did not answer.

---

## 5. Verifying Cross-Host Authentication

To ensure two machines share the exact same bearer token without exposing credentials in shell history, use a temporary shell variable:

```bash
read -rs AIBRIDGE_TOKEN
printf '\n'
curl -i -X POST http://<peer-tailscale-ip>:8787/trigger \
  -H "Authorization: Bearer $AIBRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
unset AIBRIDGE_TOKEN
```

- **`HTTP 400 Bad Request`**: Success! Authentication passed, and AIBridge rejected only the empty trigger payload.
- **`HTTP 401 Unauthorized`**: Token mismatch or missing token. Re-verify the shared bearer token in `~/.local/share/aibridge/<profile>/secrets/bearer_token` on both hosts.

---

## 6. Triggering a Task

To dispatch work from `dev-main` to `test-vps`:

```bash
curl -X POST http://test-vps.tailnet:8787/trigger \
  -H "Authorization: Bearer $AIBRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "job_id": "job-001",
    "source_agent_id": "dev-main",
    "target_agent_id": "test-vps",
    "capability": "testing",
    "project_dir": "/srv/apps/app-under-test",
    "prompt": "Run full test suite and report any failures.",
    "callback_url": "http://dev-main.tailnet:8787/report",
    "timeout_seconds": 1800
  }'
```

Upon receipt:
1. `aibr-router` performs constant-time token verification, body size checks, and commits the request to the durable ingress WAL queue before returning `HTTP 202 Accepted`.
2. The execution worker drains the queue, validates source authorization and project path containment, and spawns the task in OpenCode.
3. Upon task completion, the remote runner posts its structured report back to the specified `callback_url`.

---

## Next Steps

- [Configuration Guide](guides/configuration.md) — Comprehensive configuration options, allowlists, and permissions.
- [Operations & Deployment](operations/deployment.md) — Production service management via systemd, launchd, and multi-node meshes.
- [Monitoring & Diagnostics](operations/monitoring.md) — Health checks, queue depths, and diagnostic bundles (`aibr bundle`).
- [Operational Troubleshooting](operations/troubleshooting.md) — Resolving HTTP status codes, credential mismatches, and recovery.
- [CLI Reference](reference/cli-reference.md) — Full executable command and option reference.
