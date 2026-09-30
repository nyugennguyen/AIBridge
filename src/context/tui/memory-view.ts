/**
 * M5.8 — the memory/context TUI view model.
 *
 * # Why a view model and not a rendered string
 *
 * Same decision as `src/mesh/tui/view-model.ts`, for the same reason: a
 * renderer is one consumer of this data and a test is another, and the milestone
 * gate requires "UI tests show exact included/excluded items and reasons". A
 * string can only be asserted on with `toContain`, which cannot distinguish
 * "the reason is prohibition" from "the reason is a bullet that happens to
 * mention a prohibited record".
 *
 * So `buildMemoryTuiView` returns a structure. `lines` is attached as a derived
 * member for the renderer, and the structured fields are what the tests read.
 *
 * # The one property that matters most
 *
 * The preview must show the operator *exactly* what will be sent: the same
 * source ids, the same order, and the same reasons. `MemoryTuiView.preview` is
 * built from the manifest directly, and `verifyPreviewMatchesManifest` is a
 * function rather than a hope — so a view that drifted from its manifest is a
 * failing test, not a shipped surprise.
 *
 * Exclusions are rendered with the reason and *nothing else* when the reason is
 * sensitive. `renderExclusion` reads `revealsKind` and emits the source id and
 * the reason, and a test asserts that no `secret`-class exclusion renders
 * anything else.
 *
 * # Filters are pure
 *
 * Filtering happens in `reduceMemoryTui`, not in the view model, so "what is on
 * screen" is a function of `(state, manifest)` with no I/O. The mesh TUI's rule
 * applies unchanged: a view model that filtered would be a view model whose
 * output depended on a query it also performed.
 */

import {
  CONTEXT_CATEGORY_TITLES,
  type ContextCategory,
  type ContextExclusionReason,
  type ContextInclusionReason,
  type Sensitivity,
  type TrustState,
} from "../../memory/ontology.js"
import type { ContextManifestV2 } from "../types.js"

/** The record shapes the browse view renders. A view, not a repository type. */
export interface MemoryTuiRecordView {
  readonly memoryId: string
  readonly projectId: string
  readonly kind: string
  readonly scopeKind: string
  readonly scopeLabel: string
  readonly createdAt: string
  readonly authorKind: string
  readonly authorLabel: string
  readonly trust: TrustState
  readonly sensitivity: Sensitivity
  readonly retention: string
  readonly content: string
  readonly redactionStatus: string
  readonly redactionRuleIds: readonly string[]
  readonly supersedesMemoryId?: string
  readonly supersededByMemoryId?: string
  readonly sourceReferences: readonly { namespace: string; id: string }[]
  /** Withheld reasons for this record, as a query reported them. */
  readonly withheldReasons: readonly string[]
}

/** What the operator is looking at. */
export type MemoryTuiScreen = "browse" | "record" | "context-preview"
export type MemoryTuiOverlay = "none" | "provenance" | "help"

export interface MemoryTuiFilter {
  readonly kind?: string
  readonly trust?: TrustState
  readonly sensitivity?: Sensitivity
  readonly text?: string
  /** Show superseded records, which the active view hides by default. */
  readonly includeSuperseded: boolean
}

export interface MemoryTuiUiState {
  readonly screen: MemoryTuiScreen
  readonly overlay: MemoryTuiOverlay
  readonly records: readonly MemoryTuiRecordView[]
  readonly selectedIndex: number
  readonly filter: MemoryTuiFilter
  /** The manifest being previewed, or `null` before one is assembled. */
  readonly manifest: ContextManifestV2 | null
  readonly scrollOffset: number
  readonly notice: string | null
  readonly error: string | null
}

export type MemoryTuiAction =
  | { readonly type: "records-loaded"; readonly records: readonly MemoryTuiRecordView[] }
  | { readonly type: "manifest-loaded"; readonly manifest: ContextManifestV2 }
  | { readonly type: "navigate"; readonly screen: MemoryTuiScreen }
  | { readonly type: "set-overlay"; readonly overlay: MemoryTuiOverlay }
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "move"; readonly delta: number }
  | { readonly type: "scroll"; readonly delta: number }
  | { readonly type: "set-filter"; readonly filter: Partial<MemoryTuiFilter> }
  | { readonly type: "toggle-superseded" }
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "clear-error" }

export const MEMORY_TUI_ACTIONS = [
  "records-loaded",
  "manifest-loaded",
  "navigate",
  "set-overlay",
  "select",
  "move",
  "scroll",
  "set-filter",
  "toggle-superseded",
  "notice",
  "error",
  "clear-error",
] as const
export type MemoryTuiActionType = (typeof MEMORY_TUI_ACTIONS)[number]

export type MemoryTuiKey =
  | { readonly type: "key"; readonly name: string; readonly ctrl?: boolean }
  | { readonly type: "paste"; readonly text: string }

export type MemoryTuiIntent =
  | { readonly type: "none" }
  | { readonly type: "close" }
  | { readonly type: "dispatch"; readonly action: MemoryTuiAction }
  | { readonly type: "reject"; readonly reason: string }

export function initialMemoryTuiState(): MemoryTuiUiState {
  return {
    screen: "browse",
    overlay: "none",
    records: [],
    selectedIndex: 0,
    filter: { includeSuperseded: false },
    manifest: null,
    scrollOffset: 0,
    notice: null,
    error: null,
  }
}

/**
 * Pure reducer. Exhaustive over `MemoryTuiAction` with no `default`, so a new
 * action is a compile error here rather than a silently ignored keystroke.
 */
export function reduceMemoryTui(state: MemoryTuiUiState, action: MemoryTuiAction): MemoryTuiUiState {
  switch (action.type) {
    case "records-loaded":
      return { ...state, records: action.records, selectedIndex: 0, error: null }
    case "manifest-loaded":
      return { ...state, manifest: action.manifest, screen: "context-preview", scrollOffset: 0, error: null }
    case "navigate":
      return { ...state, screen: action.screen, overlay: "none", scrollOffset: 0 }
    case "set-overlay":
      return { ...state, overlay: action.overlay }
    case "select":
      return { ...state, selectedIndex: Math.max(0, Math.min(action.index, state.records.length - 1)) }
    case "move": {
      const last = Math.max(0, state.records.length - 1)
      return { ...state, selectedIndex: Math.max(0, Math.min(state.selectedIndex + action.delta, last)) }
    }
    case "scroll":
      return { ...state, scrollOffset: Math.max(0, state.scrollOffset + action.delta) }
    case "set-filter":
      return { ...state, filter: { ...state.filter, ...action.filter }, selectedIndex: 0, scrollOffset: 0 }
    case "toggle-superseded":
      return {
        ...state,
        filter: { ...state.filter, includeSuperseded: !state.filter.includeSuperseded },
        selectedIndex: 0,
      }
    case "notice":
      return { ...state, notice: action.message, error: null }
    case "error":
      return { ...state, error: action.message, notice: null }
    case "clear-error":
      return { ...state, error: null }
  }
}

/**
 * Key routing. Pure, with no access to a repository or a renderer.
 *
 * Keys that would need authorization to do anything are returned as `reject`
 * with a reason, not as a dispatch: the memory screen has no write actions at
 * all in M5 (accept/reject live behind the proposal flow), and a keystroke that
 * silently does nothing is worse than one that says why.
 */
export function routeMemoryTuiKey(state: MemoryTuiUiState, key: MemoryTuiKey): MemoryTuiIntent {
  if (key.type === "paste") {
    return { type: "dispatch", action: { type: "set-filter", filter: { text: key.text } } }
  }
  if (key.ctrl && key.name.toLowerCase() === "c") return { type: "close" }
  if (key.name === "?" || key.name === "f1") {
    return { type: "dispatch", action: { type: "set-overlay", overlay: state.overlay === "help" ? "none" : "help" } }
  }
  if (key.name === "escape") {
    return { type: "dispatch", action: { type: "set-overlay", overlay: "none" } }
  }

  switch (state.screen) {
    case "browse":
      if (key.name === "j" || key.name === "down") return { type: "dispatch", action: { type: "move", delta: 1 } }
      if (key.name === "k" || key.name === "up") return { type: "dispatch", action: { type: "move", delta: -1 } }
      if (key.name === "enter") return { type: "dispatch", action: { type: "navigate", screen: "record" } }
      if (key.name === "c") return { type: "dispatch", action: { type: "navigate", screen: "context-preview" } }
      if (key.name === "s") return { type: "dispatch", action: { type: "toggle-superseded" } }
      break
    case "record":
      if (key.name === "p") return { type: "dispatch", action: { type: "set-overlay", overlay: "provenance" } }
      if (key.name === "escape") return { type: "dispatch", action: { type: "navigate", screen: "browse" } }
      break
    case "context-preview":
      break
  }

  return { type: "none" }
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export interface MemoryTuiRecordRow {
  readonly memoryId: string
  readonly kind: string
  readonly scope: string
  readonly trust: TrustState
  readonly sensitivity: Sensitivity
  readonly author: string
  readonly createdAt: string
  /** The one-line summary shown. Never a whole payload. */
  readonly summary: string
  readonly redaction: string
  readonly supersession: string
  readonly withheld: readonly string[]
}

export interface MemoryTuiIncludedItem {
  readonly sourceId: string
  readonly category: ContextCategory
  readonly categoryTitle: string
  readonly reason: ContextInclusionReason
  readonly sensitivity: Sensitivity
  readonly sensitivityDecision: string
  readonly scope: string
  readonly orderingKey: string
  readonly estimatedCost: number
  readonly optional: boolean
  readonly artifactReferences: readonly string[]
}

export interface MemoryTuiExcludedItem {
  readonly sourceId: string
  readonly category: ContextCategory
  readonly reason: ContextExclusionReason
  readonly kind?: string
  readonly scopeKind?: string
  /** True when the reason forbids naming anything but the id. */
  readonly withheldDetail: boolean
}

export interface MemoryTuiPreview {
  readonly manifestId: string
  readonly digest: string
  readonly destination: string
  readonly roleSnapshotHash: string
  readonly policyVersion: string
  readonly budget: string
  readonly estimated: number
  readonly included: readonly MemoryTuiIncludedItem[]
  readonly excluded: readonly MemoryTuiExcludedItem[]
  /** The sections, in render order, with the source ids each will contain. */
  readonly sections: readonly { category: ContextCategory; title: string; sourceIds: readonly string[] }[]
}

export interface MemoryTuiViewModel {
  readonly screen: MemoryTuiScreen
  readonly title: string
  readonly rows: readonly MemoryTuiRecordRow[]
  readonly selectedIndex: number
  readonly filterDescription: string
  readonly record: MemoryTuiRecordView | null
  readonly provenance: readonly { namespace: string; id: string }[]
  readonly preview: MemoryTuiPreview | null
  readonly notice: string | null
  readonly error: string | null
  readonly lines: readonly string[]
}

/** One line per record. Long content is truncated by a fixed, stated rule. */
const SUMMARY_CHARACTERS = 96

export function summarize(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim()
  if (collapsed.length <= SUMMARY_CHARACTERS) return collapsed
  // The ellipsis is a literal, so a truncated line is distinguishable from a
  // complete one that happens to end in a period.
  return `${collapsed.slice(0, SUMMARY_CHARACTERS - 1)}…`
}

/**
 * Render an exclusion line.
 *
 * The `revealsKind` check is the security-relevant part. A sensitive exclusion
 * renders as `excluded <id>: <reason>` and nothing else — no kind, no scope, no
 * content, no hash. Every other exclusion adds the kind and scope, which is
 * what makes the view useful for the common case.
 */
export function renderExclusion(item: MemoryTuiExcludedItem): string {
  if (item.withheldDetail) return `  - ${item.sourceId}: ${item.reason} (detail withheld)`
  const parts = [item.kind, item.scopeKind].filter(Boolean)
  return parts.length > 0
    ? `  - ${item.sourceId}: ${item.reason} (${parts.join(", ")})`
    : `  - ${item.sourceId}: ${item.reason}`
}

function describeFilter(filter: MemoryTuiFilter): string {
  const parts: string[] = []
  if (filter.kind) parts.push(`kind=${filter.kind}`)
  if (filter.trust) parts.push(`trust=${filter.trust}`)
  if (filter.sensitivity) parts.push(`sensitivity=${filter.sensitivity}`)
  if (filter.text) parts.push(`text=${filter.text}`)
  parts.push(`superseded=${filter.includeSuperseded ? "shown" : "hidden"}`)
  return parts.join(" ")
}

/** The filter predicate, exposed so the reducer and the view cannot disagree. */
export function recordMatchesFilter(record: MemoryTuiRecordView, filter: MemoryTuiFilter): boolean {
  if (!filter.includeSuperseded && record.supersededByMemoryId !== undefined) return false
  if (filter.kind !== undefined && record.kind !== filter.kind) return false
  if (filter.trust !== undefined && record.trust !== filter.trust) return false
  if (filter.sensitivity !== undefined && record.sensitivity !== filter.sensitivity) return false
  if (filter.text !== undefined) {
    const needle = filter.text.toLowerCase()
    const haystack = `${record.memoryId} ${record.kind} ${record.content} ${record.authorLabel}`.toLowerCase()
    if (!haystack.includes(needle)) return false
  }
  return true
}

/**
 * Build the view. Pure: no I/O, no clock, no repository.
 *
 * The preview is built from the manifest, in the manifest's own order, so the
 * screen and the digest describe the same thing. `verifyPreviewMatchesManifest`
 * is the assertion that this stays true.
 */
export function buildMemoryTuiView(state: MemoryTuiUiState): MemoryTuiViewModel {
  const visible = state.records.filter((record) => recordMatchesFilter(record, state.filter))
  const rows = visible.map<MemoryTuiRecordRow>((record) => ({
    memoryId: record.memoryId,
    kind: record.kind,
    scope: record.scopeLabel,
    trust: record.trust,
    sensitivity: record.sensitivity,
    author: record.authorLabel,
    createdAt: record.createdAt,
    summary: summarize(record.content),
    redaction: record.redactionStatus,
    supersession:
      record.supersededByMemoryId !== undefined
        ? `superseded by ${record.supersededByMemoryId}`
        : record.supersedesMemoryId !== undefined
          ? `supersedes ${record.supersedesMemoryId}`
          : "current",
    withheld: record.withheldReasons,
  }))

  const selectedIndex = Math.max(0, Math.min(state.selectedIndex, Math.max(0, rows.length - 1)))
  const record = visible[selectedIndex] ?? null
  const preview = state.manifest ? buildPreview(state.manifest) : null

  const view: MemoryTuiViewModel = {
    screen: state.screen,
    title: titleFor(state.screen),
    rows,
    selectedIndex,
    filterDescription: describeFilter(state.filter),
    record,
    provenance: state.overlay === "provenance" && record ? record.sourceReferences : [],
    preview,
    notice: state.notice,
    error: state.error,
    lines: [],
  }
  return { ...view, lines: renderLines(view, state) }
}

function titleFor(screen: MemoryTuiScreen): string {
  switch (screen) {
    case "browse":
      return "Memory"
    case "record":
      return "Memory record"
    case "context-preview":
      return "Dispatch context preview"
  }
}

/**
 * The preview, built from the manifest and nothing else.
 *
 * Every included item's `sourceId` and ordering is taken verbatim. An operator
 * approving a dispatch is approving *this list*, so the list must be the
 * manifest rather than a re-derivation of it.
 *
 * `withheldDetail` is the preview's *claim* about each exclusion, derived from
 * the manifest's `revealsKind` and kept as a plain boolean so the shape stays
 * data. `verifyPreviewMatchesManifest` checks that claim against the manifest
 * rather than trusting it (M5.9's SF-11), so deriving it here is a convenience
 * and not the enforcement.
 */
export function buildPreview(manifest: ContextManifestV2): MemoryTuiPreview {
  const included = manifest.items.map<MemoryTuiIncludedItem>((item) => ({
    sourceId: item.sourceId,
    category: item.category,
    categoryTitle: CONTEXT_CATEGORY_TITLES[item.category],
    reason: item.reason,
    sensitivity: item.sensitivity,
    sensitivityDecision: item.sensitivityDecision,
    scope: item.scope.kind,
    orderingKey: item.orderingKey,
    estimatedCost: item.estimatedCost,
    optional: item.optional,
    artifactReferences: item.artifactReferences ?? [],
  }))

  const excluded = manifest.excluded.map<MemoryTuiExcludedItem>((entry) => ({
    sourceId: entry.sourceId,
    category: entry.category,
    reason: entry.reason,
    kind: entry.kind,
    scopeKind: entry.scopeKind,
    withheldDetail: !entry.revealsKind,
  }))

  const sections: { category: ContextCategory; title: string; sourceIds: readonly string[] }[] = []
  for (const category of new Set(manifest.items.map((item) => item.category))) {
    const ordered = manifest.items.filter((item) => item.category === category)
    sections.push({
      category,
      title: CONTEXT_CATEGORY_TITLES[category],
      sourceIds: ordered.map((item) => item.sourceId),
    })
  }

  return {
    manifestId: manifest.manifestId,
    digest: manifest.digest,
    destination: `${manifest.destination.nodeId} / ${manifest.destination.roleId} (${manifest.destination.clearance})`,
    roleSnapshotHash: manifest.roleSnapshotHash,
    policyVersion: manifest.policyVersion,
    budget: `${manifest.budget.estimated}/${manifest.budget.maximum} ${manifest.budget.unit}`,
    estimated: manifest.budget.estimated,
    included,
    excluded,
    sections,
  }
}

/**
 * Does the preview describe exactly the manifest?
 *
 * A function so the gate can assert it. Returns the list of discrepancies
 * rather than a boolean, because a boolean would tell a reviewer that something
 * was wrong and not what.
 *
 * M5.9's SF-11: the per-exclusion check compared `source.revealsKind` with
 * `item.withheldDetail`, and `buildPreview` sets `withheldDetail` to
 * `!entry.revealsKind` — a boolean against its own negation, which is never
 * true. The one drift check the "TUI previews the exact context" criterion rests
 * on could not fire, so an inverted `withheldDetail` — a preview claiming to
 * withhold detail for an exclusion the manifest says may be named in full, or
 * claiming the opposite for a prohibited record — was reported as consistent.
 *
 * The fix is to compare the preview's *claim* against the manifest's *truth*:
 * the manifest says `revealsKind`, the preview says `withheldDetail`, and the
 * preview is right only when `withheldDetail === !revealsKind`. `buildPreview`
 * still derives one from the other, so the check holds for a preview it built
 * and fires for one that was built, or edited, any other way.
 *
 * The second check is the leak half: an exclusion the manifest says must not
 * name its kind may not carry one in the preview, whatever the preview's own
 * flag claims. `renderExclusion` already refuses to print it, but the preview
 * object is what the audit reads and what a future renderer might print.
 */
export function verifyPreviewMatchesManifest(
  preview: MemoryTuiPreview,
  manifest: ContextManifestV2,
): readonly string[] {
  const problems: string[] = []
  if (preview.digest !== manifest.digest) problems.push("digest")
  if (preview.manifestId !== manifest.manifestId) problems.push("manifestId")
  if (preview.estimated !== manifest.budget.estimated) problems.push("budget.estimated")

  const previewIncluded = preview.included.map((item) => item.sourceId)
  const manifestIncluded = manifest.items.map((item) => item.sourceId)
  if (previewIncluded.join(",") !== manifestIncluded.join(",")) problems.push("included order")

  const previewExcluded = preview.excluded.map((item) => `${item.sourceId}:${item.reason}`)
  const manifestExcluded = manifest.excluded.map((item) => `${item.sourceId}:${item.reason}`)
  if (previewExcluded.join(",") !== manifestExcluded.join(",")) problems.push("excluded")

  for (const item of preview.excluded) {
    const source = manifest.excluded.find((entry) => entry.sourceId === item.sourceId)
    if (!source) continue
    if (item.withheldDetail !== !source.revealsKind) problems.push(`withheldDetail for ${item.sourceId}`)
    if (!source.revealsKind && item.kind !== undefined) problems.push(`kind leaked for ${item.sourceId}`)
  }
  return problems
}

function renderLines(view: MemoryTuiViewModel, state: MemoryTuiUiState): string[] {
  const lines: string[] = [`AIBridge — ${view.title}`, `filter: ${view.filterDescription}`, ""]

  if (view.error) lines.push(`error: ${view.error}`)
  if (view.notice) lines.push(`notice: ${view.notice}`)

  switch (view.screen) {
    case "browse": {
      if (view.rows.length === 0) {
        lines.push("no memory records match this filter")
        break
      }
      view.rows.forEach((row, index) => {
        const marker = index === view.selectedIndex ? ">" : " "
        const flags = [row.trust, row.sensitivity, row.redaction, row.supersession]
        if (row.withheld.length > 0) flags.push(`withheld:${row.withheld.join("/")}`)
        lines.push(`${marker} ${row.memoryId} [${row.kind}] ${row.scope} {${flags.join(" ")}}`)
        lines.push(`    ${row.summary}`)
      })
      break
    }
    case "record": {
      if (!view.record) {
        lines.push("no record selected")
        break
      }
      lines.push(`${view.record.memoryId} (${view.record.kind})`)
      lines.push(`scope: ${view.record.scopeLabel}`)
      lines.push(`author: ${view.record.authorLabel}`)
      lines.push(`created: ${view.record.createdAt}`)
      lines.push(`trust: ${view.record.trust}`)
      lines.push(`sensitivity: ${view.record.sensitivity}`)
      lines.push(`retention: ${view.record.retention}`)
      lines.push(`redaction: ${view.record.redactionStatus}${view.record.redactionRuleIds.length > 0 ? ` [${view.record.redactionRuleIds.join(", ")}]` : ""}`)
      if (view.record.supersedesMemoryId) lines.push(`supersedes: ${view.record.supersedesMemoryId}`)
      if (view.record.supersededByMemoryId) lines.push(`superseded by: ${view.record.supersededByMemoryId}`)
      if (view.record.withheldReasons.length > 0) lines.push(`withheld: ${view.record.withheldReasons.join(", ")}`)
      lines.push("")
      lines.push(view.record.content)
      if (view.provenance.length > 0) {
        lines.push("")
        lines.push("provenance:")
        for (const reference of view.provenance) lines.push(`  ${reference.namespace} ${reference.id}`)
      }
      break
    }
    case "context-preview": {
      if (!view.preview) {
        lines.push("no context manifest has been assembled yet")
        break
      }
      const preview = view.preview
      lines.push(`manifest: ${preview.manifestId}`)
      lines.push(`digest: ${preview.digest}`)
      lines.push(`destination: ${preview.destination}`)
      lines.push(`role snapshot: ${preview.roleSnapshotHash}`)
      lines.push(`policy: ${preview.policyVersion}`)
      lines.push(`budget: ${preview.budget}`)
      lines.push("")
      lines.push("INCLUDED:")
      for (const item of preview.included) {
        lines.push(`  + ${item.sourceId} [${item.categoryTitle}] ${item.reason} (${item.sensitivityDecision}, ${item.scope}, ${item.estimatedCost}${item.optional ? ", optional" : ", required"})`)
        if (item.artifactReferences.length > 0) lines.push(`      artifacts: ${item.artifactReferences.join(", ")}`)
      }
      lines.push("")
      lines.push("EXCLUDED:")
      if (preview.excluded.length === 0) lines.push("  (none)")
      for (const item of preview.excluded) lines.push(renderExclusion(item))
      break
    }
  }

  const body = lines.slice(state.scrollOffset)
  lines.push("")
  lines.push("j/k move · enter open · c context · s superseded · p provenance · ? help · q close")
  return body
}
