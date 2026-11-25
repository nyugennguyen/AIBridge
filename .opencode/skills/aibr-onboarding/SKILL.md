---
name: aibr-onboarding
description: Use when onboarding, provisioning, or initializing AIBridge (aibr) on a new node (macOS, Linux, VPS) — guides through aibr init (role, runtime, project, pairing code), the launchd/systemd user service started by aibr start, aibr doctor / ping / send for the end-to-end check, and the full aibr setup wizard for everything else.
---

# AIBridge Onboarding (`aibr init`)

> **Canonical copy:** `.opencode/skills/aibr-onboarding/SKILL.md`. Mirrored to
> `.claude/skills/` and `.agents/skills/` for Claude Code and Codex. Keep byte-identical.

## Three commands per machine

```bash
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash   # installs aibr, offers aibr init
aibr init                                                                                           # ≤ 4 questions
aibr doctor                                                                                         # ✓/✗ with a fix per ✗
```

`aibr setup` is a sequence of line prompts in the terminal — there is no stepper TUI
(`runSetupWizard` in `src/cli/setup-wizard.ts`; `StepperFSM` is unused). `aibr init` runs the
same wizard in quickstart mode (`SetupWizardDeps.quickstart`).

## What `aibr init` asks

1. **Role** — `worker` (runs jobs), `orchestrator` (Claude Code dispatches from here), `both`. Flag `--role`.
2. **Runtime** — `opencode` / `claude`, only when both or neither is on `PATH`. Flag `--runtime`.
3. **Project directory** (workers) — default: git root of the cwd; `$HOME`, `/` and ancestors of
   `$HOME` are refused (`projectPathProblem`). Flag `--project`.
4. **Network** — Enter = new network: a worker prints a one-time pairing code (30 min) for the
   next machine; or paste a code to join (`aibr enroll join` code path, `src/cli/enroll.ts`).
   Orchestrators are asked only for the code. Flags `--new` / `--join <code>`.

Defaults, never asked or shown: bearer token (CSPRNG, `0600`), OpenCode password, agent id
(profile name; machine name for `default`), ports 8787/4096, `request_signing: "required"`.
Preflight (role-aware prerequisites, Tailscale `Running` with an IP) runs first; a blocked
init prints the install commands. Non-interactive runs need the flags (`aibr init --help`).

## Running the bridge

```bash
aibr start  -p <profile>              # user service: launchd com.aibridge.<p> / systemd aibridge-<p>.service
aibr start  -p <profile> --foreground # tmux session aibridge-<p> (dev; remain-on-exit)
aibr status -p <profile>              # launchd|systemd|tmux|unmanaged + /health
aibr logs   -p <profile> -f           # ~/.local/state/aibridge/<p>/logs/aibridge.log
aibr stop   -p <profile>              # unload + remove the unit, kill the tmux session
```

The unit runs `aibr serve --profile <p>` by absolute path (`--with-opencode` for OpenCode
workers), with the installing shell's `PATH`/XDG dirs and no secrets. Linux servers need
`sudo loginctl enable-linger $USER` (doctor warns). Router mode (`bridge.ingress_mode: "router"`)
runs `aibr worker --profile <p> --ipc-publish` instead and is advanced/opt-in.

## Proving it works

```bash
aibr doctor -p <profile>                     # verify + status + ping of every agents[] peer
aibr ping <peer> -p <profile>                # signed no-op job; waits for completion and /report
aibr send <peer> "<prompt>" [--capability c] [--project dir|id]
```

`aibr status: healthy` only means `/health` answered (it is unauthenticated). A successful
`aibr ping` proves bearer, signature, `allowed_sources`, and the callback path. `ping` also lists
what the peer accepts from this node and its project directories, which `send` uses as defaults.

## Pairing more machines later

```bash
aibr enroll issue -p <worker-profile> [--capabilities investigate,run-tests]   # on the worker
aibr enroll join <code> -p <profile>                                         # on the other node
aibr enroll list -p <profile>
```

See `Docs/guides/pairing.md` and `Docs/getting-started.md`.
