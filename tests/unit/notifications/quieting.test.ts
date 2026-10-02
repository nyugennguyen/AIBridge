/**
 * M6.9 — quieting by category, by severity, and by the category+severity pair.
 *
 * # The property under test
 *
 * A muted notification is recorded in the store with its `muted` disposition and is
 * NOT delivered to any adapter. Three axes, each asserted across every value of its
 * enum so a test cannot forget one:
 *
 *   - `categories` — silences one category at every severity.
 *   - `severities` — silences one severity across every category.
 *   - `pairs`      — silences exactly one (category, severity) combination.
 *
 * # The two decisions this file pins
 *
 * **Muted entries are stored.** `store.ts` argues it at length: a mute that removed
 * the entry would make a silenced `run_blocked` indistinguishable from a bus that had
 * stopped emitting, and the user's only way to tell the two apart would be to un-mute
 * and wait. Here that is asserted from three sides: the entry is in `list`, it is
 * tagged, and `pendingCount` still excludes it (so muting still silences).
 *
 * **Un-muting is not retroactive.** Restoring delivery applies to SUBSEQUENT
 * notifications. A notification that was muted while the setting was on is not
 * delivered when the setting comes off. The reasoning is in `bus.ts`
 * ("setQuieting"): retroactive delivery would make the mute a delay rather than a
 * decision, and would make `emit`'s outcome depend on history a caller could branch
 * on — which N3 forbids. Asserted explicitly below, because this is the assertion
 * someone will most want to "fix".
 */

import { describe, expect, it } from "vitest"
import {
  isNotificationMuted,
  normalizeNotificationQuieting,
  notificationMuteVerdict,
} from "../../../src/notifications/index.js"
import {
  ALL_NOTIFICATION_CATEGORIES,
  ALL_NOTIFICATION_SEVERITIES,
  notificationRequest,
  reasonsOf,
  testHarness,
} from "./fixtures.js"
import type { NotificationCategory, NotificationQuieting, NotificationSeverity } from "../../../src/notifications/index.js"

const NO_MUTES: NotificationQuieting = { categories: [], severities: [], pairs: [] }

function quieting(overrides: Partial<NotificationQuieting>): NotificationQuieting {
  return { ...NO_MUTES, ...overrides }
}

describe("M6.9 quieting by category silences that category at every severity", () => {
  for (const category of ALL_NOTIFICATION_CATEGORIES) {
    it(`silences ${category} at each of its three severities`, async () => {
      const { bus, tui, store } = testHarness({ quieting: quieting({ categories: [category] }) })
      for (const severity of ALL_NOTIFICATION_SEVERITIES) {
        await bus.emit(
          notificationRequest({
            dedupeKey: `${category}:${severity}`,
            category: category as NotificationCategory,
            severity: severity as NotificationSeverity,
          }),
        )
      }
      expect(tui.size()).toBe(0)
      expect(store.entries()).toHaveLength(3)
      expect(store.entries().every((entry) => entry.disposition === "muted")).toBe(true)
    })
  }

  it("does not silence any OTHER category", async () => {
    const { bus, tui, store } = testHarness({ quieting: quieting({ categories: ["run_blocked"] }) })
    for (const category of ALL_NOTIFICATION_CATEGORIES) {
      await bus.emit(notificationRequest({ dedupeKey: `k:${category}`, category: category as NotificationCategory }))
    }
    // Five delivered — every category except the muted one — and the `run_blocked`
    // entry is present but muted, so the difference is visible in the inbox rather
    // than being an absence the user cannot interpret.
    expect(tui.size()).toBe(5)
    expect(tui.list().some((envelope) => envelope.category === "run_blocked")).toBe(false)
    expect(store.entries()).toHaveLength(6)
    expect(store.entries().filter((entry) => entry.disposition === "muted")).toHaveLength(1)
    expect(store.pendingCount()).toBe(5)
  })

  it("records which axis muted the entry", async () => {
    const { bus, store } = testHarness({ quieting: quieting({ categories: ["budget_exhausted"] }) })
    await bus.emit(notificationRequest({ dedupeKey: "k", category: "budget_exhausted" }))
    expect(store.entries()[0]!.mutedBy).toBe("category")
  })
})

describe("M6.9 quieting by severity silences that severity across every category", () => {
  for (const severity of ALL_NOTIFICATION_SEVERITIES) {
    it(`silences ${severity} for every category`, async () => {
      const { bus, tui, store } = testHarness({ quieting: quieting({ severities: [severity as NotificationSeverity] }) })
      for (const category of ALL_NOTIFICATION_CATEGORIES) {
        await bus.emit(
          notificationRequest({
            dedupeKey: `${category}:${severity}`,
            category: category as NotificationCategory,
            severity: severity as NotificationSeverity,
          }),
        )
      }
      expect(tui.size()).toBe(0)
      expect(store.entries()).toHaveLength(ALL_NOTIFICATION_CATEGORIES.length)
    })
  }

  it("does not silence any OTHER severity", async () => {
    const { bus, tui } = testHarness({ quieting: quieting({ severities: ["info"] }) })
    for (const severity of ALL_NOTIFICATION_SEVERITIES) {
      await bus.emit(notificationRequest({ dedupeKey: `k:${severity}`, severity: severity as NotificationSeverity }))
    }
    expect(tui.size()).toBe(2)
    expect(tui.list().map((envelope) => envelope.severity).sort()).toEqual(["attention", "critical"])
  })

  it("records which axis muted the entry", async () => {
    const { bus, store } = testHarness({ quieting: quieting({ severities: ["attention"] }) })
    await bus.emit(notificationRequest({ dedupeKey: "k", severity: "attention" }))
    expect(store.entries()[0]!.mutedBy).toBe("severity")
  })
})

describe("M6.9 quieting by pair silences exactly one category and severity combination", () => {
  it("silences the paired combination", async () => {
    const { bus, tui } = testHarness({ quieting: quieting({ pairs: [{ category: "lease_expired", severity: "critical" }] }) })
    await bus.emit(notificationRequest({ dedupeKey: "k", category: "lease_expired", severity: "critical" }))
    expect(tui.size()).toBe(0)
  })

  it("does not silence the same category at a different severity", async () => {
    const { bus, tui } = testHarness({ quieting: quieting({ pairs: [{ category: "lease_expired", severity: "critical" }] }) })
    await bus.emit(notificationRequest({ dedupeKey: "k", category: "lease_expired", severity: "info" }))
    expect(tui.size()).toBe(1)
  })

  it("does not silence the same severity for a different category", async () => {
    const { bus, tui } = testHarness({ quieting: quieting({ pairs: [{ category: "lease_expired", severity: "critical" }] }) })
    await bus.emit(notificationRequest({ dedupeKey: "k", category: "run_failed", severity: "critical" }))
    expect(tui.size()).toBe(1)
  })

  it("silences nothing when no pair matches", async () => {
    const { bus, tui } = testHarness({ quieting: quieting({ pairs: [{ category: "rule_conflict", severity: "info" }] }) })
    await bus.emit(notificationRequest({ dedupeKey: "k", category: "rule_conflict", severity: "attention" }))
    expect(tui.size()).toBe(1)
  })

  it("reports the pair axis ahead of a category axis that also matches", async () => {
    // Most-specific-first, so a user who has muted four categories and nine pairs is
    // told the rule that actually explains the silence.
    const { bus, store } = testHarness({
      quieting: quieting({
        categories: ["lease_expired"],
        pairs: [{ category: "lease_expired", severity: "critical" }],
      }),
    })
    await bus.emit(notificationRequest({ dedupeKey: "k", category: "lease_expired", severity: "critical" }))
    expect(store.entries()[0]!.mutedBy).toBe("pair")
  })

  it("reports the category axis ahead of a severity axis that also matches", async () => {
    const { bus, store } = testHarness({
      quieting: quieting({ categories: ["run_failed"], severities: ["info"] }),
    })
    await bus.emit(notificationRequest({ dedupeKey: "k", category: "run_failed", severity: "info" }))
    expect(store.entries()[0]!.mutedBy).toBe("category")
  })
})

describe("M6.9 a muted notification is recorded but not delivered", () => {
  it("is not delivered to any adapter", async () => {
    const { bus, tui } = testHarness({ quieting: quieting({ categories: ["run_blocked"] }) })
    const results = await bus.emit(notificationRequest())
    expect(reasonsOf(results)).toEqual(["muted"])
    expect(tui.size()).toBe(0)
  })

  it("counts as muted and as emitted, and as neither deduplicated nor delivered", async () => {
    const { bus } = testHarness({ quieting: quieting({ categories: ["run_blocked"] }) })
    await bus.emit(notificationRequest())
    await bus.emit(notificationRequest())
    expect(bus.counters()).toMatchObject({ emitted: 1, muted: 1, deduplicated: 1, delivered: 0, adapterErrors: 0 })
  })

  it("excludes muted entries from pendingCount, so muting still silences", async () => {
    // The whole point of quieting is that the unread count goes down. If a muted entry
    // counted as pending, muting would reduce nothing the user can see.
    const { bus, store } = testHarness({ quieting: quieting({ severities: ["info"] }) })
    await bus.emit(notificationRequest({ dedupeKey: "muted", severity: "info" }))
    await bus.emit(notificationRequest({ dedupeKey: "pending", severity: "critical" }))
    expect(store.pendingCount()).toBe(1)
    expect(store.list()).toHaveLength(2)
  })

  it("keeps a muted entry listable so the user can see what they silenced", async () => {
    const { bus, store } = testHarness({ quieting: quieting({ categories: ["budget_exhausted"] }) })
    await bus.emit(notificationRequest({ dedupeKey: "k", category: "budget_exhausted" }))
    const listed = store.list({ disposition: ["muted"] })
    expect(listed).toHaveLength(1)
    expect(listed[0]!.envelope.category).toBe("budget_exhausted")
  })

  it("deduplicates a muted key, so a muted retry storm still produces one entry", async () => {
    const { bus, store } = testHarness({ quieting: quieting({ categories: ["run_failed"] }) })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await bus.emit(notificationRequest({ category: "run_failed" }))
    }
    expect(store.entries()).toHaveLength(1)
    expect(bus.counters()).toMatchObject({ emitted: 1, muted: 1, deduplicated: 2 })
  })

  it("stores the muted envelope verbatim, with no added annotation inside it", async () => {
    const { bus, store } = testHarness({ quieting: quieting({ categories: ["run_blocked"] }) })
    await bus.emit(notificationRequest())
    const envelope = store.entries()[0]!.envelope
    expect(Object.keys(envelope).sort()).toEqual([
      "category",
      "createdAt",
      "dedupeKey",
      "notificationId",
      "reasonCode",
      "ruleId",
      "runId",
      "severity",
      "summary",
      "taskId",
    ])
  })
})

describe("M6.9 un-muting restores delivery for subsequent notifications only", () => {
  it("delivers a notification emitted after the mute is removed", async () => {
    const { bus, tui } = testHarness({ quieting: quieting({ categories: ["run_blocked"] }) })
    await bus.emit(notificationRequest({ dedupeKey: "muted-one" }))
    expect(tui.size()).toBe(0)
    bus.setQuieting(NO_MUTES)
    await bus.emit(notificationRequest({ dedupeKey: "delivered-one" }))
    expect(tui.size()).toBe(1)
    expect(tui.list()[0]!.notificationId).toBe("ntf-000002")
  })

  it("does NOT retroactively deliver a notification that was already muted", async () => {
    // THE assertion. A mute is a decision, not a delay. Delivering on un-mute would
    // mean `emit`'s outcome depended on history a caller could branch on (N3), and
    // it would mean a user who muted `run_blocked` for an afternoon gets the whole
    // afternoon's backlog the moment they un-mute.
    const { bus, tui, store } = testHarness({ quieting: quieting({ categories: ["run_blocked"] }) })
    await bus.emit(notificationRequest({ dedupeKey: "muted-one" }))
    await bus.emit(notificationRequest({ dedupeKey: "muted-two" }))
    expect(tui.size()).toBe(0)
    bus.setQuieting(NO_MUTES)
    expect(tui.size()).toBe(0)
    expect(store.entries()).toHaveLength(2)
    expect(store.entries().every((entry) => entry.disposition === "muted")).toBe(true)
  })

  it("leaves an already-muted entry muted in the store after the settings change", async () => {
    const { bus, store } = testHarness({ quieting: quieting({ categories: ["run_blocked"] }) })
    await bus.emit(notificationRequest())
    bus.setQuieting(NO_MUTES)
    expect(store.entries()[0]!.disposition).toBe("muted")
  })

  it("applies a changed severity mute to a subsequent notification", async () => {
    const { bus, tui } = testHarness({ quieting: quieting({ severities: ["info"] }) })
    await bus.emit(notificationRequest({ dedupeKey: "info-one", severity: "info" }))
    bus.setQuieting(quieting({ severities: ["critical"] }))
    await bus.emit(notificationRequest({ dedupeKey: "info-two", severity: "info" }))
    expect(tui.size()).toBe(1)
    expect(tui.list()[0]!.notificationId).toBe("ntf-000002")
  })

  it("applies a changed pair mute to a subsequent notification", async () => {
    const { bus, tui } = testHarness({
      quieting: quieting({ pairs: [{ category: "run_blocked", severity: "critical" }] }),
    })
    await bus.emit(notificationRequest({ dedupeKey: "paired-one" }))
    bus.setQuieting(NO_MUTES)
    await bus.emit(notificationRequest({ dedupeKey: "paired-two" }))
    expect(tui.size()).toBe(1)
  })

  it("replaces the settings wholesale rather than merging with them", async () => {
    // A merge would make it impossible to UN-mute anything: every `setQuieting` would
    // add to the previous set and there would be no way back to an empty one.
    const { bus } = testHarness()
    bus.setQuieting(quieting({ categories: ["run_blocked"], severities: ["info"] }))
    expect(bus.quieting().categories).toEqual(["run_blocked"])
    bus.setQuieting(NO_MUTES)
    expect(bus.quieting().categories).toEqual([])
    expect(bus.quieting().severities).toEqual([])
    expect(bus.quieting().pairs).toEqual([])
  })
})

describe("M6.9 the quieting rule reads only the closed enums", () => {
  it("returns an unmuted verdict for every category and severity when nothing is muted", () => {
    for (const category of ALL_NOTIFICATION_CATEGORIES) {
      for (const severity of ALL_NOTIFICATION_SEVERITIES) {
        expect(notificationMuteVerdict(NO_MUTES, category as NotificationCategory, severity as NotificationSeverity)).toEqual({ muted: false })
      }
    }
  })

  it("exposes the same verdict through the convenience predicate the TUI uses", () => {
    const setting = quieting({ categories: ["run_failed"] })
    expect(isNotificationMuted(setting, "run_failed", "info")).toBe(true)
    expect(isNotificationMuted(setting, "run_blocked", "info")).toBe(false)
  })

  it("has no parameter through which a summary could reach the quieting rule", () => {
    // A compile-time statement as much as a runtime one: `notificationMuteVerdict`
    // takes exactly a quieting, a category, and a severity. There is no fourth
    // argument for content (types.ts S2), and this test names the arity so a future
    // fourth parameter has something to break.
    expect(notificationMuteVerdict.length).toBe(3)
  })
})

describe("M6.9 a quieting setting is normalized so equal settings compare equal", () => {
  it("sorts and de-duplicates the category list by code unit", () => {
    const normalized = normalizeNotificationQuieting({
      categories: ["run_failed", "run_blocked", "run_failed"] as never,
      severities: [],
      pairs: [],
    })
    expect(normalized.categories).toEqual(["run_blocked", "run_failed"])
  })

  it("sorts and de-duplicates the severity list by code unit", () => {
    const normalized = normalizeNotificationQuieting({
      categories: [],
      severities: ["info", "critical", "info"] as never,
      pairs: [],
    })
    expect(normalized.severities).toEqual(["critical", "info"])
  })

  it("sorts and de-duplicates the pair list by category:severity code unit", () => {
    const normalized = normalizeNotificationQuieting({
      categories: [],
      severities: [],
      pairs: [
        { category: "run_failed" as NotificationCategory, severity: "info" as NotificationSeverity },
        { category: "run_blocked" as NotificationCategory, severity: "info" as NotificationSeverity },
        { category: "run_blocked" as NotificationCategory, severity: "info" as NotificationSeverity },
      ],
    })
    expect(normalized.pairs).toEqual([
      { category: "run_blocked", severity: "info" },
      { category: "run_failed", severity: "info" },
    ])
  })

  it("produces two deeply equal settings from two differently-ordered inputs", () => {
    const left = normalizeNotificationQuieting({
      categories: ["run_failed", "run_blocked"] as never,
      severities: ["critical", "info"] as never,
      pairs: [],
    })
    const right = normalizeNotificationQuieting({
      categories: ["run_blocked", "run_failed", "run_blocked"] as never,
      severities: ["info", "critical", "info"] as never,
      pairs: [],
    })
    expect(left).toEqual(right)
  })

  it("freezes the normalized setting, so a caller cannot mutate a bus's quieting", () => {
    const normalized = normalizeNotificationQuieting({ categories: ["run_blocked"], severities: [], pairs: [] })
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(Object.isFrozen(normalized.categories)).toBe(true)
  })
})
