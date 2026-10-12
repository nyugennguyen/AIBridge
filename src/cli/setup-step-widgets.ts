/**
 * AIBridge Onboarding & Setup Wizard Step Widgets
 *
 * Implements the interactive step widgets for `aibr setup` matching:
 * - Docs/tui/aibridge-setup-wizard.html
 * - Docs/assets/logos/logo-design-system.html
 * - .agents/skills/aibr-onboarding/SKILL.md
 *
 * Provides:
 * 1. Network Probe Widget: Tailscale daemon socket, mesh IPv4 coordinate, port checks (4095, 4096, 8787).
 * 2. Token Generator Widget: CSPRNG bearer token (`aibr_sec_<32-hex>` by default = 128 bits,
 *    or raw 64-hex = 256 bits), clipboard utility, security checkboxes.
 * 3. Directory Selector Widget: Multi-select project folders with path normalization and fail-closed subpath policy.
 * 4. Runtime Probe Widget: OpenCode loopback HTTP check (127.0.0.1:4096), Claude and Codex binary probes on PATH.
 * 5. Tailnet Agent Discovery Widget: enumerates the tailnet via `discoverTailscalePeers` and asks each peer's
 *    unauthenticated `/health` who it is. Reports only — enrolment is a separate, credentialed step.
 */

import { randomBytes } from "node:crypto"
import * as net from "node:net"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import type { ProcessRunner, HttpProbe } from "../host/types.js"
import { discoverTailscalePeers, type TailscalePeer } from "../host/tailscale-discovery.js"

const execFileAsync = promisify(execFile)

// ── Design Tokens & ANSI Palette ──────────────────────────────────────────

export const BRAND_COLORS = {
  cyan: "\x1b[38;2;0;240;255m",     // Primary Electric Cyan: RGB(0, 240, 255)
  violet: "\x1b[38;2;168;85;247m",  // Neural Violet: RGB(168, 85, 247)
  emerald: "\x1b[38;2;16;185;129m", // Mesh Emerald: RGB(16, 185, 129)
  amber: "\x1b[38;5;214m",          // Warning Amber
  red: "\x1b[38;5;196m",            // Error Red
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
} as const

// ── Common Probe Types ────────────────────────────────────────────────────

export type ProbeStatus = "ok" | "warn" | "error"

export interface ProbeResultItem {
  readonly status: ProbeStatus
  readonly label: string
  readonly detail?: string
}

// ── 1. Network Probe Widget ───────────────────────────────────────────────

export interface NetworkProbeDeps {
  readonly processRunner?: ProcessRunner
  readonly checkSocket?: (socketPath: string) => Promise<boolean>
  readonly checkPort?: (port: number, host?: string) => Promise<boolean>
  readonly socketPath?: string
  readonly ports?: {
    readonly router?: number
    readonly opencode?: number
    readonly bridge?: number
  }
}

export interface NetworkProbeResult {
  readonly socket: ProbeResultItem & {
    readonly exists: boolean
    readonly socketPath: string
  }
  readonly ip: ProbeResultItem & {
    readonly ipAddress: string | null
    readonly isCgnat: boolean
  }
  readonly ports: {
    readonly router: ProbeResultItem & { readonly port: number; readonly available: boolean }
    readonly opencode: ProbeResultItem & { readonly port: number; readonly available: boolean }
    readonly bridge: ProbeResultItem & { readonly port: number; readonly available: boolean }
    readonly allAvailable: boolean
  }
}

/**
 * Validates whether an IP address falls within the Tailscale Carrier-Grade NAT
 * (CGNAT) address space: 100.64.0.0/10 (100.64.0.0 to 100.127.255.255).
 */
export function isTailscaleCgnatIp(ip: string): boolean {
  const parts = ip.trim().split(".").map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false
  }
  return parts[0] === 100 && (parts[1] ?? 0) >= 64 && (parts[1] ?? 0) <= 127
}

/**
 * Tests whether a TCP port is currently available to bind on a host.
 */
export async function probePortAvailability(port: number, host = "127.0.0.1"): Promise<boolean> {
  if (port < 1 || port > 65535) return false
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const server = net.createServer()
  server.unref()
  server.once("error", () => {
    resolve(false)
  })
  server.once("listening", () => {
    server.close(() => resolve(true))
  })
  try {
    server.listen(port, host)
  } catch {
    resolve(false)
  }
  return promise
}

/**
 * Asynchronously probes:
 * 1. Local tailscaled daemon socket (/var/run/tailscaled.sock).
 * 2. Tailscale IPv4 coordinate via `tailscale ip -4`.
 * 3. Port availability for router (4095), opencode (4096), and bridge (8787).
 */
export async function probeNetwork(deps?: NetworkProbeDeps): Promise<NetworkProbeResult> {
  const socketPath = deps?.socketPath ?? "/var/run/tailscaled.sock"
  const routerPort = deps?.ports?.router ?? 4095
  const opencodePort = deps?.ports?.opencode ?? 4096
  const bridgePort = deps?.ports?.bridge ?? 8787

  // 1. Socket check
  let socketExists = false
  if (deps?.checkSocket) {
    socketExists = await deps.checkSocket(socketPath)
  } else {
    try {
      const st = await fs.stat(socketPath)
      socketExists = st.isSocket?.() ?? true
    } catch {
      socketExists = false
    }
  }

  const socketResult: NetworkProbeResult["socket"] = {
    exists: socketExists,
    socketPath,
    status: socketExists ? "ok" : "warn",
    label: "Tailscale Daemon (tailscaled)",
    detail: socketExists
      ? `Active socket at ${socketPath} (RUNNING)`
      : `Socket not found at ${socketPath} (tailscaled may run in userspace or container)`,
  }

  // 2. Tailscale IP query
  let ipAddress: string | null = null
  try {
    if (deps?.processRunner) {
      const res = await deps.processRunner.exec(["tailscale", "ip", "-4"])
      if (res.exitCode === 0 && res.stdout.trim().length > 0) {
        ipAddress = res.stdout.trim().split(/\s+/)[0] ?? null
      }
    } else {
      const { stdout } = await execFileAsync("tailscale", ["ip", "-4"], { timeout: 3000 })
      if (stdout.trim().length > 0) {
        ipAddress = stdout.trim().split(/\s+/)[0] ?? null
      }
    }
  } catch {
    ipAddress = null
  }

  const isCgnat = ipAddress !== null && isTailscaleCgnatIp(ipAddress)
  let ipStatus: ProbeStatus = "warn"
  let ipDetail = "No active Tailscale mesh IPv4 detected"
  if (ipAddress !== null) {
    if (isCgnat) {
      ipStatus = "ok"
      ipDetail = `${ipAddress} (100.64.0.0/10 CGNAT)`
    } else {
      ipStatus = "warn"
      ipDetail = `${ipAddress} (non-CGNAT IPv4)`
    }
  }

  const ipResult: NetworkProbeResult["ip"] = {
    status: ipStatus,
    label: "Tailscale Mesh IPv4 Coordinate",
    detail: ipDetail,
    ipAddress,
    isCgnat,
  }

  // 3. Port availability checks
  const checkPort = deps?.checkPort ?? probePortAvailability
  const [routerAvail, ocAvail, bridgeAvail] = await Promise.all([
    checkPort(routerPort),
    checkPort(opencodePort),
    checkPort(bridgePort),
  ])

  const allAvailable = routerAvail && ocAvail && bridgeAvail

  const portResult: NetworkProbeResult["ports"] = {
    router: {
      port: routerPort,
      available: routerAvail,
      status: routerAvail ? "ok" : "warn",
      label: `Ingress Router Port (${routerPort})`,
      detail: routerAvail ? "AVAILABLE (NO CONFLICTS)" : `CONFLICT (Port ${routerPort} in use)`,
    },
    opencode: {
      port: opencodePort,
      available: ocAvail,
      status: ocAvail ? "ok" : "warn",
      label: `OpenCode Port (${opencodePort})`,
      detail: ocAvail ? "AVAILABLE (NO CONFLICTS)" : `CONFLICT (Port ${opencodePort} in use)`,
    },
    bridge: {
      port: bridgePort,
      available: bridgeAvail,
      status: bridgeAvail ? "ok" : "warn",
      label: `Fastify HTTP Bridge Port (${bridgePort})`,
      detail: bridgeAvail ? "AVAILABLE (NO CONFLICTS)" : `CONFLICT (Port ${bridgePort} in use)`,
    },
    allAvailable,
  }

  return {
    socket: socketResult,
    ip: ipResult,
    ports: portResult,
  }
}

/**
 * Formats the network probe results as ANSI string rows matching the TUI design.
 */
export function renderNetworkProbe(result: NetworkProbeResult): string {
  const lines: string[] = []
  const { cyan, emerald, amber, dim, bold, reset } = BRAND_COLORS

  // Tailscale Daemon
  const socketBadge = result.socket.exists
    ? `${emerald}● RUNNING${reset}`
    : `${amber}▲ NOT DETECTED${reset}`
  lines.push(`🔒 ${bold}Tailscale Daemon (tailscaled)${reset}`)
  lines.push(`   ${dim}${result.socket.socketPath}${reset}  ${socketBadge}`)

  // Mesh IPv4
  const ipBadge = result.ip.ipAddress
    ? `${cyan}${bold}${result.ip.ipAddress}${reset} ${dim}(${result.ip.isCgnat ? "CGNAT" : "External"})${reset}`
    : `${amber}Offline / No IP${reset}`
  lines.push(`📡 ${bold}Tailscale Mesh IPv4 Coordinate${reset}`)
  lines.push(`   ${ipBadge}`)

  // Port checks
  const portBadge = result.ports.allAvailable
    ? `${emerald}✔ ALL AVAILABLE (NO CONFLICTS)${reset}`
    : `${amber}▲ PORT COLLISION DETECTED${reset}`
  lines.push(`🔌 ${bold}Port Availability Preflight Check${reset}`)
  lines.push(
    `   ${dim}4095: ${result.ports.router.available ? "OK" : "BUSY"}, 4096: ${result.ports.opencode.available ? "OK" : "BUSY"}, 8787: ${result.ports.bridge.available ? "OK" : "BUSY"}${reset}  ${portBadge}`,
  )

  return lines.join("\n")
}

// ── 2. Token Generator Widget ─────────────────────────────────────────────

export interface GenerateBearerTokenOptions {
  /** When true (or omitted), prefixes token with `aibr_sec_`. When false, produces raw hex without prefix. */
  readonly prefix?: boolean
  /** Number of CSPRNG bytes to sample. Defaults to 16 bytes (32 hex characters) when prefixed, or 32 bytes (64 hex characters) when raw. */
  readonly bytes?: number
}

/**
 * Real-time CSPRNG token generator.
 *
 * Defaults to producing tokens with `aibr_sec_` prefix and 32 hex chars, which is
 * 16 bytes = 128 bits of entropy. This matches `aibr_sec_<32-hex>` in SKILL.md and
 * Docs/tui/aibridge-setup-wizard.html, both of which previously mislabelled this
 * as "256-bit" -- the byte count is 16, not 32.
 *
 * 128 bits is far past brute force for a bearer token, but it is a deliberate
 * floor, not an accident: the format is pinned by those two documents. Pass
 * `bytes: 32` (or `prefix: false`) for a full 256-bit secret.
 *
 * When `prefix: false` is specified, returns raw 64-hex chars (32 bytes = 256 bits).
 */
export function generateBearerToken(options?: GenerateBearerTokenOptions | boolean): string {
  const isPrefix = typeof options === "boolean" ? options : (options?.prefix ?? true)
  const byteCount =
    typeof options === "object" && options?.bytes !== undefined
      ? options.bytes
      : isPrefix
        ? 16
        : 32
  const hex = randomBytes(byteCount).toString("hex")
  return isPrefix ? `aibr_sec_${hex}` : hex
}

/**
 * Convenience wrapper returning a CSPRNG bearer token with `aibr_sec_` prefix.
 */
export function generateCsprngToken(prefix = true): string {
  return generateBearerToken({ prefix })
}

/**
 * Validates whether a token matches the AIBridge bearer token format:
 * either `aibr_sec_<32..64 hex>` or raw 64 hex characters.
 */
export function isValidBearerToken(token: string): boolean {
  const trimmed = token.trim()
  if (trimmed.startsWith("aibr_sec_")) {
    const hex = trimmed.slice("aibr_sec_".length)
    return /^[0-9a-fA-F]{32,64}$/.test(hex)
  }
  return /^[0-9a-fA-F]{64}$/.test(trimmed)
}

/**
 * Click-to-copy / clipboard write utility.
 * Emits OSC 52 terminal copy escape sequence and attempts native platform copy.
 */
export async function copyToClipboard(text: string, _runner?: ProcessRunner): Promise<boolean> {
  let copied = false

  // 1. Emit OSC 52 escape sequence for modern terminals / SSH sessions
  try {
    if (process.stdout && typeof process.stdout.write === "function") {
      const b64 = Buffer.from(text, "utf-8").toString("base64")
      process.stdout.write(`\x1b]52;c;${b64}\x07`)
      copied = true
    }
  } catch {
    // Ignore terminal write errors
  }

  // 2. Attempt OS native clipboard tool if available
  const platform = process.platform
  try {
    let cmd = ""
    let args: string[] = []
    if (platform === "darwin") {
      cmd = "pbcopy"
    } else if (platform === "linux") {
      cmd = "xclip"
      args = ["-selection", "clipboard"]
    } else if (platform === "win32") {
      cmd = "clip"
    }

    if (cmd) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] })
      child.on("error", () => resolve())
      child.stdin.end(text, () => {
        copied = true
        resolve()
      })
      await promise
    }
  } catch {
    // Platform clipboard command not available
  }

  return copied
}

export interface SecurityFloorInvariants {
  readonly constantTimeComparison: boolean
  readonly maxBodyPayloadCapBytes: number
  readonly secretRedactionPipeline: boolean
}

export const DEFAULT_SECURITY_INVARIANTS: SecurityFloorInvariants = {
  constantTimeComparison: true,
  maxBodyPayloadCapBytes: 2 * 1024 * 1024, // 2 MB
  secretRedactionPipeline: true,
}

export interface SecurityCheckboxItem {
  readonly id: "const-time" | "body-limit" | "redact"
  readonly title: string
  readonly description: string
  checked: boolean
}

export function getDefaultSecurityCheckboxes(): SecurityCheckboxItem[] {
  return [
    {
      id: "const-time",
      title: "Enforce Constant-Time Token Comparison",
      description: "Prevents timing side-channel attacks during admission handshake.",
      checked: true,
    },
    {
      id: "body-limit",
      title: "Enforce Strict 2 MB Body Payload Cap",
      description: "Disallows oversized JSON injections and memory exhaustion DOS vectors.",
      checked: true,
    },
    {
      id: "redact",
      title: "Automated Secret Redaction Pipeline",
      description: "Scrubs API keys, passwords, and private tokens before writing to disk or terminals.",
      checked: true,
    },
  ]
}

/**
 * Formats the token generator and security checkboxes matching the design.
 */
export function renderTokenWidget(
  token: string,
  checkboxes: SecurityCheckboxItem[] = getDefaultSecurityCheckboxes(),
  port = 4095,
): string {
  const { cyan, emerald, dim, bold, reset } = BRAND_COLORS
  const lines: string[] = []

  lines.push(`🛡️ ${bold}Router Security & Invariants Enforcement${reset}`)
  lines.push(`   Listening Port: ${cyan}${port}${reset}`)
  lines.push(`   Bearer Token:   ${cyan}${bold}${token}${reset} ${dim}[r: Regen, c: Copy]${reset}`)
  lines.push("")
  lines.push(`   ${bold}Security Floor Invariants:${reset}`)
  for (const item of checkboxes) {
    const mark = item.checked ? `${emerald}✔${reset}` : `${dim}○${reset}`
    lines.push(`   [${mark}] ${bold}${item.title}${reset}`)
    lines.push(`       ${dim}${item.description}${reset}`)
  }

  return lines.join("\n")
}

// ── 3. Directory Selector Widget ──────────────────────────────────────────

export const FAIL_CLOSED_SUBPATH_NOTICE =
  "Fail-Closed Subpath Policy: Any path outside these roots or any symlink target escaping this boundary will trigger an immediate hard 403 Forbidden dispatch rejection."

export interface ProjectDirectoryItem {
  readonly path: string
  readonly label?: string
  readonly description?: string
  readonly selected: boolean
  readonly exists: boolean
  readonly isCustom?: boolean
}

export interface DirectorySelectorState {
  readonly items: readonly ProjectDirectoryItem[]
  readonly customPathInput: string
  readonly failClosedNotice: string
}

/**
 * Normalizes a raw project path string:
 * - Trims whitespace
 * - Expands leading `~` with user's home directory
 * - Resolves to absolute path
 */
export function normalizeProjectPath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return ""
  let expanded = trimmed
  if (expanded === "~" || expanded.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    expanded = path.join(home, expanded.slice(expanded === "~" ? 1 : 2))
  }
  return path.resolve(path.normalize(expanded))
}

/**
 * Validates a project directory path asynchronously.
 */
export async function validateProjectPath(rawPath: string): Promise<{
  readonly valid: boolean
  readonly normalizedPath: string
  readonly exists: boolean
  readonly isDirectory: boolean
  readonly error?: string
}> {
  const normalized = normalizeProjectPath(rawPath)
  if (!normalized) {
    return {
      valid: false,
      normalizedPath: "",
      exists: false,
      isDirectory: false,
      error: "Path cannot be empty",
    }
  }

  try {
    const stat = await fs.stat(normalized)
    const isDir = stat.isDirectory()
    return {
      valid: isDir,
      normalizedPath: normalized,
      exists: true,
      isDirectory: isDir,
      error: isDir ? undefined : `Path is not a directory: ${normalized}`,
    }
  } catch {
    return {
      valid: false,
      normalizedPath: normalized,
      exists: false,
      isDirectory: false,
      error: `Directory does not exist: ${normalized}`,
    }
  }
}

/**
 * Synchronous containment check: determines if targetPath is contained within
 * any of the allowedRoots without escaping via traversal.
 */
export function isSubpathContained(targetPath: string, allowedRoots: readonly string[]): boolean {
  if (allowedRoots.length === 0) return false
  const target = normalizeProjectPath(targetPath)
  if (!target) return false

  for (const root of allowedRoots) {
    const normRoot = normalizeProjectPath(root)
    if (!normRoot) continue
    if (target === normRoot) return true
    const prefix = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep
    if (target.startsWith(prefix)) return true
  }
  return false
}

/**
 * Enforces the fail-closed subpath policy, returning an authorization verdict.
 */
export function enforceFailClosedSubpath(
  targetPath: string,
  allowedRoots: readonly string[],
): { readonly allowed: boolean; readonly reason?: string } {
  const contained = isSubpathContained(targetPath, allowedRoots)
  if (contained) {
    return { allowed: true }
  }
  return {
    allowed: false,
    reason: `403 Forbidden: Target path "${targetPath}" escapes authorized project containment roots`,
  }
}

/**
 * Detects project directories starting with process.cwd() and checking candidate parent directories.
 */
export async function detectProjectDirectories(cwd = process.cwd()): Promise<ProjectDirectoryItem[]> {
  const items: ProjectDirectoryItem[] = []
  const resolvedCwd = normalizeProjectPath(cwd)

  // 1. Current working directory (always active root)
  items.push({
    path: resolvedCwd,
    label: path.basename(resolvedCwd) || resolvedCwd,
    description: "Active repository root (contains project files)",
    selected: true,
    exists: true,
    isCustom: false,
  })

  // 2. Discover neighboring repo directories in parent directory if readable
  try {
    const parent = path.dirname(resolvedCwd)
    if (parent && parent !== resolvedCwd) {
      const entries = await fs.readdir(parent, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue
        const candidate = path.join(parent, entry.name)
        if (candidate === resolvedCwd) continue

        try {
          const files = await fs.readdir(candidate)
          const isRepo = files.some(
            (f) =>
              f === ".git" ||
              f === "package.json" ||
              f === "Cargo.toml" ||
              f === "AGENTS.md" ||
              f === "pyproject.toml",
          )
          if (isRepo) {
            items.push({
              path: candidate,
              label: entry.name,
              description: `Discovered repository in ${parent}`,
              selected: false,
              exists: true,
              isCustom: false,
            })
          }
        } catch {
          // Skip unreadable directories
        }
      }
    }
  } catch {
    // Skip parent listing errors
  }

  return items
}

/**
 * Toggles selection for a directory in the item list.
 */
export function toggleProjectDirectory(
  items: readonly ProjectDirectoryItem[],
  targetPath: string,
): ProjectDirectoryItem[] {
  const norm = normalizeProjectPath(targetPath)
  return items.map((item) =>
    normalizeProjectPath(item.path) === norm ? { ...item, selected: !item.selected } : item,
  )
}

/**
 * Adds a new custom directory to the directory list after normalization.
 */
export function addProjectDirectory(
  items: readonly ProjectDirectoryItem[],
  rawPath: string,
): { readonly items: ProjectDirectoryItem[]; readonly added: boolean; readonly error?: string } {
  const norm = normalizeProjectPath(rawPath)
  if (!norm) {
    return { items: [...items], added: false, error: "Path cannot be empty" }
  }
  if (items.some((i) => normalizeProjectPath(i.path) === norm)) {
    return { items: [...items], added: false, error: "Path already exists in list" }
  }

  const newItem: ProjectDirectoryItem = {
    path: norm,
    label: path.basename(norm) || norm,
    description: "Custom allowlisted directory",
    selected: true,
    exists: true,
    isCustom: true,
  }

  return { items: [...items, newItem], added: true }
}

/**
 * Formats the directory selector for TUI / stdout rendering.
 */
export function renderDirectorySelector(
  items: readonly ProjectDirectoryItem[],
  customInput = "",
): string {
  const { cyan, emerald, amber, dim, bold, reset } = BRAND_COLORS
  const lines: string[] = []

  lines.push(`📁 ${bold}Project Allowlists & Containment Boundaries${reset}`)
  lines.push(`   ${dim}Allowlisted Workspaces:${reset}`)
  for (const item of items) {
    const mark = item.selected ? `${emerald}✔${reset}` : `${dim}○${reset}`
    lines.push(`   [${mark}] ${bold}${item.path}${reset}`)
    if (item.description) {
      lines.push(`       ${dim}${item.description}${reset}`)
    }
  }

  if (customInput) {
    lines.push(`   Add Custom Path: ${cyan}${customInput}${reset}`)
  }

  lines.push("")
  lines.push(`   ${amber}Policy:${reset} ${dim}${FAIL_CLOSED_SUBPATH_NOTICE}${reset}`)

  return lines.join("\n")
}

// ── 4. Runtime Probe Widget ───────────────────────────────────────────────

export interface RuntimeProbeDeps {
  readonly processRunner?: ProcessRunner
  readonly httpProbe?: HttpProbe
  readonly opencodeUrl?: string
  readonly fetchFn?: typeof fetch
  readonly checkBinary?: (
    binaryName: string,
  ) => Promise<{ readonly found: boolean; readonly path?: string; readonly version?: string }>
}

export interface RuntimeProbeResult {
  readonly opencode: ProbeResultItem & {
    readonly url: string
    readonly statusCode?: number
  }
  readonly claude: ProbeResultItem & {
    readonly binaryPath?: string
    readonly version?: string
  }
  readonly codex: ProbeResultItem & {
    readonly binaryPath?: string
    readonly version?: string
  }
  readonly allReady: boolean
}

/**
 * Probes local AI Agent Runtimes:
 * 1. OpenCode loopback HTTP health check (http://127.0.0.1:4096/health).
 * 2. Claude Code CLI binary availability on PATH.
 * 3. Codex CLI runtime binary availability on PATH.
 */
export async function probeRuntimes(deps?: RuntimeProbeDeps): Promise<RuntimeProbeResult> {
  const opencodeUrl = deps?.opencodeUrl ?? "http://127.0.0.1:4096/health"

  // 1. OpenCode probe
  let ocConnected = false
  let ocStatusCode: number | undefined
  try {
    if (deps?.httpProbe) {
      const probeRes = await deps.httpProbe.probe(opencodeUrl, { timeoutMs: 2000 })
      ocConnected = probeRes.ok || probeRes.status === 200
      ocStatusCode = probeRes.status
    } else {
      const fetchImpl = deps?.fetchFn ?? fetch
      const res = await fetchImpl(opencodeUrl, {
        signal: AbortSignal.timeout(2000),
      })
      ocConnected = res.ok || res.status === 200
      ocStatusCode = res.status
    }
  } catch {
    ocConnected = false
  }

  const opencodeResult: RuntimeProbeResult["opencode"] = {
    status: ocConnected ? "ok" : "warn",
    label: "OpenCode Serve Loopback (127.0.0.1:4096)",
    detail: ocConnected
      ? `CONNECTED (HTTP ${ocStatusCode ?? 200})`
      : "UNAVAILABLE (Connection refused / not started on :4096)",
    url: opencodeUrl,
    statusCode: ocStatusCode,
  }

  // Helper to test binary on PATH
  async function testBinary(
    binaryName: string,
  ): Promise<{ found: boolean; path?: string; version?: string }> {
    if (deps?.checkBinary) {
      return deps.checkBinary(binaryName)
    }

    if (deps?.processRunner) {
      try {
        const res = await deps.processRunner.exec([binaryName, "--version"], { timeoutMs: 2500 })
        if (res.exitCode === 0) {
          const version = res.stdout.trim().split("\n")[0] || undefined
          return { found: true, path: binaryName, version }
        }
      } catch {
        // Fall through to which
      }

      try {
        const whichRes = await deps.processRunner.exec(["which", binaryName], { timeoutMs: 1500 })
        if (whichRes.exitCode === 0 && whichRes.stdout.trim().length > 0) {
          return { found: true, path: whichRes.stdout.trim() }
        }
      } catch {
        // Not found
      }
      return { found: false }
    }

    // Default node execFile probe
    try {
      const { stdout } = await execFileAsync(binaryName, ["--version"], { timeout: 2500 })
      const version = stdout.trim().split("\n")[0] || undefined
      return { found: true, path: binaryName, version }
    } catch {
      try {
        const { stdout } = await execFileAsync("which", [binaryName], { timeout: 1500 })
        if (stdout.trim().length > 0) {
          return { found: true, path: stdout.trim() }
        }
      } catch {
        // Not found
      }
      return { found: false }
    }
  }

  // 2. Claude Code CLI probe
  const claudeProbe = await testBinary("claude")
  const claudeResult: RuntimeProbeResult["claude"] = {
    status: claudeProbe.found ? "ok" : "warn",
    label: "Claude Code CLI Binary",
    detail: claudeProbe.found
      ? `Detected (${claudeProbe.version || "ready"}) • Headless mode verified`
      : "Not detected on $PATH (optional for OpenCode)",
    binaryPath: claudeProbe.path,
    version: claudeProbe.version,
  }

  // 3. Codex CLI runtime probe
  const codexProbe = await testBinary("codex")
  const codexResult: RuntimeProbeResult["codex"] = {
    status: codexProbe.found ? "ok" : "warn",
    label: "Codex CLI Runtime",
    detail: codexProbe.found
      ? `Detected (${codexProbe.version || "ready"}) • Exec session handle verified`
      : "Not detected on $PATH (optional for OpenCode)",
    binaryPath: codexProbe.path,
    version: codexProbe.version,
  }

  const allReady = ocConnected || claudeProbe.found || codexProbe.found

  return {
    opencode: opencodeResult,
    claude: claudeResult,
    codex: codexResult,
    allReady,
  }
}

/**
 * Formats the runtime probe results for TUI / stdout rendering.
 */
export function renderRuntimeProbe(result: RuntimeProbeResult): string {
  const { emerald, amber, dim, bold, reset } = BRAND_COLORS
  const lines: string[] = []

  lines.push(`🤖 ${bold}AI Agent Runtime Discovery & Loopback Ping${reset}`)

  // OpenCode
  const ocBadge = result.opencode.status === "ok" ? `${emerald}✔ CONNECTED${reset}` : `${amber}▲ NOT RUNNING${reset}`
  lines.push(`   ⚡ ${bold}${result.opencode.label}${reset}`)
  lines.push(`      ${dim}${result.opencode.detail}${reset}  ${ocBadge}`)

  // Claude
  const claudeBadge = result.claude.status === "ok" ? `${emerald}✔ READY${reset}` : `${dim}○ OPTIONAL${reset}`
  lines.push(`   🧠 ${bold}${result.claude.label}${reset}`)
  lines.push(`      ${dim}${result.claude.detail}${reset}  ${claudeBadge}`)

  // Codex
  const codexBadge = result.codex.status === "ok" ? `${emerald}✔ READY${reset}` : `${dim}○ OPTIONAL${reset}`
  lines.push(`   🛠️  ${bold}${result.codex.label}${reset}`)
  lines.push(`      ${dim}${result.codex.detail}${reset}  ${codexBadge}`)

  return lines.join("\n")
}

// ── 5. Tailnet Agent Discovery Widget ─────────────────────────────────────

/**
 * One tailnet peer, paired with what its `/health` route said about itself.
 *
 * The two halves are deliberately separate fields rather than one merged
 * verdict, because they answer different questions and fail independently:
 * `online`/`reachable` come from the local daemon and from an HTTP answer
 * respectively, while `agentId`/`capabilities`/`opencodeReachable` are the
 * remote node's own self-description. Collapsing them would let a caller
 * present "the daemon says it is online" as if it were "the node identifies
 * itself as X", which is precisely the confusion the threat model warns about.
 */
export interface DiscoveredAgent {
  readonly ip: string
  readonly hostname: string
  readonly os: string | null
  /** From the local tailnet listing, NOT from the HTTP probe. */
  readonly online: boolean
  /** `http://<ip>:<bridgePort>` — the exact URL the probe dialled. */
  readonly bridgeUrl: string
  /** `/health` answered at all. Not an authentication signal — see below. */
  readonly reachable: boolean
  /** `/health` `.agent_id`; `null` when unreachable or absent from the body. */
  readonly agentId: string | null
  /** `/health` `.capabilities`, sorted and de-duplicated; `[]` when unknown. */
  readonly capabilities: readonly string[]
  /** `/health` `.opencode`; `null` when unreachable or absent from the body. */
  readonly opencodeReachable: boolean | null
  /** The peer's `agentId` (or, failing that, its ip) is in `enrolledAgentIds`. */
  readonly enrolled: boolean
}

export interface AgentDiscoveryDeps {
  readonly processRunner?: ProcessRunner
  /**
   * Injection seam for tests. FORWARD BOTH ARGUMENTS.
   *
   * `(url) => fetch(url)` is the natural-looking way to write this and it
   * silently drops the `init` that carries `AbortSignal.timeout`, at which
   * point an unreachable peer does not time out — the probe waits on a socket
   * that will never answer, and `aibr discover` hangs instead of reporting the
   * peer as down. No production caller supplies this field; it exists so tests
   * can drive the probe without a network.
   */
  readonly fetchFn?: typeof fetch
  /** Bridge port to dial on each peer. Defaults to 8787. */
  readonly bridgePort?: number
  /** Per-peer HTTP budget. Defaults to 2000ms. */
  readonly timeoutMs?: number
  /** Ids this host already trusts. Drives the `enrolled` flag and nothing else. */
  readonly enrolledAgentIds?: readonly string[]
}

export interface AgentDiscoveryResult {
  readonly agents: readonly DiscoveredAgent[]
  readonly reachableCount: number
  readonly enrolledCount: number
  /** Tailnet peers seen by the daemon, before any HTTP probing happened. */
  readonly peersFound: number
}

// ── Wire schema ─────────────────────────────────────────────────────────

/**
 * `/health` as seen from the outside, parsed defensively.
 *
 * Every field is optional for the same reason `tailscalePeerSchema` is: the
 * node on the other end may be running an older build, a different
 * implementation entirely, or something that merely happens to answer on 8787.
 * A probe that hard-requires `agent_id` would report "unreachable" for a node
 * that is plainly up, which is a worse answer than a partial one — the operator
 * needs to see "something is there, it just did not say much".
 *
 * `ok` is parsed but deliberately NOT used as the reachability signal: a 200
 * with `ok: false` still proves a daemon is listening on that address, which
 * is the only thing reachability claims.
 */
const peerHealthSchema = z.object({
  ok: z.boolean().optional(),
  opencode: z.boolean().optional(),
  agent_id: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
})

/** An agent for which `/health` told us nothing usable. */
function unreachableAgent(
  peer: TailscalePeer,
  bridgeUrl: string,
  enrolledAgentIds: ReadonlySet<string>,
): DiscoveredAgent {
  return {
    ip: peer.ip,
    hostname: peer.hostname,
    os: peer.os,
    online: peer.online,
    bridgeUrl,
    reachable: false,
    agentId: null,
    capabilities: [],
    opencodeReachable: null,
    // Enrolment is decided on the id OR the address, so an unreachable peer
    // can still be recognised as one we already trust — "we know this node,
    // it just is not up right now" is a distinct and useful thing to say.
    enrolled: enrolledAgentIds.has(peer.ip),
  }
}

/**
 * Order by hostname, case-insensitively, with the IP as tie-break.
 *
 * Byte-for-byte the same rule `discoverTailscalePeers` sorts with, and for
 * the same reason: `localeCompare` produces a different order under a
 * different ambient locale, and this output is read in diffs and snapshots
 * where a moving order looks like a changing tailnet.
 */
function compareAgents(a: DiscoveredAgent, b: DiscoveredAgent): number {
  const left = a.hostname.toLowerCase()
  const right = b.hostname.toLowerCase()
  if (left < right) return -1
  if (left > right) return 1
  if (a.ip < b.ip) return -1
  if (a.ip > b.ip) return 1
  return 0
}

/** Sorted, de-duplicated capability list — same projection `/health` emits. */
function normalizeCapabilities(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return []
  const unique = new Set(values)
  return [...unique].sort()
}

/** Guard against a caller passing a budget `AbortSignal.timeout` would reject. */
function safeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_DISCOVERY_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_DISCOVERY_TIMEOUT_MS
  return timeoutMs
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 2000
const DEFAULT_BRIDGE_PORT = 8787

/**
 * Probe one peer's bridge `/health`.
 *
 * Never throws, never retries, and never sends an `Authorization` header: the
 * route is unauthenticated by design because this call happens before any
 * secret has been exchanged. Every failure — refused connection, timeout, non
 * 2xx, unparseable body — collapses to the same "unreachable" projection so a
 * caller cannot mistake a garbled answer for a healthy node.
 */
async function probePeerHealth(
  bridgeUrl: string,
  peer: TailscalePeer,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  enrolledAgentIds: ReadonlySet<string>,
): Promise<DiscoveredAgent> {
  try {
    // No `headers` key at all, rather than an empty object with a comment:
    // there is no credential to send here and the option should not exist on
    // this call site for a future edit to reach for.
    const response = await fetchImpl(`${bridgeUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) return unreachableAgent(peer, bridgeUrl, enrolledAgentIds)

    let decoded: unknown
    try {
      decoded = JSON.parse(await response.text())
    } catch {
      // A 200 carrying something that is not our JSON is not an AIBridge
      // bridge, whatever it is serving. Reporting it as reachable-but-silent
      // would put a wrong node in front of the operator as a candidate.
      return unreachableAgent(peer, bridgeUrl, enrolledAgentIds)
    }

    const parsed = peerHealthSchema.safeParse(decoded)
    if (!parsed.success) return unreachableAgent(peer, bridgeUrl, enrolledAgentIds)

    const agentId = parsed.data.agent_id ?? null
    return {
      ip: peer.ip,
      hostname: peer.hostname,
      os: peer.os,
      online: peer.online,
      bridgeUrl,
      reachable: true,
      agentId,
      capabilities: normalizeCapabilities(parsed.data.capabilities),
      opencodeReachable: parsed.data.opencode ?? null,
      enrolled: agentId !== null
        ? enrolledAgentIds.has(agentId) || enrolledAgentIds.has(peer.ip)
        : enrolledAgentIds.has(peer.ip),
    }
  } catch {
    // Network error, DNS failure, or `AbortSignal.timeout` firing. All three
    // mean the same thing to the operator and are deliberately not distinguished
    // in the result: a timeout is a flavour of "not answering".
    return unreachableAgent(peer, bridgeUrl, enrolledAgentIds)
  }
}

/**
 * `ProcessRunner` over `execFile` for the case where a caller supplies none.
 *
 * Exists so `probeDiscoveredAgents()` works from the wizard with no wiring.
 * Every failure is reported as a nonzero exit rather than thrown, because
 * `discoverTailscalePeers` is documented to degrade to an empty peer list on
 * exactly that signal and a missing `tailscale` binary is the most ordinary
 * outcome here, not an exception.
 */
const defaultTailscaleRunner: ProcessRunner = {
  async exec(argv, options) {
    const [command, ...args] = argv
    if (command === undefined) return { exitCode: 1, stdout: "", stderr: "empty argv" }
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: options?.timeoutMs ?? 3000,
      })
      return { exitCode: 0, stdout, stderr }
    } catch (error) {
      const err = error as { code?: unknown; stdout?: unknown; stderr?: unknown }
      return {
        exitCode: typeof err.code === "number" ? err.code : 1,
        stdout: typeof err.stdout === "string" ? err.stdout : "",
        stderr: typeof err.stderr === "string" ? err.stderr : String(error),
      }
    }
  },
}

/**
 * Enumerate the tailnet and ask each peer who it is.
 *
 * REACHABILITY IS NOT AUTHENTICATION. `Docs/security/milestone-0-threat-model.md`
 * is explicit that a Tailscale connection buys reachability and not identity,
 * and `src/mesh/` repeats that wherever a peer is admitted. So `reachable`
 * here means "a process answered on this address", full stop; `agentId` is the
 * node's own claim about itself and no route accepts it as proof of who is
 * calling. Trust is established on the mesh identity path in
 * `src/mesh/identity/` — ed25519 node keys, enrollment codes, peer pins — and
 * nothing in this function feeds it.
 *
 * PURE BY CONSTRUCTION. This reports and never enrolls. There is no code path
 * from here to a config write or an allowlist mutation, because at this point
 * in the setup flow no peer has been shown to be anything in particular: a
 * reachable `/health` on a tailnet address is exactly what a wrong node, a
 * hijacked address, or an attacker who joined the tailnet would also produce.
 * Enrolling on discovery would be trust-on-first-use with no operator in the
 * loop. `enrolledAgentIds` is an input used only to LABEL what is already
 * enrolled; enrolment itself belongs to a separate, explicit, credentialed
 * step.
 *
 * NOTHING IS ENROLLED, NOTHING IS PRINTED RAW. The daemon's own output is
 * never surfaced: `tailscale status --json` carries node keys and, on some
 * builds, `tskey-` enrollment credentials that are reusable against the
 * node. `src/memory/redaction/` scrubs those patterns, but scrubbing on the
 * way to disk is not a licence to print them on the way to a terminal, so only
 * the normalised fields above ever leave this module.
 *
 * Discovery never throws. An empty tailnet, an absent daemon, or a tailnet
 * where every peer is down all produce a result object, because a caller
 * rendering a setup step wants a degraded screen, not a stack trace.
 */
export async function probeDiscoveredAgents(
  deps?: AgentDiscoveryDeps,
): Promise<AgentDiscoveryResult> {
  const bridgePort = deps?.bridgePort ?? DEFAULT_BRIDGE_PORT
  const timeoutMs = safeTimeout(deps?.timeoutMs)
  const fetchImpl = deps?.fetchFn ?? fetch
  const enrolledAgentIds = new Set(deps?.enrolledAgentIds ?? [])
  const runner = deps?.processRunner ?? defaultTailscaleRunner

  const peers = await discoverTailscalePeers(runner)

  if (peers.length === 0) {
    return { agents: [], reachableCount: 0, enrolledCount: 0, peersFound: 0 }
  }

  // Sequential, and that is a choice rather than an oversight: a setup screen
  // is I/O-bound against a handful of peers, and probing in order keeps the
  // `AbortSignal` budgets from overlapping into a burst that a laptop on
  // battery would rather not send. The contract that matters is the one in
  // the catch below — one dead peer must not cost us the report on the rest.
  const agents: DiscoveredAgent[] = []
  for (const peer of peers) {
    const bridgeUrl = `http://${peer.ip}:${bridgePort}`
    // `probePeerHealth` is total: it resolves to an unreachable projection on
    // every failure path, so the loop below cannot be aborted by a peer.
    agents.push(await probePeerHealth(bridgeUrl, peer, fetchImpl, timeoutMs, enrolledAgentIds))
  }

  agents.sort(compareAgents)

  let reachableCount = 0
  let enrolledCount = 0
  for (const agent of agents) {
    if (agent.reachable) reachableCount++
    if (agent.enrolled) enrolledCount++
  }

  return { agents, reachableCount, enrolledCount, peersFound: peers.length }
}

/**
 * Formats tailnet discovery as ANSI rows matching the TUI design.
 *
 * Per peer: hostname, address, whether `/health` answered, the id it claimed,
 * how much work it accepts, and whether this host already trusts it. The id
 * and the enrolment badge are rendered side by side precisely so an operator
 * can see the mismatch case — a node that answers but is not enrolled, or one
 * that is enrolled under a different id than the address it was reached at.
 */
export function renderAgentDiscoveryProbe(result: AgentDiscoveryResult): string {
  const { cyan, emerald, amber, dim, bold, reset } = BRAND_COLORS
  const lines: string[] = []

  lines.push(`🛰️  ${bold}Tailnet Agent Discovery${reset}`)
  lines.push(
    `   ${dim}${result.peersFound} peer(s) on tailnet • ${result.reachableCount} answering /health • ${result.enrolledCount} enrolled${reset}`,
  )

  if (result.agents.length === 0) {
    lines.push(`   ${amber}▲ NO PEERS FOUND${reset} ${dim}(discovery is advisory; enter ids by hand)${reset}`)
    return lines.join("\n")
  }

  for (const agent of result.agents) {
    const reachBadge = agent.reachable
      ? `${emerald}✔ REACHABLE${reset}`
      : `${amber}▲ UNREACHABLE${reset}`

    // `null` is "we were not told", which is a different fact from `false`
    // ("told, and opencode is down"), and the badges keep them apart.
    const opencodeBadge =
      agent.opencodeReachable === true
        ? `${emerald}✔ OPENCODE${reset}`
        : agent.opencodeReachable === false
          ? `${amber}▲ OPENCODE DOWN${reset}`
          : `${dim}○ OPENCODE UNKNOWN${reset}`

    const enrolledBadge = agent.enrolled
      ? `${emerald}✔ ENROLLED${reset}`
      : `${dim}○ NOT ENROLLED${reset}`

    const capabilityCount = agent.capabilities.length
    const capabilityLabel =
      agent.reachable && capabilityCount > 0
        ? `${cyan}${capabilityCount}${reset} ${dim}capabilit${capabilityCount === 1 ? "y" : "ies"}${reset}`
        : `${dim}capabilities unknown${reset}`

    const agentIdLabel = agent.agentId ?? `${dim}unidentified${reset}`

    lines.push(`   • ${bold}${agent.hostname}${reset} ${dim}(${agent.ip})${reset}  ${reachBadge}`)
    lines.push(
      `      ${dim}agent_id:${reset} ${agentIdLabel}  ${dim}•${reset}  ${capabilityLabel}  ${enrolledBadge}`,
    )
    lines.push(`      ${opencodeBadge}`)
  }

  return lines.join("\n")
}
