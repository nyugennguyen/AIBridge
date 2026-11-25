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

## 3. Set Up the Machine (`aibr init`)

AIBridge profiles encapsulate network configuration, security credentials, and project boundaries for each node. `aibr init` creates one in at most four questions:

```bash
aibr init
```

1. **Role:** `worker` (runs jobs on this machine), `orchestrator` (Claude Code dispatches work from this machine), or `both`.
2. **Runtime** (workers): `opencode` or `claude`, detected on `PATH`; asked only when both or neither are installed.
3. **Project directory** (workers): defaults to the git root of the current directory. `$HOME`, `/`, and any parent of `$HOME` are refused.
4. **Network:** press Enter to create a new network (this machine prints a one-time pairing code), or paste a code another machine printed to join its network. An orchestrator is asked only for the code.

Everything else takes a safe default and is not shown: a 256-bit bearer token and (for OpenCode) a random OpenCode password, stored `0600`; the agent ID (the profile name, or this machine's name for the `default` profile); ports `8787`/`4096`; signed requests required (`security.request_signing: "required"`). The same preflight as `aibr setup` runs first, so a missing prerequisite or a stopped Tailscale is reported with the command that fixes it.

A worker's bridge is then started as a user service (section 4) and, for a new network, the pairing code is printed. Every question has a flag, so a scripted install asks nothing:

```bash
aibr init --profile staging --role worker --runtime claude --project /srv/app --new
aibr init --profile laptop --role orchestrator --join <code>
```

For a typical two-machine setup, run `aibr init` on the worker first and paste the code it prints into `aibr init` on the other machine. Joining pins both machines' keys, adds each to the other's config (`agents[]` here, `security.allowed_sources[]` on the worker), and stores the worker's bearer token — no token is copied by hand. More machines pair later with `aibr enroll issue` / `aibr enroll join` ([Pairing Guide](guides/pairing.md)).

### The Full Wizard (`aibr setup`)

`aibr setup --profile <name>` asks every question `aibr init` answers with a default. Use it to change a profile, to enrol a peer by hand, or with `--advanced` for the ports.

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
7. **Save:** press Enter (the default is yes). A worker is then offered the user service (`aibr start`); nothing is written unless you answer `y`. An orchestrator gets no service.

Options:
- `--config <path>` writes the config somewhere other than the standard path (the path is not asked otherwise).
- `--advanced` also asks for the bridge port (default `8787`) and the OpenCode port (default `4096`).

At the end, setup prints the next commands for your role (worker: `aibr start`, `aibr enroll issue`, `aibr doctor`; orchestrator: `aibr enroll join <code>`, `aibr doctor`, `aibr plugin install claude`).

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
| **Log (`aibr logs`)** | `~/.local/state/aibridge/<profile>/logs/aibridge.log` |

---

## 4. Running the Bridge (`aibr start`)

```bash
aibr start --profile <name>
```

`aibr start` installs and loads the profile's **user service** and waits until `/health` answers:

- macOS: a launchd agent, `~/Library/LaunchAgents/com.aibridge.<name>.plist`, loaded with `launchctl bootstrap gui/<uid>`;
- Linux: a systemd user unit, `~/.config/systemd/user/aibridge-<name>.service` (`systemctl --user`).

It runs `aibr serve --profile <name>` (for an OpenCode worker with `--with-opencode`, which runs `opencode serve` on `127.0.0.1` as its child), restarts it on failure and at login, and sends its output to `~/.local/state/aibridge/<name>/logs/aibridge.log`. No secret is written into the unit. Re-running `aibr start` restarts it with the current config. On a Linux server, enable lingering so the service survives logout: `sudo loginctl enable-linger $USER`.

```bash
aibr status --profile <name>     # what runs it and whether /health answers
aibr logs --profile <name> -f    # follow the bridge log
aibr stop --profile <name>       # unload and remove the service (and the tmux session)
```

`aibr status` reports `healthy` with what runs the bridge (`launchd`, `systemd`, `tmux`, or `unmanaged`), `not_running`, or `bridge_unavailable` (something runs it but `/health` does not answer — read `aibr logs`).

### Development: `--foreground`

```bash
aibr start --profile <name> --foreground
tmux attach -t aibridge-<name>
```

runs the same processes in the tmux session `aibridge-<name>` (an `opencode` window for OpenCode workers, and a `bridge` window). Windows stay open when their process exits, so an error stays on screen. Use the service **or** tmux, not both — they bind the same port.

---

## 5. Checking It End to End (`aibr doctor`, `aibr ping`)

```bash
aibr doctor
```

`aibr doctor` merges `aibr verify` (prerequisites, Tailscale, config, project, secrets, discovery), `aibr status`, and a **ping** of every peer the profile calls into one ✓/✗ list, and prints the command that fixes each ✗.

```bash
aibr ping <peer>
```

`aibr ping` sends a signed no-op job: the peer authenticates it (bearer token and node signature), checks this node is enrolled, completes it without running anything, and reports back to this node's `/report`. It prints the round trip, whether the report arrived (on a node that runs a bridge), and what the peer accepts from this node: its capabilities and allowlisted project directories. `/health` and `aibr status` cannot prove this; a successful ping does.

---

## 6. Sending a Task (`aibr send`)

```bash
aibr send test-vps "Run the full test suite and report any failures." --capability run-tests
```

`aibr send` fills in `job_id`, `source_agent_id`, `target_agent_id`, `callback_url` and the request signature, then waits for the result and prints the summary and findings. `--capability` defaults to the peer's read-only `investigate`; `--project` takes a directory the peer allowlists (or its project id) and defaults to the peer's only project, or the one named like your current git repository. `--no-wait` returns after the job is accepted. A job held for operator approval on the worker is reported with the `aibr approve` command to run there.

From Claude Code, the AIBridge plugin dispatches the same way: `aibr plugin install claude` ([Claude Code orchestrator guide](guides/claude-code-orchestrator.md)).

---

## Next Steps

- [Configuration Guide](guides/configuration.md) — Comprehensive configuration options, allowlists, and permissions.
- [Operations & Deployment](operations/deployment.md) — Production service management via systemd, launchd, and multi-node meshes.
- [Monitoring & Diagnostics](operations/monitoring.md) — Health checks, queue depths, and diagnostic bundles (`aibr bundle`).
- [Operational Troubleshooting](operations/troubleshooting.md) — Resolving HTTP status codes, credential mismatches, and recovery.
- [CLI Reference](reference/cli-reference.md) — Full executable command and option reference.
