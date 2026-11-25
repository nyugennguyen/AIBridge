/**
 * Registration seam for the operator commands (`approve`, `reject`, `jobs`,
 * `stop`), kept out of `src/cli.ts` so that file only routes to it.
 */
import type { ProcessRunner } from "../host/types.js"
import { realOperatorDeps, runDecisionCommand, runJobsCommand } from "./approve.js"
import { runStopCommand } from "./jobs-stop.js"

export function runOperatorCommand(
  writer: (text: string) => void,
  processRunner?: ProcessRunner,
): (command: "approve" | "reject" | "jobs" | "stop", args: readonly string[]) => Promise<number> {
  return async (command, args) => {
    const deps = realOperatorDeps(writer)
    switch (command) {
      case "approve":
      case "reject":
        return runDecisionCommand(command, args, deps)
      case "jobs":
        return runJobsCommand(args, deps)
      case "stop": {
        const runner = processRunner ?? new (await import("../host/runtime.js")).BunProcessRunner()
        return runStopCommand(args, { ...deps, processRunner: runner })
      }
    }
  }
}
