# AIBridge Installation and Operator Guide Design

## Goal

Make first-time two-host AIBridge setup succeed without prior knowledge of bearer tokens. The guide will explain how to create one shared token, enter it safely on both hosts, confirm the connection, recover from a 401 response, and rotate a compromised token.

## Scope

The primary reader is an operator connecting two machines over Tailscale. The guide covers the supported CLI profile workflow (`aibr setup`, `aibr start`, and `aibr status`). It does not document the legacy `AIBRIDGE_BEARER_TOKEN` development entry point, add CLI commands, or change runtime authentication behavior.

## Documentation Structure

The README remains the single entry point and gains a task-oriented setup path:

1. **Prerequisites** — Bun, OpenCode, and a connected Tailscale network.
2. **Install AIBridge** — retain the existing package-install instructions.
3. **Create the shared bearer token** — provide a copyable `openssl rand -hex 32` command; state that the exact same value must be entered on both hosts and must not be pasted into config files, terminals shared with others, or source control.
4. **Configure each host** — use `aibr setup --profile <name>` and explicitly identify the bearer-token prompt. Explain that the CLI stores the token in the profile's XDG secrets directory, not in `config.json`.
5. **Start and verify** — start both profiles and use the existing status/health checks. For authentication, send a deliberately incomplete request to the peer's protected `/trigger` endpoint with the shared token: an HTTP 400 proves authentication succeeded and payload validation was reached, while HTTP 401 identifies a token mismatch. This check must not create a job and must not expose a real token.
6. **Operate safely** — retain safety boundaries and explain the distinction between unauthenticated health/status visibility and authenticated trigger/report requests.
7. **Troubleshoot authentication** — table for HTTP 401, wrong profile, unavailable secret file, and a token that differs between hosts. Each row has a concrete corrective action.
8. **Rotate a token** — stop both bridges, remove the write-once `bearer_token` secret on each host, run setup again with a new shared token, then restart and verify. The procedure must warn that both machines must be updated together.

## Content Rules

- Never print a real bearer token in examples. Use `<shared-token>` placeholders.
- Recommend at least 32 random bytes represented as hex; do not claim that the CLI enforces this because it currently accepts any non-empty value.
- Keep all paths profile-aware: `~/.local/share/aibridge/<profile>/secrets/bearer_token` on Linux/XDG defaults.
- Correct the existing configuration reference: bearer tokens are not a `security.bearer_token` JSON field; they are stored separately in the profile secrets directory.
- Describe HTTP 401 as an authentication mismatch, then point readers to the exact matching-token and profile checks.
- Do not recommend storing the token in `config.json`, shell history, or version control.
- State that the current secret file is write-once so rotation is a delete-and-reconfigure operation, not an overwrite.

## Validation

Documentation tests must be extended or adjusted to assert that the README includes:

- a secure token-generation command;
- the same-token-on-both-hosts requirement;
- a post-setup verification step;
- 401 troubleshooting guidance; and
- the write-once token-rotation procedure.

The existing test suite and typecheck must remain green. No production code changes are expected.

## Risks and Non-Goals

Adding an `aibr verify` command is intentionally deferred. It would either require changing the current unauthenticated health endpoint or introducing a new protected endpoint, neither of which is necessary to solve the current documentation gap. If operators continue to encounter 401 responses after following the guide, a separate follow-up can define a dedicated verification command.
