/**
 * M4.7's route, for the parts of it that are PURE.
 *
 * `./route.ts` is the only module in this directory allowed to touch Fastify and a
 * socket, and everything it DECIDES is delegated to pure functions. Two of those
 * live in the route file itself — the query resolver and the status mapping — and
 * they are tested here rather than only through a socket because both are
 * reachable without one and both have a defect that a socket test would report as
 * a generic refusal.
 *
 * The statuses are the load-bearing part. Requirement 1 is that an unauthenticated
 * client never reaches the handler, and a client learns that from the status code:
 * 401 means "we do not accept this credential" and 403 means "this credential is
 * real and is no longer welcome". Collapsing them into one tells an operator
 * whose node was revoked that their key was malformed, and the two have different
 * next actions.
 */
import { describe, expect, it } from "vitest"
import { createContractError } from "../../../../../src/orchestration/errors.js"
import { MESH_TERMINAL_PATH, statusForAttachRefusal, terminalAttachScopeFromQuery } from "../../../../../src/mesh/gateway/terminal/index.js"

const SCOPE = {
  terminalId: "term-release-1",
  projectId: "project-release",
  sessionId: "sess-release-1",
  nodeId: "node-worker-1",
  clientId: "client-alice",
}

describe("the attach scope is read from the query, and the epoch is a STRING there", () => {
  it("accepts the digits Fastify's query parser actually produces", () => {
    // The measured fact this encodes: Fastify does not coerce query values, so
    // `?epoch=4` arrives as the string "4". A resolver written against a typed
    // `number` would reject every real request, and the failure would appear as a
    // gateway that refuses all attaches rather than as a parse bug.
    const scope = terminalAttachScopeFromQuery({ ...SCOPE, epoch: "4" })
    expect(scope).toEqual({ ...SCOPE, epoch: 4 })
  })

  it("still accepts a number, for a caller that supplied a `scopeOf` over parsed input", () => {
    expect(terminalAttachScopeFromQuery({ ...SCOPE, epoch: 4 })?.epoch).toBe(4)
  })

  it("refuses a spelling of the epoch that is not digits", () => {
    // `Number("")` is 0, `Number(" 4 ")` is 4 and `Number("0x4")` is 4. A
    // controller epoch that can be written three ways is a fence somebody will
    // write the third way by accident, and the gateway's `epochSchema` then has
    // to be the only thing that decides the RANGE.
    for (const epoch of ["", " 4 ", "0x4", "4.0", "4e0", "+4", "04", "-4", "0", "four", "4 ", "99999999999999999999"]) {
      expect(terminalAttachScopeFromQuery({ ...SCOPE, epoch }), `epoch ${JSON.stringify(epoch)} should be refused`).toBeNull()
    }
  })

  it("refuses a scope with any member missing or of the wrong type", () => {
    expect(terminalAttachScopeFromQuery({ ...SCOPE, epoch: "4", terminalId: undefined })).toBeNull()
    expect(terminalAttachScopeFromQuery({ ...SCOPE, epoch: "4", clientId: 7 })).toBeNull()
    expect(terminalAttachScopeFromQuery({})).toBeNull()
    expect(terminalAttachScopeFromQuery(null)).toBeNull()
    expect(terminalAttachScopeFromQuery("terminalId=x")).toBeNull()
  })

  it("does not read a node id from anywhere but the query", () => {
    // The resolver takes the query and nothing else, so there is no parameter a
    // caller could hand it a peer's claimed identity through. A resolver that took
    // the request would have the headers, and "which node is this" would get a
    // second possible answer that the peer chose.
    expect(terminalAttachScopeFromQuery({ ...SCOPE, epoch: "4" })?.nodeId).toBe("node-worker-1")
  })
})

describe("a refusal becomes a status an operator can act on", () => {
  it("answers 401 for a missing identity decision and 400 for a malformed scope", () => {
    expect(statusForAttachRefusal(createContractError("validation", "terminal.attach_unauthenticated", "no identity"))).toBe(401)
    expect(statusForAttachRefusal(createContractError("validation", "terminal.attach_scope_malformed", "bad id"))).toBe(400)
  })

  it("answers 403 for a policy denial and for a stale epoch", () => {
    expect(statusForAttachRefusal(createContractError("policy_denied", "terminal.access_node_revoked", "revoked"))).toBe(403)
    expect(statusForAttachRefusal(createContractError("stale_epoch", "terminal.epoch_stale", "stale"))).toBe(403)
    expect(statusForAttachRefusal(createContractError("approval_required", "terminal.access_input_not_permitted", "denied"))).toBe(403)
  })

  it("answers 409 for a conflict with what this gateway holds", () => {
    // A viewer over the limit is a CONFLICT with this gateway's state, and
    // answering it 400 would tell an operator their request was malformed when
    // it was well-formed and the answer was no. Same split M4.2's status helper
    // and M4.6's refusal mapper make.
    expect(statusForAttachRefusal(createContractError("conflict", "terminal.client_already_attached", "already attached"))).toBe(409)
    expect(statusForAttachRefusal(createContractError("runtime_failure", "terminal.runtime_unavailable", "no runtime"))).toBe(409)
  })

  it("answers 500 for a store that could not be READ, rather than a conflict", () => {
    // Distinct from 409 on purpose. An operator told their request conflicts with
    // the gateway's state goes and reconciles a run; the reconciliation then fails
    // the same way, for a reason that has nothing to do with what they were sent
    // to do. A fault has to read as a fault.
    expect(statusForAttachRefusal(createContractError("internal_failure", "terminal.access_port_failed", "the store threw"))).toBe(500)
  })

  it("separates 'we do not accept this credential' from 'this one is no longer welcome'", () => {
    // 401 and 403 are different messages to an operator. 401 says the signature,
    // the nonce or a header is wrong — fix the client. 403 says the credential
    // verified and the node is revoked — go and look at the revocation. Folding
    // them together sends the second case to whoever debugs the first.
    const unauthenticated = createContractError("validation", "terminal.attach_unauthenticated", "no identity in scope")
    const revoked = createContractError("policy_denied", "terminal.access_node_revoked", "revoked")
    expect(statusForAttachRefusal(unauthenticated)).not.toBe(statusForAttachRefusal(revoked))
  })
})

describe("the route path is one path, and it is under the mesh prefix", () => {
  it("is /v1/mesh/terminal", () => {
    // Named so a client, a proxy rule and a test cannot spell it three ways. The
    // SSE route's own note is the argument: "which query parameter names the run"
    // has one answer per deployment, and this is the same class of question.
    expect(MESH_TERMINAL_PATH).toBe("/v1/mesh/terminal")
  })
})
