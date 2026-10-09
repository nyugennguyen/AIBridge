/**
 * Native binary discovery for AIBridge Rust components (`aibr-tui` and `aibr-router`).
 *
 * This module resolves the compiled Rust binaries across:
 * 1. Environment variable overrides (`AIBRIDGE_TUI_BIN`, `AIBRIDGE_ROUTER_BIN`).
 * 2. Installed per-platform optional dependency packages (`@nyugennguyen/aibridge-<platform>`).
 * 3. Package-bundled prebuilt binaries (`bin/<name>`).
 * 4. Local workspace checkouts (`target/{release,debug}/<name>`).
 * 5. System PATH (`which <name>` lookup).
 */
import { constants, accessSync, existsSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export type NativeBinaryName = "aibr-tui" | "aibr-router"

/**
 * Supported platform package identifiers for prebuilt optionalDependencies.
 */
export const SUPPORTED_PLATFORM_PACKAGES = [
  "@nyugennguyen/aibridge-darwin-arm64",
  "@nyugennguyen/aibridge-darwin-x64",
  "@nyugennguyen/aibridge-linux-arm64-gnu",
  "@nyugennguyen/aibridge-linux-arm64-musl",
  "@nyugennguyen/aibridge-linux-x64-gnu",
  "@nyugennguyen/aibridge-linux-x64-musl",
] as const

export type SupportedPlatformPackage = (typeof SUPPORTED_PLATFORM_PACKAGES)[number]

/**
 * Detect whether the running Linux environment is backed by musl libc.
 */
export function detectIsMusl(): boolean {
  if (process.env.AIBRIDGE_LIBC === "musl") return true
  if (process.env.AIBRIDGE_LIBC === "glibc") return false

  // Check Node / Bun process report if available
  try {
    const proc = process as unknown as {
      report?: {
        getReport?: () => {
          header?: { glibcVersionRuntime?: string }
        }
      }
    }
    const report = proc.report?.getReport?.()
    if (report?.header?.glibcVersionRuntime !== undefined) {
      return false
    }
  } catch {
    // Ignore report inspection failure
  }

  // Alpine Linux check
  if (existsSync("/etc/alpine-release")) {
    return true
  }

  // Inspect /lib for ld-musl-* dynamic linkers
  try {
    if (existsSync("/lib")) {
      const entries = readdirSync("/lib")
      if (entries.some((entry) => entry.startsWith("ld-musl-"))) {
        return true
      }
    }
  } catch {
    // Ignore fs inspection failure
  }

  return false
}

/**
 * Return the list of candidate platform packages in order of preference.
 */
export function getCandidatePlatformPackages(
  platform: string = process.platform,
  arch: string = process.arch,
  isMusl: boolean = detectIsMusl(),
): readonly SupportedPlatformPackage[] {
  if (platform === "darwin") {
    if (arch === "arm64") return ["@nyugennguyen/aibridge-darwin-arm64"]
    if (arch === "x64") return ["@nyugennguyen/aibridge-darwin-x64"]
    return []
  }

  if (platform === "linux") {
    if (arch === "x64") {
      return isMusl
        ? ["@nyugennguyen/aibridge-linux-x64-musl", "@nyugennguyen/aibridge-linux-x64-gnu"]
        : ["@nyugennguyen/aibridge-linux-x64-gnu", "@nyugennguyen/aibridge-linux-x64-musl"]
    }
    if (arch === "arm64") {
      return isMusl
        ? ["@nyugennguyen/aibridge-linux-arm64-musl", "@nyugennguyen/aibridge-linux-arm64-gnu"]
        : ["@nyugennguyen/aibridge-linux-arm64-gnu", "@nyugennguyen/aibridge-linux-arm64-musl"]
    }
    return []
  }

  return []
}

/**
 * Check if a file exists and is executable.
 */
function isExecutable(filePath: string): boolean {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return false
    // On Windows, any existing file is considered executable; on POSIX check X_OK.
    if (process.platform === "win32") return true
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Search system PATH for a binary.
 */
export function findInPath(name: string, customPath?: string): string | null {
  const pathEnv = customPath !== undefined ? customPath : (process.env.PATH ?? "")
  if (!pathEnv) return null

  const dirs = pathEnv.split(delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) {
      return candidate
    }
  }

  return null
}

/**
 * Base roots to search around the current module URL.
 */
function getModuleRoots(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    resolve(here, ".."), // dist/ or src/
    resolve(here, "..", ".."), // repo root or package root
    resolve(here, "..", "..", ".."), // node_modules parent
    resolve(here, "..", "..", "..", ".."), // hoisted node_modules
  ]
}

/**
 * Resolve a native binary path across environment, optional packages,
 * local builds, and system PATH.
 */
export function resolveNativeBinary(
  name: NativeBinaryName,
  options?: {
    readonly env?: Record<string, string | undefined>
    readonly roots?: readonly string[]
    readonly platform?: string
    readonly arch?: string
    readonly isMusl?: boolean
  },
): string | null {
  const env = options?.env ?? process.env

  // 1. Explicit environment variable override
  const envVar = name === "aibr-tui" ? env.AIBRIDGE_TUI_BIN : env.AIBRIDGE_ROUTER_BIN
  if (envVar !== undefined && envVar !== "") {
    if (isExecutable(envVar)) {
      return envVar
    }
  }

  const platform = options?.platform ?? process.platform
  const arch = options?.arch ?? process.arch
  const isMusl = options?.isMusl ?? detectIsMusl()
  const candidatePackages = getCandidatePlatformPackages(platform, arch, isMusl)
  const roots = options?.roots ?? getModuleRoots()

  // 2. Installed optional platform packages via Node module resolution
  try {
    const req = createRequire(import.meta.url)
    for (const pkg of candidatePackages) {
      try {
        const pkgJsonPath = req.resolve(`${pkg}/package.json`)
        const binCandidate = join(dirname(pkgJsonPath), "bin", name)
        if (isExecutable(binCandidate)) {
          return binCandidate
        }
      } catch {
        // Platform package not resolved via require.resolve
      }
    }
  } catch {
    // Module resolution unavailable
  }

  // 3. Platform packages via filesystem walking
  for (const root of roots) {
    for (const pkg of candidatePackages) {
      const unscoped = pkg.replace(/^@[^/]+\//, "")
      const pathsToCheck = [
        join(root, "node_modules", pkg, "bin", name),
        join(root, "node_modules", unscoped, "bin", name),
        join(root, "packages", unscoped, "bin", name),
        join(root, "packages", pkg, "bin", name),
      ]
      for (const candidate of pathsToCheck) {
        if (isExecutable(candidate)) {
          return candidate
        }
      }
    }
  }

  // 4. Bundled bin/ directory
  for (const root of roots) {
    const bundledCandidates = [
      join(root, "bin", name),
      join(root, "bin", `${name}-${platform}-${arch}`),
      join(root, "dist", "bin", name),
    ]
    for (const candidate of bundledCandidates) {
      if (isExecutable(candidate)) {
        return candidate
      }
    }
  }

  // 5. Local development build (Cargo workspace)
  for (const root of roots) {
    const devCandidates = [
      join(root, "target", "release", name),
      join(root, "target", "debug", name),
      join(root, "router", "target", "release", name),
      join(root, "router", "target", "debug", name),
    ]
    for (const candidate of devCandidates) {
      if (isExecutable(candidate)) {
        return candidate
      }
    }
  }

  // 6. Global npm/bun package bin directory or system PATH
  const fromPath = findInPath(name, env.PATH)
  if (fromPath !== null) {
    return fromPath
  }

  return null
}

/**
 * Locate the `aibr-tui` binary. Returns null if unavailable.
 */
export function findTuiBinary(env?: Record<string, string | undefined>): string | null {
  return resolveNativeBinary("aibr-tui", env ? { env } : undefined)
}

/**
 * Locate the `aibr-router` binary. Returns null if unavailable.
 */
export function findRouterBinary(env?: Record<string, string | undefined>): string | null {
  return resolveNativeBinary("aibr-router", env ? { env } : undefined)
}
