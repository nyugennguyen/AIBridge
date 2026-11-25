/**
 * The AIBridge MCP tool set: how a Claude Code orchestrator talks to remote
 * AIBridge worker nodes over the existing HTTP contract (`POST /trigger`,
 * `GET /jobs/:id`, `GET /health`).
 *
 * Boundaries worth knowing:
 *  - There is deliberately NO approve tool. Plan approval is operator-only.
 *  - The bearer token is read from the profile secret file at call time and is
 *    never returned: every string leaving this module goes through `redact`.
 *  - The bridge exposes no cancel route, so `bridge_cancel` reports that
 *    honestly instead of pretending.
 */
import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { bridgeConfigSchema } from "../config/schemas.js"
import { resolveProfilePaths, validateProfileName, type ProfilePaths } from "../host/paths.js"

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
      "Get the outcome of a job: status plus summary and findings when the worker reported them. Call after bridge_await reports a final status.",
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
    name: "bridge_cancel",
    description: "Cancel a running job. Only works if the bridge exposes a cancel route; current bridges do not and will say so.",
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
      case "bridge_cancel": {
        // Validate the target even though nothing is sent, so typos surface.
        const profile = await this.loadProfile()
        this.findPeer(profile, str(args, "target"))
        throw new ToolError(
          "bridge_cancel is not supported by this bridge version: the bridge exposes no cancel route.",
          "not_supported",
          "The job will stop at its own timeout. Ask the operator to stop it on the worker if it must end now.",
        )
      }
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

  private async http(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
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
          const body = (await response.json()) as { opencode?: boolean; agent_id?: string }
          return {
            ...base,
            reachable: true,
            runtime: body.opencode === true ? "up" : "down",
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
    )
    const payload = await readJson(response)
    if (!response.ok) {
      const message = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`
      if (response.status === 403 && /approval/i.test(message)) {
        throw new ToolError(
          `Dispatch denied: ${message}`,
          "approval_required",
          "Do not retry. Tell the user to approve this capability with the operator CLI, then dispatch again.",
        )
      }
      if (response.status === 401) throw new ToolError("Peer rejected the bearer token (401). The shared token may be out of date.", "unauthorized")
      throw new ToolError(`Dispatch failed (HTTP ${response.status}): ${message}`, response.status === 403 ? "forbidden" : "dispatch_failed")
    }
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
