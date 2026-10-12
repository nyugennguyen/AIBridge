/**
 * Credential-shaped agent ids from a `/health` probe.
 *
 * ## Why this lives in its own module
 *
 * `agent_id` is read out of an UNAUTHENTICATED `/health` response, so it is
 * untrusted input that crosses the network in the response direction. Two
 * surfaces print it — the `aibr discover` table and the `aibr setup` enrolment
 * roster — and both were carrying their own copy of this guard. Duplicated
 * security logic is the kind that survives a review because each copy reads as
 * deliberate, and then one of them is edited and the other is not. This is the
 * single place the rule is stated; both callers import it.
 *
 * ## Why the guard exists at all
 *
 * A `tskey-…` value is a reusable node-enrollment credential — the same class
 * of secret `src/memory/redaction/detectors.ts` scrubs from durable memory.
 * Echoing one into a terminal launders it into a scrollback, a screenshot and
 * whatever the operator pastes it into next. The Tailscale daemon's raw
 * `tailscale status --json` never reaches either caller (see
 * `src/host/tailscale-discovery.ts`); this is the second, independent guard, over
 * the only field that crosses the network in a response.
 *
 * ## Why the answer is `null` and not a redaction string
 *
 * `null` routes the peer onto the "answered but did not identify itself" path,
 * where the operator has to type an agent ID by hand, out of band from whoever
 * owns that machine. A masked string would still be a peer naming itself, and
 * "tskey-…<redacted>" reads as an identified node rather than as an unknown one.
 * `null` is the honest answer: we were not told.
 */

const TSKEY_PREFIX = /^tskey-/i

/**
 * Deliberately looser than the redaction corpus rule in
 * `src/memory/redaction/detectors.ts`, which requires a `{20,}` body.
 *
 * Here a near miss is still a miss worth taking, because the cost of the false
 * positive is one peer reported as unidentified — recoverable, and the safe
 * direction — while the cost of the false negative is a credential on screen.
 */
export function isCredentialShapedAgentId(agentId: string | null): boolean {
  return agentId !== null && TSKEY_PREFIX.test(agentId)
}

/** Drop a credential-shaped `agentId`, answering `null` instead. */
export function scrubCredentialShapedAgentId(agentId: string | null): string | null {
  return isCredentialShapedAgentId(agentId) ? null : agentId
}
