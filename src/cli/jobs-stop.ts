/**
 * `aibr stop` — the operator's stop controls on a worker node.
 *
 *   aibr stop --profile <name>               stops the profile's user service (launchd/systemd,
 *                                             unloaded and removed) and its tmux session (aibridge-<name>)
 *   aibr stop --all-jobs [--profile <name>]  kill switch: terminates every running Claude/script
 *                                             job; each is failed "stopped by operator" and reported
 *
 * `--all-jobs` uses the operator credential against this node's own bridge
 * (see `src/cli/approve.ts`) and asks first unless `--yes`. It does not stop
 * the bridge itself, and jobs awaiting approval are left for `aibr reject`.
 */
import type { ProcessRunner } from "../host/types.js"
import type { StopServiceResult } from "../host/daemonizer.js"
import { operatorRequest, parseOperatorArgs, sanitizeForTerminal, type OperatorCliDeps } from "./approve.js"
import { listProfileNames, profileMissing } from "./arg-errors.js"

export interface StopCliDeps extends OperatorCliDeps {
  readonly processRunner: ProcessRunner
  /** Unloads and removes the profile's user service. Absent: only tmux is stopped. */
  readonly stopService?: (profile: string) => Promise<StopServiceResult>
  /** The profiles on this machine, named when --profile is missing. Default: read the config root. */
  readonly listProfiles?: () => readonly string[]
}

const STOP_FLAGS = new Set(["--profile", "--yes", "--all-jobs"])

export const STOP_HELP = [
  "aibr stop — stop a profile's bridge (service and tmux), or every running job (kill switch)",
  "",
  "Usage:",
  "  aibr stop --profile <name>",
  "  aibr stop --all-jobs [--profile <name>] [--yes]",
  "",
  "--all-jobs terminates every running Claude/script job on this node; each is",
  "failed \"stopped by operator\" and its requester gets a report. It needs the",
  "operator token and must run on the node itself. Without --all-jobs the",
  "profile's user service (aibr start) is unloaded and removed, and the tmux",
  "session aibridge-<name> (aibr start --foreground) is killed.",
  "",
  "To end ONE job, use aibr cancel <job_id>.",
  "",
].join("\n")

export async function runStopCommand(argv: readonly string[], deps: StopCliDeps): Promise<number> {
  const explicitProfile = argv.includes("--profile") || argv.includes("-p")
  const parsed = parseOperatorArgs(argv, STOP_FLAGS, "stop")
  if (typeof parsed === "string") {
    deps.writer(`Error: ${parsed}\n`)
    return 64
  }
  if (parsed.help) {
    deps.writer(STOP_HELP)
    return 0
  }
  if (parsed.positional.length > 0) {
    deps.writer(`Error: unexpected argument ${sanitizeForTerminal(parsed.positional[0]!)}\n`)
    return 64
  }

  if (!parsed.allJobs) {
    if (!explicitProfile) {
      deps.writer(`Error: ${profileMissing("stop", false, (deps.listProfiles ?? listProfileNames)(), "or aibr stop --all-jobs to stop the running jobs")}\n`)
      return 64
    }
    let failed = false
    let stoppedSomething = false
    if (deps.stopService !== undefined) {
      const service = await deps.stopService(parsed.profile)
      if (service.kind === "stopped") {
        stoppedSomething = true
        deps.writer(`Stopped the ${service.manager} service for ${parsed.profile}\n`)
        for (const note of service.notes) deps.writer(`${sanitizeForTerminal(note)}\n`)
      } else if (service.kind === "failed") {
        failed = true
        deps.writer(`service_error: ${sanitizeForTerminal(service.message)}\n`)
      }
    }
    const session = `aibridge-${parsed.profile}`
    const result = await deps.processRunner.exec(["tmux", "kill-session", "-t", session])
    if (result.exitCode === 0) {
      deps.writer(`Stopped tmux session: ${session}\n`)
      return failed ? 1 : 0
    }
    if (result.exitCode === null || /can't find session|no server running|session not found|error connecting|No such file/i.test(result.stderr)) {
      if (!stoppedSomething && !failed) deps.writer(`Not running: ${parsed.profile} (no user service, no tmux session ${session})\n`)
      return failed ? 1 : 0
    }
    deps.writer(`tmux_error: ${sanitizeForTerminal(result.stderr || "kill-session failed")}\n`)
    return 1
  }

  try {
    const endpoint = await deps.loadEndpoint(parsed.profile)
    if (!parsed.yes && !(await deps.confirm("Stop EVERY running job on this node?"))) {
      deps.writer("Nothing changed.\n")
      return 1
    }
    const result = await operatorRequest(deps, endpoint, "POST", "/operator/stop-all-jobs", {})
    if (result.status !== 200) {
      const error = typeof result.body.error === "string" ? sanitizeForTerminal(result.body.error) : `HTTP ${result.status}`
      deps.writer(`Error: ${error}\n`)
      return 1
    }
    const stopped = Array.isArray(result.body.stopped) ? result.body.stopped.map((id) => sanitizeForTerminal(String(id))) : []
    deps.writer(stopped.length === 0 ? "No jobs were running.\n" : `Stopped ${stopped.length} job(s): ${stopped.join(", ")}\n`)
    return 0
  } catch (error) {
    deps.writer(`Error: ${error instanceof Error ? error.message : "stop failed"}\n`)
    return 1
  }
}
