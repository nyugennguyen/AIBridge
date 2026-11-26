# Claude Code as Orchestrator

> **Status:** Current  
> **Applies to:** AIBridge 3.1.1  
> **Owner:** Maintainers  

The AIBridge Claude Code plugin lets a Claude Code session on your workstation hand work (integration tests, bug reproduction, log reading, fixes on a branch) to remote AIBridge worker nodes, then read the results and continue locally. The plugin adds an MCP server, a dispatch skill, two slash commands and a SessionStart summary.

## Install

Prerequisites: Claude Code 2.1.x or newer on `PATH`, `aibr` on `PATH`, and an AIBridge profile with at least one enrolled peer in `agents[]`.

Install with `aibr plugin install claude` (flags: `--scope user|project|local`, default `user`; `--marketplace bundled|github`, default `bundled`). It checks `claude --version`, registers the marketplace shipped inside the npm package, and installs `aibridge@aibridge`. It is idempotent and never edits `~/.claude*` files. `aibr plugin status claude` shows version, scope and state; `aibr plugin uninstall claude` removes it.

Exit codes: `2` means `claude` is not installed; `3` means Claude Code is too old for `claude plugin` and the manual `/plugin marketplace add <path>` and `/plugin install aibridge@aibridge` steps are printed instead.

For a single session without installing, run `claude --plugin-dir plugins/aibridge` from a checkout.

## Configure

The plugin has one option, `profile`: the AIBridge profile name. Leave it empty to use the only existing profile. Resolution order is the `--profile` argument, then `AIBR_PROFILE`, then the only profile on disk; with several profiles and none selected, tools return a clear error.

The MCP server reads `config.json` (own `agent_id`, `bridge.public_url`, `agents[]`) and the bearer token in `<data>/aibridge/<profile>/secrets/bearer_token` at call time (a per-peer token written by `aibr enroll join` in `secrets/peers/<id>.bearer_token` takes precedence). When the profile has a node key (created by pairing), every request is signed with it; see the [Pairing Guide](pairing.md). Tokens and key material are never placed in tool output or errors.

Optional hardening: `aibr plugin install claude --deny-secrets` asks for confirmation and then prints deny rules for `~/.claude/settings.json` that keep Claude's file tools away from AIBridge secrets. It never writes them for you; plugins cannot ship permission rules.

## Use

Tools exposed to the model: `bridge_peers`, `bridge_dispatch`, `bridge_status`, `bridge_result`, `bridge_await` (at most 120 s per call; the skill loops), `bridge_events` (a job's status changes, messages, tool use and result, a page at a time) and `bridge_cancel` (ends a job this node dispatched: `failed`, `cancelled by requester`). There is deliberately no approve, reject or stop-all tool: approval and the node-wide kill switch stay with the operator (ADR 0015).

`bridge_events` and `bridge_cancel` need signed requests: the worker only shows and cancels the jobs whose verified signer dispatched them, so this machine must be paired with the worker (`aibr enroll`) and the worker must have `security.request_signing` set to `optional` or `required`. A worker running an older aibr answers `not_supported`.

Typical flow, driven by the `aibridge-dispatch` skill or `/aibridge:bridge-send <peer> <capability> <task>`:

1. `bridge_peers` to see reachable peers and their capabilities.
2. Push the branch; include branch and commit sha in the prompt.
3. `bridge_dispatch`, then `bridge_await` in a loop, then `bridge_result`.
4. Read the findings and fix locally.

`/aibridge:bridge-status [job_id] [peer]` gives a snapshot. A dispatch denied with `approval_required` must not be retried: ask the operator to approve it with the operator CLI.

Each session starts with a short summary (at most five lines: peer reachability and running jobs) produced by `aibr mcp summary`, with a 5 second timeout; failures are silent.
