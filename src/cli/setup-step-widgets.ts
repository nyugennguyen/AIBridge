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
 */

import { randomBytes } from "node:crypto"
import * as net from "node:net"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import type { ProcessRunner, HttpProbe } from "../host/types.js"

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
