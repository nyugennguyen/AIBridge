# AIBridge v2 (AiBR-V2)

[![CI](https://github.com/nyugennguyen/AIBridge/actions/workflows/ci.yml/badge.svg)](https://github.com/nyugennguyen/AIBridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun Version](https://img.shields.io/badge/Bun-%3E%3D1.3.0-black.svg)](https://bun.sh)
[![Rust Version](https://img.shields.io/badge/Rust-1.94-orange.svg)](https://www.rust-lang.org)

**AiBR-V2** is a resilient, polyglot orchestrator and agent mesh connecting OpenCode and local execution daemons securely across machines over private Tailscale networks.

AiBR-V2 replaces traditional monolithic bridge architectures with a **two-tier polyglot architecture**: a native Rust ingress router (`aibr-router`) for low-overhead, fail-closed admission and durable queuing, paired with a TypeScript/Bun worker daemon (`aibr worker`) for semantic task execution, rule evaluation, and distributed orchestration.

The first supported topology is two machines:

- `dev-main`: development workstation that triggers remote work.
- `test-vps`: testing VPS that creates a fresh opencode session, runs the requested task, and reports back.

The bridge keeps the design ready for a future N-machine mesh through explicit registry, routing, job store, auth, plan review, and permission policy boundaries.

---

## Architecture Overview

```
                      Private Tailscale Network (100.64.0.0/10)
                                      │
                         HTTP/JSON POST /trigger
                                      ▼
             ┌─────────────────────────────────────────────────┐
             │       Tier 1: aibr-router (Native Rust)         │
             │─────────────────────────────────────────────────│
             │ • Binds tailscale0:8787 (4-layer preflight)    │
             │ • Constant-time Bearer authentication (subtle)  │
             │ • Bounded inflight concurrency (cap: 64)        │
             │ • Payload body limit (1 MiB ceiling)            │
             │ • Structural validation & envelope checks       │
             └───────────────────────┬─────────────────────────┘
                                     │ Commit before 202
                                     ▼
                      ┌──────────────────────────────┐
                      │    Durable SQLite Queue      │
                      │  (ingress_outbox, WAL mode)  │
                      └──────────────┬───────────────┘
                                     │ Drain via claim lease
                                     ▼
             ┌─────────────────────────────────────────────────┐
             │       Tier 2: aibr worker (Bun / TypeScript)     │
             │─────────────────────────────────────────────────│
             │ • Sole semantic authorization authority         │
             │ • Source authorization & project allowlists     │
             │ • Plan review & safety policy enforcement       │
             │ • Reusable workflows & deterministic rules      │
             │ • Multi-project memory & secret redaction       │
             │ • Durable egress callback outbox                │
             └───────────────────────┬─────────────────────────┘
                                     │ Loopback only (127.0.0.1:4096)
                                     ▼
             ┌─────────────────────────────────────────────────┐
             │            Local OpenCode Instance              │
             └─────────────────────────────────────────────────┘
```

### Core Design Invariants
1. **Two-Tier Validation:** The router is a structural gate, never an authorization authority. The worker independently re-parses and enforces all semantic permissions, allowlists, and approvals.
2. **Commit Before 202 (`SF-08`):** An admission response (`HTTP 202 Accepted`) is emitted **only** after the work has been durably committed to SQLite disk storage (`synchronous=FULL`). No in-memory queues or fallback drop-paths exist.
3. **Decoupled Interactive TUI:** The terminal interface (`aibr tui`) runs independently of running background agents and daemons. Disconnecting or closing the UI never disrupts active agent runs.
4. **Append-Only Immutability:** Authoritative event logs are immutable. Repair and maintenance tools never rewrite or delete history.
5. **Terminal Outbox Rows are Evidence:** Errored or failed outbox records are preserved as permanent audit evidence with error taxonomy codes and attempt counters. They are never purged to "clear a backlog."
6. **Automated Secret Redaction:** Prompts, transcripts, raw memory, bearer tokens, and private paths are scrubbed by default across all logs, telemetry, and diagnostics support bundles.

---

## Supported Platforms

AIBridge is tested on:

- **macOS** (Apple Silicon `aarch64` and Intel `x86_64`)
- **Debian / Ubuntu** Linux (`x86_64` and `aarch64`)

Other platforms are not supported. The `aibr setup` command will refuse to run on unsupported systems.

---

## Requirements

Before installing AIBridge, ensure every participating machine has:

| Requirement | Notes |
|---|---|
| [Bun](https://bun.sh) >= 1.3.0 | Install from the official installer at bun.sh. |
| [tmux](https://github.com/tmux/tmux) | Used for process supervision. `aibr setup` can install it via Homebrew (macOS) or apt (Debian/Ubuntu) with your confirmation. |
| [opencode](https://opencode.ai) | `aibr setup` can install it via `bun install -g opencode-ai` with your confirmation. Bound strictly to loopback `127.0.0.1`. |
| [Tailscale](https://tailscale.com) | Must be installed, logged in, and authenticated. The bridge binds to your Tailscale IPv4 address — it is never exposed to the public Internet. |

---

## Install

One-liner (macOS / Debian / Ubuntu, requires Tailscale):

```bash
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash
# non-interactive (CI):
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash -s -- --yes
```

The installer will:
1. Detect OS (macOS / Debian / Ubuntu) — refuses unsupported platforms.
2. Check `bun >=1.3.0` (prompts to install from bun.sh if missing), `tmux`, `opencode`, `tailscale`.
3. Prompt before any `brew`/`apt-get` install (bypass with `--yes`).
4. Run `bun install -g @nyugennguyen/aibridge` (or `@<version>` via `AIBRIDGE_VERSION`).
5. Verify `aibr --version` and that `$(bun pm bin -g)` is on `PATH`.
6. Warn if `tailscale status` is not `Running`.

Manual fallback:

```bash
bun install -g @nyugennguyen/aibridge
aibr --version
```

Verify the `aibr` command is on your PATH:

```bash
aibr --version
```

If `aibr` is not found, add the global Bun bin directory to your shell profile:

```bash
# Check where Bun installs globals
bun pm bin -g

# Add to your shell profile (e.g. ~/.bashrc, ~/.zshrc)
export PATH="$(bun pm bin -g):$PATH"
```

---

## Setup

### Create and share the bearer token

AIBridge uses one shared bearer token to authenticate requests between the two hosts. Generate it once on a trusted machine:

```bash
openssl rand -hex 32
```

Save the value in an approved secret channel, such as a password manager or encrypted message. Enter that exact same value when `aibr setup` prompts for the bearer token on **both machines**. Both machines must use the same token.

Do not put it in `config.json`, shell history, or source control. It is not stored in `config.json`. The bearer token is stored as `~/.local/share/aibridge/<profile>/secrets/bearer_token` by default (or beneath your configured XDG data directory).

Run the interactive setup wizard on each machine:

```bash
aibr setup --profile <name>
```

For example, on your development workstation:

```bash
aibr setup --profile dev-main
```

And on your testing VPS:

```bash
aibr setup --profile test-vps
```

The wizard will:

1. **Check prerequisites** — verify tmux, opencode, and Tailscale are installed. If anything is missing, it shows the exact install command and asks for your confirmation before running it.
2. **Verify Tailscale** — confirm Tailscale is logged in and extract your machine's Tailscale IPv4 address and MagicDNS hostname.
3. **Collect configuration** — prompt for agent ID, project paths, peer addresses, bearer token, and OpenCode password. Secrets are masked during input.
4. **Validate and save** — write a Zod-validated JSON config and secrets file to your XDG directories with owner-only permissions.

Setup does **not** start any services. When it completes, it tells you the next command to run.

### XDG Profile Locations

Profile data is stored in XDG-compliant directories:

| Data | Location |
| --- | --- |
| Config | `~/.config/aibridge/<profile>/config.json` |
| Secrets | `~/.local/share/aibridge/<profile>/secrets/` |
| State (jobs, tasks) | `~/.local/state/aibridge/<profile>/` |

Override with `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, or `XDG_STATE_HOME` environment variables.

All directories are created with `0700` permissions (owner-only). Config and secret files use `0600` permissions. The setup wizard refuses to overwrite an existing profile without explicit confirmation.

---

## Start

Start the bridge and opencode on each machine:

```bash
aibr start --profile <name>
```

This creates a tmux session named `aibridge-<profile>` with two windows:

- **opencode** — runs `opencode serve --port 4096 --hostname 127.0.0.1` (loopback only)
- **aibridge** — runs the AIBridge daemon bound to your Tailscale IPv4 address

The OpenCode server is always bound to `127.0.0.1` — it is never accessible from the network. The bridge is bound to your Tailscale address — it is accessible only within your tailnet, never from the public Internet.

If the session already exists, `aibr start` reports it is already running without error.

### Attach to the session

```bash
tmux attach -t aibridge-<name>
```

Detach with `Ctrl+B, D`.

---

## Status

Check whether the bridge is healthy:

```bash
aibr status --profile <name>
```

This reports:

- `healthy` — tmux session exists and the bridge health endpoint responds.
- `session_missing` — the tmux session is not running.
- `bridge_unavailable` — the tmux session exists but the bridge is not responding.

---

## Verify Cross-Host Authentication

`aibr status` confirms that the local bridge is reachable, but `/health` does not require a bearer token. To verify that the two hosts share the same token without putting it in shell history, read it into a temporary shell variable, then send a deliberately incomplete request to the peer's protected trigger endpoint. Paste the token at the hidden prompt and press Enter:

```bash
read -rs AIBRIDGE_TOKEN
printf '\n'
curl -i -X POST http://test-vps.tailnet:8787/trigger \
  -H "Authorization: Bearer $AIBRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
unset AIBRIDGE_TOKEN
```

An `HTTP 400` response means authentication succeeded and AIBridge rejected only the intentionally incomplete request body. An `HTTP 401` response means the token is missing or does not exactly match the token saved on the peer. This request cannot create a job.

---

## CLI Command Reference (`aibr`)

```bash
aibr <command> [options]
```

### Commands

| Command | Description | Profile Required |
|---|---|:---:|
| `aibr setup` | Interactive profile setup wizard (XDG directories, permissions). | Optional |
| `aibr start` | Launches opencode and bridge inside detached tmux windows. | **Yes** |
| `aibr worker` | Starts the Tier 2 ingress drain worker (no listener). | **Yes** |
| `aibr serve` | Runs the bridge HTTP server directly (engine or shadow mode). | **Yes** |
| `aibr status` | Checks process health, queue depth, and probe connectivity. | **Yes** |
| `aibr tui` | Opens the full-screen interactive agent orchestrator TUI. | **Yes** |
| `aibr bundle` | Generates a redacted diagnostic support bundle. | **Yes** |

### Global Options
- `--profile, -p <name>`: Profile name (required for start/serve/worker/status/tui).
- `--preview`: Preview support bundle without exporting raw JSON.
- `--shadow-mode`: Runs engine in shadow mode, mirroring traffic to the router.
- `--help, -h`: Displays help output.
- `--version, -v`: Displays version.

---

## Two-Host Configuration

Configure both machines in order:

1. **Set up machine A** (e.g. `dev-main`): `aibr setup --profile dev-main`
2. **Set up machine B** (e.g. `test-vps`): `aibr setup --profile test-vps`
3. **Share the bearer token** through an approved secret channel (e.g. password manager, encrypted message). Both machines must use the same token.
4. **Start machine A**: `aibr start --profile dev-main`
5. **Start machine B**: `aibr start --profile test-vps`

Each machine's config includes a `security.allowed_sources` list that declares which remote agents can trigger it and which capabilities they can request. The peer URL uses the Tailscale MagicDNS name (e.g. `http://test-vps.tailnet:8787`).

---

## Trigger Flow

`dev-main` sends a request to `test-vps`:

```bash
curl -X POST http://test-vps.tailnet:8787/trigger \
  -H 'Authorization: Bearer replace-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "job_id": "job_1",
    "source_agent_id": "dev-main",
    "target_agent_id": "test-vps",
    "capability": "testing",
    "project_dir": "/srv/apps/app-under-test",
    "prompt": "Run tests and report failures.",
    "callback_url": "http://dev-main.tailnet:8787/report",
    "timeout_seconds": 1800,
    "metadata": {
      "plan_status": "approved",
      "plan_reference": ".omo/plans/test-vps-qa.md"
    }
  }'
```

AIBridge validates auth, source authorization, project allowlist, and Plan Annotator metadata before creating an opencode session.

---

## Cross-Machine Dependencies

A trigger can wait for work owned by another AIBridge machine without creating a local placeholder job. Keep existing local job IDs as strings and use an explicit object for a remote dependency:

```json
{
  "depends_on": [
    "local-job-id",
    { "agent_id": "test-vps", "job_id": "remote-test-job" }
  ]
}
```

The waiting job remains blocked until every dependency completes. The remote machine sends its terminal report to the stored `callback_url` with the configured bearer token. The receiving machine accepts a report only when its `target_agent_id` matches the local agent and its `source_agent_id` is allowlisted. A completed remote dependency starts newly ready work; a failed or timed-out remote dependency fails the waiting job.

---

## Configuration Reference

Example configs live in `config/`:

- `config/dev-main.example.json`
- `config/test-vps.example.json`

These are reference examples only. Use `aibr setup` to create your actual profiles.

Important fields:

- `security.auth_mode`: currently always `"bearer-token"`; the actual token is kept in the separate profile secrets file, not in this JSON configuration.
- `security.allowed_sources`: declares which source agents can trigger this agent and which capabilities they can request.
- `projects[].path`: allowlisted remote project directories. Trigger requests cannot run outside these paths.
- `planning.require_approval_for`: capabilities that require approved Plan Annotator metadata.
- `permissions`: controls opencode permission replies. Unknown tools are rejected by default.

---

## Troubleshoot Bearer-Token Authentication

| Symptom | Cause | Fix |
| --- | --- | --- |
| `HTTP 401` from `/trigger` or `/report` | The supplied token is missing or differs from the peer's token. | Compare the token saved for the selected profile on both machines and enter the exact same value during setup. |
| `bearer_token` file is missing | Setup did not complete for the selected profile, or the profile data was removed. | Run `aibr setup --profile <name>` again and provide the shared token. |
| The wrong profile starts | The command's `--profile` value does not match the profile configured for that host. | Use `aibr status --profile <name>` to identify the running profile, then start or set up the intended profile. |
| `aibr status` is healthy but protected requests return `HTTP 401` | The health endpoint does not require authentication. | Use the cross-host verification request above and correct the token mismatch on both machines. |

---

## Rotate a Bearer Token

The bearer-token secret is write-once. To rotate a compromised token:

1. Stop AIBridge on both machines.
2. Remove `~/.local/share/aibridge/<profile>/secrets/bearer_token` (or the equivalent path beneath your configured XDG data directory) on both machines.
3. Run `aibr setup --profile <name>` again on both machines with one new shared token.
4. Restart both profiles and repeat the authentication verification.

Update both machines together; leaving one host on the old token causes `HTTP 401` responses.

---

## Subsystem Highlights

### 1. Hardened Operational Recovery & Database Repair (M8.1 / M8.2)
- **Comprehensive Runbooks:** Documented recovery for 16 failure modes (`Docs/runbooks/failure-mode-recovery.md`).
- **Verified Backups:** Online backups via SQLite WAL truncation (`createDatabaseBackup()`) verify integrity before declaring success.
- **Atomic Restoration:** Safe database restores (`restoreDatabaseFromBackup()`) stage writes in temporary files and retain automatic pre-restore backups for emergency rollback.
- **Evidence Retention:** Errored outbox records in `ingress_outbox` and `egress_outbox` are preserved permanently for forensic inspection.

### 2. Structured Observability & Diagnostics (M8.3 / M8.4)
- **Structured Logging:** Standardized log events (`ingress.admitted`, `outbox.claimed`, `lease.expired`) with correlation tracing fields.
- **Metrics Telemetry:** Built-in metrics registry tracking admission rates, queue depth, oldest pending age, and projection latencies.
- **Support Bundle Generator:** Generate sanitized support bundles for issue diagnosis:
  ```bash
  aibr bundle --profile <name> --preview
  ```

### 3. Upgrade and Rollback Framework (M8.6)
- **Preflight Planning:** Detects required schema migrations and refused downgrade conditions.
- **Atomic Rollback:** Schema upgrades take a verified pre-migration backup; any interruption or failure automatically restores the pre-upgrade state.
- **Downgrade Refusal:** Refuses to run older binaries over newer schemas without manual operator intervention.

### 4. Extension SDK & Conformance Kit (M8.7)
AIBridge features a public extension SDK (`src/sdk/`) allowing third-party developers to create custom agent runtime adapters and terminal backends:
- **Clean Contracts:** Access to `AgentRuntimeAdapter`, `TerminalBackend`, and `TerminalChannel` without importing internal engine internals.
- **Conformance Test Runner:** Run `runAdapterConformance(adapter)` or `runTerminalBackendConformance(backend)` to verify contract compliance.
- **Extension Registry:** Enforces semver major compatibility checks at startup (`ExtensionRegistry`).

---

## Update

```bash
bun install -g @nyugennguyen/aibridge
```

Restart any running profiles after updating:

```bash
# Stop the existing tmux session
tmux kill-session -t aibridge-<name>

# Start with the new version
aibr start --profile <name>
```

---

## Uninstall

```bash
# Remove the global package
bun remove -g @nyugennguyen/aibridge

# Remove profile data (optional)
rm -rf ~/.config/aibridge
rm -rf ~/.local/share/aibridge
rm -rf ~/.local/state/aibridge
```

---

## Maintainer and Release Verification

Run the full verification gate before releasing:

```bash
bun run release:check
```

This verifies:
1. Frozen lockfile installation
2. TypeScript compilation (`dist/`)
3. Vitest test suite execution
4. Typecheck (`tsc --noEmit`)
5. Shellcheck and syntax validation of install scripts
6. CLI help and dry-run packaging

---

## License

MIT License. See [LICENSE](LICENSE) for details.
