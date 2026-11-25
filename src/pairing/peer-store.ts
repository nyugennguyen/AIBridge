/**
 * File-backed peer trust + key pins for bridge pairing (Phase 3, ADR 0012).
 *
 * Implements BOTH `NodeTrustStore` and `PeerKeyPinStore` from
 * `src/mesh/identity/` over one JSON file, so the mesh `MeshIdentityProvider`
 * (trust -> revocation -> pin -> signature -> replay) is reused unchanged for
 * `/trigger` and `/report`. A pinned peer's `nodeId` IS its enrolled agent id.
 *
 * Every read goes to disk: `aibr enroll revoke` runs in another process, and a
 * revocation must bite the running bridge on its next request.
 */
import { createContractError, type Result } from "../orchestration/errors.js"
import { meshIdSchema, nodeIdSchema, type MeshId, type NodeId } from "../orchestration/identifiers.js"
import { nodeKeyIdSchema } from "../mesh/protocol/identifiers.js"
import type { NodeKeyId } from "../mesh/identity/wire-ids.js"
import type { PublicNodeKey } from "../mesh/identity/node-key.js"
import {
  parsePeerKeyPin,
  type PeerKeyPin,
  type PeerKeyPinStore,
  type PinNodeKeyInput,
  type RotateNodeKeyInput,
} from "../mesh/identity/peer-key-pins.js"
import type { NodeRevocation, NodeTrustStore, TrustedNode } from "../mesh/identity/node-trust.js"
import { PAIRING_MESH_ID, peersFileFor, readJsonFile, withFileLock, writeJsonFile } from "./files.js"

interface PeersFile {
  version: 1
  pins: PeerKeyPin[]
  trusted: TrustedNode[]
  revocations: NodeRevocation[]
}

export interface PairedPeer {
  readonly agentId: string
  readonly nodeKeyId: string
  readonly fingerprint: string
  readonly pinnedAt: number
  readonly enrollmentId: string
  readonly displayName: string
}

export const PAIRING_MESH: MeshId = meshIdSchema.parse(PAIRING_MESH_ID)

export class FilePeerStore implements NodeTrustStore {
  readonly #path: string

  constructor(stateDir: string) {
    this.#path = peersFileFor(stateDir)
  }

  get path(): string {
    return this.#path
  }

  // ── NodeTrustStore ──────────────────────────────────────────────────

  async trusted(nodeId: NodeId): Promise<Result<TrustedNode | null>> {
    return this.#read((file) => file.trusted.find((t) => t.nodeId === nodeId) ?? null)
  }

  async revocation(nodeId: NodeId): Promise<Result<NodeRevocation | null>> {
    return this.#read((file) => file.revocations.find((r) => r.nodeId === nodeId) ?? null)
  }

  async revocationByKeyId(nodeKeyId: NodeKeyId): Promise<Result<NodeRevocation | null>> {
    return this.#read((file) => file.revocations.find((r) => r.revokedKeyId === nodeKeyId) ?? null)
  }

  async enroll(node: TrustedNode): Promise<Result<true>> {
    return this.#mutate((file) => {
      if (file.trusted.some((t) => t.nodeId === node.nodeId)) {
        return failure("conflict", "identity.already_enrolled", `Node ${node.nodeId} is already enrolled.`)
      }
      if (file.revocations.some((r) => r.nodeId === node.nodeId)) {
        return failure("policy_denied", "identity.enrollment_revoked", `Node ${node.nodeId} is revoked; pair it again with a fresh code.`)
      }
      file.trusted.push({ ...node })
      return { ok: true, value: true }
    })
  }

  async revoke(revocation: NodeRevocation): Promise<Result<NodeRevocation>> {
    return this.#mutate((file) => {
      const existing = file.revocations.find((r) => r.nodeId === revocation.nodeId)
      if (existing !== undefined) return { ok: true, value: existing }
      file.trusted = file.trusted.filter((t) => t.nodeId !== revocation.nodeId)
      file.revocations.push({ ...revocation })
      return { ok: true, value: revocation }
    })
  }

  async listTrusted(meshId: MeshId): Promise<Result<readonly TrustedNode[]>> {
    return this.#read((file) =>
      file.trusted.filter((t) => t.meshId === meshId && !file.revocations.some((r) => r.nodeId === t.nodeId)),
    )
  }

  // ── PeerKeyPinStore ─────────────────────────────────────────────────

  async pin(input: PinNodeKeyInput): Promise<Result<PeerKeyPin>> {
    return this.#mutate((file) => {
      if (file.pins.some((p) => p.nodeId === input.nodeId)) {
        return failure("conflict", "identity.already_pinned", `Node ${input.nodeId} already has a pinned key.`)
      }
      const record = pinRecord(input.nodeId, input.meshId, input.key, input.enrollmentId, input.now, 1)
      file.pins.push(record)
      return { ok: true, value: record }
    })
  }

  async current(nodeId: NodeId): Promise<Result<PeerKeyPin | null>> {
    return this.#read((file) => file.pins.find((p) => p.nodeId === nodeId) ?? null)
  }

  async rotate(input: RotateNodeKeyInput): Promise<Result<PeerKeyPin>> {
    return this.#mutate((file) => {
      const existing = file.pins.find((p) => p.nodeId === input.nodeId)
      if (existing === undefined) {
        return failure("policy_denied", "identity.rotate_unpinned", `Node ${input.nodeId} has no pinned key to rotate.`)
      }
      const record = pinRecord(input.nodeId, input.meshId, input.key, input.enrollmentId, input.now, existing.generation + 1)
      file.pins = file.pins.map((p) => (p.nodeId === input.nodeId ? record : p))
      return { ok: true, value: record }
    })
  }

  async dropPin(nodeId: NodeId): Promise<Result<true>> {
    return this.#mutate((file) => {
      file.pins = file.pins.filter((p) => p.nodeId !== nodeId)
      return { ok: true, value: true }
    })
  }

  // ── pairing-specific ────────────────────────────────────────────────

  /**
   * Pins `key` for `agentId` as the result of an accepted one-time pairing code.
   *
   * Pairing is an explicit operator act (a code was issued and redeemed), so it
   * REPLACES any previous pin, trust record and revocation for that agent id in
   * one atomic write. That is the "deliberate act" that clears a revocation.
   */
  async pairPeer(input: {
    readonly agentId: string
    readonly key: PublicNodeKey
    readonly enrollmentId: string
    readonly displayName: string
    readonly now: number
  }): Promise<Result<PeerKeyPin>> {
    const nodeId = nodeIdSchema.safeParse(input.agentId)
    if (!nodeId.success) {
      return failure("validation", "pairing.agent_id_invalid", `Agent id "${input.agentId}" is not a valid wire id.`)
    }
    return this.#mutate((file) => {
      const generation = (file.pins.find((p) => p.nodeId === nodeId.data)?.generation ?? 0) + 1
      const record = pinRecord(nodeId.data, PAIRING_MESH, input.key, input.enrollmentId, input.now, generation)
      file.pins = [...file.pins.filter((p) => p.nodeId !== nodeId.data), record]
      file.trusted = [
        ...file.trusted.filter((t) => t.nodeId !== nodeId.data),
        {
          nodeId: nodeId.data,
          meshId: PAIRING_MESH,
          nodeKeyId: input.key.nodeKeyId,
          enrolledAt: input.now,
          displayName: input.displayName.slice(0, 256) || input.agentId,
        },
      ]
      file.revocations = file.revocations.filter((r) => r.nodeId !== nodeId.data)
      return { ok: true, value: record }
    })
  }

  /** Revokes `agentId`: records the revocation and drops its pin, atomically. */
  async revokePeer(input: { readonly agentId: string; readonly by: string; readonly reason: string; readonly now: number }): Promise<Result<boolean>> {
    const nodeId = nodeIdSchema.safeParse(input.agentId)
    if (!nodeId.success) return { ok: true, value: false }
    return this.#mutate((file) => {
      const pin = file.pins.find((p) => p.nodeId === nodeId.data)
      const trusted = file.trusted.find((t) => t.nodeId === nodeId.data)
      if (pin === undefined && trusted === undefined) return { ok: true, value: false }
      const keyId = trusted?.nodeKeyId ?? pin!.nodeKeyId
      file.pins = file.pins.filter((p) => p.nodeId !== nodeId.data)
      file.trusted = file.trusted.filter((t) => t.nodeId !== nodeId.data)
      if (!file.revocations.some((r) => r.nodeId === nodeId.data)) {
        file.revocations.push({
          nodeId: nodeId.data,
          meshId: PAIRING_MESH,
          reason: input.reason,
          by: input.by,
          at: input.now,
          revokedKeyId: keyId,
        })
      }
      return { ok: true, value: true }
    })
  }

  async listPeers(): Promise<Result<readonly PairedPeer[]>> {
    return this.#read((file) =>
      file.pins.map((pin) => ({
        agentId: pin.nodeId,
        nodeKeyId: pin.nodeKeyId,
        fingerprint: pin.fingerprint,
        pinnedAt: pin.pinnedAt,
        enrollmentId: pin.enrollmentId,
        displayName: file.trusted.find((t) => t.nodeId === pin.nodeId)?.displayName ?? pin.nodeId,
      })),
    )
  }

  async listRevocations(): Promise<Result<readonly NodeRevocation[]>> {
    return this.#read((file) => file.revocations)
  }

  // ── io ──────────────────────────────────────────────────────────────

  async #load(): Promise<PeersFile> {
    const raw = await readJsonFile(this.#path)
    if (raw === undefined) return { version: 1, pins: [], trusted: [], revocations: [] }
    return parsePeersFile(raw)
  }

  async #read<T>(select: (file: PeersFile) => T): Promise<Result<T>> {
    try {
      return { ok: true, value: select(await this.#load()) }
    } catch (error) {
      return storeFailure(error)
    }
  }

  async #mutate<T>(change: (file: PeersFile) => Result<T>): Promise<Result<T>> {
    try {
      return await withFileLock(this.#path, async () => {
        const file = await this.#load()
        const outcome = change(file)
        if (outcome.ok) await writeJsonFile(this.#path, file)
        return outcome
      })
    } catch (error) {
      return storeFailure(error)
    }
  }
}

/**
 * The `PeerKeyPinStore` view of a `FilePeerStore`. The two mesh interfaces both
 * name a `revoke` (trust revocation vs. dropping a pin), so the class implements
 * `NodeTrustStore` and the pin interface is this adapter over the same file.
 */
export function pinStoreOf(store: FilePeerStore): PeerKeyPinStore {
  return {
    pin: (input) => store.pin(input),
    current: (nodeId) => store.current(nodeId),
    rotate: (input) => store.rotate(input),
    revoke: (nodeId) => store.dropPin(nodeId),
  }
}

function pinRecord(
  nodeId: NodeId,
  meshId: MeshId,
  key: PublicNodeKey,
  enrollmentId: string,
  now: number,
  generation: number,
): PeerKeyPin {
  return {
    nodeId,
    meshId,
    nodeKeyId: key.nodeKeyId,
    publicKey: key.publicKey,
    fingerprint: key.fingerprint,
    pinnedAt: now,
    enrollmentId,
    generation,
  }
}

function parsePeersFile(raw: unknown): PeersFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("peers.json is not an object")
  const record = raw as Record<string, unknown>
  const pins = arrayOf(record.pins).map((entry) => {
    const parsed = parsePeerKeyPin(entry)
    if (!parsed.ok) throw new Error(parsed.error.message)
    return { ...parsed.value }
  })
  const trusted = arrayOf(record.trusted).map((entry) => parseTrusted(entry))
  const revocations = arrayOf(record.revocations).map((entry) => parseRevocation(entry))
  return { version: 1, pins, trusted, revocations }
}

function parseTrusted(entry: unknown): TrustedNode {
  const r = asRecord(entry)
  return {
    nodeId: nodeIdSchema.parse(r.nodeId),
    meshId: meshIdSchema.parse(r.meshId),
    nodeKeyId: nodeKeyIdSchema.parse(r.nodeKeyId),
    enrolledAt: safeInt(r.enrolledAt),
    displayName: typeof r.displayName === "string" ? r.displayName : String(r.nodeId),
  }
}

function parseRevocation(entry: unknown): NodeRevocation {
  const r = asRecord(entry)
  return {
    nodeId: nodeIdSchema.parse(r.nodeId),
    meshId: meshIdSchema.parse(r.meshId),
    reason: typeof r.reason === "string" ? r.reason : "",
    by: typeof r.by === "string" ? r.by : "",
    at: safeInt(r.at),
    revokedKeyId: nodeKeyIdSchema.parse(r.revokedKeyId),
  }
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("peers.json has a non-array section")
  return value
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("peers.json entry is not an object")
  return value as Record<string, unknown>
}

function safeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("peers.json has an invalid timestamp")
  return value
}

function failure(category: Parameters<typeof createContractError>[0], code: string, message: string): { ok: false; error: ReturnType<typeof createContractError> } {
  return { ok: false, error: createContractError(category, code, message) }
}

function storeFailure(error: unknown): { ok: false; error: ReturnType<typeof createContractError> } {
  return failure(
    "internal_failure",
    "pairing.peer_store_unavailable",
    `The peer pin store could not be read or written (${error instanceof Error ? error.message : "unknown error"}); requests are refused rather than trusted.`,
  )
}
