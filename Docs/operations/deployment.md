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

## 4. Updates & Maintenance

### Updating AIBridge

```bash
# Update global CLI package
bun install -g @nyugennguyen/aibridge

# Restart existing sessions
tmux kill-session -t aibridge-<profile>
aibr start --profile <profile>
```

### Uninstallation

```bash
# Remove global npm package
bun remove -g @nyugennguyen/aibridge

# Remove profile configuration, secrets, and database state
rm -rf ~/.config/aibridge
rm -rf ~/.local/share/aibridge
rm -rf ~/.local/state/aibridge
```
