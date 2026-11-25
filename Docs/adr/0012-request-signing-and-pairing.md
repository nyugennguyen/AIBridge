# ADR 0012: Node Request Signing for `/trigger` and `/report`, and Pairing

- **Status:** Accepted
- **Date:** 2026-11-25
- **Related:** `Docs/implementation-plans/claude-adapter-and-plugin.md` Phase 3, `Docs/implementation-plans/installation-ux-review.md` §4.2 (C3), [ADR 0008](./0008-polyglot-ingress-and-admission.md)

## Context

`/trigger` and `/report` were authenticated by one shared bearer token. Anyone holding it could act as any `source_agent_id`, revoking one peer meant rotating the token everywhere, and pairing two machines meant copying the token by hand. The mesh layer (`src/mesh/identity/`) already had ed25519 node keys, one-time enrollment codes, peer key pins, a replay guard and a verifier used by the mesh gateway.

## Decision

1. **Config `security.request_signing: "off" | "optional" | "required"`.** Absent means `off`, so every existing profile keeps its meaning. `aibr setup` writes `required` for new profiles only.
   - `optional`: a request with signature headers is verified and refused if bad; an unsigned one is accepted on its bearer.
   - `required`: unsigned → 401, a key that is not pinned (or was revoked) → 403, a replay → 401 from the replay guard, and the body's `source_agent_id` must equal the verified key's enrolled agent id (403 otherwise).
2. **Bearer stays required as well** (defence in depth) while `auth_mode` is `bearer-token`. `auth_mode: "none"` with `request_signing: "required"` is signature-only.
3. **Same crypto as the mesh.** Headers `x-aibridge-mesh-*`, `signMeshRequest`, `authenticateForRequest` and `MeshIdentityProvider` (revocation → trust → pin → ed25519 → nonce) are reused unchanged. The node-id header only selects which pinned key must verify the signature. Pins, trust and revocations live in `<stateDir>/identity/peers.json` and are re-read per request, so `aibr enroll revoke` takes effect without a restart. One replay guard (in memory, 5 min + 30 s window) is shared by both routes.
4. **Clients sign when they have a key**: the callback reporter (per delivery attempt, so retries are fresh requests) and the Claude Code plugin's MCP client. The key is `<stateDir>/identity/self.node-key.json` (0600 in a 0700 directory).
5. **Pairing replaces token copying.** `aibr enroll issue` (worker) prints `aibr1-…` = worker URL + one-time secret + worker key id. `aibr enroll join` (orchestrator) POSTs `/enroll` signed with its own key (proof of possession). The worker consumes the code (one use, TTL default 10 min, max 24 h), pins the orchestrator, adds `allowed_sources[]` (on disk and in the live config), and answers with its key, agent id, granted capabilities and bearer token, signed with its key. The orchestrator checks the key id against the code, verifies the signature, pins the worker, writes `agents[]` and stores the token at `secrets/peers/<id>.bearer_token` (and `secrets/bearer_token` when absent). `/enroll` is on the bridge's normal (tailnet-bound) listener, has no bearer (the code is the credential) and is rate limited (5/min per address, 20/min overall).
6. **Router mode: refused, not ported (option c).** With `bridge.ingress_mode: "router"`, `aibr-router` admits `/trigger` on the bearer alone and does not carry signature headers into its admission record. Porting verification to Rust, or persisting headers for the worker to verify, is a larger change with contract parity. Instead, `request_signing` other than `off` combined with `ingress_mode: "router"` is rejected by the TypeScript schema and by `aibr-router` at config load. Pairing (`/enroll`) is likewise engine-only.

## Consequences

- A paired orchestrator can only send work as itself; revocation is per peer.
- A worker in `required` mode refuses peers enrolled by hand until they pair.
- The orchestrator's node key is readable by the OS user that runs Claude Code. Claude could sign requests directly; what it can do on a worker is still bounded by the worker's `allowed_sources[]` and capability profiles (threat model note).
- Deferred: router-mode verification; per-peer bearer tokens on the receiving side (a node that already has its own token and receives `/report` from a paired worker using a different token still needs one shared token); key rotation without re-pairing.
