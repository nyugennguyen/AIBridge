// SPIKE CODE -- NOT PRODUCTION. Throwaway measurement artefact for M7.1.
// See spike/README.md. This file exists only to put a Bun process into a
// reproducible steady state so that bench/mem.sh samples a level rather than an
// allocator plateau. Nothing here may be imported from src/.
//
// WHY AN IN-PROCESS LOOP AND NOT ONLY HTTP TRAFFIC.
//
// Milestone 7 §5.1.1 removed "idle" as a gateable quantity: JSC migrates between
// RSS plateaus on a minute timescale, and M7.0 measured a 61% run-to-run spread
// on an unchanged process. The replacement is "steady state under sustained
// load". For a Bun process whose entire job in this milestone is to drain a
// queue, the work is NOT behind the socket -- after M7.7 the worker receives
// admitted work in-process. Measuring only socket traffic would leave the worker
// doing no work at all, which is the opposite of the state the gate cares about.
//
// So every topology in this spike runs the SAME loop at the SAME rate inside its
// Bun process, and the only thing that varies between topologies is whether
// Fastify and a listening socket are present, and which extra processes exist.
// That is what makes A vs B a measurement of one variable.
//
// WHAT THE LOOP DOES, and the two places it deliberately departs from
// src/server/routes/trigger.ts:
//
//   1. It does not stop at the opencode health probe. No opencode serve runs on
//      this capture host, so every iteration would terminate at the same
//      ECONNREFUSED with no durable write, and the loop would measure rejection
//      handling rather than steady-state drain work. Continuing past the probe
//      is a SPIKE DEVIATION and is recorded as one in the spike report.
//   2. It marks each job failed instead of launching a session, so the job store
//      holds terminal records rather than an unbounded pile of accepted work.
//
// KNOWN UPWARD BIAS, accepted rather than engineered away: each iteration adds
// one JobManager map entry (~2 KiB), so a 60 s window at the profile rate adds
// roughly 0.5 MiB. It is identical in every topology, so it cancels in the A-vs-B
// comparison, but it inflates the absolute level slightly against the 48 MiB
// criterion. Correcting it by deleting records would add work no worker performs.

import { loadConfig } from "../src/config/loader.js"
import { triggerRequestSchema } from "../src/config/schemas.js"
import type { BridgeConfig } from "../src/config/types.js"
import { JobManager } from "../src/jobs/manager.js"
import { JsonFileJobStore } from "../src/jobs/store.js"
import { SdkOpencodeClientAdapter } from "../src/opencode/client.js"
import { ConfigPlanReviewProvider } from "../src/planning/provider.js"
import { assertProjectAllowed } from "../src/security/allowlist.js"
import { assertSourceAuthorized } from "../src/security/source-authorization.js"

export interface LoadProfile {
  inProcessRatePerSecond: number
  payload: Record<string, unknown>
  stateDir: string
}

export interface LoadLoopHandle {
  readonly config: BridgeConfig
  readonly iterations: () => number
  readonly failures: () => number
}

const TICK_MS = 5

/**
 * Start the fixed-rate loop and return once the first tick has been scheduled.
 * Returns immediately; the loop runs for the life of the process.
 */
export async function startLoadLoop(profile: LoadProfile): Promise<LoadLoopHandle> {
  const config = await loadConfig(process.env.AIBRIDGE_CONFIG as string)

  const opencodeClient = new SdkOpencodeClientAdapter({
    baseUrl: config.opencode.base_url,
    username: config.opencode.username,
    password: process.env[config.opencode.password_env],
  })

  const jobManager = new JobManager(new JsonFileJobStore(`${profile.stateDir}/load-loop-jobs`))
  const planReview = new ConfigPlanReviewProvider(config.planning.require_approval_for)

  let iterations = 0
  let failures = 0

  async function once(): Promise<void> {
    const parsed = triggerRequestSchema.safeParse(profile.payload)
    if (!parsed.success) {
      failures += 1
      return
    }
    const trigger = parsed.data

    if (trigger.target_agent_id !== config.agent_id) {
      failures += 1
      return
    }
    try {
      assertSourceAuthorized(trigger.source_agent_id, trigger.capability, config.security.allowed_sources)
      assertProjectAllowed(trigger.project_dir, config.projects)
      if (!planReview.isApproved(trigger.capability, trigger.metadata)) {
        failures += 1
        return
      }
    } catch {
      failures += 1
      return
    }

    // Probed for its side effect on the code path, not its result: see the
    // departure note at the top of this file.
    await opencodeClient.health().catch(() => false)

    try {
      const job = await jobManager.createJob(trigger)
      await jobManager.markFailed(job.id, "spike: synthetic drain work")
    } catch {
      failures += 1
    }
  }

  const periodMs = 1000 / profile.inProcessRatePerSecond
  let running = true
  let next = Date.now() + periodMs

  const tick = async (): Promise<void> => {
    if (!running) return
    await once()
    iterations += 1
    next += periodMs
    const drift = next - Date.now()
    setTimeout(tick, drift > 0 ? drift : TICK_MS)
  }

  setTimeout(() => void tick(), 0)

  // Written so a capture transcript shows the loop was actually running at rate;
  // a loop that silently stopped is indistinguishable from an idle process.
  const report = setInterval(() => {
    process.stdout.write(`spike-load iterations=${iterations} failures=${failures}\n`)
  }, 10_000)
  report.unref?.()

  // No SIGTERM/SIGINT handlers here on purpose. An earlier revision installed
  // ones that cleared `running` and expected the process to exit afterwards; it
  // did not, because registering a handler replaces the default terminate
  // behaviour and nothing else in this process is short-lived. The capture
  // script's cleanup then blocked forever in `wait`, and the whole measurement run
  // hung on its first capture. A process that must be killable must not install a
  // handler that declines to kill it.
  return {
    config,
    iterations: () => iterations,
    failures: () => failures,
  }
}