/**
 * The AIBridge MCP tool set: how an orchestrator agent (Claude Code, Codex,
 * OpenCode or any MCP client) talks to remote AIBridge worker nodes over the
 * HTTP contract (`POST /trigger`, `GET /jobs/:id`, `GET /jobs/:id/events`,
 * `POST /jobs/:id/cancel`, `GET /health`).
 *
 * Boundaries worth knowing:
 *  - There is deliberately NO approve, reject or stop-all tool. Approval and
 *    the node-wide kill switch are operator-only (ADR 0013, 0014, 0015).
 *    `bridge_cancel` only ends a job this node dispatched; it is not an
 *    approval action.
 *  - The bearer token is read from the profile secret file at call time and is
 *    never returned: every string leaving this module goes through `redact`.
 */
import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { bridgeConfigSchema } from "../config/schemas.js"
import { resolveProfilePaths, validateProfileName, type ProfilePaths } from "../host/paths.js"
import { prepareSignedRequest } from "./signed-http.js"
import { PING_CAPABILITY } from "../jobs/ping.js"
import type { PongInfo } from "../jobs/types.js"

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface BridgeToolDeps {
  readonly fetch: FetchLike
  readonly env: Readonly<Record<string, string | undefined>>
  readonly readFile: (path: string) => Promise<string>
  readonly listProfileDirs: (configRoot: string) => Promise<readonly string[]>
  readonly writeFile: (path: string, data: string) => Promise<void>
  readonly uuid: () => string
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

export function defaultBridgeToolDeps(): BridgeToolDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    readFile: (path) => readFile(path, "utf8"),
    listProfileDirs: async (root) => {
      try {
        const entries = await readdir(root, { withFileTypes: true })
        return entries.filter((e) => e.isDirectory()).map((e) => e.name)
      } catch {
        return []
      }
    },
    writeFile: async (path, data) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, data, { mode: 0o600 })
    },
    uuid: () => randomUUID(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export interface ToolResult {
  readonly content: readonly { type: "text"; text: string }[]
  readonly isError?: boolean
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "timed_out", "callback_failed"])

/**
 * What to tell the model about a job held for operator approval on the worker.
 * There is deliberately no approve tool: only a human on that node can approve.
 */
export function awaitingApprovalHint(jobId: string, target: string, approveHint: unknown): string {
  // The peer's hint is used only when it is exactly a plain approve command.
  const plain = /^aibr approve [A-Za-z0-9._:-]+(?: --profile [a-z0-9-]+)?$/
  const command = typeof approveHint === "string" && plain.test(approveHint) ? approveHint : `aibr approve ${jobId}`
  return `Awaiting operator approval on ${target}; ask the user to run \`${command}\` there. Do not re-dispatch; call bridge_await after they approve.`
}
export const MAX_AWAIT_SECONDS = 120
export const DEFAULT_AWAIT_SECONDS = 60
const POLL_INTERVAL_MS = 2000
const HEALTH_TIMEOUT_MS = 3000
const HTTP_TIMEOUT_MS = 15000
const DEFAULT_JOB_TIMEOUT_SECONDS = 900
const LEDGER_LIMIT = 20
const MAX_EVENTS_PAGE = 200
/** The worker waits up to 15 s for a running job to stop before answering. */
const CANCEL_TIMEOUT_MS = 30_000

class ToolError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly hint?: string,
  ) {
    super(message)
  }
}

function jobSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      job_id: { type: "string" },
      target: { type: "string", description: "Peer id the job was dispatched to." },
    },
    required: ["job_id", "target"],
    additionalProperties: false,
  }
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "bridge_peers",
    description:
      "List the remote AIBridge worker nodes enrolled in this profile, with live reachability. Call this first to learn valid `target` ids and the capabilities each peer advertises.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bridge_dispatch",
    description:
      "Send a task to a remote worker node (POST /trigger). Returns a job_id immediately; the work runs asynchronously. Push your branch first and put the branch and commit sha in the prompt. Prefer capability `investigate` (read-only) unless the user wants changes. Then poll with bridge_await.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Peer id from bridge_peers." },
        capability: { type: "string", description: "A capability the peer advertises, e.g. investigate, run-tests, fix-on-branch." },
        project_dir: { type: "string", description: "Project directory on the worker (must be allowlisted there)." },
        prompt: { type: "string", description: "Self-contained task description including branch and sha." },
        timeout_seconds: { type: "integer", minimum: 1, description: "Worker-side job timeout. Default 900." },
      },
      required: ["target", "capability", "project_dir", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_status",
    description: "Get the current status of a dispatched job (one HTTP call, does not wait).",
    inputSchema: jobSchema(),
  },
  {
    name: "bridge_result",
    description:
      "Get the outcome of a job: status plus summary and findings when the worker reported them. Call after bridge_await reports a final status. A failed job whose error starts with \"interrupted: bridge restarted\" was cut off when the worker's bridge restarted: it may have partly run (changed files, run commands) and is never retried automatically, so check its effects and decide whether to dispatch it again. An error starting with \"not relaunched after restart\" means the job never started (the reason follows); dispatching it again is safe if it is still wanted.",
    inputSchema: jobSchema(),
  },
  {
    name: "bridge_await",
    description:
      "Wait for a job to reach a final status, polling every 2 s for up to timeout_s (max 120, default 60). If it is still running, returns still_running=true: call bridge_await again.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        target: { type: "string", description: "Peer id the job was dispatched to." },
        timeout_s: { type: "integer", minimum: 1, maximum: MAX_AWAIT_SECONDS, description: "Default 60, capped at 120." },
      },
      required: ["job_id", "target"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_events",
    description:
      "Read what a dispatched job has done so far, in order: status changes, messages, tool use and the final result (secrets are redacted on the worker). Returns one page of events and `next`; pass `next` back as `after` to read on. `final: true` means the job has ended and this page reaches its last event, so there is nothing more to read; `final: false` with an ended `status` means read on. Use it to follow a long job between bridge_await calls or to see why a job failed.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        target: { type: "string", description: "Peer id the job was dispatched to." },
        after: { type: "integer", minimum: 0, description: "Return events after this sequence number (the `next` of the previous page). Default 0." },
        limit: { type: "integer", minimum: 1, maximum: MAX_EVENTS_PAGE, description: `Events per page. Default 100, at most ${MAX_EVENTS_PAGE}.` },
      },
      required: ["job_id", "target"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_cancel",
    description:
      "Cancel a job you dispatched: the worker stops it and it ends `failed` with error \"cancelled by requester\"; its report is delivered as for any finished job. Only the node that dispatched a job can cancel it. A job that has already ended, or that is still waiting for the operator's approval, cannot be cancelled (the operator rejects those). Cancelling cannot be undone: dispatch again if the work is still wanted.",
    inputSchema: jobSchema(),
  },
]

export interface LoadedProfile {
  readonly name: string
  readonly paths: ProfilePaths
  readonly config: ReturnType<typeof bridgeConfigSchema.parse>
}

export interface LedgerEntry {
  job_id: string
  target: string
  at: string
}

export function parseLedger(raw: string): LedgerEntry[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (e): e is LedgerEntry =>
      !!e && typeof e === "object" && typeof (e as LedgerEntry).job_id === "string" && typeof (e as LedgerEntry).target === "string",
  )
}

export class BridgeTools {
  private readonly secretsToRedact: string[] = []

  constructor(
    private readonly deps: BridgeToolDeps,
    private readonly profileArg: string | undefined,
  ) {}

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const data = await this.run(name, args)
      return { content: [{ type: "text", text: this.redact(JSON.stringify(data, null, 2)) }] }
    } catch (error) {
      const err = error instanceof ToolError ? error : undefined
      const payload: Record<string, unknown> = {
        error: this.redact(error instanceof Error ? error.message : String(error)),
      }
      if (err?.code) payload.code = err.code
      if (err?.hint) payload.hint = err.hint
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true }
    }
  }

  private async run(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "bridge_peers":
        return this.peers()
      case "bridge_dispatch":
        return this.dispatchJob(args)
      case "bridge_status":
        return this.status(str(args, "job_id"), str(args, "target"))
      case "bridge_result":
        return this.result(str(args, "job_id"), str(args, "target"))
      case "bridge_await":
        return this.awaitJob(str(args, "job_id"), str(args, "target"), args.timeout_s)
      case "bridge_events":
        return this.events(str(args, "job_id"), str(args, "target"), args.after, args.limit)
      case "bridge_cancel":
        return this.cancel(str(args, "job_id"), str(args, "target"))
      default:
        throw new ToolError(`Unknown tool: ${name}`)
    }
  }

  // ── profile ────────────────────────────────────────────────────────

  async resolveProfileName(): Promise<string> {
    const explicit = (this.profileArg ?? "").trim() || (this.deps.env.AIBR_PROFILE ?? "").trim()
    if (explicit) return validateProfileName(explicit)
    const root = dirname(resolveProfilePaths("probe", this.deps.env).configDir)
    const dirs = await this.deps.listProfileDirs(root)
    const found: string[] = []
    for (const dir of dirs) {
      try {
        validateProfileName(dir)
        await this.deps.readFile(join(root, dir, "config.json"))
        found.push(dir)
      } catch {
        // not a profile
      }
    }
    if (found.length === 1) return found[0] as string
    if (found.length === 0) {
      throw new ToolError("No AIBridge profile found. Run the AIBridge setup first, or set the plugin's `profile` option.", "no_profile")
    }
    throw new ToolError(
      `Multiple AIBridge profiles exist (${found.sort().join(", ")}). Set the plugin's \`profile\` option or AIBR_PROFILE.`,
      "ambiguous_profile",
    )
  }

  async loadProfile(): Promise<LoadedProfile> {
    const name = await this.resolveProfileName()
    const paths = resolveProfilePaths(name, this.deps.env)
    let raw: string
    try {
      raw = await this.deps.readFile(join(paths.configDir, "config.json"))
    } catch {
      throw new ToolError(`Profile "${name}" has no readable config.json.`, "no_profile")
    }
    let config: LoadedProfile["config"]
    try {
      config = bridgeConfigSchema.parse(JSON.parse(raw))
    } catch {
      throw new ToolError(`Profile "${name}" config.json is invalid.`, "invalid_config")
    }
    return { name, paths, config }
  }

  private async token(profile: LoadedProfile): Promise<string | undefined> {
    if (profile.config.security.auth_mode === "none") return undefined
    try {
      const token = (await this.deps.readFile(join(profile.paths.secretsDir, "bearer_token"))).trim()
      if (token) {
        if (!this.secretsToRedact.includes(token)) this.secretsToRedact.push(token)
        return token
      }
    } catch {
      // fall through
    }
    throw new ToolError(`Profile "${profile.name}" has no bearer token; run the AIBridge setup.`, "no_token")
  }

  private redact(text: string): string {
    let out = text
    for (const secret of this.secretsToRedact) out = out.split(secret).join("[redacted]")
    return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
  }

  private findPeer(profile: LoadedProfile, target: string) {
    const peer = profile.config.agents.find((a) => a.id === target)
    if (!peer) {
      const known = profile.config.agents.map((a) => a.id).join(", ") || "none"
      throw new ToolError(`Unknown peer "${target}". Enrolled peers: ${known}.`, "unknown_peer")
    }
    return peer
  }

  /** `signAs`: sign with the profile's node key and use its per-peer token (Phase 3). */
  private async http(url: string, init: RequestInit, timeoutMs: number, signAs?: LoadedProfile): Promise<Response> {
    if (signAs !== undefined) {
      const prepared = await prepareSignedRequest(signAs, url, init, this.deps)
      for (const secret of prepared.secrets) if (!this.secretsToRedact.includes(secret)) this.secretsToRedact.push(secret)
      init = prepared.init
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await this.deps.fetch(url, { ...init, signal: controller.signal })
    } catch (error) {
      const reason = controller.signal.aborted ? "timed out" : error instanceof Error ? error.message : String(error)
      throw new ToolError(`Request to ${urlOrigin(url)} failed: ${reason}`, "unreachable")
    } finally {
      clearTimeout(timer)
    }
  }

  private async authHeaders(profile: LoadedProfile): Promise<Record<string, string>> {
    const token = await this.token(profile)
    return token ? { authorization: `Bearer ${token}` } : {}
  }

  // ── tools ──────────────────────────────────────────────────────────

  private async peers(): Promise<unknown> {
    const profile = await this.loadProfile()
    const peers = await Promise.all(
      profile.config.agents.map(async (peer) => {
        const base = { id: peer.id, url: peer.url, capabilities: peer.capabilities }
        try {
          const response = await this.http(`${trimSlash(peer.url)}/health`, { method: "GET" }, HEALTH_TIMEOUT_MS)
          if (!response.ok) return { ...base, reachable: false, runtime: null, note: `health returned HTTP ${response.status}` }
          const body = (await response.json()) as { opencode?: boolean; runtime?: string; agent_id?: string }
          // A Claude worker's /health says `runtime: "claude"` and has no `opencode`
          // field; only an OpenCode worker reports opencode up/down.
          const runtime =
            typeof body.runtime === "string" && body.runtime !== "opencode"
              ? body.runtime
              : body.opencode === true ? "opencode (up)" : "opencode (down)"
          return {
            ...base,
            reachable: true,
            runtime,
            ...(typeof body.agent_id === "string" && body.agent_id !== peer.id ? { note: `peer identifies itself as ${body.agent_id}` } : {}),
          }
        } catch {
          return { ...base, reachable: false, runtime: null }
        }
      }),
    )
    return { profile: profile.name, own_agent_id: profile.config.agent_id, peers }
  }

  private async dispatchJob(args: Record<string, unknown>): Promise<unknown> {
    const target = str(args, "target")
    const capability = str(args, "capability")
    const projectDir = str(args, "project_dir")
    const prompt = str(args, "prompt")
    const timeout = args.timeout_seconds === undefined ? DEFAULT_JOB_TIMEOUT_SECONDS : args.timeout_seconds
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) {
      throw new ToolError("timeout_seconds must be a positive integer.", "invalid_argument")
    }
    const profile = await this.loadProfile()
    const peer = this.findPeer(profile, target)
    if (!peer.capabilities.includes(capability)) {
      throw new ToolError(
        `Peer "${target}" does not advertise capability "${capability}". Advertised: ${peer.capabilities.join(", ") || "none"}.`,
        "capability_not_advertised",
      )
    }
    const jobId = this.deps.uuid()
    const body = {
      job_id: jobId,
      source_agent_id: profile.config.agent_id,
      target_agent_id: peer.id,
      capability,
      project_dir: projectDir,
      prompt,
      callback_url: `${trimSlash(profile.config.bridge.public_url)}/report`,
      timeout_seconds: timeout,
    }
    const response = await this.http(
      `${trimSlash(peer.url)}/trigger`,
      { method: "POST", headers: { "content-type": "application/json", ...(await this.authHeaders(profile)) }, body: JSON.stringify(body) },
      HTTP_TIMEOUT_MS,
      profile,
    )
    const payload = await readJson(response)
    if (!response.ok) throw dispatchError(response.status, payload)
    const returnedId = typeof payload.job_id === "string" ? payload.job_id : jobId
    await this.recordJob(profile, returnedId, target)
    return {
      job_id: returnedId,
      target,
      status: typeof payload.status === "string" ? payload.status : "accepted",
      status_url: typeof payload.status_url === "string" ? payload.status_url : `${trimSlash(peer.url)}/jobs/${returnedId}`,
      ...(typeof payload.sha === "string" ? { sha: payload.sha } : {}),
      ...(payload.status === "awaiting_approval" ? { message: awaitingApprovalHint(returnedId, target, payload.approve_hint) } : {}),
    }
  }

  private async fetchJob(jobId: string, target: string): Promise<Record<string, unknown>> {
    const profile = await this.loadProfile()
    const peer = this.findPeer(profile, target)
    const response = await this.http(
      `${trimSlash(peer.url)}/jobs/${encodeURIComponent(jobId)}`,
      { method: "GET", headers: await this.authHeaders(profile) },
      HTTP_TIMEOUT_MS,
      profile,
    )
    if (response.status === 404) throw new ToolError(`Job ${jobId} not found on ${target}.`, "job_not_found")
    if (!response.ok) throw new ToolError(`Status lookup failed (HTTP ${response.status}).`, "status_failed")
    return readJson(response)
  }

  private async status(jobId: string, target: string): Promise<unknown> {
    const job = await this.fetchJob(jobId, target)
    return {
      job_id: jobId,
      target,
      status: job.status,
      final: typeof job.status === "string" && TERMINAL_STATUSES.has(job.status),
      ...(typeof job.error === "string" ? { error: job.error } : {}),
      updated_at: job.updatedAt,
    }
  }

  private shapeResult(jobId: string, target: string, job: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {
      job_id: jobId,
      target,
      status: job.status,
      final: typeof job.status === "string" && TERMINAL_STATUSES.has(job.status),
    }
    for (const key of ["summary", "findings", "artifacts", "error", "started_at", "finished_at"]) {
      if (job[key] !== undefined) out[key] = job[key]
    }
    // Some bridge versions nest the worker's report under `report`/`result`.
    for (const key of ["report", "result"]) {
      const nested = job[key]
      if (nested && typeof nested === "object") {
        for (const inner of ["summary", "findings", "artifacts"]) {
          const value = (nested as Record<string, unknown>)[inner]
          if (value !== undefined && out[inner] === undefined) out[inner] = value
        }
      }
    }
    if (out.summary === undefined && out.findings === undefined) {
      out.note = out.final
        ? "This bridge version did not store a summary or findings for the job; only the status is available."
        : "Job is not finished yet; call bridge_await."
    }
    return out
  }

  private async result(jobId: string, target: string): Promise<unknown> {
    return this.shapeResult(jobId, target, await this.fetchJob(jobId, target))
  }

  private async awaitJob(jobId: string, target: string, timeoutArg: unknown): Promise<unknown> {
    let timeoutS = DEFAULT_AWAIT_SECONDS
    if (timeoutArg !== undefined) {
      if (typeof timeoutArg !== "number" || !Number.isFinite(timeoutArg) || timeoutArg <= 0) {
        throw new ToolError("timeout_s must be a positive number.", "invalid_argument")
      }
      timeoutS = Math.min(timeoutArg, MAX_AWAIT_SECONDS)
    }
    const deadline = this.deps.now() + timeoutS * 1000
    for (;;) {
      const job = await this.fetchJob(jobId, target)
      const status = typeof job.status === "string" ? job.status : "unknown"
      if (TERMINAL_STATUSES.has(status)) return { ...this.shapeResult(jobId, target, job), still_running: false }
      // Not final, but waiting on a human: polling longer will not change it.
      if (status === "awaiting_approval") {
        return { job_id: jobId, target, status, still_running: true, message: awaitingApprovalHint(jobId, target, undefined) }
      }
      const remaining = deadline - this.deps.now()
      if (remaining <= 0) {
        return { job_id: jobId, target, status, still_running: true, message: "Still running. Call bridge_await again." }
      }
      await this.deps.sleep(Math.min(POLL_INTERVAL_MS, remaining))
    }
  }

  private async events(jobId: string, target: string, afterArg: unknown, limitArg: unknown): Promise<unknown> {
    const after = afterArg === undefined ? 0 : afterArg
    if (typeof after !== "number" || !Number.isInteger(after) || after < 0) {
      throw new ToolError("after must be a non-negative integer.", "invalid_argument")
    }
    const limit = limitArg === undefined ? 100 : limitArg
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
      throw new ToolError("limit must be a positive integer.", "invalid_argument")
    }
    const profile = await this.loadProfile()
    const peer = this.findPeer(profile, target)
    const query = `after=${after}&limit=${Math.min(limit, MAX_EVENTS_PAGE)}`
    const response = await this.http(
      `${trimSlash(peer.url)}/jobs/${encodeURIComponent(jobId)}/events?${query}`,
      { method: "GET", headers: { accept: "application/json", ...(await this.authHeaders(profile)) } },
      HTTP_TIMEOUT_MS,
      profile,
    )
    const payload = await readJson(response)
    if (!response.ok) throw jobApiError(response.status, payload, jobId, target, "events")
    const status = typeof payload.status === "string" ? payload.status : "unknown"
    return {
      job_id: jobId,
      target,
      status,
      // The worker decides: an ended job whose page misses its last events is not final yet.
      final: typeof payload.final === "boolean" ? payload.final && TERMINAL_STATUSES.has(status) : false,
      events: Array.isArray(payload.events) ? payload.events : [],
      next: typeof payload.next === "number" ? payload.next : after,
    }
  }

  private async cancel(jobId: string, target: string): Promise<unknown> {
    const profile = await this.loadProfile()
    const peer = this.findPeer(profile, target)
    const response = await this.http(
      `${trimSlash(peer.url)}/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST", headers: await this.authHeaders(profile) },
      CANCEL_TIMEOUT_MS,
      profile,
    )
    const payload = await readJson(response)
    if (response.status === 200) {
      return {
        job_id: jobId,
        target,
        cancelled: true,
        status: typeof payload.status === "string" ? payload.status : "failed",
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      }
    }
    if (response.status === 202) {
      return {
        job_id: jobId,
        target,
        cancelled: false,
        cancelling: true,
        status: typeof payload.status === "string" ? payload.status : "unknown",
        message: "The worker is stopping the job. Call bridge_await to see it end.",
      }
    }
    throw jobApiError(response.status, payload, jobId, target, "cancel")
  }

  // ── ping (aibr ping / aibr doctor) ─────────────────────────────────

  /**
   * Sends a signed no-op job (capability `aibr.ping`, src/jobs/ping.ts) and
   * waits for it to complete and — when this node runs a bridge that can
   * receive it — for the worker's `/report` callback to be delivered.
   * Never throws: every failure is a `PingOutcome` naming the stage it hit.
   */
  async ping(
    target: string,
    options: { readonly timeoutMs?: number; readonly waitForCallback?: boolean } = {},
  ): Promise<PingOutcome> {
    const started = this.deps.now()
    const timeoutMs = options.timeoutMs ?? DEFAULT_PING_TIMEOUT_MS
    let profile: LoadedProfile
    let peer: { id: string; url: string; capabilities: string[] }
    try {
      profile = await this.loadProfile()
      peer = this.findPeer(profile, target)
    } catch (error) {
      return this.pingFailure(target, null, "profile", error, started)
    }
    const expectCallback = profile.config.role !== "orchestrator" && options.waitForCallback !== false
    const jobId = `ping-${this.deps.uuid()}`
    const body = {
      job_id: jobId,
      source_agent_id: profile.config.agent_id,
      target_agent_id: peer.id,
      capability: PING_CAPABILITY,
      project_dir: "/",
      prompt: "aibr ping (no-op)",
      callback_url: `${trimSlash(profile.config.bridge.public_url)}/report`,
      timeout_seconds: 60,
    }
    try {
      const response = await this.http(
        `${trimSlash(peer.url)}/trigger`,
        { method: "POST", headers: { "content-type": "application/json", ...(await this.authHeaders(profile)) }, body: JSON.stringify(body) },
        HTTP_TIMEOUT_MS,
        profile,
      )
      const payload = await readJson(response)
      if (!response.ok) {
        const message = typeof payload.error === "string" ? payload.error : ""
        if (response.status === 403 && message.includes(`capability ${PING_CAPABILITY}`)) {
          throw new ToolError(
            `Peer "${peer.id}" authenticated this node but does not know ${PING_CAPABILITY} (HTTP 403): it runs an older aibr.`,
            "ping_unsupported",
            `Update aibr on ${peer.id} and restart its bridge (aibr start there).`,
          )
        }
        throw dispatchError(response.status, payload)
      }
    } catch (error) {
      return this.pingFailure(target, peer.url, "dispatch", error, started)
    }

    const deadline = started + timeoutMs
    let job: Record<string, unknown> = {}
    for (;;) {
      try {
        job = await this.fetchJob(jobId, target)
      } catch (error) {
        return this.pingFailure(target, peer.url, "job", error, started, jobId)
      }
      const status = typeof job.status === "string" ? job.status : "unknown"
      const delivery = (job.callbackDelivery ?? {}) as { status?: unknown; error?: unknown }
      const settled = !expectCallback || delivery.status === "delivered" || delivery.status === "failed"
      if (TERMINAL_STATUSES.has(status) && settled) break
      if (this.deps.now() >= deadline) break
      await this.deps.sleep(PING_POLL_INTERVAL_MS)
    }

    const status = typeof job.status === "string" ? job.status : "unknown"
    const rttMs = this.deps.now() - started
    const pong = isPong(job.pong) ? job.pong : undefined
    if (status !== "completed") {
      return {
        ok: false,
        target,
        url: peer.url,
        jobId,
        stage: "job",
        rttMs,
        error: this.redact(
          TERMINAL_STATUSES.has(status)
            ? `The ping job ended ${status}${typeof job.error === "string" ? `: ${job.error}` : ""}.`
            : `The ping job did not complete within ${Math.round(timeoutMs / 1000)}s (status ${status}).`,
        ),
        code: "ping_incomplete",
        callback: { status: "unknown" },
        ...(pong !== undefined ? { pong } : {}),
      }
    }
    const delivery = (job.callbackDelivery ?? {}) as { status?: unknown; error?: unknown }
    const callback: PingOutcome["callback"] = !expectCallback
      ? { status: "skipped" }
      : delivery.status === "delivered"
        ? { status: "delivered" }
        : delivery.status === "failed" || delivery.status === "pending"
          ? { status: delivery.status, ...(typeof delivery.error === "string" ? { error: this.redact(delivery.error) } : {}) }
          : { status: "unknown" }
    const callbackOk = callback.status === "delivered" || callback.status === "skipped"
    return {
      ok: callbackOk,
      target,
      url: peer.url,
      jobId,
      stage: callbackOk ? "done" : "callback",
      rttMs,
      callback,
      ...(pong !== undefined ? { pong } : {}),
      ...(callbackOk
        ? {}
        : {
            code: "callback_not_delivered",
            error: `The job reached ${peer.id}, but its report to ${trimSlash(profile.config.bridge.public_url)}/report was ${callback.status === "pending" ? "not delivered yet (queued for retry)" : "not delivered"}${callback.error !== undefined ? `: ${callback.error}` : ""}.`,
            hint: `${peer.id} must be able to reach this node's bridge (is it running? aibr status) and must list this node in agents[] (pair with aibr enroll).`,
          }),
    }
  }

  private pingFailure(
    target: string,
    url: string | null,
    stage: PingOutcome["stage"],
    error: unknown,
    started: number,
    jobId?: string,
  ): PingOutcome {
    const err = error instanceof ToolError ? error : undefined
    return {
      ok: false,
      target,
      url,
      ...(jobId !== undefined ? { jobId } : {}),
      stage,
      rttMs: this.deps.now() - started,
      error: this.redact(error instanceof Error ? error.message : String(error)),
      ...(err?.code !== undefined ? { code: err.code } : {}),
      ...(err?.hint !== undefined ? { hint: err.hint } : {}),
      callback: { status: "unknown" },
    }
  }

  /** The job record as the worker serves it (redacted), for `aibr send --wait`. */
  async jobRecord(jobId: string, target: string): Promise<Record<string, unknown>> {
    return JSON.parse(this.redact(JSON.stringify(await this.fetchJob(jobId, target)))) as Record<string, unknown>
  }

  // ── job ledger (best effort; feeds the SessionStart summary) ───────

  private async recordJob(profile: LoadedProfile, jobId: string, target: string): Promise<void> {
    const path = join(profile.paths.stateDir, "mcp-jobs.json")
    try {
      let jobs: LedgerEntry[] = []
      try {
        jobs = parseLedger(await this.deps.readFile(path))
      } catch {
        // first write
      }
      jobs.push({ job_id: jobId, target, at: new Date(this.deps.now()).toISOString() })
      await this.deps.writeFile(path, JSON.stringify(jobs.slice(-LEDGER_LIMIT)))
    } catch {
      // never fail a dispatch over bookkeeping
    }
  }

  /** Read the ledger for the SessionStart summary. */
  async readLedger(profile: LoadedProfile): Promise<LedgerEntry[]> {
    try {
      return parseLedger(await this.deps.readFile(join(profile.paths.stateDir, "mcp-jobs.json")))
    } catch {
      return []
    }
  }

  async fetchJobStatus(profile: LoadedProfile, entry: LedgerEntry): Promise<string | null> {
    try {
      const peer = profile.config.agents.find((a) => a.id === entry.target)
      if (!peer) return null
      const response = await this.http(
        `${trimSlash(peer.url)}/jobs/${encodeURIComponent(entry.job_id)}`,
        { method: "GET", headers: await this.authHeaders(profile) },
        HEALTH_TIMEOUT_MS,
        profile,
      )
      if (!response.ok) return null
      const body = await readJson(response)
      return typeof body.status === "string" ? body.status : null
    } catch {
      return null
    }
  }

  async peerReachable(peer: { url: string }): Promise<boolean> {
    try {
      const response = await this.http(`${trimSlash(peer.url)}/health`, { method: "GET" }, HEALTH_TIMEOUT_MS)
      return response.ok
    } catch {
      return false
    }
  }
}

export const DEFAULT_PING_TIMEOUT_MS = 20_000
const PING_POLL_INTERVAL_MS = 300

export interface PingOutcome {
  readonly ok: boolean
  readonly target: string
  readonly url: string | null
  readonly jobId?: string
  /** Where it stopped: `profile` (local config), `dispatch` (POST /trigger), `job`, `callback`, or `done`. */
  readonly stage: "profile" | "dispatch" | "job" | "callback" | "done"
  readonly rttMs: number
  readonly pong?: PongInfo
  /** The worker's `/report` to this node: `skipped` when this node runs no bridge (orchestrator). */
  readonly callback: { readonly status: "delivered" | "failed" | "pending" | "skipped" | "unknown"; readonly error?: string }
  readonly error?: string
  readonly code?: string
  readonly hint?: string
}

function isPong(value: unknown): value is PongInfo {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as PongInfo).agent_id === "string" &&
    Array.isArray((value as PongInfo).projects) &&
    Array.isArray((value as PongInfo).capabilities)
  )
}

/** A non-2xx `/trigger` answer as a ToolError that names the fix. */
function dispatchError(status: number, payload: Record<string, unknown>): ToolError {
  const message = typeof payload.error === "string" ? payload.error : `HTTP ${status}`
  if (status === 403 && /approval/i.test(message)) {
    return new ToolError(
      `Dispatch denied: ${message}`,
      "approval_required",
      "Do not retry. Tell the user to approve this capability with the operator CLI, then dispatch again.",
    )
  }
  if (status === 401) {
    // Since Phase 3 a 401 is not always the bearer: a worker with
    // request_signing "required" answers signature_required to an unpaired
    // node. Surface the peer's own reason; it names the fix (aibr enroll).
    const code = typeof payload.code === "string" ? payload.code : ""
    if (code === "signature_required" || /sign|pair|enrol/i.test(message)) {
      return new ToolError(
        `Peer requires a signed request from a paired node (401): ${message}`,
        "signature_required",
        "Do not retry. Ask the user to pair this machine with the worker: `aibr enroll issue` on the worker, then `aibr enroll join <code>` here.",
      )
    }
    return new ToolError("Peer rejected the bearer token (401). The shared token may be out of date.", "unauthorized")
  }
  if (status === 403 && /not authorized/i.test(message)) {
    return new ToolError(
      `Dispatch denied (403): ${message}`,
      "forbidden",
      "Ask the worker's operator to grant it: `aibr enroll issue --capabilities <list>` there, then `aibr enroll join <code>` here.",
    )
  }
  if (status === 403 && /not allowlisted/i.test(message)) {
    return new ToolError(`Dispatch denied (403): ${message}`, "project_not_allowlisted", "Use a project directory the worker allowlists (`aibr ping <peer>` lists them).")
  }
  return new ToolError(`Dispatch failed (HTTP ${status}): ${message}`, status === 403 ? "forbidden" : "dispatch_failed")
}

/** A non-2xx answer from the job API (`/jobs/:id/events`, `/jobs/:id/cancel`) as a ToolError that names the fix. */
function jobApiError(status: number, payload: Record<string, unknown>, jobId: string, target: string, action: "events" | "cancel"): ToolError {
  const message = typeof payload.error === "string" ? payload.error : `HTTP ${status}`
  const code = typeof payload.code === "string" ? payload.code : ""
  if (status === 404) {
    // Fastify's own 404 for a route it does not have names the route, not the job.
    if (typeof payload.message === "string" && /route/i.test(payload.message)) {
      return new ToolError(
        `Peer "${target}" runs an aibr version without the job ${action} route.`,
        "not_supported",
        action === "cancel" ? "The job will stop at its own timeout. Ask the user to update aibr on the worker." : "Use bridge_status and bridge_result instead.",
      )
    }
    return new ToolError(`Job ${jobId} not found on ${target}.`, "job_not_found")
  }
  if (status === 409) {
    const jobStatus = typeof payload.status === "string" ? payload.status : undefined
    if (code === "awaiting_approval") {
      return new ToolError(
        message,
        "awaiting_approval",
        "Nothing has run yet. Tell the user the job is waiting for the operator on the worker, who can reject it there.",
      )
    }
    if (code === "cancel_in_progress") return new ToolError(message, "cancel_in_progress", "Call bridge_await to see the job end.")
    return new ToolError(
      `${message}${typeof payload.job_error === "string" ? `: ${payload.job_error}` : ""}`,
      "job_finished",
      `Nothing to cancel${jobStatus !== undefined ? ` (status ${jobStatus})` : ""}; call bridge_result for its outcome.`,
    )
  }
  if (status === 403) {
    if (code === "requester_identity_required") {
      return new ToolError(
        message,
        "signature_required",
        "This node's requests must be signed for the worker to know which jobs are its own: pair it with the worker (`aibr enroll issue` there, `aibr enroll join <code>` here) and have the worker's operator enable security.request_signing.",
      )
    }
    if (code === "not_job_requester") return new ToolError(message, "forbidden", "Only the node that dispatched a job can follow or cancel it.")
    return new ToolError(`Denied (403): ${message}`, "forbidden")
  }
  if (status === 401) {
    if (code === "signature_required" || /sign|pair|enrol/i.test(message)) {
      return new ToolError(
        `Peer requires a signed request from a paired node (401): ${message}`,
        "signature_required",
        "Ask the user to pair this machine with the worker: `aibr enroll issue` on the worker, then `aibr enroll join <code>` here.",
      )
    }
    return new ToolError("Peer rejected the bearer token (401). The shared token may be out of date.", "unauthorized")
  }
  return new ToolError(`Job ${action} failed (HTTP ${status}): ${message}`, `${action}_failed`)
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.trim() === "") throw new ToolError(`Missing required string argument: ${key}`, "invalid_argument")
  return value
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

function urlOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return "peer"
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json()
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
