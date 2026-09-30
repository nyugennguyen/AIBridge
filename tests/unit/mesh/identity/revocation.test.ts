import { describe, expect, it } from "vitest"
import { readFile, writeFile } from "node:fs/promises"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContractError, type Result } from "../../../../src/orchestration/errors.js"
import { nodeIdSchema, type MeshId, type NodeId } from "../../../../src/orchestration/identifiers.js"
import { nodeKeyIdSchema, type NodeKeyId } from "../../../../src/mesh/identity/wire-ids.js"
import {
  InMemoryNodeTrustStore,
  UnavailableNodeTrustStore,
  parseTrustedNode,
  revokeNode,
  verifyNodeTrust,
  type NodeRevocation,
  type NodeTrustStore,
  type PeerKeyPinRevoker,
  type TrustedNode,
} from "../../../../src/mesh/identity/node-trust.js"
import { InMemoryPeerKeyPinStore, resolvePinnedKey } from "../../../../src/mesh/identity/peer-key-pins.js"
import { InMemoryEnrollmentCodeStore, issueEnrollmentCode } from "../../../../src/mesh/identity/enrollment-code.js"
import { decideEnrollment } from "../../../../src/mesh/identity/enrollment.js"
import { InMemoryNonceGuard } from "../../../../src/mesh/identity/replay-guard.js"
import { MeshIdentityProvider } from "../../../../src/mesh/identity/identity-provider.js"
import { NodeKeyPair, publicNodeKeyOf } from "../../../../src/mesh/identity/node-key.js"
import { MESH_ID, OTHER_MESH_ID, PROVISIONAL_ID, WORKER_ID, at, iso } from "./fixtures.js"

async function anEnrolledNode(now = at(0)) {
  const trust = new InMemoryNodeTrustStore()
  const pins = new InMemoryPeerKeyPinStore()
  const keyPair = NodeKeyPair.generate()
  const nodeId = nodeIdSchema.parse("node-enr-revoked")
  const trusted: TrustedNode = {
    nodeId,
    meshId: MESH_ID,
    nodeKeyId: keyPair.keyId,
    enrolledAt: now,
    displayName: "worker",
  }
  await trust.enroll(trusted)
  await pins.pin({ nodeId, meshId: MESH_ID, key: publicNodeKeyOf(keyPair), enrollmentId: "enr-1", now })
  return { trust, pins, keyPair, nodeId, trusted }
}

describe("revokeNode", () => {
  it("revokes an enrolled node and removes its pin", async () => {
    const { trust, pins, nodeId, keyPair } = await anEnrolledNode()

    const revoked = await revokeNode(
      { nodeId, meshId: MESH_ID, reason: "machine reported stolen", by: "user-1", at: at(600) },
      { trust, pins },
    )

    expect(revoked.ok).toBe(true)
    if (revoked.ok) {
      expect(revoked.value.nodeId).toBe(nodeId)
      expect(revoked.value.revokedKeyId).toBe(keyPair.keyId)
    }

    // The key must be REMOVED from the trusted set, not merely flagged. A flag with
    // the pin still present leaves one record somewhere saying this key belongs to a
    // node, and a read path that consults the pin store without the trust store would
    // still accept it.
    const pin = await pins.current(nodeId)
    expect(pin).toEqual({ ok: true, value: null })
    expect(pins.size).toBe(0)
  })

  it("requires a reason and an actor", async () => {
    const { trust, pins, nodeId } = await anEnrolledNode()

    const unreasoned = await revokeNode({ nodeId, meshId: MESH_ID, reason: "", by: "user-1", at: at(1) }, { trust, pins })
    const unattributed = await revokeNode({ nodeId, meshId: MESH_ID, reason: "x", by: "", at: at(1) }, { trust, pins })

    // An unexplained revocation is indistinguishable from a mistake, which is the
    // state nobody wants to be in when a fleet goes dark.
    expect(unreasoned.ok).toBe(false)
    if (!unreasoned.ok) expect(unreasoned.error.code).toBe("identity.revocation_unmotivated")
    // An unattributable one is indistinguishable from a compromise of the controller.
    expect(unattributed.ok).toBe(false)
    if (!unattributed.ok) expect(unattributed.error.code).toBe("identity.revocation_unattributed")
  })

  it("refuses to revoke a node that is not enrolled, so a typo creates no record", async () => {
    const { trust, pins } = await anEnrolledNode()
    const result = await revokeNode(
      { nodeId: WORKER_ID, meshId: MESH_ID, reason: "typo", by: "user-1", at: at(1) },
      { trust, pins },
    )

    // A revocation record an operator later reads as "this machine was removed from
    // the mesh" must mean it, not that somebody typed an id that did not exist.
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("identity.revoke_unknown_node")
  })

  it("refuses to revoke from the wrong mesh", async () => {
    const { trust, pins, nodeId } = await anEnrolledNode()
    const result = await revokeNode({ nodeId, meshId: OTHER_MESH_ID, reason: "x", by: "user-1", at: at(1) }, { trust, pins })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("identity.revoke_wrong_mesh")
  })

  it("reports honestly when the revocation lands but the pin cannot be removed", async () => {
    const { trust, nodeId } = await anEnrolledNode()
    // Annotated as the interface the parameter takes, because an unannotated literal
    // widens `ok: false` to `ok: boolean` and a `Result` is a DISCRIMINATED union —
    // the whole fail-closed argument of this module rests on `if (!x.ok)` narrowing,
    // and a widened `boolean` is how that narrowing quietly stops happening.
    const brokenPins: PeerKeyPinRevoker = {
      revoke: async (): Promise<Result<true>> => ({
        ok: false,
        error: createContractError("internal_failure", "identity.pin_store_down", "down"),
      }),
    }

    const result = await revokeNode({ nodeId, meshId: MESH_ID, reason: "x", by: "user-1", at: at(1) }, { trust, pins: brokenPins })

    // Revoke-then-unpin, so the recoverable direction is the safe one: the node IS
    // revoked and every authentication path checks revocation first. The message says
    // which half completed, because "revoked but pinned" is an operator's to finish.
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("identity.revocation_pin_retained")
      expect(result.error.message).toContain("revoked")
    }
    // The revocation itself stands. Read ONCE and narrowed, because two separate
    // `await`s are two separate values and TS will not carry the first one's
    // narrowing into the second — which is the shape that produces the illusion of
    // a check that checks nothing.
    const recorded = await trust.revocation(nodeId)
    expect(recorded.ok).toBe(true)
    if (recorded.ok) expect(recorded.value).not.toBeNull()
  })
})

describe("revocation at the authentication seam", () => {
  it("blocks authenticate outright, before the signature is even checked", async () => {
    const { trust, pins, keyPair, nodeId } = await anEnrolledNode()
    await revokeNode({ nodeId, meshId: MESH_ID, reason: "stolen", by: "user-1", at: at(600) }, { trust, pins })

    const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(601) })
    const request = {
      method: "POST",
      path: "/v1/mesh/command",
      bodyDigest: `sha256:${"a".repeat(64)}`,
      timestamp: at(601),
      nonce: Buffer.from(new Uint8Array(32).fill(3)).toString("base64url"),
      nodeId,
      keyId: keyPair.keyId,
      signature: Buffer.alloc(64).toString("base64url"),
    }

    const outcome = await provider.authenticate({ expectedNodeId: nodeId, expectedMeshId: MESH_ID, signature: request })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe("node_revoked")
    expect(outcome.error.code).toBe("identity.node_revoked")
    // Revocation is checked FIRST, so a revoked node spends no ed25519 verification
    // and burns no nonce. It cannot be used to make the controller do work.
    expect(outcome.error.message).not.toContain("signature")
  })

  it("does not disclose the revocation's reason or actor to the revoked node", async () => {
    const { trust, pins, nodeId } = await anEnrolledNode()
    await revokeNode(
      { nodeId, meshId: MESH_ID, reason: "machine was stolen from a coffee shop", by: "user-1", at: at(1) },
      { trust, pins },
    )

    const verdict = await verifyNodeTrust(trust, { nodeId, meshId: MESH_ID })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    // Those two fields are operator-facing. A revoked node reconnecting learns that
    // it is revoked, and not whether the machine it was on was reported stolen —
    // which is the answer an attacker would use to decide whether to keep trying.
    expect(verdict.error.message).not.toContain("coffee shop")
    expect(verdict.error.message).not.toContain("user-1")
  })

  it("blocks reconnect with the old key, a rotated key, and any key at all", async () => {
    const { trust, pins, keyPair, nodeId } = await anEnrolledNode()
    await revokeNode({ nodeId, meshId: MESH_ID, reason: "stolen", by: "user-1", at: at(600) }, { trust, pins })

    const now = () => at(601)
    const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now })
    const nonceOf = (fill: number) => Buffer.from(new Uint8Array(32).fill(fill)).toString("base64url")
    const sign = (key: NodeKeyPair) => ({
      method: "POST",
      path: "/v1/mesh/command",
      bodyDigest: `sha256:${"a".repeat(64)}`,
      timestamp: at(601),
      nonce: nonceOf(7),
      nodeId,
      keyId: key.keyId,
      signature: "",
    })

    const rotated = NodeKeyPair.generate()
    for (const [label, key] of [["the old key", keyPair], ["a rotated key", rotated]] as const) {
      const request = sign(key)
      const outcome = await provider.authenticate({
        expectedNodeId: nodeId,
        expectedMeshId: MESH_ID,
        signature: { ...request, signature: key.sign(Buffer.from("x")).toString("base64url") },
      })
      expect(outcome.ok, label).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toBe("node_revoked")
    }
  })

  it("blocks re-enrollment with the REVOKED KEY, not merely with the revoked node id", async () => {
    const { trust, pins, keyPair, nodeId } = await anEnrolledNode()
    await revokeNode({ nodeId, meshId: MESH_ID, reason: "stolen", by: "user-1", at: at(600) }, { trust, pins })

    // The attack this closes, and the reason revocation is indexed by key as well as
    // by node. A `nodeId` is DERIVED from an enrollment code, so a revoked machine
    // that presents a FRESH code is given a DIFFERENT node id — and would otherwise be
    // re-pinned while holding the very key the operator revoked in order to remove it.
    // Revoking the node id alone reduces "revoke this machine" to "revoke one of its
    // names", which a compromised machine re-acquires with a single new code.
    const codes = new InMemoryEnrollmentCodeStore()
    const fresh = await issueEnrollmentCode({ meshId: MESH_ID, issuedBy: "user-1", now: at(700) }, codes)
    if (!fresh.ok) throw new Error(fresh.error.message)

    const decided = await decideEnrollment(
      {
        request: {
          meshId: MESH_ID,
          enrollmentId: fresh.value.enrollmentId,
          enrollmentCodeHash: fresh.value.codeHash,
          nodePublicKey: keyPair.publicKey,
          nodeDisplayName: "worker",
          provisionalNodeId: PROVISIONAL_ID,
          requestedAt: iso(at(700)),
          codeExpiresAt: iso(fresh.value.expiresAt),
        },
        now: at(700),
      },
      { codes, pins, trust },
    )

    expect(decided.outcome).toBe("rejected")
    // The key is not trusted anywhere, under any id.
    const anyPin = await pins.current(nodeIdSchema.parse(decided.nodeId))
    expect(anyPin).toEqual({ ok: true, value: null })

    // And the code was NOT burned: the check runs before the redemption, because the
    // code is the operator's to re-issue for a node that brings a FRESH key. A check
    // placed after the redemption would cost the operator their code to learn that
    // the submission was never going to be accepted.
    expect(codes.find(fresh.value.codeHash)?.redeemedNodeId).toBeUndefined()
  })

  it("lets a node return with a FRESH key after a revocation, because revocation is of the credential", async () => {
    const { trust, pins, nodeId } = await anEnrolledNode()
    await revokeNode({ nodeId, meshId: MESH_ID, reason: "decommissioned", by: "user-1", at: at(600) }, { trust, pins })

    // The other half of the guarantee. If revocation also refused every future
    // enrollment, the remedy for a decommissioned machine would be to rename it, which
    // is exactly what "individually revocable" is meant to avoid — and an operator
    // restoring a host from backup would be permanently locked out.
    const codes = new InMemoryEnrollmentCodeStore()
    const issued = await issueEnrollmentCode({ meshId: MESH_ID, issuedBy: "user-1", now: at(700) }, codes)
    if (!issued.ok) throw new Error(issued.error.message)
    const replacement = NodeKeyPair.generate()

    const decided = await decideEnrollment(
      {
        request: {
          meshId: MESH_ID,
          enrollmentId: issued.value.enrollmentId,
          enrollmentCodeHash: issued.value.codeHash,
          nodePublicKey: replacement.publicKey,
          nodeDisplayName: "worker",
          provisionalNodeId: PROVISIONAL_ID,
          requestedAt: iso(at(700)),
          codeExpiresAt: iso(issued.value.expiresAt),
        },
        now: at(700),
      },
      { codes, pins, trust },
    )

    expect(decided.outcome).toBe("accepted")
    expect(decided.nodeId).not.toBe(nodeId)
  })

  it("refuses a second trust record for a revoked node id", async () => {
    const { trust, pins, nodeId } = await anEnrolledNode()
    await revokeNode({ nodeId, meshId: MESH_ID, reason: "stolen", by: "user-1", at: at(600) }, { trust, pins })

    // Revocation and enrollment are two writes to the same row, so without an
    // explicit guard the second one silently wins — and a node revoked for a
    // compromised machine comes back the moment anything calls `enroll`.
    // The key id is branded through its own schema rather than written as a literal,
    // because a cast here is a test that passes against a key id no node could hold.
    const again = await trust.enroll({ nodeId, meshId: MESH_ID, nodeKeyId: nodeKeyIdSchema.parse("key-1"), enrolledAt: at(700), displayName: "worker" })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe("identity.enrollment_revoked")
    expect((await verifyNodeTrust(trust, { nodeId, meshId: MESH_ID })).ok).toBe(false)
  })
})

describe("revocation durability", () => {
  /**
   * A store that persists to a file, which is what "durable revocation" has to
   * MEAN rather than assert.
   *
   * Written here rather than imported because there is no durable `NodeTrustStore`
   * in `src/` yet: M4.3 supplies the production one. What this proves is that the
   * INTERFACE has room for durability — that revocation is a separate durable row
   * rather than a flag on a trust record that a restart could lose.
   */
  class JsonFileTrustStore implements NodeTrustStore {
    readonly #path: string
    #trusted: TrustedNode[] = []
    #revoked: NodeRevocation[] = []

    constructor(path: string) {
      this.#path = path
    }

    static async open(path: string): Promise<JsonFileTrustStore> {
      const store = new JsonFileTrustStore(path)
      const raw = await readFile(path, "utf8").catch(() => null)
      if (raw !== null) {
        const parsed = JSON.parse(raw) as { trusted: TrustedNode[]; revoked: NodeRevocation[] }
        store.#trusted = parsed.trusted
        store.#revoked = parsed.revoked
      }
      return store
    }

    async #flush(): Promise<void> {
      await writeFile(this.#path, JSON.stringify({ trusted: this.#trusted, revoked: this.#revoked }), "utf8")
    }

    async trusted(nodeId: NodeId): Promise<Result<TrustedNode | null>> {
      return { ok: true, value: this.#trusted.find((row) => row.nodeId === nodeId) ?? null }
    }

    async revocation(nodeId: NodeId): Promise<Result<NodeRevocation | null>> {
      return { ok: true, value: this.#revoked.find((row) => row.nodeId === nodeId) ?? null }
    }

    async enroll(node: TrustedNode): Promise<Result<true>> {
      if (this.#trusted.some((row) => row.nodeId === node.nodeId)) {
        return {
          ok: false,
          error: createContractError("conflict", "identity.already_enrolled", "already"),
        }
      }
      this.#trusted.push(node)
      await this.#flush()
      return { ok: true, value: true }
    }

    async revocationByKeyId(nodeKeyId: NodeKeyId): Promise<Result<NodeRevocation | null>> {
      return { ok: true, value: this.#revoked.find((row) => row.revokedKeyId === nodeKeyId) ?? null }
    }

    /**
     * The FIRST revocation wins, matching `InMemoryNodeTrustStore` — the durability
     * property under test is "the record is on disk", and a fake that kept the LAST
     * write would pass a restart test while disagreeing with the store it stands in
     * for.
     */
    async revoke(revocation: NodeRevocation): Promise<Result<NodeRevocation>> {
      const found = await this.revocation(revocation.nodeId)
      if (!found.ok) return found
      if (found.value !== null) return { ok: true, value: found.value }
      this.#trusted = this.#trusted.filter((row) => row.nodeId !== revocation.nodeId)
      this.#revoked = [...this.#revoked, revocation]
      await this.#flush()
      return { ok: true, value: revocation }
    }

    async listTrusted(meshId: MeshId): Promise<Result<readonly TrustedNode[]>> {
      return {
        ok: true,
        value: this.#trusted.filter(
          (row) => row.meshId === meshId && !this.#revoked.some((r) => r.nodeId === row.nodeId),
        ),
      }
    }
  }

  it("survives a store reload: a revoked node is still revoked after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aibridge-revoke-"))
    try {
      const path = join(dir, "trust.json")
      const store = await JsonFileTrustStore.open(path)
      const pins = new InMemoryPeerKeyPinStore()
      const nodeId = nodeIdSchema.parse("node-durable-1")
      await store.enroll({ nodeId, meshId: MESH_ID, nodeKeyId: nodeKeyIdSchema.parse("key-abc"), enrolledAt: at(0), displayName: "worker" })
      await pins.pin({ nodeId, meshId: MESH_ID, key: publicNodeKeyOf(NodeKeyPair.generate()), enrollmentId: "enr-1", now: at(0) })

      await revokeNode({ nodeId, meshId: MESH_ID, reason: "decommissioned", by: "user-1", at: at(60) }, { trust: store, pins })

      // Restart. An in-memory revocation set would make revocation a promise that a
      // controller restart silently withdraws, which is worse than not offering it.
      const reloaded = await JsonFileTrustStore.open(path)
      const verdict = await verifyNodeTrust(reloaded, { nodeId, meshId: MESH_ID })
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toBe("node_revoked")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("keeps the FIRST revocation on a repeat, so the audit record does not move", async () => {
    const { trust, pins, nodeId } = await anEnrolledNode()
    const first = await revokeNode({ nodeId, meshId: MESH_ID, reason: "stolen", by: "user-1", at: at(60) }, { trust, pins })
    const repeat = await revokeNode({ nodeId, meshId: MESH_ID, reason: "re-revoked", by: "user-2", at: at(600) }, { trust, pins })

    // If a second call could move `at`, an audit reader asking "was this node
    // trusted when the incident happened?" would get an answer that depends on when
    // somebody happened to re-run the command.
    expect(first.ok && repeat.ok).toBe(true)
    if (first.ok && repeat.ok) {
      expect(repeat.value.at).toBe(at(60))
      expect(repeat.value.reason).toBe("stolen")
      expect(repeat.value.by).toBe("user-1")
    }
  })

  it("keeps the first reason for a repeat through the provider too", async () => {
    const { trust, pins, nodeId } = await anEnrolledNode()
    await revokeNode({ nodeId, meshId: MESH_ID, reason: "first", by: "user-1", at: at(60) }, { trust, pins })
    await revokeNode({ nodeId, meshId: MESH_ID, reason: "second", by: "user-2", at: at(600) }, { trust, pins })

    const verdict = await verifyNodeTrust(trust, { nodeId, meshId: MESH_ID })
    if (!verdict.ok) {
      expect(verdict.error.message).not.toContain("second")
      expect(verdict.error.message).not.toContain("user-2")
    }
  })
})

describe("revoked nodes are excluded from every peer list", () => {
  it("by construction, not by a filter each call site has to remember", async () => {
    const trust = new InMemoryNodeTrustStore()
    const pins = new InMemoryPeerKeyPinStore()
    const doomed = nodeIdSchema.parse("node-doomed")
    const survivor = nodeIdSchema.parse("node-survivor")
    for (const nodeId of [doomed, survivor]) {
      await trust.enroll({ nodeId, meshId: MESH_ID, nodeKeyId: nodeKeyIdSchema.parse("key-1"), enrolledAt: at(0), displayName: "w" })
    }
    await revokeNode({ nodeId: doomed, meshId: MESH_ID, reason: "x", by: "user-1", at: at(1) }, { trust, pins })

    const listed = await trust.listTrusted(MESH_ID)

    // The exclusion is inside `listTrusted`, so a caller building an
    // `enrollment.response.peerKeyPins` cannot hand a joining node the address of a
    // node that must not be contacted.
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.value.map((node) => node.nodeId)).toEqual([survivor])
  })
})

describe("verifyNodeTrust fail-closed behaviour", () => {
  it("refuses when the revocation store is unavailable, never reading it as empty", async () => {
    const verdict = await verifyNodeTrust(new UnavailableNodeTrustStore(), { nodeId: WORKER_ID, meshId: MESH_ID })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toBe("trust_store_failure")
      // The empty reading is the permissive one, and making it the default turns a
      // storage failure into a mesh-wide authentication bypass.
      expect(verdict.error.code).toBe("identity.trust_store_unavailable")
    }
  })
})

describe("parseTrustedNode", () => {
  it("refuses a record whose fields are not wire-shaped", () => {
    expect(parseTrustedNode({ nodeId: "not a wire id", meshId: MESH_ID, nodeKeyId: "key-1", enrolledAt: 0, displayName: "w" }).ok).toBe(false)
    expect(parseTrustedNode({ nodeId: WORKER_ID, meshId: MESH_ID, nodeKeyId: "not a wire id", enrolledAt: 0, displayName: "w" }).ok).toBe(false)
    expect(parseTrustedNode({ nodeId: WORKER_ID, meshId: MESH_ID, nodeKeyId: "key-1", enrolledAt: -1, displayName: "w" }).ok).toBe(false)
    expect(parseTrustedNode({ nodeId: WORKER_ID, meshId: MESH_ID, nodeKeyId: "key-1", enrolledAt: 0, displayName: "" }).ok).toBe(false)
    expect(parseTrustedNode(null).ok).toBe(false)
  })

  it("accepts an honest record", () => {
    const result = parseTrustedNode({
      nodeId: WORKER_ID,
      meshId: MESH_ID,
      nodeKeyId: "key-abc",
      enrolledAt: at(0),
      displayName: "worker",
    })
    expect(result.ok).toBe(true)
  })
})

describe("a revoked node cannot reach a terminal or a command", () => {
  it("because the pin it would need is gone, not merely because the pin is flagged", async () => {
    const { trust, pins, keyPair, nodeId } = await anEnrolledNode()
    await revokeNode({ nodeId, meshId: MESH_ID, reason: "stolen", by: "user-1", at: at(1) }, { trust, pins })

    // M4.6's SSE gateway and M4.7's terminal WebSocket both authenticate through
    // `IdentityProvider`. There is no separate "can this node open a terminal"
    // check, so there is no second place for a revoked node to be admitted.
    const trustVerdict = await verifyNodeTrust(trust, { nodeId, meshId: MESH_ID })
    const pinVerdict = await resolvePinnedKey(pins, { nodeId, meshId: MESH_ID, nodeKeyId: keyPair.keyId })

    expect(trustVerdict.ok).toBe(false)
    expect(pinVerdict.ok).toBe(false)
    if (!pinVerdict.ok) expect(pinVerdict.reason).toBe("pin_missing")
  })
})
