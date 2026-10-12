import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../app.js"
import type { BridgeConfig } from "../../config/types.js"

/**
 * The work this node ACCEPTS, flattened out of `security.allowed_sources`.
 *
 * WHY `allowed_sources` RATHER THAN `agents`. `agents[]` is the mesh registry —
 * who this node can call — so its capability list describes the tailnet rather
 * than this node, and would turn a discovery probe into topology disclosure.
 * `allowed_sources[].capabilities` is the inbound half: the capability strings
 * `/trigger` will honour for the peers authorized to send them. That is the
 * question discovery actually asks ("what can I hand you?"), and it is bounded
 * by the allowlist rather than by aspiration.
 *
 * WHY FLATTENED, DE-DUPLICATED AND SORTED. Several sources routinely name the
 * same capability, so a raw projection is a list of lists with repeats and a
 * caller comparing two nodes gets an answer that depends on how many allowlist
 * entries happen to mention a capability. A sorted set is the same answer for
 * the same config regardless of key order, which is what makes it comparable
 * across nodes and stable across restarts.
 *
 * The source identities sitting beside these capabilities are NOT carried
 * through — see the route below.
 */
export function acceptedCapabilities(config: BridgeConfig): readonly string[] {
  const capabilities = new Set<string>()
  for (const source of config.security.allowed_sources) {
    for (const capability of source.capabilities) capabilities.add(capability)
  }
  return [...capabilities].sort()
}

export interface HealthResponse {
  readonly ok: boolean
  readonly opencode: boolean
  readonly agent_id: string
  readonly capabilities: readonly string[]
}

export function registerHealthRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  // IDENTITY AND REACHABILITY, ADDED TOGETHER, AND NEVER AN AUTHORIZATION INPUT.
  //
  // Why: `/health` is unauthenticated on purpose because it is what a peer
  // probes during setup-time discovery, before any shared secret has been
  // exchanged. `ok: true` proves only that a daemon answered, and nothing about
  // which node answered — the M0 threat model is explicit that a Tailscale
  // connection provides reachability, NOT identity, so a probe that stopped
  // there left the operator unable to tell a correctly named node from a
  // mis-routed one. `agent_id` closes that gap: a peer that probed one address
  // and reached another learns so, and `aibr setup`'s discovery step can refuse
  // the mismatch instead of trusting the route it took.
  //
  // What this does NOT become. The id is the node's own assertion about itself,
  // read from its own config. No route accepts an `agent_id` from a caller as
  // proof of who that caller is: `/trigger` still resolves `target_agent_id`
  // against the config and the bearer against the shared secret. Publishing a
  // self-description does not promote a Tailscale address into an enrolled
  // identity (threat model SF-01).
  //
  // Why the disclosure is acceptable. In order of weight:
  //
  //   1. `GET /jobs/:id` is ALREADY unauthenticated and returns the stored
  //      trigger verbatim — prompt, `project_dir` filesystem path, callback
  //      URL, source and target agent ids (threat model finding F-03). An
  //      `agent_id` plus a capability name is a strict subset of what an
  //      anonymous caller can already read from this same bridge.
  //   2. Neither value is secret in the first place. `agent_id` is echoed in
  //      this same config's `bridge.public_url` (`http://test-vps.tailnet:8787`)
  //      and in every `/trigger` response as `target_agent_id`; the capability
  //      list is the set of values `/trigger` will accept in `capability`.
  //      Nothing is newly secret here, it is newly in one readable place.
  //   3. The threat model's requirement for health responses is that they
  //      "omit sensitive configuration". This adds no credential, no bearer
  //      token, no project path, no allowed host, and no peer identity: the
  //      flatten above drops the `source_agent_id` beside each capability, so a
  //      probe learns what work kinds this node accepts and not which tailnet
  //      peers it has authorized. `requires_plan_approval` is dropped for the
  //      same reason — it is policy detail with no discovery value.
  //   4. The router made the OPPOSITE call for its own `/health`
  //      (`router/src/routes.rs`: "Behind the bearer like everything else",
  //      because an unauthenticated probe reporting that a process is a live
  //      AIBridge bridge is "reconnaissance with no cost"). That argument is
  //      about `ok: true`, which already answers it and cannot be withdrawn
  //      without deleting discovery, not about the id. A supervisor in front of
  //      the router holds the token, so closing its probe cost nothing; the
  //      engine's route IS the discovery endpoint and is already open, so the
  //      only question here is how much it should say — not whether to say it.
  //
  // `ok` and `opencode` are untouched; this is additive.
  app.get("/health", async (): Promise<HealthResponse> => ({
    ok: true,
    opencode: await dependencies.opencodeClient.health(),
    agent_id: dependencies.config.agent_id,
    capabilities: acceptedCapabilities(dependencies.config),
  }))
}
