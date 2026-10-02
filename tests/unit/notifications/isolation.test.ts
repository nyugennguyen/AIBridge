/**
 * M6.9 — the headline test: notification delivery MUST NOT affect orchestration state.
 *
 * > "Do not let notification delivery affect orchestration state." (guardrail)
 * > "Stop if a notification is found able to affect orchestration state." (stop condition 6)
 *
 * # The three mechanisms, asserted separately
 *
 * **STRUCTURAL.** `src/notifications/**` has no upward import edge. It imports
 * nothing from `src/orchestration/`, `src/mesh/`, `src/runtime/`, `src/application/`,
 * `src/memory/`, `src/context/`, or `src/server/`. This is the mechanism ADR 0007
 * section 17 names: the bus is never handed an orchestrator, so it has no verb for
 * "block", "retry", "fail the run", or "re-dispatch". Asserted by SOURCE SCAN over
 * real `from "..."` statements, because an import cycle is exactly what a type checker
 * will happily accept.
 *
 * **BEHAVIOURAL.** `emit` resolves — never rejects — whatever an adapter does, and
 * every other adapter is still attempted. A throwing adapter, a rejecting adapter, an
 * adapter that reports itself unavailable, an adapter whose probe throws, an adapter
 * that returns garbage, and a store that throws on write are each asserted to produce
 * a resolved promise, an attempted-exactly-once fan-out, and counters that reflect the
 * failure.
 *
 * **INFORMATIONAL.** The producer cannot branch on anything it gets back. Asserted by
 * enumerating the return value's possible shapes and refusing any element outside
 * them — so a future change that returns, say, `{ delivered: false, retry: true }`
 * fails here rather than being discovered in a producer that started depending on it.
 *
 * # Determinism, asserted here rather than in its own file
 *
 * The same emitted sequence must produce the same inbox state and the same rendered
 * lines, across 50 runs and with the adapters shuffled. That is an isolation property
 * too: a notification whose rendering depended on adapter timing would be a
 * notification whose content depended on how many sinks were healthy, which is a
 * channel from orchestration state into the operator's screen.
 *
 * # N14 — the fourth mechanism, added in the M6.10 security round: a value, never a handle
 *
 * The three above are all about what delivery can REACH. N14 is about what delivery
 * is HANDED, and it was added after MED-4 demonstrated the gap: `store.publish`
 * deliberately stored the object it was given, and the bus deliberately handed that
 * same object to every adapter, so an adapter could rewrite `runId`, `ruleId`,
 * `reasonCode`, `summary` and `createdAt` in the operator's own inbox, and the next
 * adapter saw the rewrite.
 *
 * That is not the usual "internal state escaped" problem. This module exists to be an
 * untrusted boundary — ADR 0007 section 17 says a notification is an OBSERVATION, and
 * `src/notifications/**` has no upward import edge precisely so that it cannot act. An
 * adapter that can rewrite what the operator reads is an adapter that can lie about
 * what happened, and the fix has to be asserted in both directions:
 *
 *   - **OUT** — after `emit` returns, the store's record is byte-identical to what it
 *     was before, whatever the adapter did: mutate, mutate deeply, or mutate and
 *     throw.
 *   - **IN** — no adapter, and no caller of `list()`/`entries()`/`findByDedupeKey()`,
 *     receives an object through which the record could be written.
 *
 * The section at the end of this file is where those claims live. The regression that
 * matters is not "an adapter tried something" but "the INBOX the operator reads was
 * not the one the producer described", so every test here compares the whole serialised
 * inbox before and after rather than spot-checking a field.
 */

import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS,
  NOTIFICATION_NON_DELIVERY_REASONS,
  buildNotificationTuiView,
  createNotificationBus,
  createNotificationStore,
  deepFreezeNotificationValue,
  initialNotificationTuiState,
  loadNotificationTuiEntries,
  notificationEnvelopeSchema,
  notificationNoticeLine,
  type NotificationAdapter,
  type NotificationCounters,
  type NotificationDeliveryResult,
  type NotificationEnvelope,
  type NotificationInboxEntry,
  type NotificationStore,
} from "../../../src/notifications/index.js"
import {
  FIXED_NOW,
  FORGED_ENVELOPE_FIELDS,
  createTestClock,
  halfMutatingThrowingAdapter,
  identityRecordingAdapter,
  inboxAtRest,
  malformedAdapter,
  nestedVandalousAdapter,
  notificationRequest,
  probingAdapter,
  reasonsOf,
  recordingAdapter,
  rejectingAdapter,
  testHarness,
  throwingAdapter,
  unavailableAdapter,
  vandalousAdapter,
} from "./fixtures.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const NOTIFICATIONS_DIRECTORY = join(REPOSITORY_ROOT, "src/notifications")

/**
 * The directories `src/notifications/` must not import from.
 *
 * Each entry says WHY, because a bare list of forbidden paths reads as superstition
 * and a list with reasons reads as a decision someone can revisit.
 */
const FORBIDDEN_UPWARD_EDGES: readonly { readonly needle: string; readonly why: string }[] = [
  { needle: "/orchestration/", why: "ADR 0007 section 17: notifications -> (no orchestration imports); an edge here would be a second control path into the kernel" },
  { needle: "/mesh/", why: "ADR 0007 section 1: the M6 modules sit above mesh, and a notification that could read the registry is a notification that observes more than orchestration decided to tell it" },
  { needle: "/runtime/", why: "a runtime adapter is where a run's effects happen; a notification that could reach it could cause one" },
  { needle: "/application/", why: "the application service is the M0 orchestrator; an edge here is the edge N1 exists to prevent" },
  { needle: "/memory/", why: "ADR 0007 section 12: a notification carries no memory content, and an edge here would make it possible to carry some" },
  { needle: "/context/", why: "context -> memory, so an edge here is a TRANSITIVE edge to memory; the isolation audit in src/context/ also imports orchestration identifiers, so reusing it would be an edge too" },
  { needle: "/server/", why: "a notification reaching an HTTP route would put a transport between it and the operator, and ADR 0007 section 12 has no transport in the payload path" },
  { needle: "/tui/", why: "types.ts S4: the TUI may import notifications, notifications may not import the TUI; the notice is structurally compatible rather than imported" },
  { needle: "/rules/", why: "notifications sit below the rule modules in the dependency order; an edge from here to rules would let an advisory surface be built out of a policy engine" },
  { needle: "/routing/", why: "same: notifications observe facts, they do not compute eligibility" },
  { needle: "/budgets/", why: "same: a notification must not be able to reserve or release budget" },
  { needle: "/workflows/", why: "same: a notification must not be able to instantiate a run" },
]

/** Import specifiers in a source file, ignoring the ones inside a docblock. */
function importsOf(text: string): readonly string[] {
  return [...text.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]!)
}

function sourceFiles(directory: string): readonly { path: string; text: string }[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const path = join(entry.parentPath ?? directory, entry.name)
      return { path, text: readFileSync(path, "utf8") }
    })
}

describe("M6.9 the notifications module has no upward import edge", () => {
  it("imports nothing from any module that owns orchestration state", () => {
    const offenders: string[] = []
    for (const file of sourceFiles(NOTIFICATIONS_DIRECTORY)) {
      for (const specifier of importsOf(file.text)) {
        for (const { needle } of FORBIDDEN_UPWARD_EDGES) {
          if (specifier.includes(needle)) {
            offenders.push(`${file.path.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier} (${needle})`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("imports only from its own directory and from zod", () => {
    // Stronger than the forbidden list: an ALLOW list. A new dependency has to be
    // added here to be permitted, which means adding it is a deliberate act rather
    // than something a `git add` sweep can do by accident.
    const external = sourceFiles(NOTIFICATIONS_DIRECTORY)
      .flatMap((file) => importsOf(file.text))
      .filter((specifier) => !specifier.startsWith("."))
    expect([...new Set(external)].sort()).toEqual(["zod"])
  })

  it("imports nothing from node builtins, so it cannot read a clock, a file, or a socket", () => {
    const builtins = sourceFiles(NOTIFICATIONS_DIRECTORY)
      .flatMap((file) => importsOf(file.text))
      .filter((specifier) => specifier.startsWith("node:"))
    expect(builtins).toEqual([])
  })

  it("names no upward edge in an actual import statement in any file it owns", () => {
    // The forbidden-list scan could pass while a file reached upward through a path
    // the list does not name. This asserts the positive: every relative import either
    // stays inside `src/notifications/` or names a package.
    for (const file of sourceFiles(NOTIFICATIONS_DIRECTORY)) {
      for (const specifier of importsOf(file.text)) {
        if (!specifier.startsWith(".")) continue
        expect(specifier.startsWith("./"), `${file.path} -> ${specifier}`).toBe(true)
      }
    }
  })

  it("uses no ambient time, no randomness, no filesystem, and no process in its sources", () => {
    const forbidden = [/\bDate\.now\s*\(/, /\bnew Date\s*\(\s*\)/, /\bMath\.random\s*\(/, /\brequire\s*\(/, /\bprocess\./, /\bglobalThis\b/]
    for (const file of sourceFiles(NOTIFICATIONS_DIRECTORY)) {
      const code = stripComments(file.text)
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file.path} matches ${pattern}`).toBe(false)
      }
    }
  })

  it("keeps every local import ending in .js, as NodeNext requires", () => {
    for (const file of sourceFiles(NOTIFICATIONS_DIRECTORY)) {
      for (const specifier of importsOf(file.text)) {
        if (!specifier.startsWith(".")) continue
        expect(specifier.endsWith(".js")).toBe(true)
      }
    }
  })

  it("documents itself: every file it owns opens with a docblock over a thousand characters", () => {
    // A module boundary nobody can read is a module boundary nobody can check. The
    // routing barrel test asserts the same for `src/routing/`.
    const files = sourceFiles(NOTIFICATIONS_DIRECTORY)
    expect(files.length).toBeGreaterThanOrEqual(5)
    for (const file of files) {
      expect(file.text.startsWith("/**")).toBe(true)
      expect(file.text.length).toBeGreaterThan(1_000)
    }
  })
})

/** Strip comments so a docblock mentioning `Date.now` does not fail the scan. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** A store that throws on every write, and only on writes. */
function throwingWriteStore(inner: NotificationStore): NotificationStore {
  return {
    ...inner,
    publish() {
      throw new Error("the store is on fire")
    },
  }
}

describe("M6.9 emit resolves and every adapter is attempted when an adapter throws", () => {
  it("resolves rather than rejecting when the ONLY adapter throws", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [throwingAdapter("boom")], clock })
    await expect(bus.emit(notificationRequest())).resolves.toEqual([
      { delivered: false, notificationId: "ntf-000001", reason: "adapter_error" },
    ])
  })

  it("attempts every OTHER adapter exactly once when one adapter throws", async () => {
    const first = recordingAdapter("first")
    const broken = throwingAdapter("broken")
    const last = recordingAdapter("last")
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [first, broken, last], clock })
    await bus.emit(notificationRequest())
    expect(first.calls).toHaveLength(1)
    expect(last.calls).toHaveLength(1)
  })

  it("reports one result per adapter, in the order the adapters were given", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({
      store,
      adapters: [recordingAdapter("a"), throwingAdapter("b"), recordingAdapter("c")],
      clock,
    })
    const results = await bus.emit(notificationRequest())
    expect(reasonsOf(results)).toEqual(["delivered", "adapter_error", "delivered"])
  })

  it("counts the throwing adapter in adapterErrors and the others in delivered", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({
      store,
      adapters: [recordingAdapter("a"), throwingAdapter("b"), recordingAdapter("c")],
      clock,
    })
    await bus.emit(notificationRequest())
    expect(bus.counters()).toMatchObject({ emitted: 1, delivered: 2, adapterErrors: 1 })
  })

  it("survives five throwing adapters in a row and still reports five attempts", async () => {
    const adapters = ["a", "b", "c", "d", "e"].map((id) => throwingAdapter(id))
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters, clock })
    const results = await bus.emit(notificationRequest())
    expect(results).toHaveLength(5)
    expect(bus.counters().adapterErrors).toBe(5)
  })
})

describe("M6.9 emit resolves for every way an adapter can misbehave", () => {
  const misbehaviours: readonly { readonly name: string; readonly make: (id: string) => NotificationAdapter; readonly reason: string }[] = [
    { name: "a deliver that throws", make: throwingAdapter, reason: "adapter_error" },
    { name: "a deliver that rejects", make: rejectingAdapter, reason: "adapter_error" },
    { name: "an adapter that reports itself unavailable", make: unavailableAdapter, reason: "adapter_unavailable" },
    { name: "an adapter whose available probe throws", make: probingAdapter, reason: "adapter_unavailable" },
    { name: "an adapter that returns a non-result", make: malformedAdapter, reason: "adapter_error" },
  ]

  for (const { name, make, reason } of misbehaviours) {
    it(`resolves rather than rejecting for ${name}`, async () => {
      const clock = createTestClock()
      const store = createNotificationStore({ clock })
      const bus = createNotificationBus({ store, adapters: [make("bad")], clock })
      const results = await bus.emit(notificationRequest())
      expect(reasonsOf(results)).toEqual([reason])
    })
  }

  it("never asks an unavailable adapter to deliver at all", async () => {
    // `available() === false` must short-circuit. An adapter asked to deliver after
    // saying it is unavailable would be told, by being asked, that the answer did not
    // matter.
    let deliveries = 0
    const adapter: NotificationAdapter = {
      id: "unavailable",
      available: () => false,
      deliver: async (envelope) => {
        deliveries += 1
        return { delivered: true, notificationId: envelope.notificationId }
      },
    }
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [adapter], clock })
    await bus.emit(notificationRequest())
    expect(deliveries).toBe(0)
  })

  it("keeps attempting later adapters when an earlier adapter's probe throws", async () => {
    const good = recordingAdapter("good")
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [probingAdapter("probe"), good], clock })
    await bus.emit(notificationRequest())
    expect(good.calls).toHaveLength(1)
  })
})

describe("M6.9 emit resolves when the store throws on write", () => {
  it("resolves rather than rejecting", async () => {
    const clock = createTestClock()
    const inner = createNotificationStore({ clock })
    const store = throwingWriteStore(inner)
    const bus = createNotificationBus({ store, adapters: [recordingAdapter("a")], clock })
    await expect(bus.emit(notificationRequest())).resolves.toHaveLength(1)
  })

  it("still delivers, because a notification that was never stored is still true", async () => {
    // The reasoning is in bus.ts ("Why a store failure does not stop delivery"): the
    // store is the retention mechanism, not the truth mechanism, and refusing to notify
    // because a cache write failed would turn a memory-pressure blip into a silently
    // swallowed blocked run.
    const adapter = recordingAdapter("a")
    const clock = createTestClock()
    const inner = createNotificationStore({ clock })
    const bus = createNotificationBus({ store: throwingWriteStore(inner), adapters: [adapter], clock })
    const results = await bus.emit(notificationRequest())
    expect(reasonsOf(results)).toEqual(["delivered"])
    expect(adapter.calls).toHaveLength(1)
  })

  it("counts the store failure in adapterErrors", async () => {
    const clock = createTestClock()
    const inner = createNotificationStore({ clock })
    const bus = createNotificationBus({ store: throwingWriteStore(inner), adapters: [recordingAdapter("a")], clock })
    await bus.emit(notificationRequest())
    expect(bus.counters().adapterErrors).toBe(1)
  })

  it("attempts every adapter exactly once despite the store failure", async () => {
    const first = recordingAdapter("first")
    const last = recordingAdapter("last")
    const clock = createTestClock()
    const inner = createNotificationStore({ clock })
    const bus = createNotificationBus({ store: throwingWriteStore(inner), adapters: [first, last], clock })
    await bus.emit(notificationRequest())
    expect(first.calls).toHaveLength(1)
    expect(last.calls).toHaveLength(1)
  })

  it("resolves when BOTH the store and every adapter fail", async () => {
    const clock = createTestClock()
    const inner = createNotificationStore({ clock })
    const bus = createNotificationBus({
      store: throwingWriteStore(inner),
      adapters: [throwingAdapter("a"), unavailableAdapter("b")],
      clock,
    })
    await expect(bus.emit(notificationRequest())).resolves.toHaveLength(2)
    // Three failures: the store write, the throwing adapter, and the unavailable one.
    // The counter is deliberately broader than "an adapter threw" — from the producer's
    // side there is one question ("did this reach a human") and one counter for every
    // way the answer was no (types.ts, `NotificationCounters`).
    expect(bus.counters().adapterErrors).toBe(3)
    expect(bus.counters().delivered).toBe(0)
  })

  it("resolves rather than rejecting for a request the schema refuses", async () => {
    const { bus } = testHarness()
    const results = await bus.emit({ summary: "no category, no key, nothing" } as never)
    expect(results).toEqual([])
    expect(bus.counters().adapterErrors).toBe(1)
  })

  it("delivers nothing at all for a request the schema refuses", async () => {
    const { bus, tui } = testHarness()
    await bus.emit({ summary: "no category, no key" } as never)
    expect(tui.size()).toBe(0)
  })
})

describe("M6.9 the producer cannot branch on anything emit returns", () => {
  it("returns only the five documented result shapes", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({
      store,
      adapters: [recordingAdapter("ok"), throwingAdapter("bad"), unavailableAdapter("off")],
      clock,
    })
    const results = await bus.emit(notificationRequest())
    const shapes = results.map((result) => Object.keys(result).sort().join(","))
    // The keys, not the values: a new field on the result type would change the key
    // set and fail here. That is the point — a producer must not find a new field to
    // branch on.
    expect(shapes).toEqual([
      "delivered,notificationId",
      "delivered,notificationId,reason",
      "delivered,notificationId,reason",
    ])
  })

  it("reports every non-delivery reason from the closed four-member set", async () => {
    // The reason is drawn from a closed enum, so a caller cannot be handed a
    // free-form string describing an infrastructure state — which is what an
    // orchestration branch would need in order to exist.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({
      store,
      adapters: [recordingAdapter("ok"), throwingAdapter("bad"), unavailableAdapter("off"), malformedAdapter("junk")],
      clock,
    })
    const reasons = (await bus.emit(notificationRequest())).flatMap((result) => (result.delivered ? [] : [result.reason]))
    expect([...new Set(reasons)].sort()).toEqual(["adapter_error", "adapter_unavailable"])
    for (const reason of reasons) {
      expect(NOTIFICATION_NON_DELIVERY_REASONS).toContain(reason)
    }
  })

  it("reports a duplicate, a mute, and a delivery as the same single-element shape", async () => {
    // The reason differs, and the reason is NOT an orchestration signal. What matters
    // is that all three are `{ delivered: false, notificationId, reason }` — the same
    // shape, with no severity, no retry-ability, and no queue position.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [recordingAdapter("ok")], clock })
    await bus.emit(notificationRequest())
    const duplicate = await bus.emit(notificationRequest())
    bus.setQuieting({ categories: ["run_blocked"], severities: [], pairs: [] })
    const muted = await bus.emit(notificationRequest({ dedupeKey: "a-different-key" }))
    expect(Object.keys(duplicate[0]!).sort()).toEqual(["delivered", "notificationId", "reason"])
    expect(Object.keys(muted[0]!).sort()).toEqual(["delivered", "notificationId", "reason"])
  })

  it("gives the duplicate and the mute the same shape as each other", async () => {
    // The ADR's "indistinguishable to the orchestrator" claim, stated precisely for the
    // two outcomes that carry no delivery: both are one element, both are
    // `{ delivered: false, notificationId, reason }`, and the reason is drawn from a
    // closed four-member enum. Neither names a run, a task, or an orchestration state,
    // so neither can be turned into a decision about what orchestration should do.
    //
    // The DELIVERED outcome is deliberately not in this equality: it is
    // `{ delivered: true }`, which is a different shape. It is still not a branch point
    // — `delivered` is a fact about the sink, carries no orchestration identifier, and
    // the bus holds no orchestrator to be told either way (N1). What the two
    // non-delivery outcomes share is the property the ADR names.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [recordingAdapter("ok")], clock })
    await bus.emit(notificationRequest({ dedupeKey: "k1" }))
    const duplicate = await bus.emit(notificationRequest({ dedupeKey: "k1" }))
    bus.setQuieting({ categories: ["run_blocked"], severities: [], pairs: [] })
    const muted = await bus.emit(notificationRequest({ dedupeKey: "k2" }))
    const shape = (results: readonly NotificationDeliveryResult[]): string =>
      results.map((result) => Object.keys(result).sort().join(",")).join(";")
    expect(shape(duplicate)).toBe(shape(muted))
    expect(duplicate).toHaveLength(1)
    expect(muted).toHaveLength(1)
    expect(duplicate[0]!.delivered).toBe(false)
    expect(muted[0]!.delivered).toBe(false)
  })

  it("names no orchestration state in any delivery result, delivered or not", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({
      store,
      adapters: [recordingAdapter("ok"), throwingAdapter("bad")],
      clock,
    })
    await bus.emit(notificationRequest({ dedupeKey: "k1", runId: "run-1", taskId: "task-1" }))
    const duplicate = await bus.emit(notificationRequest({ dedupeKey: "k1" }))
    for (const results of [await bus.emit(notificationRequest({ dedupeKey: "k3" })), duplicate]) {
      for (const result of results) {
        expect(Object.keys(result).sort()).toEqual(
          result.delivered ? ["delivered", "notificationId"] : ["delivered", "notificationId", "reason"],
        )
      }
    }
  })

  it("returns no notification the producer did not ask about", async () => {
    const { bus } = testHarness()
    const results = await bus.emit(notificationRequest())
    expect(results.every((result) => result.notificationId === "ntf-000001")).toBe(true)
  })
})

describe("M6.9 the same emitted sequence produces the same state and the same lines", () => {
  /** The sequence every determinism run performs, in the same order. */
  // `Parameters<typeof notificationRequest>[0]`, NOT
  // `Parameters<ReturnType<typeof notificationRequest>[0]>`: the latter indexes the
  // FUNCTION type with `0` before `Parameters` ever sees it, which resolves to
  // nonsense rather than to a compile error the author would read.
  const SEQUENCE: readonly Parameters<typeof notificationRequest>[0][] = Object.freeze([
    { dedupeKey: "k-a", category: "run_blocked", severity: "critical", summary: "run blocked" },
    { dedupeKey: "k-b", category: "run_failed", severity: "attention", summary: "run failed" },
    { dedupeKey: "k-c", category: "lease_expired", severity: "critical", summary: "lease expired" },
    { dedupeKey: "k-a", category: "run_blocked", severity: "critical", summary: "run blocked" },
    { dedupeKey: "k-d", category: "budget_exhausted", severity: "info", summary: "budget exhausted" },
  ])

  async function runOnce(adapters: readonly NotificationAdapter[]): Promise<{ inbox: string; lines: string; notice: string | null; counters: NotificationCounters }> {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters, clock })
    for (const request of SEQUENCE) {
      await bus.emit(notificationRequest(request))
    }
    const state = loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)
    const view = buildNotificationTuiView(state)
    return {
      inbox: JSON.stringify(store.entries()),
      lines: view.lines.join("\n"),
      notice: notificationNoticeLine(state),
      counters: bus.counters(),
    }
  }

  it("produces byte-identical state, lines, and counters across fifty runs", async () => {
    const first = await runOnce([recordingAdapter("a"), recordingAdapter("b")])
    for (let run = 0; run < 50; run += 1) {
      const next = await runOnce([recordingAdapter("a"), recordingAdapter("b")])
      expect(next.inbox, `run ${run} inbox`).toBe(first.inbox)
      expect(next.lines, `run ${run} lines`).toBe(first.lines)
      expect(next.notice, `run ${run} notice`).toBe(first.notice)
      expect(next.counters, `run ${run} counters`).toEqual(first.counters)
    }
  })

  it("produces identical state and lines with the adapter order shuffled", async () => {
    // Rendering must not depend on how many sinks were configured or in what order
    // they were wired. A view whose content depended on adapter timing would be a
    // channel from orchestration state into the operator's screen.
    const forward = await runOnce([recordingAdapter("a"), recordingAdapter("b"), recordingAdapter("c")])
    const reversed = await runOnce([recordingAdapter("c"), recordingAdapter("b"), recordingAdapter("a")])
    expect(reversed.inbox).toBe(forward.inbox)
    expect(reversed.lines).toBe(forward.lines)
    expect(reversed.notice).toBe(forward.notice)
  })

  it("produces the same inbox state with one adapter as with three", async () => {
    const one = await runOnce([recordingAdapter("a")])
    const three = await runOnce([recordingAdapter("a"), recordingAdapter("b"), recordingAdapter("c")])
    expect(three.inbox).toBe(one.inbox)
    expect(three.lines).toBe(one.lines)
  })

  it("differing only in the delivered COUNT, which is a counter and not the state", async () => {
    const one = await runOnce([recordingAdapter("a")])
    const two = await runOnce([recordingAdapter("a"), recordingAdapter("b")])
    expect(two.counters.delivered).toBe(one.counters.delivered * 2)
    expect(two.inbox).toBe(one.inbox)
  })

  it("produces a notice that names the most severe unread notification, not the newest", async () => {
    const { notice } = await runOnce([recordingAdapter("a")])
    expect(notice).toContain("Run blocked")
  })
})

describe("M6.9 the bus is handed observations and cannot act on them", () => {
  it("exposes no method that could mutate anything but its own counters and quieting", () => {
    // The public surface of a bus, asserted as a set. A method named `retry`,
    // `block`, `fail`, `dispatch`, `acknowledge`, or `resolve` appearing here would be
    // the guardrail violation this whole module exists to prevent — so it is asserted
    // rather than left to review.
    const { bus } = testHarness()
    expect(Object.keys(bus).sort()).toEqual(["counters", "emit", "emittedCount", "quieting", "setQuieting", "store"])
  })

  it("exposes no store method that mutates anything outside the inbox", () => {
    const { store } = testHarness()
    expect(Object.keys(store).sort()).toEqual([
      "acknowledge",
      "acknowledgeAll",
      "entries",
      "findByDedupeKey",
      "list",
      "pendingCount",
      "publish",
      "retentionWindowMs",
    ])
  })

  it("stores the envelope the adapter was handed, by value and not by reference", async () => {
    // N4, restated for the M6.10 security round. It USED to be asserted as identity — `store.entries()[0]
    // .envelope` toBe `tui.list()[0]` — and that assertion was the bug (MED-4): the
    // store's record and the object handed to an adapter were the same object, so
    // anything holding the second could write the first. "Verbatim" is a claim about
    // CONTENT, so that is what is asserted now, and identity is asserted to be
    // absent — twice, because there are two references to compare: the record, and
    // the clone the adapter received.
    //
    // Content is compared through the KEY SET as well as the values, because a store
    // that re-serialized would be equal on every field it kept while quietly
    // annotating the envelope with a `storedAt` — which is precisely the edit the old
    // identity assertion existed to catch, and which `no-secrets.test.ts` would then
    // see on both of its audit paths at once.
    const { bus, store, tui } = testHarness()
    await bus.emit(notificationRequest())
    const atRest = store.entries()[0]!.envelope
    const delivered = tui.list()[0]!
    expect(atRest).toEqual(delivered)
    expect(Object.keys(atRest).sort()).toEqual(Object.keys(delivered).sort())
    expect(atRest).not.toBe(delivered)
    expect(Object.isFrozen(atRest)).toBe(true)
    expect(Object.isFrozen(delivered)).toBe(true)
  })

  it("mints notification ids from a sequence with no randomness in it", async () => {
    const { bus } = testHarness()
    const first = await bus.emit(notificationRequest({ dedupeKey: "k1" }))
    const second = await bus.emit(notificationRequest({ dedupeKey: "k2" }))
    const third = await bus.emit(notificationRequest({ dedupeKey: "k3" }))
    expect([first[0]!.notificationId, second[0]!.notificationId, third[0]!.notificationId]).toEqual([
      "ntf-000001",
      "ntf-000002",
      "ntf-000003",
    ])
  })

  it("gives two buses over two stores the same ids for the same sequence", async () => {
    const left = await runOneEmission()
    const right = await runOneEmission()
    expect(left).toEqual(right)
  })
})

async function runOneEmission(): Promise<readonly NotificationEnvelope[]> {
  const clock = createTestClock()
  const store = createNotificationStore({ clock })
  const bus = createNotificationBus({ store, adapters: [recordingAdapter("a")], clock })
  await bus.emit(notificationRequest({ dedupeKey: "k1" }))
  await bus.emit(notificationRequest({ dedupeKey: "k2" }))
  return store.entries().map((entry) => entry.envelope)
}

// ===========================================================================
// N14 — the untrusted boundary: a value, never a handle on the record
// ===========================================================================

/**
 * A store that remembers the record at the instant it was published.
 *
 * This is what makes "the record is unchanged after `emit` returns" a real assertion
 * rather than a tautology. Taking the "before" snapshot from outside the bus is not
 * possible — the record does not exist until `emit` publishes it — and taking it from
 * the store AFTER the adapters have run is exactly the bug. So the snapshot is taken
 * inside `publish`, on the way out, which is the only moment that is both "after the
 * record exists" and "before any adapter has seen anything".
 *
 * The wrapper is a spread of the real store, so it inherits the real `list`,
 * `acknowledge` and the rest rather than reimplementing any of them; only `publish`
 * is intercepted. It is a test double for the same reason `throwingWriteStore` is
 * below: the store's own surface is already asserted elsewhere.
 */
function snapshottingStore(inner: NotificationStore): { readonly store: NotificationStore; atPublish: () => string } {
  let snapshot = "[]"
  return {
    store: {
      ...inner,
      publish(envelope, disposition, mutedBy) {
        const published = inner.publish(envelope, disposition, mutedBy)
        snapshot = JSON.stringify([published.entry])
        return published
      },
    },
    atPublish: () => snapshot,
  }
}

/**
 * Emit once with the given adapters, and hand back the inbox as it was at publish and
 * as it is after `emit` has resolved.
 *
 * Both moments are the ones the claim needs, and the test below asserts they are equal
 * as STRINGS rather than as objects: a record that was mutated and mutated back would
 * pass an object comparison and fail this one, and a forged inbox is exactly a
 * plausible-looking object.
 */
async function inboxAround(
  adapters: readonly NotificationAdapter[],
): Promise<{ store: NotificationStore; atPublish: string; after: string }> {
  const clock = createTestClock()
  const inner = createNotificationStore({ clock })
  const { store, atPublish } = snapshottingStore(inner)
  const bus = createNotificationBus({ store, adapters, clock })
  await bus.emit(notificationRequest())
  return { store, atPublish: atPublish(), after: inboxAtRest(inner) }
}

describe("N14 an adapter cannot rewrite the notification the operator reads", () => {
  it("leaves the inbox byte-identical after an adapter rewrites every field of the envelope", async () => {
    // The MED-4 reproduction, and the whole reason this file grew a section. Before the
    // fix, `store.entries()[0].envelope` and the object the adapter was handed were the
    // SAME object, so all eleven writes below landed in the operator's inbox and the
    // record the user read was the record an adapter was handed, by reference.
    const vandal = vandalousAdapter("vandal")
    const { atPublish, after } = await inboxAround([vandal])
    expect(after).toBe(atPublish)
  })

  it("attempts every writable field, so an unchanged inbox is a defence rather than a no-op probe", async () => {
    // Without this, the test above would also pass against an adapter that wrote
    // nothing. The count is asserted against the closed table, so adding a field to
    // `FORGED_ENVELOPE_FIELDS` without a test noticing is the failure mode this guards.
    const vandal = vandalousAdapter("vandal")
    await inboxAround([vandal])
    expect(vandal.attempted).toBe(Object.keys(FORGED_ENVELOPE_FIELDS).length + 1)
    expect(vandal.landed).toBe(0)
    expect(vandal.refusals()).toHaveLength(vandal.attempted)
  })

  it("hands the adapter the original values, so the unchanged inbox is not an empty inbox", async () => {
    // The other half of the same worry: a defence that handed the adapter a blank
    // envelope would also leave the inbox unchanged, and the delivery would be a lie.
    const vandal = vandalousAdapter("vandal")
    await inboxAround([vandal])
    expect(vandal.received).toEqual(
      notificationEnvelopeSchema.parse({
        ...notificationRequest(),
        notificationId: "ntf-000001",
        createdAt: FIXED_NOW,
      }),
    )
  })

  it("refuses each forged write with a TypeError, rather than ignoring it", async () => {
    // A silently-ignored write is a worse outcome than a thrown one in a different
    // sense: it would be a defence that only works in strict mode, silently. ES modules
    // are always strict, so the throw is the guarantee, and the names are asserted so a
    // future `Object.seal` (which does NOT throw) fails here.
    const vandal = vandalousAdapter("vandal")
    await inboxAround([vandal])
    for (const refusal of vandal.refusals()) expect(refusal).toContain("TypeError")
  })

  it("gives a second adapter the ORIGINAL values after the first adapter has attacked the envelope", async () => {
    // Cross-adapter contamination. Before the fix, the bus handed every adapter the same
    // object, so this second adapter saw "TAMPERED" — which means a lying adapter could
    // lie to a HONEST one, and the honest sink is the one the operator reads.
    const vandal = vandalousAdapter("vandal")
    const honest = recordingAdapter("honest")
    const { atPublish, after } = await inboxAround([vandal, honest])
    expect(honest.calls).toHaveLength(1)
    expect(honest.calls[0]!.summary).toBe("Run run-1 task-1 blocked by rule rule-1 (policy_denied)")
    expect(honest.calls[0]!.runId).toBe("run-1")
    expect(after).toBe(atPublish)
  })

  it("hands two adapters two different objects, so neither can be a window into the other's view", async () => {
    // The mechanism, asserted directly. A shared frozen object would satisfy the
    // "original values" test above on its own — nothing can mutate it — so the property
    // that distinguishes a shared frozen envelope from a per-adapter clone is that the
    // objects are NOT the same, and that is what makes the guarantee independent of the
    // freeze still being there.
    const first = identityRecordingAdapter("first")
    const second = identityRecordingAdapter("second")
    await inboxAround([first.adapter, second.adapter])
    expect(first.seen).toHaveLength(1)
    expect(second.seen).toHaveLength(1)
    expect(first.seen[0]).not.toBe(second.seen[0])
    expect(first.seen[0]).toEqual(second.seen[0])
  })

  it("leaves the inbox byte-identical after an adapter writes to structure the envelope does not have", async () => {
    // The deep case. The envelope the schema accepts is flat, so a nested write is an
    // adapter inventing a container — and inventing one on a frozen object has to fail,
    // including when the invented key is `__proto__`, which is the write that would
    // otherwise poison every object in the process.
    const vandal = nestedVandalousAdapter("nested")
    const { atPublish, after } = await inboxAround([vandal])
    expect(vandal.landed).toBe(0)
    expect(after).toBe(atPublish)
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined()
  })

  it("leaves the inbox byte-identical and still resolves when an adapter throws mid-forgery", async () => {
    // ADR 0007 section 17: delivery never affects orchestration state. The awkward case
    // is the adapter that fails AFTER a partial write, because that is the shape that
    // would leave a naive implementation with a half-updated record and a dedupe index
    // that disagrees with it.
    const { atPublish, after } = await inboxAround([halfMutatingThrowingAdapter("half")])
    expect(after).toBe(atPublish)
    expect(JSON.parse(after)).toHaveLength(1)
    expect(JSON.parse(after)[0].envelope.summary).toBe("Run run-1 task-1 blocked by rule rule-1 (policy_denied)")
  })

  it("keeps delivering to the adapters after one of them attacked the envelope", async () => {
    // N10 and N14 together: an adapter that misbehaves cannot stop the fan-out, because
    // the throw is contained in `deliverOne` and the next adapter gets its own clone.
    const vandal = vandalousAdapter("vandal")
    const last = recordingAdapter("last")
    await inboxAround([vandal, halfMutatingThrowingAdapter("half"), last])
    expect(last.calls).toHaveLength(1)
    expect(last.calls[0]!.ruleId).toBe("rule-1")
  })

  it("never lets an unclonable value reach the delivery path, so the fan-out cannot be aborted by a failed clone", async () => {
    // The regression this fix was one line away from introducing. The per-adapter clone
    // is a `structuredClone`, and `structuredClone` THROWS on a value it cannot copy. A
    // bus that put the clone outside `deliverOne`'s `catch` would look correct and would
    // break N10 the first time an envelope carried something exotic: the rejection would
    // escape `deliverOne`, abort the fan-out loop, and silently skip every adapter
    // after it. `bus.ts` places the clone inside the `try` for exactly that reason.
    //
    // What is asserted here is the OTHER half, and it is the half that can be executed:
    // such a value is unreachable. `notificationRequestSchema` is `.strict()` and every
    // field on it is a string or an enum, so a request carrying a function is refused
    // before the bus mints an envelope, let alone clones one. So the `catch` is
    // unreachable defence today, and the test that keeps it that way is the one that
    // says "a function on the request is refused, not delivered" — if a future field
    // made an unclonable value legal, THIS test would be the place it showed up.
    const adapter = recordingAdapter("only")
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [adapter], clock })
    const results = await bus.emit({ ...notificationRequest(), detonate: () => "unclonable" } as never)
    expect(results).toEqual([])
    expect(adapter.calls).toHaveLength(0)
    expect(store.entries()).toEqual([])
    expect(bus.counters()).toMatchObject({ emitted: 0, delivered: 0, adapterErrors: 1 })
    // And the positive control: the value IS unclonable, so the refusal above is the
    // schema doing the work rather than the value having been harmless all along.
    expect(() => structuredClone({ detonate: () => "unclonable" })).toThrow()
  })

  it("counts a refused forgery as an adapter error, and reports it as not delivered", async () => {
    // The counter is the producer's only signal, and N3 says it carries nothing
    // actionable — so a failed forgery has to land in `adapterErrors` and nowhere else.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("vandal")], clock })
    const results = await bus.emit(notificationRequest())
    expect(reasonsOf(results)).toEqual(["adapter_error"])
    expect(bus.counters()).toMatchObject({ emitted: 1, delivered: 0, deduplicated: 0, adapterErrors: 1 })
  })

  it("leaves the dedupe index consistent after an adapter rewrites the key it was handed", async () => {
    // The second MED-4 consequence, and the one that outlives a naive freeze of the
    // envelope's fields: `byDedupeKey` was keyed on the record's `dedupeKey`, so a
    // rewrite desynchronised the index from the entries and the next notification
    // carrying the ORIGINAL key was stored as a second entry instead of deduplicated.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("vandal")], clock })
    await bus.emit(notificationRequest({ dedupeKey: "original-key" }))
    expect(store.findByDedupeKey("original-key")).not.toBeNull()
    expect(store.findByDedupeKey(FORGED_ENVELOPE_FIELDS.dedupeKey!)).toBeNull()
    const repeat = await bus.emit(notificationRequest({ dedupeKey: "original-key" }))
    expect(reasonsOf(repeat)).toEqual(["duplicate"])
    expect(store.entries()).toHaveLength(1)
  })

  it("stores a producer's envelope unchanged even after the producer edits its own object", async () => {
    // One layer below the adapter: `publish` is public, so a caller can hand it an
    // object it keeps. Before the fix the record WAS that object, so this was the same
    // bug with the bus left out of the story.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const envelope = notificationEnvelopeSchema.parse({
      ...notificationRequest(),
      notificationId: "ntf-000007",
      createdAt: FIXED_NOW,
    })
    store.publish(envelope)
    ;(envelope as unknown as Record<string, unknown>)["summary"] = "edited after the fact"
    expect(store.entries()[0]!.envelope.summary).toBe("Run run-1 task-1 blocked by rule rule-1 (policy_denied)")
  })
})

describe("N14 no caller-facing read hands out live internal state", () => {
  /**
   * The same defect one layer up. A TUI that reads the store and writes to what it got
   * would be exactly the MED-4 bug with the adapter replaced by the renderer, so the
   * claim is asserted for every accessor rather than for `list()` alone.
   */
  async function storeWithOneEntry(): Promise<NotificationStore> {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [], clock })
    await bus.emit(notificationRequest())
    return store
  }

  it("hands out no writable envelope from list()", async () => {
    const store = await storeWithOneEntry()
    const listed = store.list()
    expect(Object.isFrozen(listed)).toBe(true)
    const mutable = listed[0]!.envelope as unknown as Record<string, unknown>
    expect(() => {
      mutable["summary"] = "rewritten by a caller"
    }).toThrow(TypeError)
    expect(store.entries()[0]!.envelope.summary).toBe("Run run-1 task-1 blocked by rule rule-1 (policy_denied)")
  })

  it("hands out no writable envelope from entries()", async () => {
    const store = await storeWithOneEntry()
    const all = store.entries()
    expect(Object.isFrozen(all)).toBe(true)
    const mutable = all[0]!.envelope as unknown as Record<string, unknown>
    expect(() => {
      mutable["runId"] = "run-forged"
    }).toThrow(TypeError)
    expect(store.entries()[0]!.envelope.runId).toBe("run-1")
  })

  it("hands out no writable entry from findByDedupeKey()", async () => {
    const store = await storeWithOneEntry()
    const found = store.findByDedupeKey("run_blocked:run-1:task-1:rule-1")
    expect(found).not.toBeNull()
    expect(Object.isFrozen(found)).toBe(true)
    const entry = found as unknown as Record<string, unknown>
    expect(() => {
      entry["disposition"] = "muted"
    }).toThrow(TypeError)
    const envelope = found!.envelope as unknown as Record<string, unknown>
    expect(() => {
      envelope["summary"] = "rewritten by a caller"
    }).toThrow(TypeError)
    expect(store.pendingCount()).toBe(1)
  })

  it("hands out no writable disposition, so a caller cannot silence a notification by writing to it", async () => {
    // Quieting is a user decision recorded by the store. If a caller could write
    // `disposition` on an entry it read, then "muted" and "the renderer was told to
    // hide this" would be the same value, and the mute would stop being evidence of
    // anything (store.ts, "the decision on storing muted entries").
    const store = await storeWithOneEntry()
    const entry = store.entries()[0]! as unknown as Record<string, unknown>
    expect(() => {
      entry["disposition"] = "muted"
    }).toThrow(TypeError)
    expect(store.entries()[0]!.disposition).toBe("pending")
  })

  it("hands out a list that cannot be re-sorted into the store's order by a caller", async () => {
    // `sort` is a mutation, so this is the operation a renderer is most likely to reach
    // for and the one that would silently change what the NEXT render reads. The
    // assertion is on the array, not on the order: the claim is that the call fails, so
    // the order the store computed is the only order that can exist.
    //
    // The casts are the point, not a workaround. `list()` returns
    // `readonly NotificationInboxEntry[]`, so the TYPE SYSTEM already forbids `.sort`
    // and `.splice` here — the same reason this cannot happen by accident in
    // TypeScript. The cast is what lets the test ask the question a JS caller could
    // still ask, and the answer has to be a `TypeError` rather than a silent success.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [], clock })
    for (const overrides of [
      { dedupeKey: "k1", category: "run_blocked", severity: "critical" },
      { dedupeKey: "k2", category: "run_failed", severity: "info" },
    ] as const) {
      await bus.emit(notificationRequest(overrides))
    }
    const listed = store.list() as NotificationInboxEntry[]
    const order = listed.map((entry) => entry.envelope.dedupeKey)
    expect(() => listed.sort(() => 0)).toThrow(TypeError)
    expect(() => listed.splice(0, 1)).toThrow(TypeError)
    expect(store.list().map((entry) => entry.envelope.dedupeKey)).toEqual(order)
  })

  it("hands out a result array from emit that a producer cannot rewrite", async () => {
    // The last reference path out of the bus. `results[0].delivered = true` would be a
    // mutation of a value the producer holds, and a value a producer can edit is a
    // value a producer can branch on — which is what N3 exists to prevent.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [recordingAdapter("a")], clock })
    const results = await bus.emit(notificationRequest())
    expect(Object.isFrozen(results)).toBe(true)
    expect(Object.isFrozen(results[0])).toBe(true)
    const mutable = results[0] as unknown as Record<string, unknown>
    expect(() => {
      mutable["delivered"] = false
    }).toThrow(TypeError)
    expect(results[0]!.delivered).toBe(true)
  })

  it("freezes a deep value, so the freezing reaches inside a nested object rather than stopping at the top", async () => {
    // The recursion is the claim, and the envelope cannot nest — so this is the test
    // that keeps `deepFreezeNotificationValue` from quietly becoming a shallow freeze.
    // A shallow freeze passes every other test in this file and fails here.
    const value = deepFreezeNotificationValue({ outer: { inner: [1, 2, 3] } })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.outer)).toBe(true)
    expect(Object.isFrozen(value.outer.inner)).toBe(true)
    expect(() => {
      value.outer.inner.push(4)
    }).toThrow(TypeError)
    expect(() => {
      value.outer.inner[0] = 99
    }).toThrow(TypeError)
  })

  it("returns the same value it froze, so a caller can freeze in place without a second reference", async () => {
    // The property the store and the bus both rely on: `publish` and `deliverOne` use
    // the return value, and if it were a copy the object they went on to store would be
    // the mutable original.
    const value = { envelope: { summary: "s" } }
    expect(deepFreezeNotificationValue(value)).toBe(value)
    expect(Object.isFrozen(value.envelope)).toBe(true)
  })
})

describe("N14 the emitted sequence is deterministic with adversarial adapters in the fan-out", () => {
  /**
   * The determinism sequence again, this time with a forgery attempt at every position
   * an adapter can occupy — first, middle, last — and the adapter order reversed.
   *
   * Before the fix, the inbox in this test contained "nothing happened and nothing was
   * blocked" in some runs and the real summary in others, depending purely on which
   * adapter ran last. That is the sharpest statement of why MED-4 matters: it is not
   * only that a hostile adapter wins, it is that the operator's inbox becomes a
   * function of the adapter list.
   */
  const SEQUENCE: readonly Parameters<typeof notificationRequest>[0][] = Object.freeze([
    { dedupeKey: "k-a", category: "run_blocked", severity: "critical", summary: "run blocked" },
    { dedupeKey: "k-b", category: "run_failed", severity: "attention", summary: "run failed" },
    { dedupeKey: "k-c", category: "lease_expired", severity: "critical", summary: "lease expired" },
    { dedupeKey: "k-a", category: "run_blocked", severity: "critical", summary: "run blocked" },
    { dedupeKey: "k-d", category: "budget_exhausted", severity: "info", summary: "budget exhausted" },
  ])

  async function runWith(adapters: readonly NotificationAdapter[]): Promise<{ inbox: string; lines: string; notice: string | null; counters: NotificationCounters }> {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters, clock })
    for (const request of SEQUENCE) {
      await bus.emit(notificationRequest(request))
    }
    const state = loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)
    const view = buildNotificationTuiView(state)
    return { inbox: inboxAtRest(store), lines: view.lines.join("\n"), notice: notificationNoticeLine(state), counters: bus.counters() }
  }

  it("produces the same inbox and the same lines whether or not a forging adapter is registered", async () => {
    const honest = await runWith([recordingAdapter("a"), recordingAdapter("b")])
    const attacked = await runWith([vandalousAdapter("v1"), recordingAdapter("a"), nestedVandalousAdapter("v2"), recordingAdapter("b")])
    expect(attacked.inbox).toBe(honest.inbox)
    expect(attacked.lines).toBe(honest.lines)
    expect(attacked.notice).toBe(honest.notice)
  })

  it("produces the same inbox and the same lines with the forging adapters in a different order", async () => {
    const forward = await runWith([vandalousAdapter("v1"), recordingAdapter("a"), nestedVandalousAdapter("v2")])
    const reversed = await runWith([nestedVandalousAdapter("v2"), recordingAdapter("a"), vandalousAdapter("v1")])
    const last = await runWith([halfMutatingThrowingAdapter("half"), recordingAdapter("a")])
    expect(reversed.inbox).toBe(forward.inbox)
    expect(reversed.lines).toBe(forward.lines)
    expect(last.inbox).toBe(forward.inbox)
    expect(last.lines).toBe(forward.lines)
  })

  it("produces byte-identical state and lines across fifty runs with a forging adapter present", async () => {
    const first = await runWith([vandalousAdapter("v1"), recordingAdapter("a"), nestedVandalousAdapter("v2"), halfMutatingThrowingAdapter("half")])
    for (let run = 0; run < 50; run += 1) {
      const next = await runWith([vandalousAdapter("v1"), recordingAdapter("a"), nestedVandalousAdapter("v2"), halfMutatingThrowingAdapter("half")])
      expect(next.inbox, `run ${run} inbox`).toBe(first.inbox)
      expect(next.lines, `run ${run} lines`).toBe(first.lines)
      expect(next.notice, `run ${run} notice`).toBe(first.notice)
      // Counters are the ONE thing that legitimately differs: four adapters, two of
      // which fail, is a different number from two adapters that both succeed. What
      // must not differ is the state the operator reads.
      expect(next.counters.adapterErrors, `run ${run} adapterErrors`).toBe(first.counters.adapterErrors)
    }
  })

  it("keeps deduplication working when the adapters are forgeries rather than honest sinks", async () => {
    // Requirement six, stated as a determinism claim: a cloned-per-adapter envelope
    // must not break dedupe-by-key, which depends on `dedupeKey` being the same string
    // to the store, to the bus, and to every adapter.
    const { store } = await (async () => {
      const clock = createTestClock()
      const store = createNotificationStore({ clock })
      const bus = createNotificationBus({ store, adapters: [vandalousAdapter("v1"), nestedVandalousAdapter("v2")], clock })
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await bus.emit(notificationRequest({ dedupeKey: "storm-key" }))
      }
      return { store, bus }
    })()
    expect(store.entries()).toHaveLength(1)
    expect(store.entries()[0]!.envelope.dedupeKey).toBe("storm-key")
  })
})

describe("N14 a notification still arrives, is still acknowledged, and is still counted", () => {
  it("delivers to an honest adapter and stores one entry, unchanged by the presence of a forger", async () => {
    // Requirement eight, as a single end-to-end statement: the security fix must not
    // have changed what a working configuration does. Counters, entries, and the
    // delivered value are all the pre-fix values.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const honest = recordingAdapter("honest")
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("v1"), honest], clock })
    const results = await bus.emit(notificationRequest())
    expect(reasonsOf(results)).toEqual(["adapter_error", "delivered"])
    expect(bus.counters()).toMatchObject({ emitted: 1, delivered: 1, deduplicated: 0, muted: 0, adapterErrors: 1 })
    expect(honest.calls).toHaveLength(1)
    expect(store.entries()).toHaveLength(1)
    expect(store.pendingCount()).toBe(1)
  })

  it("still acknowledges by the id the adapter was handed, from a record it cannot write to", async () => {
    // The acknowledgement path reads `notificationId` off the record. That the record
    // is frozen must not make the id unreadable, and the id the adapter received must
    // still be the id that removes the entry.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const honest = recordingAdapter("honest")
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("v1"), honest], clock })
    await bus.emit(notificationRequest())
    const id = honest.calls[0]!.notificationId
    expect(store.acknowledge(id)).toBe(true)
    expect(store.entries()).toEqual([])
    expect(store.pendingCount()).toBe(0)
    expect(store.acknowledge(id)).toBe(false)
  })

  it("still mutes, still counts, and still records the axis when a forger is registered", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const honest = recordingAdapter("honest")
    const bus = createNotificationBus({
      store,
      adapters: [vandalousAdapter("v1"), honest],
      clock,
      quieting: { categories: ["run_blocked"], severities: [], pairs: [] },
    })
    const results = await bus.emit(notificationRequest())
    expect(reasonsOf(results)).toEqual(["muted"])
    expect(honest.calls).toHaveLength(0)
    expect(bus.counters()).toMatchObject({ emitted: 1, muted: 1, delivered: 0, adapterErrors: 0 })
    expect(store.entries()[0]).toMatchObject({ disposition: "muted", mutedBy: "category" })
    expect(store.pendingCount()).toBe(0)
  })

  it("still expires a stored entry on the retention clock, with a forger registered", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("v1")], clock })
    await bus.emit(notificationRequest())
    clock.advance(DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS)
    expect(store.list()).toEqual([])
  })
})
