import { describe, expect, it } from "vitest"
import {
  dispatchStateSchema,
  runStateSchema,
  sessionLifecycleStateSchema,
  sessionStateSchema,
  taskStateSchema,
} from "../../../src/orchestration/schemas.js"
import {
  DISPATCH_STATES,
  RUN_STATES,
  SESSION_OBSERVED_STATES,
  SESSION_STATES,
  TASK_STATES,
  UnhandledSessionObservationError,
  advanceSessionLifecycle,
  isSessionTerminal,
  mapObservedSessionLifecycle,
  type SessionObservedState,
} from "../../../src/orchestration/transitions.js"

/**
 * These tests lock in the Milestone 3 state-model resolution. Before it, the
 * persisted contract (`schemas.ts`) and the aggregate lifecycle machine
 * (`transitions.ts`) held non-overlapping vocabularies, so a run persisted as
 * `paused` could not be driven through `transitionRun` and a session reporting
 * `unknown` threw on read. `as TaskState`-style casts hid it from the compiler.
 */
describe("Lifecycle and observation vocabularies are distinct axes", () => {
  const aligned: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
    ["run", runStateSchema.options, RUN_STATES],
    ["task", taskStateSchema.options, TASK_STATES],
    ["dispatch", dispatchStateSchema.options, DISPATCH_STATES],
    ["session lifecycle", sessionLifecycleStateSchema.options, SESSION_STATES],
  ]

  for (const [name, persisted, lifecycle] of aligned) {
    it(`${name} persists exactly the states the machine governs`, () => {
      const persistedSet = new Set(persisted)
      const lifecycleSet = new Set(lifecycle)
      // Every persisted state must be driveable, and every machine state must be
      // persistable. Either direction drifting re-creates the original bug.
      expect(persisted.filter((state) => !lifecycleSet.has(state))).toEqual([])
      expect(lifecycle.filter((state) => !persistedSet.has(state))).toEqual([])
    })
  }

  it("the provider observation vocabulary is never a lifecycle vocabulary", () => {
    const observed = new Set<string>(sessionStateSchema.options)
    expect([...observed].sort()).toEqual([...SESSION_OBSERVED_STATES].sort())

    // `starting`, `working`, `blocked` and `unknown` exist ONLY as observations.
    // If any leaked into the lifecycle, the two axes would be conflated again.
    const lifecycle = new Set<string>(sessionLifecycleStateSchema.options)
    for (const providerOnly of ["starting", "working", "blocked", "unknown"]) {
      expect(observed.has(providerOnly)).toBe(true)
      expect(lifecycle.has(providerOnly)).toBe(false)
    }
  })

  it("every provider observation maps to a lifecycle, or explicitly to no claim", () => {
    for (const observed of SESSION_OBSERVED_STATES) {
      const mapped = mapObservedSessionLifecycle(observed as SessionObservedState)
      if (observed === "unknown") {
        // An observation carrying no information must not invent a lifecycle claim.
        expect(mapped).toBeNull()
      } else {
        expect(mapped).not.toBeNull()
        expect(isSessionTerminal(mapped!)).toBe(observed === "completed" || observed === "failed")
      }
    }
  })

  it("rejects an unknown provider observation instead of silently absorbing it", () => {
    // A `switch` with no default is how `unknown` became unrepresentable.
    expect(() => mapObservedSessionLifecycle("teleported" as SessionObservedState)).toThrow(
      UnhandledSessionObservationError,
    )
  })
})

describe("Lifecycle advancement goes through the machine", () => {
  it("an unknown observation leaves the lifecycle untouched", () => {
    expect(advanceSessionLifecycle("running", "unknown")).toBe("running")
    expect(advanceSessionLifecycle("launching", "unknown")).toBe("launching")
  })

  it("a provider report can only ever advance a session it is legal to advance", () => {
    // `blocked` is a provider report of waiting on a human; the kernel's honest
    // lifecycle claim for that is `idle`, not `blocked`.
    expect(advanceSessionLifecycle("running", "blocked")).toBe("idle")
    expect(advanceSessionLifecycle("running", "working")).toBe("running")
    expect(advanceSessionLifecycle("launching", "working")).toBe("running")
  })

  it("terminal lifecycles are absorbing: no observation resurrects a finished session", () => {
    for (const terminal of ["completed", "failed", "cancelled", "timed_out"] as const) {
      for (const observed of SESSION_OBSERVED_STATES) {
        expect(advanceSessionLifecycle(terminal, observed as SessionObservedState)).toBe(terminal)
      }
    }
  })

  it("an authoritative result can complete a session that was never observed running", () => {
    // A fast task, or a lost status event, means `launching` can legitimately go
    // straight to a terminal state. This was unreachable while callers assigned
    // session state directly instead of going through the machine.
    expect(advanceSessionLifecycle("launching", "completed")).toBe("completed")
    expect(advanceSessionLifecycle("launching", "failed")).toBe("failed")
    expect(advanceSessionLifecycle("launching", "idle")).toBe("idle")
  })
})
