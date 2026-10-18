# Deployment & Operations Guide

> **Status:** Current  
> **Applies to:** AIBridge 3.0.0  
> **Owner:** Maintainers  

This guide covers deployment topologies, platform supervisor configurations (systemd and launchd), headless tmux management, and two-tier service operation.

---

## 1. Topologies

### Two-Machine Starter Topology
A common configuration pairs a local developer workstation (`dev-main`) with a dedicated remote test runner or VPS (`test-vps`):

- **`dev-main` (Workstation):** Initiates task dispatches, hosts the Herdr presentation manager, and monitors test feedback.
- **`test-vps` (Execution Runner):** Runs the admission router, background worker, and OpenCode daemon inside allowlisted repository checkouts.

### Multi-Node Mesh Federation
In larger deployments, N nodes participate in a mesh. Each node defines:
- **`security.allowed_sources`**: Who is authorized to dispatch work to this node and with which capabilities.
- **`agents[]`**: Which remote nodes this machine is permitted to trigger.

---

## 2. Process Supervision

### 2.1 Headless tmux Sessions (Default)

Launch the managed session using:

```bash
aibr start --profile <name>
```

This launches a detached tmux session named `aibridge-<profile>` with separate windows for `opencode` and `aibridge`.

To inspect or attach:

```bash
tmux attach -t aibridge-<profile>
```

To stop the session:

```bash
tmux kill-session -t aibridge-<profile>
```

### 2.2 macOS launchd Integration

`aibr setup` generates user agent launchd definitions located at:
`~/Library/LaunchAgents/com.aibridge.<profile>.plist`

Manage the service using `launchctl`:

```bash
# Load and start service
launchctl load ~/Library/LaunchAgents/com.aibridge.<profile>.plist

# Stop and unload service
launchctl unload ~/Library/LaunchAgents/com.aibridge.<profile>.plist
```

### 2.3 Linux systemd Integration

On Debian/Ubuntu Linux systems, systemd user services are written to:
`~/.config/systemd/user/aibridge-<profile>.service`

Manage via `systemctl --user`:

```bash
# Reload systemd configuration
systemctl --user daemon-reload

# Enable on boot and start immediately
systemctl --user enable --now aibridge-<profile>.service

# Inspect service logs
journalctl --user -u aibridge-<profile>.service -f
```

---

## 3. Two-Tier Admission & Worker Operations

AIBridge separates HTTP ingress admission from task execution:

```
[HTTP Request] ──▶ [aibr-router (Rust)] ──Commit WAL──▶ [ingress_outbox.db] ◀──Claim Lease── [aibr worker (TS)]
```

### Initializing the Admission Store
The native Rust router requires the SQLite admission queue (`ingress_outbox.db`) to exist prior to serving traffic:

```bash
aibr-router --init-store
```

### Validating Router Configuration
Run preflight checks to verify network interfaces, port availability, and database access:

```bash
aibr-router --preflight
```

### Starting the Background Execution Worker
The worker daemon drains admitted requests from `ingress_outbox.db` and delegates work to agent runtimes:

```bash
aibr worker --profile <profile>
```

To expose the local Unix domain socket IPC bus for presentation tools:

```bash
aibr worker --profile <profile> --ipc-publish
```

---

## 4. Maintenance & Operations

### Updating AIBridge

```bash
# Update global CLI package
bun install -g @nyugennguyen/aibridge

# Restart existing sessions
tmux kill-session -t aibridge-<profile>
aibr start --profile <profile>
```

### Uninstallation & Profile Cleanup

AIBridge strictly separates application package removal from configuration, credentials, and state data.

#### Removing the Application Package (Recommended Default)

For standard upgrades, toolchain changes, or uninstallation, **package-only removal is the default and recommended action**. It uninstalls the executable while preserving your profiles, tokens, and database logs:

```bash
bun remove -g @nyugennguyen/aibridge
```

> [!NOTE]
> Removing the global package uninstalls only the `aibr` executable and its npm dependencies. It leaves all user profiles, configuration files, shared bearer tokens, task history, and SQLite databases intact.
> AIBridge does not provide an automated CLI command for deleting profiles or purging data (`aibr` does not implement an uninstall or profile-deletion subcommand). Data removal must be performed manually and intentionally.

#### Identifying Resolved Paths & XDG Overrides

AIBridge adheres to the XDG Base Directory specification on both macOS and Linux (`src/host/paths.ts`). Paths resolve as follows:

- **Configuration:** `${XDG_CONFIG_HOME:-$HOME/.config}/aibridge`
- **Secrets & Data:** `${XDG_DATA_HOME:-$HOME/.local/share}/aibridge`
- **State (Jobs & Event WAL):** `${XDG_STATE_HOME:-$HOME/.local/state}/aibridge`

*(Note: Per the XDG specification and `src/host/paths.ts`, if any XDG variable is unset, empty, or set to a relative path, AIBridge falls back to the default path under `$HOME`. The listed paths `~/.config/aibridge`, `~/.local/share/aibridge`, and `~/.local/state/aibridge` represent default locations when no XDG environment variables are overridden. If your environment sets custom absolute XDG base directories, substitute your custom paths accordingly).*

To inspect the resolved directory paths in your active shell:

```bash
echo "Config: ${XDG_CONFIG_HOME:-$HOME/.config}/aibridge/<profile>"
echo "Data:   ${XDG_DATA_HOME:-$HOME/.local/share}/aibridge/<profile>"
echo "State:  ${XDG_STATE_HOME:-$HOME/.local/state}/aibridge/<profile>"
```

#### Profile Decommissioning (Narrowly Scoped)

To decommission a specific profile (e.g. `<profile>`) without affecting other profiles on the machine:

1. **Stop active services:** Ensure tmux sessions and supervisor services for the profile are terminated:
   ```bash
   tmux kill-session -t aibridge-<profile>
   # If using systemd (Linux): systemctl --user stop aibridge-<profile>.service
   # If using launchd (macOS): launchctl unload ~/Library/LaunchAgents/com.aibridge.<profile>.plist
   ```
2. **Inspect and back up data:** Review the files before deletion. Archive any audit databases or tokens you may need to preserve:
   ```bash
   # Default paths shown; adjust if using XDG overrides
   ls -la "${XDG_CONFIG_HOME:-$HOME/.config}/aibridge/<profile>/"
   ls -la "${XDG_DATA_HOME:-$HOME/.local/share}/aibridge/<profile>/secrets/"
   ls -la "${XDG_STATE_HOME:-$HOME/.local/state}/aibridge/<profile>/"
   ```
3. **Remove profile directories:**
   ```bash
   rm -r "${XDG_CONFIG_HOME:-$HOME/.config}/aibridge/<profile>"
   rm -r "${XDG_DATA_HOME:-$HOME/.local/share}/aibridge/<profile>"
   rm -r "${XDG_STATE_HOME:-$HOME/.local/state}/aibridge/<profile>"
   ```

#### Destructive Complete Data Removal

> [!CAUTION]
> **Irreversible Action:** The commands below permanently delete **all** AIBridge profiles, network configurations, cryptographic bearer secrets, job logs, and SQLite event stores on this system. Do NOT run these commands unless you intend to completely wipe all AIBridge data.

Before proceeding, verify the contents of each directory and create backups if necessary:

| Directory Role | Default Path (When XDG Unset) | Resolved Location | Contents |
|---|---|---|---|
| **Configuration** | `~/.config/aibridge/` | `${XDG_CONFIG_HOME:-$HOME/.config}/aibridge` | Profile configurations (`config.json`), project allowlists, network addresses, and peer definitions. |
| **Secrets & Data** | `~/.local/share/aibridge/` | `${XDG_DATA_HOME:-$HOME/.local/share}/aibridge` | Cryptographic bearer tokens (`secrets/bearer_token`) and local runtime credentials. |
| **Persistent State** | `~/.local/state/aibridge/` | `${XDG_STATE_HOME:-$HOME/.local/state}/aibridge` | Ingress outbox WAL (`ingress_outbox.db`), authoritative event stores (`events.db`), and job records. |

After inspecting and backing up needed data, remove all user data directories:

```bash
# 1. Verify the paths first:
ls -d "${XDG_CONFIG_HOME:-$HOME/.config}/aibridge" \
      "${XDG_DATA_HOME:-$HOME/.local/share}/aibridge" \
      "${XDG_STATE_HOME:-$HOME/.local/state}/aibridge"

# 2. Permanently remove all data directories:
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/aibridge"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/aibridge"
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/aibridge"
```
