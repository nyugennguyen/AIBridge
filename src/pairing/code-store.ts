/**
 * File-backed one-time pairing codes (Phase 3, ADR 0012).
 *
 * Implements the mesh `EnrollmentCodeStore` contract (`consume` is the single
 * atomic redeem step) over `<stateDir>/identity/enrollment-codes.json`, so
 * `issueEnrollmentCode` / `verifyEnrollmentCode` from `src/mesh/identity/` are
 * reused unchanged. Only the code's sha256 is stored, never the code. Each code
 * additionally carries the capabilities the worker operator granted with it.
 */
import { createContractError, type Result } from "../orchestration/errors.js"
import { meshIdSchema, nodeIdSchema, type MeshId, type NodeId } from "../orchestration/identifiers.js"
import { codeHashSchema, enrollmentIdSchema, provisionalNodeIdSchema } from "../mesh/protocol/identifiers.js"
import type { ProvisionalNodeId } from "../mesh/identity/wire-ids.js"
import { constantTimeEqual } from "../mesh/identity/crypto.js"
import type {
  EnrollmentCodeHash,
  EnrollmentCodeRedemption,
  EnrollmentCodeStore,
  StoredEnrollmentCode,
} from "../mesh/identity/enrollment-code.js"
import { enrollmentCodesFileFor, readJsonFile, withFileLock, writeJsonFile } from "./files.js"

export interface StoredPairingCode extends StoredEnrollmentCode {
  readonly capabilities: readonly string[]
}

interface CodesFile {
  version: 1
  codes: StoredPairingCode[]
}

/** Redeemed or expired codes are kept this long for `enroll list`, then pruned. */
const RETENTION_MS = 24 * 60 * 60_000

export class FilePairingCodeStore implements EnrollmentCodeStore {
  readonly #path: string

  constructor(stateDir: string) {
    this.#path = enrollmentCodesFileFor(stateDir)
  }

  /** `EnrollmentCodeStore.save`: a code with no granted capabilities. */
  async save(code: StoredEnrollmentCode): Promise<Result<true>> {
    return this.saveWithGrant(code, [])
  }

  async saveWithGrant(code: StoredEnrollmentCode, capabilities: readonly string[]): Promise<Result<true>> {
    return this.#mutate((file) => {
      if (file.codes.some((c) => constantTimeEqual(c.codeHash, code.codeHash))) {
        return failure("conflict", "identity.enrollment_code_collision", "An enrollment code with this hash already exists.")
      }
      file.codes.push({ ...code, capabilities: [...capabilities] })
      return { ok: true, value: true }
    })
  }

  async consume(input: {
    readonly codeHash: EnrollmentCodeHash
    readonly meshId: MeshId
    readonly nodeId: NodeId
    readonly nodePublicKey: string
    readonly provisionalNodeId: ProvisionalNodeId
    readonly now: number
  }): Promise<Result<EnrollmentCodeRedemption | null>> {
    return this.#mutate<EnrollmentCodeRedemption | null>((file) => {
      // Every stored hash is compared, so timing does not reveal which entry matched.
      let index = -1
      file.codes.forEach((candidate, i) => {
        if (constantTimeEqual(candidate.codeHash, input.codeHash)) index = i
      })
      if (index === -1) return { ok: true, value: null }
      const existing = file.codes[index]!
      if (
        existing.meshId !== input.meshId ||
        input.now >= existing.expiresAt ||
        (existing.boundProvisionalNodeId !== undefined && existing.boundProvisionalNodeId !== input.provisionalNodeId) ||
        existing.redeemedNodeId !== undefined
      ) {
        return { ok: true, value: { record: existing, firstUse: false } }
      }
      const redeemed: StoredPairingCode = { ...existing, redeemedNodeId: input.nodeId, redeemedPublicKey: input.nodePublicKey }
      file.codes[index] = redeemed
      return { ok: true, value: { record: redeemed, firstUse: true } }
    })
  }

  /** The capabilities granted with an issued code. */
  async grantFor(enrollmentId: string): Promise<readonly string[]> {
    const file = await this.#load()
    return file.codes.find((c) => c.enrollmentId === enrollmentId)?.capabilities ?? []
  }

  async list(): Promise<readonly StoredPairingCode[]> {
    return (await this.#load()).codes
  }

  async #load(): Promise<CodesFile> {
    const raw = await readJsonFile(this.#path)
    if (raw === undefined) return { version: 1, codes: [] }
    return parseCodesFile(raw)
  }

  async #mutate<T>(change: (file: CodesFile) => Result<T>): Promise<Result<T>> {
    try {
      return await withFileLock(this.#path, async () => {
        const file = await this.#load()
        const outcome = change(file)
        if (outcome.ok) {
          const cutoff = Date.now() - RETENTION_MS
          file.codes = file.codes.filter((c) => c.expiresAt > cutoff)
          await writeJsonFile(this.#path, file)
        }
        return outcome
      })
    } catch (error) {
      return failure(
        "internal_failure",
        "pairing.code_store_unavailable",
        `The pairing code store could not be read or written (${error instanceof Error ? error.message : "unknown error"}).`,
      )
    }
  }
}

function parseCodesFile(raw: unknown): CodesFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("enrollment-codes.json is not an object")
  const codes = (raw as { codes?: unknown }).codes
  if (codes !== undefined && !Array.isArray(codes)) throw new Error("enrollment-codes.json codes is not an array")
  return { version: 1, codes: (codes ?? []).map(parseCode) }
}

function parseCode(entry: unknown): StoredPairingCode {
  if (typeof entry !== "object" || entry === null) throw new Error("enrollment code entry is not an object")
  const r = entry as Record<string, unknown>
  const int = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error("enrollment code has an invalid timestamp")
    return v
  }
  return {
    enrollmentId: enrollmentIdSchema.parse(r.enrollmentId),
    meshId: meshIdSchema.parse(r.meshId),
    codeHash: codeHashSchema.parse(r.codeHash),
    issuedAt: int(r.issuedAt),
    expiresAt: int(r.expiresAt),
    issuedBy: typeof r.issuedBy === "string" ? r.issuedBy : "unknown",
    ...(r.boundProvisionalNodeId === undefined ? {} : { boundProvisionalNodeId: provisionalNodeIdSchema.parse(r.boundProvisionalNodeId) }),
    ...(r.redeemedNodeId === undefined ? {} : { redeemedNodeId: nodeIdSchema.parse(r.redeemedNodeId) }),
    ...(typeof r.redeemedPublicKey === "string" ? { redeemedPublicKey: r.redeemedPublicKey } : {}),
    capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter((c): c is string => typeof c === "string") : [],
  }
}

function failure(category: Parameters<typeof createContractError>[0], code: string, message: string): { ok: false; error: ReturnType<typeof createContractError> } {
  return { ok: false, error: createContractError(category, code, message) }
}
