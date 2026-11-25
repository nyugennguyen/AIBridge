import type { JobRecord } from "./types.js"

/**
 * The record as the legacy translation knows it. `legacyJobRecordSchema` (and
 * its trigger) is strict and predates runtime selection, operator approval and
 * repository pinning, so those fields are dropped before the kernel sees the
 * record rather than widening the frozen legacy contract. A job held for
 * approval is, to the kernel, accepted-but-not-launched work: the held
 * DRAFT/PAUSED run `acceptTrigger` already records for every legacy trigger.
 */
export function legacyJobProjection(job: JobRecord): JobRecord {
  const {
    runtime: _runtime,
    runtimeSessionId: _session,
    runtimeResult: _result,
    approval: _approval,
    checkout: _checkout,
    ...legacy
  } = job
  const { repo: _repo, ref: _ref, ...trigger } = legacy.trigger
  return { ...legacy, trigger, status: legacy.status === "awaiting_approval" ? "accepted" : legacy.status }
}
