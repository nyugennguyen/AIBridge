/**
 * Pairing (Phase 3, ADR 0012): one-time code exchange that replaces copying a
 * bearer token by hand.
 *
 *   worker        `aibr enroll issue`   -> prints aibr1-… (url + one-time secret + key id)
 *   orchestrator  `aibr enroll join`    -> POST <url>/enroll, signed with its node key
 *   worker        /enroll               -> code consumed, orchestrator key pinned,
 *                                          allowed_sources[] written, response signed
 *   orchestrator                         -> worker key pinned, agents[] written,
 *                                          bearer token stored 0600 (never printed)
 *
 * This module owns the logic; `src/server/routes/enroll.ts` and
 * `src/cli/enroll.ts` are thin adapters over it.
 */
import { createPublicKey, randomBytes, verify as edVerify } from "node:crypto"
import { access, unlink } from "node:fs/promises"
import type { FastifyRequest } from "fastify"
import { z } from "zod"
import type { BridgeConfig, RequestSigningMode } from "../config/types.js"
import { readConfig, writeConfig } from "../host/profile-store.js"
import type { ProfilePaths } from "../host/paths.js"
import { digestJson } from "../orchestration/digest.js"
import { createContractError } from "../orchestration/errors.js"
import { nodeIdSchema } from "../orchestration/identifiers.js"
import { fromBase64Url, sha256Digest } from "../mesh/identity/crypto.js"
import { issueEnrollmentCode, verifyEnrollmentCode, type EnrollmentCodeStore } from "../mesh/identity/enrollment-code.js"
import type { IdentityProvider } from "../mesh/identity/identity-provider.js"
import { authenticateForRequest } from "../mesh/identity/middleware.js"
import { publicNodeKeyFromBase64, type NodeKeyPair } from "../mesh/identity/node-key.js"
import { InMemoryNonceGuard } from "../mesh/identity/replay-guard.js"
import { verifyMeshRequest } from "../mesh/identity/request-signature.js"
import { provisionalNodeIdSchema } from "../mesh/protocol/identifiers.js"
import { FilePairingCodeStore } from "./code-store.js"
import {
  enrollmentCodesFileFor,
  isPairableAgentId,
  loadNodeKey,
  loadOrCreateNodeKey,
  peerBearerTokenPath,
  writePrivateFile,
} from "./files.js"
import { decodePairingCode, encodePairingCode } from "./pairing-code.js"
import { FilePeerStore, PAIRING_MESH } from "./peer-store.js"
import { signedRequestHeaders } from "./signer.js"

export const ENROLL_PATH = "/enroll"
const RESPONSE_SIGNATURE_DOMAIN = "aibridge.pairing.response.v1"

export class PairingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

// ── worker: issue ──────────────────────────────────────────────────────

export interface IssuedPairingCode {
  readonly code: string
  readonly enrollmentId: string
  readonly expiresAt: number
  readonly capabilities: readonly string[]
  readonly keyId: string
  readonly url: string
}

export async function issuePairingCode(input: {
  readonly config: BridgeConfig
  readonly stateDir: string
  readonly capabilities?: readonly string[]
  readonly ttlMs: number
  readonly issuedBy: string
  readonly now?: () => number
}): Promise<IssuedPairingCode> {
  const { config } = input
  if (config.role === "orchestrator") {
    throw new PairingError(
      "This profile is an orchestrator: it runs no bridge for a peer to pair with. Issue the code on the worker, then run `aibr enroll join <code>` here.",
      "not_a_worker",
    )
  }
  if (config.bridge.ingress_mode === "router") {
    throw new PairingError(
      'Pairing needs bridge.ingress_mode "engine": the Rust router does not serve /enroll (ADR 0012).',
      "router_mode",
    )
  }
  if (!isPairableAgentId(config.agent_id)) {
    throw new PairingError(`agent_id "${config.agent_id}" must match [A-Za-z0-9][A-Za-z0-9._:-]* to pair.`, "agent_id_invalid")
  }
  const capabilities = resolveGrantedCapabilities(config, input.capabilities)
  const now = input.now ?? Date.now
  const key = await loadOrCreateNodeKey(input.stateDir, now)
  const secret = randomBytes(18).toString("base64url")
  const store = new FilePairingCodeStore(input.stateDir)
  const granting: EnrollmentCodeStore = {
    save: (code) => store.saveWithGrant(code, capabilities),
    consume: (consumeInput) => store.consume(consumeInput),
  }
  const issued = await issueEnrollmentCode(
    { meshId: PAIRING_MESH, issuedBy: input.issuedBy, now: now(), ttlMs: input.ttlMs, entropy: () => secret },
    granting,
  )
  if (!issued.ok) throw new PairingError(issued.error.message, issued.error.code)
  const url = config.bridge.public_url.replace(/\/+$/, "")
  return {
    code: encodePairingCode({ url, secret, keyId: key.keyId }),
    enrollmentId: issued.value.enrollmentId,
    expiresAt: issued.value.expiresAt,
    capabilities,
    keyId: key.keyId,
    url,
  }
}

function resolveGrantedCapabilities(config: BridgeConfig, requested: readonly string[] | undefined): readonly string[] {
  const profiles = Object.keys(config.capability_profiles ?? {})
  const wanted = (requested ?? []).map((c) => c.trim()).filter((c) => c !== "")
  if (wanted.length === 0) {
    if (profiles.includes("investigate")) return ["investigate"]
    throw new PairingError("Name the capabilities to grant, e.g. --capabilities investigate,run-tests.", "capabilities_required")
  }
  if ((config.runtime?.kind ?? "opencode") === "claude") {
    const unknown = wanted.filter((c) => !profiles.includes(c))
    if (unknown.length > 0) {
      throw new PairingError(
        `Unknown capability ${unknown.join(", ")}: this Claude worker defines ${profiles.join(", ") || "no capability_profiles"}.`,
        "capability_unknown",
      )
    }
  }
  return [...new Set(wanted)]
}

// ── wire shapes ─────────────────────────────────────────────────────────

const pairingRequestSchema = z
  .object({
    version: z.literal(1),
    secret: z.string().min(16).max(128),
    agent_id: z.string().min(1).max(128),
    public_key: z.string().min(1).max(128),
    display_name: z.string().max(256).optional(),
    callback_url: z.url().optional(),
  })
  .strict()

const pairingResponseSchema = z.object({
  version: z.literal(1),
  agent_id: z.string().min(1),
  public_key: z.string().min(1),
  key_id: z.string().min(1),
  capabilities: z.array(z.string()),
  bearer_token: z.string().min(1).nullable(),
  request_signing: z.enum(["off", "optional", "required"]),
  signature: z.string().min(1),
})

type PairingResponse = z.infer<typeof pairingResponseSchema>

function responseSigningBytes(response: Omit<PairingResponse, "signature">, orchestratorAgentId: string): Buffer {
  return Buffer.from(`${RESPONSE_SIGNATURE_DOMAIN}\n${digestJson({ ...response, orchestrator_agent_id: orchestratorAgentId })}`, "utf8")
}

// ── worker: accept (the /enroll endpoint) ───────────────────────────────

export interface PairingAcceptResult {
  readonly status: number
  readonly body: Record<string, unknown>
}

export interface PairingAcceptor {
  accept(request: FastifyRequest): Promise<PairingAcceptResult>
}

export interface PairingAcceptorOptions {
  /** The live config object the routes read; updated in place on success. */
  readonly config: BridgeConfig
  /** Profile config file to persist to; absent = in-memory only (tests). */
  readonly configPath?: string
  readonly stateDir: string
  readonly bearerToken: string | null
  readonly now?: () => number
  /**
   * The bridge log. A refused code is answered to the caller without detail
   * (that is the enumeration defence), so the reason is only ever written here.
   */
  readonly log?: (level: "info" | "warn" | "error", message: string) => void
}

export function createPairingAcceptor(options: PairingAcceptorOptions): PairingAcceptor {
  const now = options.now ?? Date.now
  const codes = new FilePairingCodeStore(options.stateDir)
  const peers = new FilePeerStore(options.stateDir)
  const proofNonces = new InMemoryNonceGuard()

  return {
    async accept(request) {
      const parsed = pairingRequestSchema.safeParse(request.body)
      if (!parsed.success) return fail(400, "pairing.invalid_request", "Invalid pairing request.")
      const body = parsed.data
      if (!isPairableAgentId(body.agent_id)) {
        return fail(400, "pairing.agent_id_invalid", `agent_id "${body.agent_id}" must match [A-Za-z0-9][A-Za-z0-9._:-]*.`)
      }
      if (body.agent_id === options.config.agent_id) {
        return fail(409, "pairing.self", "A node cannot pair with itself: the joining agent_id equals this worker's agent_id.")
      }
      const presented = publicNodeKeyFromBase64(body.public_key)
      if (!presented.ok) return fail(400, "pairing.public_key_invalid", presented.error.message)

      // Proof of possession: the request must be signed by the key it presents,
      // as the agent id it claims. Checked BEFORE the code is consumed.
      const nodeId = nodeIdSchema.parse(body.agent_id)
      const storedKey = fromBase64Url(presented.value.publicKey)
      const pop: IdentityProvider = {
        async authenticate(req) {
          if (req.signature.keyId !== presented.value.nodeKeyId) {
            return {
              ok: false,
              reason: "signature_invalid",
              error: createContractError("policy_denied", "pairing.key_id_mismatch", "The signing key id does not match the presented public key."),
            }
          }
          const verified = verifyMeshRequest(req.signature, { storedKey, expectedNodeId: nodeId, now: now(), replayGuard: proofNonces })
          if (!verified.ok) return verified
          return {
            ok: true,
            value: { nodeId, meshId: PAIRING_MESH, nodeKeyId: presented.value.nodeKeyId, fingerprint: presented.value.fingerprint, enrolledAt: now() },
          }
        },
      }
      const proof = await authenticateForRequest(request, { provider: pop, expectedNodeId: nodeId, expectedMeshId: PAIRING_MESH })
      if (!proof.ok) {
        return fail(401, "pairing.proof_failed", `The pairing request is not signed by the key it presents (${proof.error.message}).`)
      }

      const workerKey = await loadNodeKey(options.stateDir).catch(() => null)
      if (workerKey === null) {
        return fail(503, "pairing.no_node_key", "This worker has no node key. Run `aibr enroll issue` on it first.")
      }

      const verified = await verifyEnrollmentCode(
        {
          meshId: PAIRING_MESH,
          codeHash: sha256Digest(body.secret),
          nodePublicKey: presented.value.publicKey,
          provisionalNodeId: provisionalNodeIdSchema.parse(body.agent_id),
          now: now(),
        },
        codes,
      )
      if (!verified.ok && verified.error.code !== "identity.enrollment_code_rejected") {
        // The store could not be read or written. Answering "unknown code" here
        // sends the operator hunting for a copy/paste mistake that is not there.
        options.log?.("error", `pairing: the code store could not be used (${verified.error.code}): ${verified.error.message}`)
        return fail(
          503,
          "pairing.code_store_unavailable",
          "This worker could not read its pairing code store. Check `aibr logs` on the worker.",
        )
      }
      if (!verified.ok || verified.value.converged) {
        const reason = verified.ok ? "code_already_used" : verified.reason
        options.log?.(
          "warn",
          `pairing: refused a code from agent ${body.agent_id} (${reason}); store ${enrollmentCodesFileFor(options.stateDir)} ` +
            `holds ${await liveCodeCount(codes, now())} unused unexpired code(s)`,
        )
        if (reason === "code_expired") {
          return refuse(workerKey.keyId, "pairing.code_expired", "This pairing code has expired. Run `aibr enroll issue` on the worker for a new one.")
        }
        if (reason === "code_already_used") {
          return refuse(workerKey.keyId, "pairing.code_used", "This pairing code has already been used. Each code pairs exactly one node; issue a new one.")
        }
        return refuse(workerKey.keyId, "pairing.code_unknown", "Unknown pairing code. Check you copied the whole code, or issue a new one.")
      }

      const capabilities = await codes.grantFor(verified.value.enrollmentId)
      const pinned = await peers.pairPeer({
        agentId: body.agent_id,
        key: presented.value,
        enrollmentId: verified.value.enrollmentId,
        displayName: body.display_name ?? body.agent_id,
        now: now(),
      })
      if (!pinned.ok) return fail(500, pinned.error.code, pinned.error.message)

      const callbackUrl = body.callback_url
      try {
        await updateProfileConfig(options.configPath, (raw) => {
          upsertAllowedSource(raw, body.agent_id, capabilities)
          if (callbackUrl !== undefined) upsertAgent(raw, { id: body.agent_id, url: new URL(callbackUrl).origin, capabilities: [] }, { keepCapabilities: true })
        })
      } catch (error) {
        return fail(500, "pairing.config_write_failed", `The peer was pinned but the config could not be written (${error instanceof Error ? error.message : "unknown error"}).`)
      }
      // The routes read the live config object per request, so the new source is
      // authorised without a restart. Arrays are mutated in place because the
      // callback reporter holds a reference to `config.agents`.
      upsertAllowedSourceLive(options.config, body.agent_id, capabilities)
      if (callbackUrl !== undefined) upsertAgentLive(options.config, { id: body.agent_id, url: new URL(callbackUrl).origin, capabilities: [] })

      const unsigned: Omit<PairingResponse, "signature"> = {
        version: 1,
        agent_id: options.config.agent_id,
        public_key: workerKey.publicKey,
        key_id: workerKey.keyId,
        capabilities: [...capabilities],
        bearer_token: options.config.security.auth_mode === "none" ? null : options.bearerToken,
        request_signing: options.config.security.request_signing ?? "off",
      }
      const signature = workerKey.sign(responseSigningBytes(unsigned, body.agent_id)).toString("base64url")
      return { status: 200, body: { ...unsigned, signature } }
    },
  }
}

/**
 * A refused code. The worker's key id rides along so the joining side can tell
 * "wrong code" from "wrong bridge": the key id is already public (it is part of
 * every code this worker prints), and it says nothing about the code.
 */
function refuse(keyId: string, code: string, error: string): PairingAcceptResult {
  return { status: 403, body: { error, code, key_id: keyId } }
}

async function liveCodeCount(codes: FilePairingCodeStore, at: number): Promise<number | string> {
  try {
    return (await codes.list()).filter((c) => c.redeemedNodeId === undefined && c.expiresAt > at).length
  } catch {
    return "an unreadable number of"
  }
}

function fail(status: number, code: string, error: string): PairingAcceptResult {
  return { status, body: { error, code } }
}

// ── orchestrator: join ─────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface JoinResult {
  readonly agent: { readonly id: string; readonly url: string; readonly capabilities: readonly string[] }
  /** The worker's bearer token. Store it; never print it. */
  readonly bearerToken: string | null
  readonly workerKeyId: string
  readonly workerFingerprint: string
  readonly requestSigning: RequestSigningMode
  readonly ownKeyId: string
}

export async function joinWithPairingCode(input: {
  readonly code: string
  readonly agentId: string
  readonly stateDir: string
  readonly displayName?: string
  /** This node's bridge URL, when it runs one, so the worker can deliver /report. */
  readonly callbackUrl?: string
  readonly fetch?: FetchLike
  readonly now?: () => number
  readonly timeoutMs?: number
}): Promise<JoinResult> {
  const decoded = decodePairingCode(input.code)
  if (!decoded.ok) throw new PairingError(decoded.error, "code_malformed")
  const code = decoded.value
  if (!isPairableAgentId(input.agentId)) {
    throw new PairingError(`This profile's agent_id "${input.agentId}" must match [A-Za-z0-9][A-Za-z0-9._:-]* to pair.`, "agent_id_invalid")
  }
  const now = input.now ?? Date.now
  const key: NodeKeyPair = await loadOrCreateNodeKey(input.stateDir, now)
  const body = {
    version: 1 as const,
    secret: code.secret,
    agent_id: input.agentId,
    public_key: key.publicKey,
    ...(input.displayName !== undefined ? { display_name: input.displayName.slice(0, 256) } : {}),
    ...(input.callbackUrl !== undefined ? { callback_url: input.callbackUrl } : {}),
  }
  const url = `${code.url}${ENROLL_PATH}`
  const headers = {
    "content-type": "application/json",
    ...signedRequestHeaders({ key, agentId: input.agentId, method: "POST", url, body, now: now() }),
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000)
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal })
  } catch (error) {
    const reason = controller.signal.aborted ? "timed out" : error instanceof Error ? error.message : String(error)
    throw new PairingError(`Could not reach the worker at ${code.url} (${reason}). Is its bridge running and reachable over the tailnet?`, "unreachable")
  } finally {
    clearTimeout(timer)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }
  if (!response.ok) {
    const record = (payload ?? {}) as { error?: unknown; code?: unknown }
    const message = typeof record.error === "string" ? record.error : `HTTP ${response.status}`
    if (response.status === 404) {
      throw new PairingError(`The worker at ${code.url} does not serve ${ENROLL_PATH} (HTTP 404): update aibr there and restart its bridge.`, "not_supported")
    }
    const answeredKey = (payload as { key_id?: unknown } | null)?.key_id
    if (typeof answeredKey === "string" && answeredKey !== code.keyId) {
      throw new PairingError(
        `The bridge answering at ${code.url} is not the one that printed this code (its key is ${answeredKey}, the code's is ${code.keyId}). ` +
          `Another AIBridge bridge (another profile, or another user on that machine) holds that address, so the worker that issued the code is not listening. ` +
          `On the worker, run "aibr doctor --profile <profile>" and free the port or give the profile another one.`,
        "wrong_bridge",
      )
    }
    throw new PairingError(`The worker refused the pairing: ${message}`, typeof record.code === "string" ? record.code : "refused")
  }
  const parsed = pairingResponseSchema.safeParse(payload)
  if (!parsed.success) throw new PairingError("The worker sent an invalid pairing response.", "invalid_response")
  const reply = parsed.data
  const workerKey = publicNodeKeyFromBase64(reply.public_key)
  if (!workerKey.ok || workerKey.value.nodeKeyId !== code.keyId || reply.key_id !== code.keyId) {
    throw new PairingError(
      "The node that answered is not the worker that printed this code (its key does not match the code). Nothing was saved.",
      "key_mismatch",
    )
  }
  const { signature, ...unsigned } = reply
  const signatureOk = verifyRawSignature(workerKey.value.publicKey, responseSigningBytes(unsigned, input.agentId), signature)
  if (!signatureOk) throw new PairingError("The pairing response is not signed by the worker's key. Nothing was saved.", "signature_invalid")
  if (!isPairableAgentId(reply.agent_id)) throw new PairingError(`The worker's agent_id "${reply.agent_id}" is not a valid wire id.`, "invalid_response")

  const peers = new FilePeerStore(input.stateDir)
  const pinned = await peers.pairPeer({
    agentId: reply.agent_id,
    key: workerKey.value,
    enrollmentId: `join-${randomBytes(8).toString("hex")}`,
    displayName: reply.agent_id,
    now: now(),
  })
  if (!pinned.ok) throw new PairingError(pinned.error.message, pinned.error.code)

  return {
    agent: { id: reply.agent_id, url: code.url, capabilities: reply.capabilities },
    bearerToken: reply.bearer_token,
    workerKeyId: workerKey.value.nodeKeyId,
    workerFingerprint: workerKey.value.fingerprint,
    requestSigning: reply.request_signing,
    ownKeyId: key.keyId,
  }
}

function verifyRawSignature(publicKey: string, message: Buffer, signature: string): boolean {
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), fromBase64Url(publicKey)])
    return edVerify(null, message, createPublicKey({ key: spki, format: "der", type: "spki" }), fromBase64Url(signature))
  } catch {
    return false
  }
}

// ── orchestrator: persist the join ─────────────────────────────────────

export interface AppliedJoin {
  readonly notes: readonly string[]
}

/**
 * Writes a successful join into the orchestrator profile: `agents[]` entry for
 * the worker, `allowed_sources[]` entry (no capabilities) when this node runs a
 * bridge that receives the worker's `/report`, and the bearer token at
 * `secrets/peers/<worker>.bearer_token` (+ `secrets/bearer_token` when absent).
 */
export async function applyJoinToProfile(input: {
  readonly paths: ProfilePaths
  readonly configPath: string
  readonly join: JoinResult
}): Promise<AppliedJoin> {
  const notes: string[] = []
  let role = "worker"
  let authMode = "bearer-token"
  await updateProfileConfig(input.configPath, (raw) => {
    role = typeof raw.role === "string" ? raw.role : "worker"
    const security = raw.security as Record<string, unknown> | undefined
    authMode = typeof security?.auth_mode === "string" ? security.auth_mode : "bearer-token"
    upsertAgent(raw, { id: input.join.agent.id, url: input.join.agent.url, capabilities: [...input.join.agent.capabilities] }, { keepCapabilities: false })
    if (role !== "orchestrator") ensureAllowedSource(raw, input.join.agent.id)
  })
  await storePeerBearerToken(input.paths, input.join.agent.id, input.join.bearerToken)
  if (input.join.bearerToken !== null && authMode === "bearer-token") {
    const sharedPath = `${input.paths.secretsDir}/bearer_token`
    if (!(await exists(sharedPath))) {
      await writePrivateFile(sharedPath, input.join.bearerToken)
    } else if (role !== "orchestrator") {
      notes.push(
        "This profile already had its own bearer token; reports from the worker are sent with the worker's token, so keep both nodes on one token or set auth_mode accordingly.",
      )
    }
  }
  return { notes }
}

export async function storePeerBearerToken(paths: ProfilePaths, peerId: string, token: string | null): Promise<void> {
  const path = peerBearerTokenPath(paths.secretsDir, peerId)
  if (token === null) {
    await unlink(path).catch(() => undefined)
    return
  }
  await writePrivateFile(path, token)
}

// ── revoke / list ──────────────────────────────────────────────────────

export async function revokePeer(input: {
  readonly paths: ProfilePaths
  readonly configPath: string
  readonly agentId: string
  readonly by: string
  readonly now?: () => number
}): Promise<{ readonly pinRemoved: boolean; readonly configChanged: boolean }> {
  const peers = new FilePeerStore(input.paths.stateDir)
  const revoked = await peers.revokePeer({ agentId: input.agentId, by: input.by, reason: "aibr enroll revoke", now: (input.now ?? Date.now)() })
  if (!revoked.ok) throw new PairingError(revoked.error.message, revoked.error.code)
  let configChanged = false
  await updateProfileConfig(input.configPath, (raw) => {
    const agents = Array.isArray(raw.agents) ? raw.agents : []
    const security = (raw.security ?? {}) as Record<string, unknown>
    const sources = Array.isArray(security.allowed_sources) ? security.allowed_sources : []
    const keptAgents = agents.filter((a) => (a as { id?: unknown }).id !== input.agentId)
    const keptSources = sources.filter((s) => (s as { source_agent_id?: unknown }).source_agent_id !== input.agentId)
    configChanged = keptAgents.length !== agents.length || keptSources.length !== sources.length
    raw.agents = keptAgents
    raw.security = { ...security, allowed_sources: keptSources }
  })
  await unlink(peerBearerTokenPath(input.paths.secretsDir, input.agentId)).catch(() => undefined)
  return { pinRemoved: revoked.value, configChanged }
}

// ── config helpers ─────────────────────────────────────────────────────

async function updateProfileConfig(configPath: string | undefined, mutate: (raw: Record<string, unknown>) => void): Promise<void> {
  if (configPath === undefined) return
  const raw = await readConfig(configPath)
  if (raw === null) throw new Error(`No config at ${configPath}; run \`aibr setup\` first.`)
  mutate(raw)
  await writeConfig(configPath, raw)
}

function sourcesOf(raw: Record<string, unknown>): Record<string, unknown>[] {
  const security = (typeof raw.security === "object" && raw.security !== null ? raw.security : {}) as Record<string, unknown>
  raw.security = security
  if (!Array.isArray(security.allowed_sources)) security.allowed_sources = []
  return security.allowed_sources as Record<string, unknown>[]
}

function upsertAllowedSource(raw: Record<string, unknown>, agentId: string, capabilities: readonly string[]): void {
  const sources = sourcesOf(raw)
  const existing = sources.find((s) => s.source_agent_id === agentId)
  if (existing !== undefined) {
    existing.capabilities = [...capabilities]
  } else {
    sources.push({ source_agent_id: agentId, capabilities: [...capabilities], requires_plan_approval: [] })
  }
}

function ensureAllowedSource(raw: Record<string, unknown>, agentId: string): void {
  const sources = sourcesOf(raw)
  if (!sources.some((s) => s.source_agent_id === agentId)) {
    sources.push({ source_agent_id: agentId, capabilities: [], requires_plan_approval: [] })
  }
}

function upsertAgent(
  raw: Record<string, unknown>,
  agent: { id: string; url: string; capabilities: string[] },
  options: { keepCapabilities: boolean },
): void {
  if (!Array.isArray(raw.agents)) raw.agents = []
  const agents = raw.agents as Record<string, unknown>[]
  const existing = agents.find((a) => a.id === agent.id)
  if (existing !== undefined) {
    existing.url = agent.url
    if (!options.keepCapabilities || !Array.isArray(existing.capabilities)) existing.capabilities = agent.capabilities
  } else {
    agents.push({ ...agent })
  }
}

function upsertAllowedSourceLive(config: BridgeConfig, agentId: string, capabilities: readonly string[]): void {
  const sources = config.security.allowed_sources
  const index = sources.findIndex((s) => s.source_agent_id === agentId)
  const entry = { source_agent_id: agentId, capabilities: [...capabilities], requires_plan_approval: index >= 0 ? sources[index]!.requires_plan_approval : [] }
  if (index >= 0) sources.splice(index, 1, entry)
  else sources.push(entry)
}

function upsertAgentLive(config: BridgeConfig, agent: { id: string; url: string; capabilities: string[] }): void {
  const index = config.agents.findIndex((a) => a.id === agent.id)
  if (index >= 0) config.agents.splice(index, 1, { ...config.agents[index]!, url: agent.url })
  else config.agents.push(agent)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
