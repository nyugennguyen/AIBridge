---
name: aibr-onboarding
description: Use when onboarding, provisioning, or initializing AIBridge (aibr) on a new node (macOS, Linux, VPS) — guides through tailscale network interface discovery, CSPRNG bearer token generation, project allowlists, local AI agent runtime probes (opencode, claude, codex), launchd/systemd service configuration, and running the interactive aibr setup wizard.
---

# AIBridge Onboarding & Setup Guide (`aibr setup`)

> **Canonical copy:** `.opencode/skills/aibr-onboarding/SKILL.md`. Mirrored to
> `.claude/skills/` and `.agents/skills/` for Claude Code and Codex. Keep byte-identical.

## Overview

AIBridge connects distributed AI agent runtimes (OpenCode, Claude Code, Codex) across a private Tailscale network. 
The interactive onboarding wizard is invoked via:

```bash
aibr setup
```

Instead of sequential stdout readline prompts, `aibr setup` runs an interactive 5-step stepper TUI (or browser-rendered OpenDesign canvas at `Docs/tui/aibridge-setup-wizard.html`).

---

## The 5-Step Onboarding Architecture

```text
[1. Network] ──▶ [2. Security] ──▶ [3. Allowlists] ──▶ [4. AI Runtimes] ──▶ [5. Install & Test]
```

### Step 1: Network & Tailscale Discovery
1. Probe local `tailscaled` daemon socket (`/var/run/tailscaled.sock`).
2. Query Tailscale IPv4 coordinate:
   ```bash
   tailscale ip -4
   ```
   Must belong to `100.64.0.0/10` CGNAT range.
3. Validate port availability:
   - Port `4095`: Ingress router (`aibr-router`)
   - Port `4096`: OpenCode loopback (`opencode serve`)
   - Port `8787`: AIBridge Fastify HTTP bridge

### Step 2: Router Security & Bearer Credentials
1. Listening port defaults to `4095`.
2. Generate a cryptographically secure 128-bit bearer token (32 hex chars;
   `openssl rand -hex 16` is 16 bytes, NOT 32 -- do not write 32 here by mistake):
   ```bash
   openssl rand -hex 16 | awk '{print "aibr_sec_"$1}'
   ```
3. Store config in `~/.config/aibridge/<profile>/config.json` with strict `0600` permissions.
4. Enforce security floor invariants:
   - Constant-time token comparison (mitigates timing side-channels).
   - Strict 2 MB payload cap (prevents memory exhaustion DoS).
   - Automated secret redaction pipeline on stdout and telemetry.

### Step 3: Project Allowlists & Containment Boundaries
1. Declare canonical allowed project directories:
   ```json
   {
     "allowedProjects": [
       "/Users/mac/Projects/AIBrigde",
       "/Users/mac/Projects/paryaj-demo"
     ]
   }
   ```
2. Invariant: Fail-closed subpath containment. Any symlink or file operation resolving outside approved roots returns an immediate `403 Forbidden`.

### Step 4: AI Agent Runtime Diagnostics
1. Test loopback connectivity to OpenCode:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4096/health
   ```
2. Verify Claude Code CLI binary:
   ```bash
   claude --version
   ```
3. Verify Codex CLI binary:
   ```bash
   codex --version
   ```

### Step 5: System Service Installation & Preflight
1. **macOS `launchd`**:
   Install agent to `~/Library/LaunchAgents/com.aibridge.daemon.plist`:
   ```bash
   launchctl load -w ~/Library/LaunchAgents/com.aibridge.daemon.plist
   ```
2. **Linux `systemd`**:
   Install user service to `~/.config/systemd/user/aibridge.service`:
   ```bash
   systemctl --user enable --now aibridge.service
   ```
3. Run verification test:
   ```bash
   aibr verify -p default
   ```
4. Attach client:
   ```bash
   aibr tui
   ```

---

## Interactive Visual Artifacts
- **Interactive Stepper Wizard**: [`Docs/tui/aibridge-setup-wizard.html`](file:///Users/mac/Projects/AIBrigde/Docs/tui/aibridge-setup-wizard.html)
- **TUI Next-Gen Canvas**: [`Docs/tui/aibridge-tui-redesign.html`](file:///Users/mac/Projects/AIBrigde/Docs/tui/aibridge-tui-redesign.html)
- **Logo Design System**: [`Docs/assets/logos/logo-design-system.html`](file:///Users/mac/Projects/AIBrigde/Docs/assets/logos/logo-design-system.html)
