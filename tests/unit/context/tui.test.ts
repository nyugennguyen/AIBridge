/**
 * M5.8 — the memory TUI: browse, filter, provenance, and the dispatch-context
 * preview.
 *
 * The plan's criterion is "UI tests show exact included/excluded items and
 * reasons", and its guardrail is "The TUI previews the exact context before
 * approval". Both are asserted on the *structured* view model rather than on
 * rendered text, because `toContain` cannot tell "the reason is
 * `prohibited_content`" from "a line that happens to mention a prohibited
 * record".
 *
 * The three properties under test:
 *
 * 1. **The preview is the manifest.** Same ids, same order, same reasons.
 * 2. **Every excluded item is shown with a reason**, and a sensitive exclusion
 *    shows *only* its reason.
 * 3. **Filtering is a pure function of state**, so what is on screen is never a
 *    function of a query the view also performed.
 */

import { describe, expect, it } from "vitest"
import {
  buildMemoryTuiView,
  buildPreview,
  initialMemoryTuiState,
  recordMatchesFilter,
  reduceMemoryTui,
  renderExclusion,
  routeMemoryTuiKey,
  summarize,
  verifyPreviewMatchesManifest,
  type MemoryTuiRecordView,
  type MemoryTuiUiState,
} from "../../../src/context/tui/memory-view.js"
import { assembleContext } from "../../../src/context/assembler.js"
import type { ContextCandidate, ContextManifestV2 } from "../../../src/context/types.js"
import { digestJson } from "../../../src/orchestration/digest.js"
import { runIdSchema, taskIdSchema, dispatchIdSchema, projectIdSchema, roleIdSchema } from "../../../src/orchestration/identifiers.js"

const NOW = "2026-09-30T12:00:00.000Z"
const PROJECT = projectIdSchema.parse("project-m5-tui")
const RUN = runIdSchema.parse("run-1")
const TASK = taskIdSchema.parse("task-1")
const ROLE = roleIdSchema.parse("role-implementer")
const ROLE_HASH = digestJson({ roleId: ROLE, version: 2 })

function record(overrides: Partial<MemoryTuiRecordView> = {}): MemoryTuiRecordView {
  return {
    memoryId: "memory-1",
    projectId: PROJECT,
    kind: "decision",
    scopeKind: "project",
    scopeLabel: "project:project-m5-tui",
    createdAt: NOW,
    authorKind: "user",
    authorLabel: "user:user-owner",
    trust: "accepted",
    sensitivity: "public_to_project",
    retention: "project",
    content: "Use the Tailscale-only bridge endpoint.",
    redactionStatus: "none",
    redactionRuleIds: [],
    sourceReferences: [{ namespace: "legacy.memory.decision", id: "decision-1" }],
    withheldReasons: [],
    ...overrides,
  }
}

function state(records: readonly MemoryTuiRecordView[]): MemoryTuiUiState {
  return reduceMemoryTui(initialMemoryTuiState(), { type: "records-loaded", records })
}

function candidate(overrides: Partial<ContextCandidate> & { memoryId: string }): ContextCandidate {
  return {
    source: { kind: "memory", memoryId: overrides.memoryId, memoryKind: "decision" },
    scope: { kind: "project" },
    category: "project_constraints",
    reason: "active_decision",
    text: overrides.text ?? `content of ${overrides.memoryId}`,
    sensitivity: "public_to_project",
    priority: 500,
    optional: true,
    createdAt: NOW,
    ...overrides,
  }
}

async function manifestOf(
  candidates: readonly ContextCandidate[],
  clearance: ContextManifestV2["destination"]["clearance"] = "restricted",
  maximum = 100_000,
): Promise<ContextManifestV2> {
  const assembled = await assembleContext(
    {
      projectId: PROJECT,
      runId: RUN,
      taskId: TASK,
      dispatchId: dispatchIdSchema.parse("dispatch-1"),
      destination: { nodeId: "node-a", roleId: ROLE, clearance },
      roleSnapshotHash: ROLE_HASH,
      policy: { policyVersion: "m5.v1", budget: { maximum, unit: "tokens" } },
      now: NOW,
      correlationId: "corr-tui",
    },
    { provider: { candidates: async () => candidates } },
  )
  if (!assembled.ok) throw new Error(`assembly should succeed: ${assembled.error.code}`)
  return assembled.value
}

describe("M5.8 the browse view filters purely", () => {
  // Distinct content per record. With a shared default body, a free-text filter
  // matches every row and the assertion would be testing the fixture rather
  // than the filter.
  const records = [
    record({ memoryId: "m-1", kind: "decision", trust: "accepted", content: "Use the Tailscale-only bridge endpoint." }),
    record({ memoryId: "m-2", kind: "constraint", trust: "proposed", content: "Never expose the OpenCode server publicly." }),
    record({ memoryId: "m-3", kind: "constraint", trust: "accepted", content: "Superseded claim about loopback binding.", supersededByMemoryId: "m-4" }),
    record({ memoryId: "m-4", kind: "constraint", trust: "accepted", content: "Correction: the server binds to loopback.", supersedesMemoryId: "m-3" }),
    record({ memoryId: "m-5", kind: "finding", sensitivity: "restricted", content: "The deploy job does not verify the digest." }),
  ]

  it("hides the SUPERSEDED record by default and shows the correction, like the active view", () => {
    // m-3 was corrected by m-4. The active view shows the correction and hides
    // what it replaced; showing the stale record by default would put a known-
    // wrong fact on screen.
    const view = buildMemoryTuiView(state(records))
    expect(view.rows.map((row) => row.memoryId)).toEqual(["m-1", "m-2", "m-4", "m-5"])
    expect(view.rows.map((row) => row.memoryId)).not.toContain("m-3")
  })

  it("shows them when asked, and says which record superseded each", () => {
    const withSuperseded = reduceMemoryTui(state(records), { type: "toggle-superseded" })
    const view = buildMemoryTuiView(withSuperseded)
    const superseded = view.rows.find((row) => row.memoryId === "m-3")
    expect(superseded?.supersession).toBe("superseded by m-4")
    const superseding = view.rows.find((row) => row.memoryId === "m-4")
    expect(superseding?.supersession).toBe("supersedes m-3")
  })

  it("filters by kind, trust, and sensitivity", () => {
    const byKind = buildMemoryTuiView(reduceMemoryTui(state(records), { type: "set-filter", filter: { kind: "constraint" } }))
    expect(byKind.rows.map((row) => row.memoryId)).toEqual(["m-2", "m-4"])

    const byTrust = buildMemoryTuiView(reduceMemoryTui(state(records), { type: "set-filter", filter: { trust: "proposed" } }))
    expect(byTrust.rows.map((row) => row.memoryId)).toEqual(["m-2"])

    const bySensitivity = buildMemoryTuiView(
      reduceMemoryTui(state(records), { type: "set-filter", filter: { sensitivity: "restricted" } }),
    )
    expect(bySensitivity.rows.map((row) => row.memoryId)).toEqual(["m-5"])
  })

  it("filters by free text across id, kind, content, and author", () => {
    for (const [needle, expected] of [
      ["m-1", ["m-1"]],
      ["constraint", ["m-2", "m-4"]],
      ["m-4", ["m-4"]],
      ["tailscale", ["m-1"]],
      ["user-owner", ["m-1", "m-2", "m-4", "m-5"]],
    ] as const) {
      const view = buildMemoryTuiView(reduceMemoryTui(state(records), { type: "set-filter", filter: { text: needle } }))
      expect(view.rows.map((row) => row.memoryId)).toEqual([...expected])
    }
  })

  it("says so when nothing matches, rather than showing an empty screen", () => {
    const view = buildMemoryTuiView(reduceMemoryTui(state(records), { type: "set-filter", filter: { kind: "nonexistent" } }))
    expect(view.lines.join("\n")).toContain("no memory records match this filter")
  })

  it("describes the active filter on screen, so the view is self-explaining", () => {
    const view = buildMemoryTuiView(
      reduceMemoryTui(state(records), { type: "set-filter", filter: { kind: "decision", trust: "accepted" } }),
    )
    expect(view.filterDescription).toBe("kind=decision trust=accepted superseded=hidden")
  })

  it("the predicate is exported, so the reducer and the view cannot disagree", () => {
    expect(recordMatchesFilter(record({ kind: "decision" }), { includeSuperseded: false })).toBe(true)
    expect(recordMatchesFilter(record({ kind: "constraint" }), { includeSuperseded: false, kind: "decision" })).toBe(false)
  })

  it("truncates a long content to a stated length, with a visible ellipsis", () => {
    const long = "x".repeat(500)
    const line = summarize(long)
    expect(line).toHaveLength(96)
    expect(line.endsWith("…")).toBe(true)
    // A short one is untouched, and does NOT get an ellipsis.
    expect(summarize("short")).toBe("short")
    expect(summarize("line one\n\nline   two")).toBe("line one line two")
  })
})

describe("M5.8 the record view shows provenance, trust, sensitivity, and supersession", () => {
  it("shows the whole metadata set on the record screen", () => {
    const one = record({
      memoryId: "m-9",
      sensitivity: "restricted",
      redactionStatus: "redacted",
      redactionRuleIds: ["aws_access_key_id"],
      supersedesMemoryId: "m-8",
      content: "The deploy key is in 1Password, item prod/deploy.",
    })
    // Navigate FIRST, then open the overlay: `navigate` deliberately clears the
    // overlay, so a test that opens it and then navigates would be asserting the
    // wrong order and would silently see an empty provenance section.
    const onRecordScreen = reduceMemoryTui(state([one]), { type: "navigate", screen: "record" })
    const view = buildMemoryTuiView(reduceMemoryTui(onRecordScreen, { type: "set-overlay", overlay: "provenance" }))
    const text = view.lines.join("\n")

    expect(text).toContain("m-9 (decision)")
    expect(text).toContain("trust: accepted")
    expect(text).toContain("sensitivity: restricted")
    expect(text).toContain("redaction: redacted [aws_access_key_id]")
    expect(text).toContain("supersedes: m-8")
    expect(text).toContain("legacy.memory.decision decision-1")
  })

  it("shows the witholding reasons a query reported, so a missing record is explainable", () => {
    const one = record({ memoryId: "m-7", trust: "proposed", withheldReasons: ["not_trusted"] })
    const view = buildMemoryTuiView(reduceMemoryTui(state([one]), { type: "navigate", screen: "record" }))
    expect(view.lines.join("\n")).toContain("withheld: not_trusted")
  })

  it("provenance is only shown when the overlay is open", () => {
    const one = record()
    const withoutOverlay = buildMemoryTuiView(reduceMemoryTui(state([one]), { type: "navigate", screen: "record" }))
    const withOverlay = buildMemoryTuiView(
      reduceMemoryTui(reduceMemoryTui(state([one]), { type: "navigate", screen: "record" }), { type: "set-overlay", overlay: "provenance" }),
    )
    expect(withoutOverlay.provenance).toHaveLength(0)
    expect(withOverlay.provenance).toHaveLength(1)
  })
})

describe("M5.8 the preview is the manifest, exactly", () => {
  it("shows the same included ids, in the same order, with the same reasons", async () => {
    const candidates = [
      candidate({ memoryId: "m-low", priority: 100, text: "a low priority note" }),
      candidate({ memoryId: "m-high", priority: 900, text: "a high priority constraint", reason: "active_constraint" }),
      candidate({ memoryId: "m-secret", sensitivity: "prohibited", text: "never shown" }),
      candidate({ memoryId: "m-restricted", sensitivity: "secret_reference_only", text: "the deploy key is in 1Password" }),
    ]
    const manifest = await manifestOf(candidates)
    const view = buildMemoryTuiView(reduceMemoryTui(initialMemoryTuiState(), { type: "manifest-loaded", manifest }))

    expect(view.preview).not.toBeNull()
    expect(verifyPreviewMatchesManifest(view.preview!, manifest)).toEqual([])

    // The manifest's own order, not the input's.
    expect(view.preview!.included.map((item) => item.sourceId)).toEqual(manifest.items.map((item) => item.sourceId))
    expect(view.preview!.included.find((item) => item.sourceId === "m-high")?.reason).toBe("active_constraint")
    // Exclusions are sorted by source id, independent of the order the
    // candidates arrived in — the same total order the manifest digest uses.
    expect(view.preview!.excluded.map((item) => `${item.sourceId}:${item.reason}`)).toEqual([
      "m-restricted:sensitivity_above_clearance",
      "m-secret:prohibited_content",
    ])
  })

  it("shows the digest, policy, budget, and destination an approval would bind to", async () => {
    const manifest = await manifestOf([candidate({ memoryId: "m-1" })])
    const view = buildMemoryTuiView(reduceMemoryTui(initialMemoryTuiState(), { type: "manifest-loaded", manifest }))
    const text = view.lines.join("\n")

    expect(text).toContain(manifest.digest)
    expect(text).toContain(manifest.roleSnapshotHash)
    expect(text).toContain("policy: m5.v1")
    expect(text).toContain("budget:")
    expect(text).toContain("node-a / role-implementer (restricted)")
  })

  it("marks a secret_reference_only item as a reference, not content", async () => {
    const manifest = await manifestOf(
      [candidate({ memoryId: "m-ref", sensitivity: "secret_reference_only", text: "the deploy key is in 1Password" })],
      "secret_reference_only",
    )
    const view = buildMemoryTuiView(reduceMemoryTui(initialMemoryTuiState(), { type: "manifest-loaded", manifest }))
    expect(view.preview!.included[0]?.sensitivityDecision).toBe("reference_only")
  })

  it("a sensitive exclusion renders its id and reason and NOTHING else", () => {
    // Rendered directly, so the assertion is about the render function rather
    // than about whatever the screen happened to put around it.
    const line = renderExclusion({
      sourceId: "m-secret",
      category: "project_constraints",
      reason: "prohibited_content",
      withheldDetail: true,
    })
    expect(line).toBe("  - m-secret: prohibited_content (detail withheld)")

    // Even if a kind leaked into the object, the render must not print it.
    const contaminated = renderExclusion({
      sourceId: "m-secret",
      category: "project_constraints",
      reason: "prohibited_content",
      kind: "handoff",
      scopeKind: "task",
      withheldDetail: true,
    })
    expect(contaminated).toBe(line)
    expect(contaminated).not.toContain("handoff")
    expect(contaminated).not.toContain("task")
  })

  it("a non-sensitive exclusion does name the kind, because that is what makes it useful", () => {
    const line = renderExclusion({
      sourceId: "m-budget",
      category: "project_constraints",
      reason: "budget_exceeded",
      kind: "decision",
      scopeKind: "project",
      withheldDetail: false,
    })
    expect(line).toContain("budget_exceeded")
    expect(line).toContain("decision")
    expect(line).toContain("project")
  })

  it("says when nothing was excluded, rather than printing an empty heading", async () => {
    const manifest = await manifestOf([candidate({ memoryId: "m-1" })])
    const view = buildMemoryTuiView(reduceMemoryTui(initialMemoryTuiState(), { type: "manifest-loaded", manifest }))
    expect(view.lines.join("\n")).toContain("EXCLUDED:\n  (none)")
  })

  it("says so when no manifest has been assembled yet", () => {
    const view = buildMemoryTuiView(reduceMemoryTui(initialMemoryTuiState(), { type: "navigate", screen: "context-preview" }))
    expect(view.lines.join("\n")).toContain("no context manifest has been assembled yet")
  })

  it("detects a preview that has drifted from its manifest", () => {
    const base = {
      manifestId: "manifest-a",
      schemaVersion: 2 as const,
      projectId: PROJECT,
      runId: RUN,
      taskId: TASK,
      dispatchId: dispatchIdSchema.parse("dispatch-1"),
      roleSnapshotHash: ROLE_HASH,
      items: [],
      excluded: [],
      budget: { maximum: 100, estimated: 0, unit: "tokens" as const },
      policyVersion: "m5.v1",
      destination: { nodeId: "node-a", roleId: ROLE, clearance: "restricted" as const },
      createdAt: NOW,
      digest: digestJson({ a: 1 }),
    }
    const preview = buildPreview(base)
    // A preview that claims a digest the manifest does not have.
    expect(verifyPreviewMatchesManifest({ ...preview, digest: digestJson({ a: 2 }) }, base)).toContain("digest")
    // A preview that claims an exclusion the manifest does not have.
    expect(
      verifyPreviewMatchesManifest(
        {
          ...preview,
          excluded: [{ sourceId: "m-x", category: "project_constraints", reason: "policy_disabled", withheldDetail: false }],
        },
        base,
      ),
    ).toContain("excluded")
  })
})

describe("M5.9 the withheldDetail check fires (SF-11)", () => {
  // The check M5.9 found inert: it compared `source.revealsKind` with
  // `item.withheldDetail`, and `buildPreview` sets the latter to the negation of
  // the former, so `revealsKind === withheldDetail` was never true and an
  // inverted `withheldDetail` was reported as consistent. These four assertions
  // are the difference between a check and a comment.
  const manifestWith = (excluded: readonly ContextManifestV2["excluded"][number][]) => ({
    manifestId: "manifest-a",
    schemaVersion: 2 as const,
    projectId: PROJECT,
    runId: RUN,
    taskId: TASK,
    dispatchId: dispatchIdSchema.parse("dispatch-1"),
    roleSnapshotHash: ROLE_HASH,
    items: [],
    excluded: [...excluded],
    budget: { maximum: 100, estimated: 0, unit: "tokens" as const },
    policyVersion: "m5.v1",
    destination: { nodeId: "node-a", roleId: ROLE, clearance: "restricted" as const },
    createdAt: NOW,
    digest: digestJson({ a: 1 }),
  })

  const sensitive: ContextManifestV2["excluded"][number] = {
    sourceId: "m-secret",
    category: "project_constraints",
    reason: "prohibited_content",
    revealsKind: false,
    scopeKind: "project",
  }
  const ordinary: ContextManifestV2["excluded"][number] = {
    sourceId: "m-pruned",
    category: "project_constraints",
    reason: "budget_exceeded",
    revealsKind: true,
    kind: "handoff",
    scopeKind: "project",
  }

  it("reports a CORRECT withheldDetail as consistent, for both kinds of exclusion", () => {
    const manifest = manifestWith([sensitive, ordinary])
    expect(verifyPreviewMatchesManifest(buildPreview(manifest), manifest)).toEqual([])
  })

  it("reports an INVERTED withheldDetail, and names the source", () => {
    // The manifest says the prohibited record's kind must be withheld; the
    // preview claims it is disclosed. Under the old comparison this returned [].
    const manifest = manifestWith([sensitive])
    const preview = buildPreview(manifest)
    expect(preview.excluded[0]?.withheldDetail).toBe(true)

    const inverted = {
      ...preview,
      excluded: preview.excluded.map((item) => ({ ...item, withheldDetail: false })),
    }
    expect(verifyPreviewMatchesManifest(inverted, manifest)).toEqual(["withheldDetail for m-secret"])
  })

  it("reports the other inversion too: claiming detail is withheld when the manifest allows it", () => {
    // The over-cautious direction. It is not a leak, but it is still a preview
    // that does not describe its manifest, and an operator reading it cannot tell
    // that a pruned `handoff` was in fact nameable.
    const manifest = manifestWith([ordinary])
    const preview = buildPreview(manifest)
    expect(preview.excluded[0]?.withheldDetail).toBe(false)

    const inverted = {
      ...preview,
      excluded: preview.excluded.map((item) => ({ ...item, withheldDetail: true })),
    }
    expect(verifyPreviewMatchesManifest(inverted, manifest)).toEqual(["withheldDetail for m-pruned"])
  })

  it("reports a kind carried beside a non-revealing exclusion", () => {
    // `revealsKind: false` and `kind: "handoff"` is the exact shape
    // `contextExclusionSchema.superRefine` refuses and the exact shape M5.9's
    // SF-4 found an access path producing. The preview object is what the audit
    // reads, so it is checked here too.
    const manifest = manifestWith([sensitive])
    const preview = buildPreview(manifest)
    const contaminated = {
      ...preview,
      excluded: preview.excluded.map((item) => ({ ...item, kind: "handoff" })),
    }
    expect(verifyPreviewMatchesManifest(contaminated, manifest)).toEqual(["kind leaked for m-secret"])
  })

  it("the preview the assembler produces is self-consistent for a real manifest", async () => {
    // `candidate` hard-codes `memoryKind: "decision"`, so the handoff is spelled
    // out here: the whole point of the assertion below is that the exclusion
    // names the record's kind rather than its inclusion reason.
    const handoff: ContextCandidate = {
      source: { kind: "memory", memoryId: "m-pruned", memoryKind: "handoff" },
      scope: { kind: "project" },
      category: "dependency_results",
      reason: "handoff_packet",
      text: "a".repeat(400),
      sensitivity: "public_to_project",
      priority: 500,
      optional: true,
      createdAt: NOW,
    }
    // 400 characters is 100 tokens, so a budget of 50 prunes it.
    const manifest = await manifestOf(
      [handoff, candidate({ memoryId: "m-secret", sensitivity: "prohibited", text: "never shown" })],
      "restricted",
      50,
    )
    // One revealing exclusion and one non-revealing one, from a real assembly
    // rather than a hand-built manifest.
    const preview = buildPreview(manifest)
    const byId = Object.fromEntries(preview.excluded.map((item) => [item.sourceId, item]))
    expect(byId["m-pruned"]?.reason).toBe("budget_exceeded")
    expect(byId["m-pruned"]?.kind).toBe("handoff")
    expect(byId["m-pruned"]?.kind).not.toBe("handoff_packet")
    expect(byId["m-pruned"]?.withheldDetail).toBe(false)
    expect(byId["m-secret"]?.kind).toBeUndefined()
    expect(byId["m-secret"]?.withheldDetail).toBe(true)
    expect(verifyPreviewMatchesManifest(preview, manifest)).toEqual([])
  })
})

describe("M5.8 the reducer and the key router are pure and total", () => {
  it("navigation changes the screen and clears the overlay", () => {
    const withOverlay = reduceMemoryTui(initialMemoryTuiState(), { type: "set-overlay", overlay: "help" })
    const navigated = reduceMemoryTui(withOverlay, { type: "navigate", screen: "record" })
    expect(navigated.screen).toBe("record")
    expect(navigated.overlay).toBe("none")
  })

  it("selection is clamped to the visible range", () => {
    const withRecords = state([record({ memoryId: "m-1" }), record({ memoryId: "m-2" })])
    expect(reduceMemoryTui(withRecords, { type: "select", index: 99 }).selectedIndex).toBe(1)
    expect(reduceMemoryTui(withRecords, { type: "select", index: -5 }).selectedIndex).toBe(0)
    expect(reduceMemoryTui(withRecords, { type: "move", delta: 99 }).selectedIndex).toBe(1)
    expect(reduceMemoryTui(withRecords, { type: "move", delta: -99 }).selectedIndex).toBe(0)
  })

  it("scrolling never goes negative", () => {
    expect(reduceMemoryTui(initialMemoryTuiState(), { type: "scroll", delta: -10 }).scrollOffset).toBe(0)
    expect(reduceMemoryTui(initialMemoryTuiState(), { type: "scroll", delta: 3 }).scrollOffset).toBe(3)
  })

  it("routes keys to the screen they belong to", () => {
    const browse = initialMemoryTuiState()
    expect(routeMemoryTuiKey(browse, { type: "key", name: "j" })).toEqual({ type: "dispatch", action: { type: "move", delta: 1 } })
    expect(routeMemoryTuiKey(browse, { type: "key", name: "enter" })).toEqual({
      type: "dispatch",
      action: { type: "navigate", screen: "record" },
    })
    expect(routeMemoryTuiKey(browse, { type: "key", name: "c" })).toEqual({
      type: "dispatch",
      action: { type: "navigate", screen: "context-preview" },
    })
    expect(routeMemoryTuiKey(browse, { type: "key", name: "s" })).toEqual({ type: "dispatch", action: { type: "toggle-superseded" } })
    expect(routeMemoryTuiKey(browse, { type: "key", name: "p" })).toEqual({ type: "none" })
  })

  it("closes on ctrl-c and nothing else", () => {
    expect(routeMemoryTuiKey(initialMemoryTuiState(), { type: "key", name: "c", ctrl: true })).toEqual({ type: "close" })
    expect(routeMemoryTuiKey(initialMemoryTuiState(), { type: "key", name: "q" })).toEqual({ type: "none" })
  })

  it("toggles help, and escape closes the overlay", () => {
    const browse = initialMemoryTuiState()
    const opened = routeMemoryTuiKey(browse, { type: "key", name: "?" })
    expect(opened).toEqual({ type: "dispatch", action: { type: "set-overlay", overlay: "help" } })
    const helpState = reduceMemoryTui(browse, { type: "set-overlay", overlay: "help" })
    expect(routeMemoryTuiKey(helpState, { type: "key", name: "?" })).toEqual({
      type: "dispatch",
      action: { type: "set-overlay", overlay: "none" },
    })
    expect(routeMemoryTuiKey(helpState, { type: "key", name: "escape" })).toEqual({
      type: "dispatch",
      action: { type: "set-overlay", overlay: "none" },
    })
  })

  it("a paste becomes a text filter, so a pasted id finds its record", () => {
    expect(routeMemoryTuiKey(initialMemoryTuiState(), { type: "paste", text: "memory-42" })).toEqual({
      type: "dispatch",
      action: { type: "set-filter", filter: { text: "memory-42" } },
    })
  })

  it("an error replaces a notice, and clearing it does not resurrect the notice", () => {
    const noticed = reduceMemoryTui(initialMemoryTuiState(), { type: "notice", message: "Loaded 5 records." })
    expect(noticed.notice).toBe("Loaded 5 records.")
    const errored = reduceMemoryTui(noticed, { type: "error", message: "Repository unavailable." })
    expect(errored.error).toBe("Repository unavailable.")
    expect(errored.notice).toBeNull()
    expect(reduceMemoryTui(errored, { type: "clear-error" }).notice).toBeNull()
  })

  it("the view renders every screen without throwing on an empty state", () => {
    for (const screen of ["browse", "record", "context-preview"] as const) {
      const view = buildMemoryTuiView(reduceMemoryTui(initialMemoryTuiState(), { type: "navigate", screen }))
      expect(view.title.length).toBeGreaterThan(0)
      expect(view.lines.length).toBeGreaterThan(0)
    }
  })
})
