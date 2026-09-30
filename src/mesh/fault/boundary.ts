/**
 * M4.9 — the crash boundary.
 *
 * A crash is injected by THROWING from inside an `EffectBoundary` hook, and the
 * reason is that this is the only point at which "the process died" is faithful.
 * Everything before the hook has already committed and everything after it never
 * ran, so a crash at hook 5 leaves a `sending` outbox row with a durable claim and
 * no delivery, which is exactly the window the plan's restart diagram describes.
 * A boundary that returned a sentinel instead would let the caller carry on, and
 * the crash would not be a crash.
 *
 * ### Why the recorder is one object for all eight hooks
 *
 * `EffectBoundary` is a single interface with eight optional members and the
 * coordinator, the outbox deliverer and the projection updater each accept a
 * NARROWED `Pick` of it. Passing one full `EffectBoundary` to all three is what
 * makes the fault log readable: `crashes.map(c => c.hook)` names the boundary, and
 * a harness that built three separate recorders would report "the deliverer
 * crashed" without saying at which of its two hooks.
 *
 * ### Why the hook count is asserted per hook
 *
 * `calls` records every firing, and `crashes` records every crash. A test that
 * only asserted `crashes.length === 1` would pass against a boundary whose hook
 * fired for the wrong reason — the coordinator firing `duringAppend` twice and the
 * test believing `duringValidate` crashed. `crashes` therefore carries the hook
 * NAME and the count of prior firings of that same hook.
 */
import type { EffectBoundary } from "../../orchestration/coordinator/types.js"
import type { OrchestrationCommand, OrchestrationEvent } from "../../orchestration/types.js"
import { EFFECT_BOUNDARY_HOOKS, type EffectBoundaryHook } from "./types.js"

/**
 * The error a crash throws.
 *
 * A named class rather than a message, so a test can distinguish an INJECTED
 * crash from a bug that happened to throw at the same instant. The message names
 * the hook, which is what an operator reads in a transcript.
 */
export class InjectedCrash extends Error {
  readonly hook: EffectBoundaryHook
  /** 1-based. The Nth firing of THIS hook is the one that died. */
  readonly occurrence: number

  constructor(hook: EffectBoundaryHook, occurrence: number) {
    super(`crash injected at EffectBoundary.${hook} (firing #${occurrence})`)
    this.name = "InjectedCrash"
    this.hook = hook
    this.occurrence = occurrence
  }
}

export interface BoundaryCrash {
  readonly hook: EffectBoundaryHook
  readonly occurrence: number
}

/**
 * One recorder for all eight `EffectBoundary` hooks.
 *
 * `arm` is what a scenario calls; `crash` is the armed state; `disarm` is what a
 * restart calls. The armed hook throws exactly ONCE and then disarms itself,
 * because the harness restarts and continues — a boundary that kept throwing
 * would make "restart and continue" untestable, and would model a process that
 * dies on every attempt rather than a process that died once.
 */
export class CrashBoundary implements EffectBoundary {
  /** Every hook firing, in order, as `hook` or `hook#occurrence`. */
  readonly calls: string[] = []
  /** Every crash this boundary injected, in order. */
  readonly crashes: BoundaryCrash[] = []
  #armed: { readonly hook: EffectBoundaryHook; readonly occurrence: number } | null = null
  readonly #counts = new Map<EffectBoundaryHook, number>()

  /** Arms the Nth firing of `hook` to throw. `occurrence` defaults to the first. */
  arm(hook: EffectBoundaryHook, occurrence = 1): void {
    this.#armed = { hook, occurrence }
  }

  /** Clears any armed hook. Called by a restart: the new process has no crash pending. */
  disarm(): void {
    this.#armed = null
  }

  /** How many times `hook` has fired. Zero means the boundary was never reached. */
  fired(hook: EffectBoundaryHook): number {
    return this.#counts.get(hook) ?? 0
  }

  /** Whether `hook` fired at least once. The non-vacuity assertion for a crash test. */
  reached(hook: EffectBoundaryHook): boolean {
    return this.fired(hook) > 0
  }

  reset(): void {
    this.calls.length = 0
    this.crashes.length = 0
    this.#armed = null
    this.#counts.clear()
  }

  beforeValidate = (command: OrchestrationCommand): void => {
    this.#enter("beforeValidate", command.commandId)
  }

  afterValidate = (command: OrchestrationCommand): void => {
    this.#enter("afterValidate", command.commandId)
  }

  duringAppend = (command: OrchestrationCommand, index: number): void => {
    // The index is part of the record because `duringAppend` fires ONCE PER
    // PLANNED EVENT and a multi-event append is the case the hook exists for. A
    // log that collapsed the index would make "crashed on the second event of a
    // two-event append" indistinguishable from "crashed on the first".
    this.#enter("duringAppend", `${command.commandId}#${index}`)
  }

  afterCommit = (command: OrchestrationCommand, result: unknown): void => {
    this.#enter("afterCommit", command.commandId)
  }

  beforeDeliver = (outboxId: string): void => {
    this.#enter("beforeDeliver", outboxId)
  }

  afterRuntimeAccept = (outboxId: string): void => {
    this.#enter("afterRuntimeAccept", outboxId)
  }

  duringProjectionUpdate = (event: OrchestrationEvent): void => {
    this.#enter("duringProjectionUpdate", event.eventId)
  }

  duringTranslation = (payload: unknown): void => {
    this.#enter("duringTranslation", describe(payload))
  }

  #enter(hook: EffectBoundaryHook, detail: string): void {
    const occurrence = (this.#counts.get(hook) ?? 0) + 1
    this.#counts.set(hook, occurrence)
    this.calls.push(`${hook}#${occurrence}:${detail}`)
    const armed = this.#armed
    if (armed === null || armed.hook !== hook || armed.occurrence !== occurrence) return
    // One crash per arming. The harness restarts and continues, and a boundary
    // that threw on every subsequent firing would model a poison hook rather
    // than a dead process.
    this.#armed = null
    this.crashes.push({ hook, occurrence })
    throw new InjectedCrash(hook, occurrence)
  }
}

/** Every hook name, for a test that enumerates rather than trusting a hand-written list. */
export { EFFECT_BOUNDARY_HOOKS }

function describe(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return JSON.stringify(payload)
  const candidate = (payload as { commandId?: unknown; runId?: unknown; sessionId?: unknown })
  for (const field of ["commandId", "runId", "sessionId"] as const) {
    if (typeof candidate[field] === "string") return candidate[field]
  }
  return "payload"
}
