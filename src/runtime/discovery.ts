import { execFile as defaultExecFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { stat as fsStat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { contractErrorSchema, type ContractError, type Result } from "../orchestration/errors.js"
import type { DispatchEnvelope } from "../orchestration/types.js"
import { SdkOpencodeClientAdapter } from "../opencode/client.js"
import type { OpencodeClient } from "../opencode/types.js"
import { ClaudeCodeRuntimeAdapter, type SpawnFunction } from "./claude-adapter.js"
import { CodexRuntimeAdapter } from "./codex-adapter.js"
import { DEFAULT_RUNTIME_PROBE_TIMEOUT_MS } from "./constants.js"
import { OpencodeRuntimeAdapter } from "./opencode-adapter.js"
import {
  agentInstallationSchema,
  nodeContextSchema,
  type AdapterCapabilityReport,
  type AgentInstallation,
  type NodeContext,
  type RuntimeCapabilities,
} from "./schemas.js"
import type { AgentRuntimeAdapter } from "./types.js"

const execFileAsync = promisify(defaultExecFile)

export type SupportedRuntimeKind = "opencode" | "claude" | "codex"

export interface RuntimeBinaryMetadata {
  path: string
  mtimeMs: number
  size: number
}

export interface DiscoveredRuntimeEntry {
  kind: SupportedRuntimeKind
  displayName: string
  installed: boolean
  executablePath?: string
  version?: string
  capabilities?: RuntimeCapabilities
  capabilityReport?: AdapterCapabilityReport
  metadata?: RuntimeBinaryMetadata
  lastProbedAt: string
  error?: string
}

export interface RuntimeDiscoveryServiceOptions {
  nodeId: string
  installationIdPrefix?: string
  projects: {
    resolve(scope: { projectId: string; projectPathId: string; nodeId: string }): Promise<Result<string>>
  }
  opencodeClient?: OpencodeClient
  opencodeServerUrl?: string
  opencodeUsername?: string
  opencodePassword?: string
  probeTimeoutMs?: number
  env?: NodeJS.ProcessEnv
  customBinaryPaths?: Partial<Record<SupportedRuntimeKind, string>>
  pathSearchRoots?: string[]
  statFile?: (filePath: string) => Promise<{ mtimeMs: number; size: number } | undefined>
  execProbe?: (filePath: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string }>
  spawn?: SpawnFunction
}

export interface CachedRuntimeProbe {
  metadata: RuntimeBinaryMetadata
  version: string
  capabilities: RuntimeCapabilities
  capabilityReport?: AdapterCapabilityReport
  probedAt: string
}

const DEFAULT_BINARIES: Record<SupportedRuntimeKind, { binaryName: string; probeArgs: string[]; displayName: string }> = {
  opencode: {
    binaryName: "opencode",
    probeArgs: ["--version"],
    displayName: "OpenCode",
  },
  claude: {
    binaryName: "claude",
    probeArgs: ["--version"],
    displayName: "Claude Code",
  },
  codex: {
    binaryName: "codex",
    probeArgs: ["-V"],
    displayName: "Codex CLI",
  },
}

export class RuntimeDiscoveryService {
  readonly #nodeId: string
  readonly #installationIdPrefix: string
  readonly #projects: RuntimeDiscoveryServiceOptions["projects"]
  readonly #opencodeClient?: OpencodeClient
  readonly #opencodeServerUrl: string
  readonly #opencodeUsername: string
  readonly #opencodePassword?: string
  readonly #probeTimeoutMs: number
  readonly #env: NodeJS.ProcessEnv
  readonly #customBinaryPaths: Partial<Record<SupportedRuntimeKind, string>>
  readonly #pathSearchRoots: string[]
  readonly #statFile: (filePath: string) => Promise<{ mtimeMs: number; size: number } | undefined>
  readonly #execProbe: (filePath: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string }>
  readonly #spawn?: SpawnFunction

  readonly #cache = new Map<SupportedRuntimeKind, CachedRuntimeProbe>()
  readonly #adapters = new Map<SupportedRuntimeKind, AgentRuntimeAdapter>()

  constructor(options: RuntimeDiscoveryServiceOptions) {
    this.#nodeId = options.nodeId
    this.#installationIdPrefix = options.installationIdPrefix ?? "installation"
    this.#projects = options.projects
    this.#opencodeClient = options.opencodeClient
    this.#opencodeServerUrl = options.opencodeServerUrl ?? "http://127.0.0.1:4096"
    this.#opencodeUsername = options.opencodeUsername ?? "aibridge"
    this.#opencodePassword = options.opencodePassword
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_RUNTIME_PROBE_TIMEOUT_MS
    this.#env = options.env ?? process.env
    this.#customBinaryPaths = { ...options.customBinaryPaths }
    this.#pathSearchRoots = options.pathSearchRoots ?? this.#computeDefaultSearchRoots()
    this.#spawn = options.spawn

    this.#statFile = options.statFile ?? (async (path) => {
      try {
        const s = await fsStat(path)
        return { mtimeMs: s.mtimeMs, size: s.size }
      } catch {
        return undefined
      }
    })

    this.#execProbe = options.execProbe ?? (async (filePath, args, timeoutMs) => {
      try {
        const { stdout } = await execFileAsync(filePath, args, {
          timeout: timeoutMs,
          env: this.#env,
        })
        return { ok: true, stdout: String(stdout) }
      } catch {
        return { ok: false, stdout: "" }
      }
    })
  }

  get nodeId(): string {
    return this.#nodeId
  }

  #computeDefaultSearchRoots(): string[] {
    const fromPath = (this.#env.PATH ?? "").split(":").filter((p) => p.length > 0)
    const defaults = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      join(homedir(), ".local/bin"),
      "/usr/bin",
      "/bin",
    ]
    return Array.from(new Set([...fromPath, ...defaults]))
  }

  async resolveBinaryPath(kind: SupportedRuntimeKind): Promise<string | undefined> {
    const custom = this.#customBinaryPaths[kind]
    if (custom) {
      const stat = await this.#statFile(custom)
      if (stat) return custom
      return undefined
    }

    const { binaryName } = DEFAULT_BINARIES[kind]
    for (const root of this.#pathSearchRoots) {
      const candidate = join(root, binaryName)
      try {
        const stat = await this.#statFile(candidate)
        if (stat) return candidate
      } catch {
        /* skip invalid dir */
      }
    }
    return undefined
  }

  async probeRuntime(kind: SupportedRuntimeKind, forceRefresh = false): Promise<DiscoveredRuntimeEntry> {
    const config = DEFAULT_BINARIES[kind]
    const binaryPath = await this.resolveBinaryPath(kind)

    if (!binaryPath) {
      this.#cache.delete(kind)
      this.#adapters.delete(kind)
      return {
        kind,
        displayName: config.displayName,
        installed: false,
        lastProbedAt: new Date().toISOString(),
        error: `Executable "${config.binaryName}" was not found on PATH.`,
      }
    }

    const currentMeta = await this.#statFile(binaryPath)
    if (!currentMeta) {
      this.#cache.delete(kind)
      this.#adapters.delete(kind)
      return {
        kind,
        displayName: config.displayName,
        installed: false,
        executablePath: binaryPath,
        lastProbedAt: new Date().toISOString(),
        error: `Failed to inspect binary at ${binaryPath}.`,
      }
    }

    const cached = this.#cache.get(kind)
    if (!forceRefresh && cached) {
      const isCacheValid =
        cached.metadata.path === binaryPath &&
        cached.metadata.mtimeMs === currentMeta.mtimeMs &&
        cached.metadata.size === currentMeta.size

      if (isCacheValid) {
        return {
          kind,
          displayName: config.displayName,
          installed: true,
          executablePath: binaryPath,
          version: cached.version,
          capabilities: cached.capabilities,
          capabilityReport: cached.capabilityReport,
          metadata: cached.metadata,
          lastProbedAt: cached.probedAt,
        }
      }
    }

    // Direct probe execution bounded by probeTimeoutMs
    const probeResult = await this.#execProbe(binaryPath, config.probeArgs, this.#probeTimeoutMs)
    if (!probeResult.ok || probeResult.stdout.trim().length === 0) {
      this.#cache.delete(kind)
      this.#adapters.delete(kind)
      return {
        kind,
        displayName: config.displayName,
        installed: false,
        executablePath: binaryPath,
        lastProbedAt: new Date().toISOString(),
        error: `Probe execution timed out or failed for ${binaryPath}.`,
      }
    }

    const version = probeResult.stdout.trim()
    const adapter = this.createAdapter(kind, binaryPath)

    const metadata: RuntimeBinaryMetadata = {
      path: binaryPath,
      mtimeMs: currentMeta.mtimeMs,
      size: currentMeta.size,
    }

    const probeEntry: CachedRuntimeProbe = {
      metadata,
      version,
      capabilities: adapter.capabilities,
      capabilityReport: adapter.capabilityReport,
      probedAt: new Date().toISOString(),
    }

    this.#cache.set(kind, probeEntry)
    this.#adapters.set(kind, adapter)

    return {
      kind,
      displayName: config.displayName,
      installed: true,
      executablePath: binaryPath,
      version,
      capabilities: adapter.capabilities,
      capabilityReport: adapter.capabilityReport,
      metadata,
      lastProbedAt: probeEntry.probedAt,
    }
  }

  async discoverAll(forceRefresh = false): Promise<DiscoveredRuntimeEntry[]> {
    const kinds: SupportedRuntimeKind[] = ["opencode", "claude", "codex"]
    const results = await Promise.allSettled(
      kinds.map((kind) => this.probeRuntime(kind, forceRefresh)),
    )

    return results.map((res, index) => {
      if (res.status === "fulfilled") {
        return res.value
      }
      const kind = kinds[index]
      return {
        kind,
        displayName: DEFAULT_BINARIES[kind].displayName,
        installed: false,
        lastProbedAt: new Date().toISOString(),
        error: `Discovery rejected with error: ${String(res.reason)}`,
      }
    })
  }

  createAdapter(kind: SupportedRuntimeKind, executablePath?: string): AgentRuntimeAdapter {
    const installationId = `${this.#installationIdPrefix}-${kind}`
    switch (kind) {
      case "opencode":
        return new OpencodeRuntimeAdapter({
          nodeId: this.#nodeId,
          installationId,
          baseUrl: this.#opencodeServerUrl,
          projects: this.#projects,
          client: this.#opencodeClient ?? new SdkOpencodeClientAdapter({
            baseUrl: this.#opencodeServerUrl,
            username: this.#opencodeUsername,
            password: this.#opencodePassword,
          }),
        })
      case "claude":
        return new ClaudeCodeRuntimeAdapter({
          nodeId: this.#nodeId,
          installationId,
          executablePath,
          projects: this.#projects,
          probeTimeoutMs: this.#probeTimeoutMs,
          env: this.#env,
          ...(this.#spawn ? { spawn: this.#spawn } : {}),
        })
      case "codex":
        return new CodexRuntimeAdapter({
          nodeId: this.#nodeId,
          installationId,
          executablePath,
          projects: this.#projects,
          probeTimeoutMs: this.#probeTimeoutMs,
          env: this.#env,
          ...(this.#spawn ? { spawn: this.#spawn } : {}),
        })
    }
  }

  getAdapter(kind: SupportedRuntimeKind): AgentRuntimeAdapter | undefined {
    return this.#adapters.get(kind)
  }

  async route(dispatchEnvelope: DispatchEnvelope, correlationId?: string): Promise<Result<AgentRuntimeAdapter>> {
    const rawKind = dispatchEnvelope.runtimeKind
    if (rawKind !== "opencode" && rawKind !== "claude" && rawKind !== "codex") {
      return failure(
        "unsupported_capability",
        "runtime.router.unsupported_kind",
        `Requested runtime "${rawKind}" is not a recognized AIBridge runtime kind. Supported kinds: opencode, claude, codex.`,
        correlationId,
      )
    }

    const kind = rawKind as SupportedRuntimeKind
    let adapter = this.#adapters.get(kind)

    if (!adapter) {
      const probe = await this.probeRuntime(kind)
      if (!probe.installed) {
        const available = await this.getSelectableRuntimes()
        const availableNames = available.map((r) => `${r.displayName} (${r.kind})`).join(", ") || "none"
        return failure(
          "unsupported_capability",
          "runtime.router.runtime_unavailable",
          `Requested runtime "${DEFAULT_BINARIES[kind].displayName}" is not available on node ${this.#nodeId}. Available runtimes: ${availableNames}. Reason: ${probe.error ?? "binary not found"}`,
          correlationId,
        )
      }
      adapter = this.#adapters.get(kind)
    }

    if (!adapter) {
      return failure(
        "runtime_failure",
        "runtime.router.adapter_creation_failed",
        `Failed to initialize runtime adapter for "${kind}".`,
        correlationId,
      )
    }

    return success(adapter)
  }

  async getSelectableRuntimes(): Promise<Array<{ kind: SupportedRuntimeKind; displayName: string; version?: string }>> {
    const discovered = await this.discoverAll()
    return discovered
      .filter((r) => r.installed)
      .map((r) => ({
        kind: r.kind,
        displayName: r.displayName,
        version: r.version,
      }))
  }

  async detect(nodeContext: NodeContext): Promise<Result<AgentInstallation[]>> {
    const checked = nodeContextSchema.safeParse(nodeContext)
    if (!checked.success) {
      return failure("validation", "runtime.detect.invalid_node", "Node context is invalid.")
    }
    if (checked.data.nodeId !== this.#nodeId) {
      return failure("policy_denied", "runtime.detect.node_scope", `Node ID "${checked.data.nodeId}" does not match discovery service node "${this.#nodeId}".`)
    }

    const discovered = await this.discoverAll()
    const installations: AgentInstallation[] = []

    for (const entry of discovered) {
      if (!entry.installed || !entry.capabilities) continue
      installations.push(
        agentInstallationSchema.parse({
          schemaVersion: 1,
          installationId: `${this.#installationIdPrefix}-${entry.kind}`,
          nodeId: this.#nodeId,
          runtimeKind: entry.kind,
          displayName: entry.displayName,
          version: entry.version,
          executable: entry.executablePath,
          capabilities: entry.capabilities,
          capabilityReport: entry.capabilityReport,
        }),
      )
    }

    return success(installations)
  }
}

function failure(category: ContractError["category"], code: string, message: string, correlationId?: string): Result<never> {
  return {
    ok: false,
    error: contractErrorSchema.parse({
      schemaVersion: 1,
      category,
      code,
      message,
      retryable: category === "transient_transport" || category === "timeout" || category === "runtime_failure" || category === "internal_failure",
      ...(correlationId ? { correlationId } : {}),
    }),
  }
}

function success<T>(value: T): Result<T> {
  return { ok: true, value }
}
