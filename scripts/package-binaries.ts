/**
 * scripts/package-binaries.ts
 *
 * Package compiled native binaries (aibr-tui and aibr-router) into per-platform
 * npm packages (@nyugennguyen/aibridge-<platform>) for distribution via npm optionalDependencies.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")
const DIST_BIN = resolve(ROOT, "dist-bin")
const PACKAGES_DIR = resolve(ROOT, "packages")

export interface PlatformConfig {
  readonly name: string
  readonly unscoped: string
  readonly os: readonly string[]
  readonly cpu: readonly string[]
  readonly libc?: readonly string[]
  readonly target: string
}

export const PLATFORM_CONFIGS: readonly PlatformConfig[] = [
  {
    name: "@nyugennguyen/aibridge-darwin-arm64",
    unscoped: "aibridge-darwin-arm64",
    os: ["darwin"],
    cpu: ["arm64"],
    target: "aarch64-apple-darwin",
  },
  {
    name: "@nyugennguyen/aibridge-darwin-x64",
    unscoped: "aibridge-darwin-x64",
    os: ["darwin"],
    cpu: ["x64"],
    target: "x86_64-apple-darwin",
  },
  {
    name: "@nyugennguyen/aibridge-linux-x64-gnu",
    unscoped: "aibridge-linux-x64-gnu",
    os: ["linux"],
    cpu: ["x64"],
    libc: ["glibc"],
    target: "x86_64-unknown-linux-gnu",
  },
  {
    name: "@nyugennguyen/aibridge-linux-x64-musl",
    unscoped: "aibridge-linux-x64-musl",
    os: ["linux"],
    cpu: ["x64"],
    libc: ["musl"],
    target: "x86_64-unknown-linux-musl",
  },
  {
    name: "@nyugennguyen/aibridge-linux-arm64-gnu",
    unscoped: "aibridge-linux-arm64-gnu",
    os: ["linux"],
    cpu: ["arm64"],
    libc: ["glibc"],
    target: "aarch64-unknown-linux-gnu",
  },
  {
    name: "@nyugennguyen/aibridge-linux-arm64-musl",
    unscoped: "aibridge-linux-arm64-musl",
    os: ["linux"],
    cpu: ["arm64"],
    libc: ["musl"],
    target: "aarch64-unknown-linux-musl",
  },
]

export interface PackageResult {
  readonly platform: string
  readonly packageDir: string
  readonly packaged: boolean
  readonly reason?: string
}

/**
 * Locate source binaries for a given target.
 */
function findSourceBinaries(config: PlatformConfig, allowLocalRelease = false): {
  router: string | null
  tui: string | null
} {
  let router: string | null = null
  let tui: string | null = null

  // 1. Check dist-bin for explicit target
  const distRouter = join(DIST_BIN, `aibr-router-${config.target}`)
  const distTui = join(DIST_BIN, `aibr-tui-${config.target}`)
  if (existsSync(distRouter)) router = distRouter
  if (existsSync(distTui)) tui = distTui

  // 2. Darwin universal fallback if target-specific binary is absent
  if (config.os.includes("darwin")) {
    const universalRouter = join(DIST_BIN, "aibr-router-universal-apple-darwin")
    const universalTui = join(DIST_BIN, "aibr-tui-universal-apple-darwin")
    if (router === null && existsSync(universalRouter)) router = universalRouter
    if (tui === null && existsSync(universalTui)) tui = universalTui
  }

  // 3. Fallback to target/release if matching host platform
  if (allowLocalRelease) {
    const isHost =
      (process.platform === "darwin" && config.os.includes("darwin") && process.arch === config.cpu[0]) ||
      (process.platform === "linux" && config.os.includes("linux") && process.arch === config.cpu[0])

    if (isHost) {
      const localRouter = join(ROOT, "target", "release", "aibr-router")
      const localTui = join(ROOT, "target", "release", "aibr-tui")
      if (router === null && existsSync(localRouter)) router = localRouter
      if (tui === null && existsSync(localTui)) tui = localTui
    }
  }

  return { router, tui }
}

/**
 * Package a single platform.
 */
export function packagePlatform(
  config: PlatformConfig,
  version: string,
  options: { allowLocalRelease?: boolean; dryRun?: boolean } = {},
): PackageResult {
  const packageDir = join(PACKAGES_DIR, config.unscoped)
  const { router, tui } = findSourceBinaries(config, options.allowLocalRelease)

  if (router === null || tui === null) {
    return {
      platform: config.name,
      packageDir,
      packaged: false,
      reason: `Missing binary: router=${router !== null}, tui=${tui !== null}`,
    }
  }

  if (options.dryRun) {
    return {
      platform: config.name,
      packageDir,
      packaged: true,
      reason: "dry-run",
    }
  }

  mkdirSync(join(packageDir, "bin"), { recursive: true })

  // Copy binaries and set executable bit
  const destRouter = join(packageDir, "bin", "aibr-router")
  const destTui = join(packageDir, "bin", "aibr-tui")

  copyFileSync(router, destRouter)
  chmodSync(destRouter, 0o755)

  copyFileSync(tui, destTui)
  chmodSync(destTui, 0o755)

  // Copy documentation & license
  const licenseSrc = join(ROOT, "LICENSE")
  if (existsSync(licenseSrc)) {
    copyFileSync(licenseSrc, join(packageDir, "LICENSE"))
  }

  const readmeContent = `# ${config.name}\n\nPrebuilt native binaries for AIBridge on ${config.os.join(", ")} (${config.cpu.join(", ")}).\n`
  writeFileSync(join(packageDir, "README.md"), readmeContent, "utf8")

  // Generate package.json
  const manifest: Record<string, unknown> = {
    name: config.name,
    version,
    description: `Prebuilt native binaries for AIBridge (${config.os.join(",")}-${config.cpu.join(",")})`,
    license: "MIT",
    os: [...config.os],
    cpu: [...config.cpu],
    bin: {
      "aibr-tui": "bin/aibr-tui",
      "aibr-router": "bin/aibr-router",
    },
    files: ["bin", "README.md", "LICENSE"],
    publishConfig: {
      access: "public",
    },
  }

  if (config.libc !== undefined) {
    manifest.libc = [...config.libc]
  }

  writeFileSync(join(packageDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8")

  return {
    platform: config.name,
    packageDir,
    packaged: true,
  }
}

/**
 * Package all available platforms.
 */
export function packageAllPlatforms(options: {
  allowLocalRelease?: boolean
  dryRun?: boolean
  hostOnly?: boolean
} = {}): PackageResult[] {
  const rootManifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  const version: string = rootManifest.version

  const configsToProcess = options.hostOnly
    ? PLATFORM_CONFIGS.filter(
        (c) =>
          c.os.includes(process.platform) &&
          c.cpu.includes(process.arch),
      )
    : PLATFORM_CONFIGS

  const results: PackageResult[] = []
  for (const config of configsToProcess) {
    results.push(packagePlatform(config, version, options))
  }

  return results
}

// CLI execution
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const hostOnly = args.includes("--host-only")
  const allowLocalRelease = args.includes("--allow-local-release") || hostOnly

  console.log(`Packaging AIBridge platform binaries (dryRun=${dryRun}, hostOnly=${hostOnly})...`)
  const results = packageAllPlatforms({ dryRun, hostOnly, allowLocalRelease })

  for (const res of results) {
    if (res.packaged) {
      console.log(`✓ [SUCCESS] ${res.platform} -> ${res.packageDir}`)
    } else {
      console.log(`- [SKIPPED] ${res.platform}: ${res.reason}`)
    }
  }
}
