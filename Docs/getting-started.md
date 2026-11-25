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

Prompts are read from `/dev/tty`, so piping works; with no terminal, use `--yes`. Choose the machine's role with `--role worker|orchestrator|both` (default `worker`) and the agent runtime with `--runtime opencode|claude|auto`. A worker needs Tailscale, tmux, and OpenCode or Claude Code; an orchestrator needs Tailscale and Claude Code only. Add `--with-claude-plugin` to install the Claude Code plugin when your `aibr` version provides the plugin installer.

The installer verifies prerequisites for the chosen role, offers to install tmux and Tailscale (Tailscale via its official installer, after confirmation; then run `sudo tailscale up`), installs the `@nyugennguyen/aibridge` package via Bun, offers to add Bun's global bin directory to your shell rc if `aibr` is not on `$PATH`, and ends with a summary of anything still missing. OpenCode and Claude Code are never installed automatically; the installer prints their install commands. Router and ingress-store provisioning only happens with `--ingress router`, and `--with-units` requires running the script from a repository checkout.

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

### What the Wizard Asks

`aibr setup` is a sequence of line prompts in your terminal (there is no full-screen or mouse-driven stepper). Press Enter to accept the default shown in `[brackets]`.

1. **Node role:** `worker` (runs jobs on this machine; the default), `orchestrator` (Claude Code dispatches work from this machine), or `both`. For a worker, the runtime — `opencode` or `claude` — is detected on `PATH` and only asked when both or neither are installed.
2. **Preflight:** checks only what the role needs and offers to install what it can (with confirmation):
   - worker + opencode: `tmux`, `opencode`, `tailscale`
   - worker + claude: `tmux`, `claude`, `tailscale`
   - orchestrator: `claude`, `tailscale`

   Tailscale must be up (`BackendState: Running`) with a Tailscale IPv4 address; the bridge binds to it.
3. **Bearer token:** generate a 256-bit CSPRNG token (default), paste an existing one, or type `none` (refused unless the bridge binds a Tailscale CGNAT address, and only after an explicit confirmation). Secrets are saved with `0600` permissions and are never echoed while you type or paste them.
4. **OpenCode password** (OpenCode workers only): press Enter to generate a random one; `aibr start` reads it from the secrets directory.
5. **Agent ID and project directory:** the project defaults to the git root of the current directory (or the current directory outside a repository). `$HOME`, `/`, and any parent of `$HOME` are refused, because every file below them would be reachable by remote jobs.
6. **Peer enrolment:** AIBridge bridges that answered `/health` on the tailnet are listed and numbered; every other tailnet device is summarized in one line. Discovery enrols nothing: a peer is written to `agents[]` and `security.allowed_sources[]` only after you pick it, choose its capabilities, and confirm. If nothing is found, you can enter a peer by hand. For the orchestrator role the first question here is a pairing code: run `aibr enroll issue` on the worker and paste the code it prints (see the [Pairing Guide](guides/pairing.md)); no token is copied by hand.
7. **Save:** press Enter (the default is yes). For a worker, a supervisor unit (launchd on macOS, systemd on Linux) is then written but only started if you answer `y`; an orchestrator gets no unit.

Options:
- `--config <path>` writes the config somewhere other than the standard path (the path is not asked otherwise).
- `--advanced` also asks for the bridge port (default `8787`) and the OpenCode port (default `4096`).

At the end, setup prints the next commands for your role (worker: `aibr start` and `aibr status`; orchestrator: `aibr verify`).

### Re-running Setup (Updating a Profile)

Running `aibr setup --profile <name>` on an existing profile asks **"Update existing profile?"** (default yes) and then offers every current value as the default — role, agent ID, project directory, ports, and enrolled peers. This is how you enrol the second machine after both are set up.

The bearer token is **kept** by default. The token prompt offers `[K]eep existing (default)`, `[G]enerate new` (every peer still using the old token will get `HTTP 401` until it is updated), `[P]aste`, or `none`. The OpenCode password is likewise kept when you press Enter. At the peer prompt, Enter keeps the current peers, a number adds a discovered bridge next to them, and `clear` removes them all.

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

### Running Under the Supervisor Instead of tmux

The supervisor unit written by `aibr setup` runs the same bridge as the `aibridge` tmux window: `aibr serve --profile <name>` in the default `engine` ingress mode (the router drain `aibr worker --profile <name> --ipc-publish` only when `bridge.ingress_mode` is `router`). It supervises the bridge only; an OpenCode worker still needs `opencode serve` running. Use tmux **or** the unit, not both — they bind the same port.

On macOS:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aibridge.daemon.plist   # start
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.aibridge.daemon.plist     # stop
```

On Linux:

```bash
systemctl --user enable --now aibridge.service    # start
systemctl --user disable --now aibridge.service   # stop
```

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
- **`HTTP 401` with `"code": "signature_required"`**: the token was accepted, but the worker requires signed requests (`security.request_signing: "required"`, the default for profiles created by `aibr setup`). `curl` cannot sign; pair the nodes with `aibr enroll` and dispatch from the paired node (Claude Code plugin), as described in the [Pairing Guide](guides/pairing.md).

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
