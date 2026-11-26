# Pairing nodes

> **Status:** Current
> **Applies to:** AIBridge 3.1.1
> **Owner:** Maintainers

Pairing connects an orchestrator (for example Claude Code on your workstation) to a worker without copying a bearer token by hand. Both nodes exchange ed25519 public keys once and pin them; from then on every `/trigger` and `/report` can be signed and verified. Design: [ADR 0012](../adr/0012-request-signing-and-pairing.md).

## Steps

On the **worker** (its bridge must be running, `bridge.ingress_mode` must be `engine`):

```bash
aibr enroll issue --profile staging --capabilities investigate,run-tests
```

It prints a one-time code (`aibr1-…`), valid for 10 minutes (`--ttl 30m`, at most 24 h). The capabilities are what the joining node may request.

On the **orchestrator** (no bridge needed):

```bash
aibr enroll join aibr1-... --profile dev
```

Or run `aibr setup` with the orchestrator role and paste the code when Step 4 asks.

Afterwards:

- the worker has the orchestrator in `security.allowed_sources[]` with the granted capabilities (no restart needed);
- the orchestrator has the worker in `agents[]`, and the worker's bearer token is stored in `secrets/peers/<worker>.bearer_token` (0600). It is never printed;
- both nodes pinned each other's key in `<state>/identity/peers.json`.

A code works once. An expired or already used code is refused with a message saying which.

## Manage

```bash
aibr enroll list --profile staging            # paired peers and unused codes
aibr enroll revoke dev-main --profile staging # unpin and remove from config
```

Revocation refuses the peer's signed requests immediately. Restart the bridge so its bearer-only requests are refused too.

## Require signatures

`security.request_signing` in `config.json`:

| Value | Effect on `/trigger` and `/report` |
|---|---|
| `off` (or absent) | Signatures ignored; bearer only. Existing profiles. |
| `optional` | Signed requests are verified; unsigned ones are accepted on the bearer. |
| `required` | Unsigned → 401; unpinned or revoked key → 403; replay → 401; `source_agent_id` must match the signing key. New profiles from `aibr setup`. |

The bearer token is still checked as well while `auth_mode` is `bearer-token`. Signing cannot be combined with `ingress_mode: "router"`; the config is rejected.

## Files

| Path | Content |
|---|---|
| `<state>/identity/self.node-key.json` | This node's private key (0600) |
| `<state>/identity/peers.json` | Pinned peer keys and revocations |
| `<state>/identity/enrollment-codes.json` | Hashes of issued codes |
| `<data>/secrets/peers/<id>.bearer_token` | Bearer token received when pairing |
