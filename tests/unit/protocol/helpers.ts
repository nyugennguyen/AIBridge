import { taskSchema } from "../../../src/orchestration/schemas.js"

/**
 * Test-only derivation of the kernel's `shortTextSchema` bound.
 *
 * `shortTextSchema` is module-private in `src/orchestration/schemas.ts`, and M4.0
 * is finished and reviewed, so the bound is DISCOVERED rather than exported. The
 * ReDoS argument for a `SafePattern` is "bounded pattern x bounded subject x
 * linear matching", so the subject half has to be a real measured number and not
 * an assumption — which is exactly what a search over the real schema gives.
 *
 * Measured once and memoised: this is 17 parses, not 17 per assertion.
 */
let cached: number | null = null

export function shortTextBound(): number {
  if (cached !== null) return cached
  const at = (length: number): boolean =>
    taskSchema.safeParse({
      schemaVersion: 1,
      taskId: "task-1",
      runId: "run-1",
      projectId: "project-1",
      title: "a".repeat(length),
      description: "d",
      state: "pending",
      failurePolicy: "block",
      dependencies: [],
      externalReferences: [],
    }).success

  if (!at(1)) throw new Error("A one-character task title was refused; the search bound is not a length bound")
  let low = 1
  let high = 1
  while (at(high) && high < 1_000_000) high *= 2
  // The bound is inclusive, so the last accepted length is the answer.
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2)
    if (at(mid)) low = mid
    else high = mid
  }
  cached = low
  return low
}
