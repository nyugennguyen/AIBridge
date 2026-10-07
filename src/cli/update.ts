import type { ProcessRunner, Prompter } from "../host/types.js"

export const PACKAGE_NAME = "@nyugennguyen/aibridge"

export interface UpdateOptions {
  readonly checkOnly?: boolean
  readonly yes?: boolean
}

export interface UpdateResult {
  readonly ok: boolean
  readonly currentVersion: string
  readonly latestVersion?: string
  readonly hasUpdate: boolean
  readonly updated: boolean
  readonly message: string
}

export interface UpdateDeps {
  readonly currentVersion: string
  readonly processRunner?: ProcessRunner
  readonly prompter?: Prompter
  readonly fetchLatestVersion?: (packageName: string) => Promise<string>
  readonly isTTY?: boolean
}

/**
 * Compare two semver strings (e.g. "1.0.1" vs "1.1.0").
 * Returns:
 *   -1 if v1 < v2
 *    0 if v1 === v2
 *    1 if v1 > v2
 */
export function compareSemver(v1: string, v2: string): number {
  const clean1 = v1.replace(/^v/, "").trim()
  const clean2 = v2.replace(/^v/, "").trim()

  const parts1 = clean1.split(".").map((p) => parseInt(p, 10))
  const parts2 = clean2.split(".").map((p) => parseInt(p, 10))

  const len = Math.max(parts1.length, parts2.length)
  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] ?? 0
    const p2 = parts2[i] ?? 0
    if (p1 > p2) return 1
    if (p1 < p2) return -1
  }
  return 0
}

export async function defaultFetchLatestVersion(packageName: string): Promise<string> {
  const url = `https://registry.npmjs.org/${packageName}/latest`
  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  })
  if (!resp.ok) {
    throw new Error(`Registry responded with HTTP ${resp.status}`)
  }
  const data = (await resp.json()) as { version?: string }
  if (!data.version || typeof data.version !== "string") {
    throw new Error("Invalid registry response: missing version field")
  }
  return data.version
}

export async function runUpdate(
  options?: UpdateOptions,
  deps?: UpdateDeps,
): Promise<UpdateResult> {
  const currentVersion = deps?.currentVersion ?? "2.1.0"
  const fetchVersion = deps?.fetchLatestVersion ?? defaultFetchLatestVersion

  // ── 1. Fetch latest version from registry ──────────────────────────
  let latestVersion: string
  try {
    latestVersion = await fetchVersion(PACKAGE_NAME)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      currentVersion,
      hasUpdate: false,
      updated: false,
      message: `Failed to check for updates: ${reason}`,
    }
  }

  // ── 2. Compare versions ────────────────────────────────────────────
  const cmp = compareSemver(currentVersion, latestVersion)
  const hasUpdate = cmp < 0

  if (!hasUpdate) {
    return {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate: false,
      updated: false,
      message: `AIBridge is up to date (current: v${currentVersion}, latest: v${latestVersion})`,
    }
  }

  // ── 3. Check-only mode ─────────────────────────────────────────────
  if (options?.checkOnly) {
    return {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate: true,
      updated: false,
      message: `Update available: v${currentVersion} -> v${latestVersion}\nRun "aibr update" to install the update.`,
    }
  }

  // ── 4. Confirmation ────────────────────────────────────────────────
  if (!options?.yes) {
    if (deps?.isTTY === false) {
      return {
        ok: false,
        currentVersion,
        latestVersion,
        hasUpdate: true,
        updated: false,
        message: `Update available: v${currentVersion} -> v${latestVersion}\nTo update in non-interactive environments, pass --yes: aibr update --yes`,
      }
    }

    if (deps?.prompter) {
      const confirm = await deps.prompter.promptConfirm(
        `Update AIBridge to v${latestVersion}?`,
      )
      if (confirm !== "y") {
        return {
          ok: true,
          currentVersion,
          latestVersion,
          hasUpdate: true,
          updated: false,
          message: "Update cancelled.",
        }
      }
    }
  }

  // ── 5. Run update installation ─────────────────────────────────────
  let runner = deps?.processRunner
  if (!runner) {
    const { BunProcessRunner } = await import("../host/runtime.js")
    runner = new BunProcessRunner()
  }

  const pkgTarget = `${PACKAGE_NAME}@${latestVersion}`
  const execResult = await runner.exec(["bun", "install", "-g", pkgTarget])

  if (execResult.exitCode !== 0) {
    return {
      ok: false,
      currentVersion,
      latestVersion,
      hasUpdate: true,
      updated: false,
      message: `Update failed: ${execResult.stderr || "installation failed"}`,
    }
  }

  return {
    ok: true,
    currentVersion,
    latestVersion,
    hasUpdate: true,
    updated: true,
    message: `Successfully updated AIBridge from v${currentVersion} to v${latestVersion}!`,
  }
}
