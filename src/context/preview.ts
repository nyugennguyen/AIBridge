/**
 * The dispatch-context preview: what a manifest will send, as data, and the
 * check that a preview still describes its manifest.
 *
 * Extracted from the retired memory TUI view model (3.1.1). The isolation
 * auditor (`isolation.ts`) is its consumer: it verifies a rendered preview
 * against the manifest instead of trusting the preview's claims about itself.
 */

import {
  CONTEXT_CATEGORY_TITLES,
  type ContextCategory,
  type ContextExclusionReason,
  type ContextInclusionReason,
  type Sensitivity,
} from "../memory/ontology.js"
import type { ContextManifestV2 } from "./types.js"

export interface ContextPreviewIncludedItem {
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

export interface ContextPreviewExcludedItem {
  readonly sourceId: string
  readonly category: ContextCategory
  readonly reason: ContextExclusionReason
  readonly kind?: string
  readonly scopeKind?: string
  /** True when the reason forbids naming anything but the id. */
  readonly withheldDetail: boolean
}

export interface ContextPreview {
  readonly manifestId: string
  readonly digest: string
  readonly destination: string
  readonly roleSnapshotHash: string
  readonly policyVersion: string
  readonly budget: string
  readonly estimated: number
  readonly included: readonly ContextPreviewIncludedItem[]
  readonly excluded: readonly ContextPreviewExcludedItem[]
  /** The sections, in render order, with the source ids each will contain. */
  readonly sections: readonly { category: ContextCategory; title: string; sourceIds: readonly string[] }[]
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
export function buildPreview(manifest: ContextManifestV2): ContextPreview {
  const included = manifest.items.map<ContextPreviewIncludedItem>((item) => ({
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

  const excluded = manifest.excluded.map<ContextPreviewExcludedItem>((entry) => ({
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
  preview: ContextPreview,
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
