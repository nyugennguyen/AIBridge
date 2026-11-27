/**
 * `aibr update`: check npm for a newer `@nyugennguyen/aibridge`, install it,
 * confirm the install, and restart the bridges that were running the old code.
 *
 * What an update has to get right, each learned from a real node:
 *
 * - **Which package manager.** The installer uses `bun install -g`; a node set
 *   up with `npm install -g` must be updated with npm, or it ends up with two
 *   copies and the old one first on PATH. A source checkout (`bun src/cli.ts`,
 *   `bun run dev`) is not a package install at all and is refused, not
 *   "updated" into a second copy.
 * - **Which `bun`.** `su <user>` and service environments often lack
 *   `~/.bun/bin` on PATH ("env: 'bun': No such file"), so the install runs
 *   with the bun that is running this command, by absolute path.
 * - **The running bridges.** Installing replaces files on disk; a bridge that
 *   is already running keeps the old code in memory until it restarts. Every
 *   profile whose user service (launchd/systemd) is running is restarted with
 *   the NEW `aibr start`, in a child process, since this process still holds
 *   the old code. A bridge run in tmux (`aibr start --foreground`) is named
 *   with the command that restarts it: killing an interactive session the
 *   operator may be watching is not this command's call.
 * - **Proof.** The new install is asked for its own `--version`; an install
 *   that "succeeded" but still reports the old version is a failure.
 */
import type { ProcessRunner, Prompter } from "../host/types.js"
import { CLI_VERSION } from "../version.js"

export const PACKAGE_NAME = "@nyugennguyen/aibridge"

export interface UpdateOptions {
  readonly checkOnly?: boolean
  readonly yes?: boolean
  /** `--no-restart`: install, but leave running bridges on the old code. */
  readonly noRestart?: boolean
}

export interface UpdateResult {
  readonly ok: boolean
  readonly currentVersion: string
  readonly latestVersion?: string
  readonly hasUpdate: boolean
  readonly updated: boolean
  readonly message: string
}

/** How this `aibr` was installed, and the command that installs a version of it. */
export type InstallMethod =
  | { readonly kind: "bun"; readonly command: (pkg: string) => readonly string[] }
  | { readonly kind: "npm"; readonly command: (pkg: string) => readonly string[] }
  | { readonly kind: "source"; readonly path: string }

/** One running bridge, after the update tried to restart it. */
export interface RestartOutcome {
  readonly profile: string
  readonly runner: "launchd" | "systemd" | "tmux"
  /** `restarted`: its service was restarted on the new code. `manual`: it runs in tmux; `hint` says how. */
  readonly result: "restarted" | "failed" | "manual"
  readonly detail?: string
}

export interface UpdateDeps {
  readonly currentVersion: string
  readonly processRunner?: ProcessRunner
  readonly prompter?: Prompter
  readonly fetchLatestVersion?: (packageName: string) => Promise<string>
  readonly isTTY?: boolean
  /** Absolute argv that runs this `aibr` (`[bun, cli.js]`). Default: the running process. */
  readonly entry?: readonly string[]
  /** Restart the bridges running the old code, with the new `aibr` at `entry`. */
  readonly restartBridges?: (entry: readonly string[], runner: ProcessRunner) => Promise<readonly RestartOutcome[]>
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
    signal: AbortSignal.timeout(10_000),
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

/**
 * How the `aibr` at `entry` was installed. `entry[0]` is the runtime (bun),
 * `entry[1]` the script it runs, when there is one.
 */
export function detectInstallMethod(entry: readonly string[]): InstallMethod {
  const runtime = entry[0] ?? "bun"
  const script = (entry[1] ?? entry[0] ?? "").replace(/\\/g, "/")
  if (/\/\.bun\/install\/global\//.test(script) || /\/install\/global\/node_modules\//.test(script)) {
    return { kind: "bun", command: (pkg) => [runtime, "install", "-g", pkg] }
  }
  if (/\/node_modules\/@nyugennguyen\/aibridge\//.test(script)) {
    return { kind: "npm", command: (pkg) => ["npm", "install", "-g", pkg] }
  }
  return { kind: "source", path: script }
}

/** The version the installed `aibr` reports, or `null` when it cannot be run. */
async function installedVersion(runner: ProcessRunner, entry: readonly string[]): Promise<string | null> {
  try {
    const result = await runner.exec([...entry, "--version"], { timeoutMs: 30_000 })
    if (result.exitCode !== 0) return null
    const lines = result.stdout.trim().split("\n")
    const last = lines[lines.length - 1]?.trim() ?? ""
    return /^\d+\.\d+\.\d+/.test(last) ? last : null
  } catch {
    return null
  }
}

function restartSummary(outcomes: readonly RestartOutcome[]): string[] {
  if (outcomes.length === 0) return ["No running bridge to restart."]
  return outcomes.map((o) => {
    switch (o.result) {
      case "restarted":
        return `✓ Restarted the ${o.runner} service of profile "${o.profile}" on the new version.`
      case "failed":
        return `✗ Could not restart profile "${o.profile}" (${o.runner}): ${o.detail ?? "aibr start failed"}. Run: aibr start --profile ${o.profile}`
      case "manual":
        return `! Profile "${o.profile}" runs in tmux and still has the old code. Restart it: aibr stop --profile ${o.profile} && aibr start --foreground --profile ${o.profile}`
    }
  })
}

export async function runUpdate(
  options?: UpdateOptions,
  deps?: UpdateDeps,
): Promise<UpdateResult> {
  const currentVersion = deps?.currentVersion ?? CLI_VERSION
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
      message: `Failed to check for updates: ${reason}\nCheck the network, or look it up by hand: npm view ${PACKAGE_NAME} version`,
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
      message: `Update available: v${currentVersion} -> v${latestVersion}\nRun "aibr update" to install it and restart the running bridges.`,
    }
  }

  // ── 4. Where this aibr came from ───────────────────────────────────
  let entry = deps?.entry
  if (entry === undefined) {
    const { currentAibrEntry } = await import("../host/daemonizer.js")
    entry = currentAibrEntry()
  }
  const method = detectInstallMethod(entry)
  if (method.kind === "source") {
    return {
      ok: false,
      currentVersion,
      latestVersion,
      hasUpdate: true,
      updated: false,
      message:
        `Update available: v${currentVersion} -> v${latestVersion}, but this aibr runs from ${method.path || "an unknown location"}, ` +
        `not from a global package install. Update that checkout with git, or install the package: bun install -g ${PACKAGE_NAME}`,
    }
  }

  // ── 5. Confirmation ────────────────────────────────────────────────
  if (!options?.yes) {
    if (deps?.isTTY === false || deps?.prompter === undefined) {
      return {
        ok: false,
        currentVersion,
        latestVersion,
        hasUpdate: true,
        updated: false,
        message: `Update available: v${currentVersion} -> v${latestVersion}\nTo update without a prompt, pass --yes: aibr update --yes`,
      }
    }
    const confirm = await deps.prompter.promptConfirm(`Update AIBridge v${currentVersion} -> v${latestVersion} and restart the running bridges?`)
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

  // ── 6. Install ─────────────────────────────────────────────────────
  let runner = deps?.processRunner
  if (!runner) {
    const { BunProcessRunner } = await import("../host/runtime.js")
    runner = new BunProcessRunner()
  }

  const pkgTarget = `${PACKAGE_NAME}@${latestVersion}`
  const installArgv = method.command(pkgTarget)
  const execResult = await runner.exec(installArgv, { timeoutMs: 300_000 })

  if (execResult.exitCode !== 0) {
    const detail = (execResult.stderr || execResult.stdout || "installation failed").trim().split("\n").slice(-3).join("\n  ")
    return {
      ok: false,
      currentVersion,
      latestVersion,
      hasUpdate: true,
      updated: false,
      message: `Update failed (${installArgv.join(" ")}):\n  ${detail}\nNothing was restarted; the running bridges still use v${currentVersion}.`,
    }
  }

  // ── 7. Prove it ────────────────────────────────────────────────────
  const installed = await installedVersion(runner, entry)
  if (installed !== null && compareSemver(installed, latestVersion) !== 0) {
    return {
      ok: false,
      currentVersion,
      latestVersion,
      hasUpdate: true,
      updated: false,
      message:
        `"${installArgv.join(" ")}" succeeded, but ${entry.join(" ")} still reports v${installed}, not v${latestVersion}. ` +
        `Another copy of aibr may come first: check "which -a aibr". Nothing was restarted.`,
    }
  }

  const lines = [`Updated AIBridge v${currentVersion} -> v${latestVersion} (${method.kind} install).`]
  if (installed === null) lines.push("(Could not run the new aibr to confirm its version; check with: aibr --version)")

  // ── 8. Restart the bridges on the old code ─────────────────────────
  if (options?.noRestart) {
    lines.push("Running bridges were left on the old code (--no-restart). Restart each with: aibr start --profile <name>")
  } else {
    const restart = deps?.restartBridges ?? defaultRestartBridges
    let outcomes: readonly RestartOutcome[] = []
    try {
      outcomes = await restart(entry, runner)
    } catch (error) {
      lines.push(`Could not look for running bridges (${error instanceof Error ? error.message : String(error)}). Restart each with: aibr start --profile <name>`)
    }
    lines.push(...restartSummary(outcomes))
    if (outcomes.some((o) => o.result === "failed")) {
      return { ok: false, currentVersion, latestVersion, hasUpdate: true, updated: true, message: lines.join("\n") }
    }
  }

  return {
    ok: true,
    currentVersion,
    latestVersion,
    hasUpdate: true,
    updated: true,
    message: lines.join("\n"),
  }
}

/**
 * Restart every worker profile whose user service is running, with the new
 * `aibr start` (`entry`), and name the ones that run in tmux.
 */
export async function defaultRestartBridges(entry: readonly string[], runner: ProcessRunner): Promise<readonly RestartOutcome[]> {
  const { listProfileNames } = await import("./arg-errors.js")
  const { loadProfileRunInfo, tmuxSessionExists, tmuxSessionName } = await import("./service.js")
  const { defaultUserServiceDeps, userServiceState } = await import("../host/daemonizer.js")
  const serviceDeps = defaultUserServiceDeps(runner)
  const outcomes: RestartOutcome[] = []
  for (const profile of listProfileNames()) {
    let role: string
    try {
      role = (await loadProfileRunInfo(profile, process.env)).role
    } catch {
      continue
    }
    if (role === "orchestrator") continue
    const service = await userServiceState(serviceDeps, profile)
    if (service.running && service.manager !== null) {
      const result = await runner.exec([...entry, "start", "--profile", profile], { timeoutMs: 120_000 })
      const tail = (result.stdout || result.stderr).trim().split("\n").filter((l) => l.trim() !== "")
      outcomes.push(
        result.exitCode === 0
          ? { profile, runner: service.manager, result: "restarted" }
          : { profile, runner: service.manager, result: "failed", detail: tail[tail.length - 1] ?? `exit ${result.exitCode}` },
      )
    } else if (await tmuxSessionExists(runner, tmuxSessionName(profile))) {
      outcomes.push({ profile, runner: "tmux", result: "manual" })
    }
  }
  return outcomes
}
