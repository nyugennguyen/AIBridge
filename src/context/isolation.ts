/**
 * M5.9 — the isolation audit: a data-flow map and a leakage auditor.
 *
 * # What this is for
 *
 * The plan's criterion is "No unauthorized record, secret, or artifact reference
 * crosses boundary", and the verification is an *independent* review. This
 * module is the machine-checkable half of that review: it enumerates every path
 * a memory record or a context item can take out of the system, and it scans
 * what each path produces for material the destination was not cleared for.
 *
 * It is deliberately NOT a second access-control implementation. It reads the
 * same `MemoryAccessPolicy` the repository uses and asserts on the *outputs* of
 * real assembly and real rendering. A second policy would be a second place to
 * get authorization wrong, which is the opposite of the point.
 *
 * # The paths, and why there are exactly these
 *
 * | # | Path | What could leak |
 * | --- | --- | --- |
 * | 1 | repository query | another project's, role's, or node's records |
 * | 2 | context manifest | a restricted record reaching a lower clearance |
 * | 3 | context exclusions | prohibited content described by its reason |
 * | 4 | rendered prompt | a record the manifest did not include |
 * | 5 | memory record at rest | a secret value, in any field |
 * | 6 | audit events | content, or a secret, in a log |
 * | 7 | TUI preview | content a manifest withheld |
 *
 * Seven, because those are the seven places M5 writes or emits anything. A
 * leak path that is not in this list is a leak path nobody is checking, so the
 * list is exported and the gate report cites it.
 *
 * # What "no leak" is asserted as
 *
 * For each path the auditor is given a set of *seeded secret literals* and
 * forbidden identity pairs, and it asserts two things:
 *
 * 1. **No seeded literal appears** in the output, in any form — raw string,
 *    JSON-serialized, base64, or URL-encoded. Checking the raw form alone would
 *    pass an implementation that base64s its output, which is a real thing
 *    transports do.
 * 2. **Every emitted identifier was cleared for the destination.** This is the
 *    check that catches a record leaking *by reference*: a manifest exclusion
 *    that names the right id but for the wrong reason, or a rendered prompt
 *    that names an artifact the reader may not dereference.
 *
 * The second is the one that finds real bugs. The first is the one everyone
 * writes.
 */

import { assembleContext, renderContextWithContent, sourceIdOf } from "./assembler.js"
import { verifyPreviewMatchesManifest } from "./tui/memory-view.js"
import type {
  ContextAssemblyRequest,
  ContextCandidate,
  ContextManifestV2,
  ContextTextRedactor,
} from "./types.js"
import { SENSITIVE_EXCLUSION_REASONS, type ContextExclusionReason, type Sensitivity } from "../memory/ontology.js"
import {
  nodeIdSchema,
  projectIdSchema,
  roleIdSchema,
  runIdSchema,
  userIdSchema,
} from "../orchestration/identifiers.js"
import { memoryRecordSchemaV2, type MemoryRecordV2 } from "../memory/record.js"
import type { MemoryQueryResult, MemoryQueryScope, MemoryRepository } from "../memory/ports.js"
import type { MemoryViewScope } from "../memory/record.js"
import { createContractError, type Result } from "../orchestration/errors.js"

/** The seven egress paths. Exported so the gate report can cite the list. */
export const MEMORY_EGRESS_PATHS = [
  "repository_query",
  "context_manifest",
  "context_exclusion",
  "rendered_prompt",
  "record_at_rest",
  "audit_event",
  "tui_preview",
] as const
export type MemoryEgressPath = (typeof MEMORY_EGRESS_PATHS)[number]

export interface LeakFinding {
  readonly path: MemoryEgressPath
  readonly kind: "secret_material" | "unauthorized_identifier" | "unauthorized_content" | "structure"
  readonly severity: "blocker" | "high" | "medium"
  /** What was found, in a form safe to put in a report: ids and counts, never content. */
  readonly detail: string
  /** The record or item id involved, when there is one. */
  readonly subjectId?: string
}

export interface AuditInput {
  /** Literals that must not appear anywhere in any output, in any encoding. */
  readonly seededSecrets: readonly string[]
  /**
   * Identifiers the destination was not cleared for. An output naming any of
   * them is a leak even if it names no content.
   */
  readonly forbiddenIdentifiers: readonly string[]
  /** The manifest under audit, when one was assembled. */
  readonly manifest?: ContextManifestV2 | null
  /** The rendered prompt under audit. */
  readonly rendered?: { readonly text: string; readonly sourceIds: readonly string[] } | null
  /** A query result under audit. */
  readonly query?: MemoryQueryResult | null
  /**
   * The TUI preview under audit.
   *
   * Typed structurally rather than as the M5.8 view-model class, so the auditor
   * does not import the presentation layer — a redaction check that depended on
   * the renderer it is checking could be defeated by a renderer change. Only the
   * fields the audit reads are required.
   */
  readonly preview?: {
    readonly lines: readonly string[]
    readonly included: readonly { readonly sourceId: string }[]
    readonly excluded: readonly { readonly sourceId: string; readonly reason: string }[]
    /** Source ids whose CONTENT the preview displayed, per the caller. */
    readonly excludedContent?: readonly string[]
  } | null
  /** Records at rest under audit. */
  readonly records?: readonly MemoryRecordV2[]
  /** Audit events under audit. */
  readonly auditEvents?: readonly { readonly memoryId: string; readonly reason?: string; readonly [key: string]: unknown }[]
  /** The source ids the manifest cleared, for the rendered-prompt check. */
  readonly clearedSourceIds?: readonly string[]
}

export interface AuditResult {
  readonly findings: readonly LeakFinding[]
  /** Every egress path that was actually examined, so "no findings" is not "no checks". */
  readonly examinedPaths: readonly MemoryEgressPath[]
  readonly passed: boolean
}

/**
 * Every encoding a value could plausibly arrive in.
 *
 * Base64 and URL-encoding are here because a transport or a log formatter will
 * do one of them, and a leak test that only greps the raw form is a test that
 * passes on a leak. A secret that survives base64 is still a secret.
 */
function encodings(value: string): string[] {
  const forms = [value]
  forms.push(Buffer.from(value, "utf8").toString("base64"))
  forms.push(Buffer.from(value, "utf8").toString("base64url"))
  forms.push(encodeURIComponent(value))
  // A leaked secret is often one field of a larger string; the surrounding JSON
  // escaping is applied by whoever serializes, so it is applied here too.
  forms.push(JSON.stringify(value).slice(1, -1))
  return forms
}

/** Does any seeded secret appear in `text`, in any encoding? Returns the first hit. */
export function findSeededSecret(text: string, seededSecrets: readonly string[]): string | null {
  for (const secret of seededSecrets) {
    for (const form of encodings(secret)) {
      if (form.length >= 8 && text.includes(form)) return secret
    }
  }
  return null
}

function findForbiddenIdentifier(text: string, forbidden: readonly string[]): string | null {
  for (const identifier of forbidden) {
    if (identifier.length >= 3 && text.includes(identifier)) return identifier
  }
  return null
}

/**
 * Audit one assembly.
 *
 * Checks the paths the input actually supplies, and records which ones it
 * examined. A caller that forgets to pass `records` gets an audit that says it
 * examined five of seven paths — not an audit that quietly passed.
 */
export function auditMemoryContext(input: AuditInput): AuditResult {
  const findings: LeakFinding[] = []
  const examined: MemoryEgressPath[] = []

  // --- Path 1: repository query -------------------------------------------
  if (input.query) {
    examined.push("repository_query")
    const serialized = JSON.stringify(input.query.records)
    const secret = findSeededSecret(serialized, input.seededSecrets)
    if (secret) {
      findings.push({
        path: "repository_query",
        kind: "secret_material",
        severity: "blocker",
        detail: `A query result contained a seeded secret literal (${input.query.records.length} records serialized)`,
      })
    }
    for (const record of input.query.records) {
      if (record.sensitivity === "prohibited") {
        findings.push({
          path: "repository_query",
          kind: "unauthorized_content",
          severity: "blocker",
          detail: "A prohibited record was returned by a query",
          subjectId: record.memoryId,
        })
      }
      if (record.trust !== "accepted") {
        findings.push({
          path: "repository_query",
          kind: "unauthorized_content",
          severity: "high",
          detail: `A '${record.trust}' record was returned as injectable content`,
          subjectId: record.memoryId,
        })
      }
    }
    // A withholding must never describe more than its reason.
    for (const withheld of input.query.withheld) {
      if (!withheld.revealsKind && withheld.kind !== undefined) {
        findings.push({
          path: "repository_query",
          kind: "structure",
          severity: "high",
          detail: `A withholding with reason '${withheld.reason}' named a kind it must not reveal`,
          subjectId: withheld.memoryId,
        })
      }
    }
  }

  // --- Path 2/3: manifest items and exclusions ----------------------------
  if (input.manifest) {
    examined.push("context_manifest")
    examined.push("context_exclusion")
    const manifestText = JSON.stringify(input.manifest)

    const secret = findSeededSecret(manifestText, input.seededSecrets)
    if (secret) {
      findings.push({
        path: "context_manifest",
        kind: "secret_material",
        severity: "blocker",
        detail: "The serialized manifest contained a seeded secret literal",
      })
    }
    const forbidden = findForbiddenIdentifier(manifestText, input.forbiddenIdentifiers)
    if (forbidden) {
      findings.push({
        path: "context_manifest",
        kind: "unauthorized_identifier",
        severity: "high",
        detail: `The manifest names an identifier the destination was not cleared for ('${forbidden}')`,
      })
    }

    for (const item of input.manifest.items) {
      if (item.sensitivity === "prohibited") {
        findings.push({
          path: "context_manifest",
          kind: "unauthorized_content",
          severity: "blocker",
          detail: "A prohibited record was included in the manifest",
          subjectId: item.sourceId,
        })
      }
      if (item.sensitivity === "restricted" && input.manifest.destination.clearance === "public_to_project") {
        findings.push({
          path: "context_manifest",
          kind: "unauthorized_content",
          severity: "blocker",
          detail: "A restricted record was included for a public_to_project destination",
          subjectId: item.sourceId,
        })
      }
    }

    // An exclusion of a sensitive reason must not carry anything but its id.
    for (const exclusion of input.manifest.excluded) {
      if (!SENSITIVE_EXCLUSION_REASONS.includes(exclusion.reason as ContextExclusionReason)) continue
      const serialized = JSON.stringify(exclusion)
      if (!exclusion.revealsKind && exclusion.kind !== undefined) {
        findings.push({
          path: "context_exclusion",
          kind: "structure",
          severity: "high",
          detail: `A '${exclusion.reason}' exclusion named a kind it must not reveal`,
          subjectId: exclusion.sourceId,
        })
      }
      // A hash is a fingerprint. A prohibited record's exclusion must not carry
      // one, because a fingerprint confirms guesses.
      if (JSON.stringify(exclusion).includes("sha256:")) {
        findings.push({
          path: "context_exclusion",
          kind: "structure",
          severity: "high",
          detail: `A '${exclusion.reason}' exclusion carried a content hash`,
          subjectId: exclusion.sourceId,
        })
      }
      const exclusionSecret = findSeededSecret(serialized, input.seededSecrets)
      if (exclusionSecret) {
        findings.push({
          path: "context_exclusion",
          kind: "secret_material",
          severity: "blocker",
          detail: "An exclusion contained a seeded secret literal",
          subjectId: exclusion.sourceId,
        })
      }
    }
  }

  // --- Path 4: the rendered prompt ----------------------------------------
  if (input.rendered) {
    examined.push("rendered_prompt")
    const secret = findSeededSecret(input.rendered.text, input.seededSecrets)
    if (secret) {
      findings.push({
        path: "rendered_prompt",
        kind: "secret_material",
        severity: "blocker",
        detail: "The rendered prompt contained a seeded secret literal",
      })
    }
    // A prompt may name only what the manifest included. This is the check that
    // catches a renderer that fetched something the assembler did not select.
    //
    // The M5.9 review found this check was **silently disabled** whenever
    // `clearedSourceIds` was empty and no manifest was supplied: the `cleared.size
    // > 0` guard meant an audit with nothing to compare against passed with no
    // comparison performed, and reported `passed: true`. A check that disables
    // itself in the case where it has nothing is a check that reports success
    // when it did not run.
    //
    // So: when there is no ground truth, the auditor says so *as a finding*
    // rather than staying quiet. `clearedSourceIds: []` explicitly means "this
    // prompt should name nothing"; omitting it entirely while supplying a
    // manifest falls back to the manifest. Supplying neither is the only
    // uncheckable case, and it is reported as a Medium `structure` finding so a
    // caller cannot mistake "I could not check" for "I checked and it was fine".
    const hasGroundTruth = input.clearedSourceIds !== undefined || input.manifest !== undefined && input.manifest !== null
    if (!hasGroundTruth) {
      findings.push({
        path: "rendered_prompt",
        kind: "structure",
        severity: "medium",
        detail:
          "The rendered prompt was audited with no manifest and no `clearedSourceIds`, so its source ids could not be checked; supply one of the two for the check to mean anything",
      })
    }
    const cleared = new Set(
      input.clearedSourceIds ?? input.manifest?.items.map((item) => item.sourceId) ?? [],
    )
    for (const sourceId of input.rendered.sourceIds) {
      if (hasGroundTruth && !cleared.has(sourceId)) {
        findings.push({
          path: "rendered_prompt",
          kind: "unauthorized_content",
          severity: "blocker",
          detail: "The rendered prompt names a source the manifest did not include",
          subjectId: sourceId,
        })
      }
    }
    if (input.manifest) {
      // And it must not name anything the manifest EXCLUDED.
      const excluded = new Set(input.manifest.excluded.map((entry) => entry.sourceId))
      for (const sourceId of input.rendered.sourceIds) {
        if (excluded.has(sourceId)) {
          findings.push({
            path: "rendered_prompt",
            kind: "unauthorized_content",
            severity: "blocker",
            detail: "The rendered prompt names a source the manifest excluded",
            subjectId: sourceId,
          })
        }
      }
    }
  }

  // --- Path 5: records at rest --------------------------------------------
  if (input.records) {
    examined.push("record_at_rest")
    for (const raw of input.records) {
      const record = memoryRecordSchemaV2.safeParse(raw)
      if (!record.success) {
        findings.push({
          path: "record_at_rest",
          kind: "structure",
          severity: "high",
          detail: "A stored record does not satisfy the record contract",
          subjectId: (raw as { memoryId?: string }).memoryId,
        })
        continue
      }
      const value = record.data
      const serialized = JSON.stringify(value)
      const secret = findSeededSecret(serialized, input.seededSecrets)
      if (secret) {
        findings.push({
          path: "record_at_rest",
          kind: "secret_material",
          severity: "blocker",
          detail: "A stored record contains a seeded secret literal",
          subjectId: value.memoryId,
        })
      }
      // The schema forbids this, and the audit says so: a `secret_reference_only`
      // record with no reference is a record asserting a credential with no
      // referent, which is how a secret gets described instead of redacted.
      if (value.sensitivity === "secret_reference_only" && (value.payload.secretReferences ?? []).length === 0) {
        findings.push({
          path: "record_at_rest",
          kind: "structure",
          severity: "high",
          detail: "A secret_reference_only record names no secret reference",
          subjectId: value.memoryId,
        })
      }
    }
  }

  // --- Path 7: the TUI preview --------------------------------------------
  //
  // The preview is an operator-facing rendering, so it is a distinct egress
  // from the manifest it renders. The check that matters is that the preview
  // shows exactly the manifest's items: a view that filtered, re-sorted, or
  // un-redacted would let an operator approve something other than what the
  // agent receives, and the manifest would still verify.
  if (input.preview) {
    examined.push("tui_preview")
    const previewText = input.preview.lines.join("\n")
    const secret = findSeededSecret(previewText, input.seededSecrets)
    if (secret) {
      findings.push({
        path: "tui_preview",
        kind: "secret_material",
        severity: "blocker",
        detail: "The TUI preview rendered a seeded secret literal",
      })
    }
    if (input.manifest) {
      // `verifyPreviewMatchesManifest` is the M5.8 function, and it wants the
      // full view model. The audit's structural type is deliberately narrower, so
      // the comparison is done against a merged object whose manifest-derived
      // fields come from the manifest — which is the point: any field the
      // preview *claims* about itself is ignored in favour of the manifest's.
      const drift = verifyPreviewMatchesManifest(
        {
          ...(input.preview as unknown as Record<string, unknown>),
          manifestId: input.manifest.manifestId,
          digest: input.manifest.digest,
          estimated: input.manifest.budget.estimated,
        } as unknown as Parameters<typeof verifyPreviewMatchesManifest>[0],
        input.manifest,
      )
      if (drift.length > 0) {
        findings.push({
          path: "tui_preview",
          kind: "unauthorized_content",
          severity: "blocker",
          // The names of the discrepancies, never the content: this string ends
          // up in an operator's report.
          detail: `The preview does not describe its manifest (${drift.join(", ")})`,
        })
      }
      // A withheld record's CONTENT must not appear anywhere on screen, even if
      // the preview's structured fields are correct.
      for (const exclusion of input.manifest.excluded) {
        if (input.preview.excludedContent?.includes(exclusion.sourceId) === true) {
          findings.push({
            path: "tui_preview",
            kind: "unauthorized_content",
            severity: "blocker",
            detail: "The TUI preview displayed an excluded record's content",
            subjectId: exclusion.sourceId,
          })
        }
      }
    }
  }

  // --- Path 6: audit events -----------------------------------------------
  if (input.auditEvents) {
    examined.push("audit_event")
    for (const event of input.auditEvents) {
      const serialized = JSON.stringify(event)
      const secret = findSeededSecret(serialized, input.seededSecrets)
      if (secret) {
        findings.push({
          path: "audit_event",
          kind: "secret_material",
          severity: "blocker",
          detail: "An audit event contains a seeded secret literal",
          subjectId: event.memoryId,
        })
      }
      // An audit event names a record; it must not carry that record's body.
      for (const key of Object.keys(event)) {
        if (key === "content" || key === "payload" || key === "text") {
          findings.push({
            path: "audit_event",
            kind: "unauthorized_content",
            severity: "high",
            detail: `An audit event carries a '${key}' field; an audit log is a support ticket`,
            subjectId: event.memoryId,
          })
        }
      }
    }
  }

  return { findings, examinedPaths: examined, passed: findings.length === 0 }
}

/**
 * A one-line disposition for the gate report.
 *
 * Says which paths were checked, because "no leaks found" without "out of seven"
 * is indistinguishable from "no leaks, because nothing was checked".
 */
export function describeAudit(result: AuditResult): string {
  const blockers = result.findings.filter((finding) => finding.severity === "blocker").length
  return `${result.examinedPaths.length}/${MEMORY_EGRESS_PATHS.length} paths examined, ${result.findings.length} finding(s) (${blockers} blocker), ${result.passed ? "PASS" : "FAIL"}`
}

/** Turn findings into a refusal, so a caller cannot audit and then proceed anyway. */
export function assertNoLeaks(result: AuditResult): Result<true> {
  if (result.passed) return { ok: true, value: true }
  const blockers = result.findings.filter((finding) => finding.severity === "blocker").length
  return {
    ok: false,
    error: createContractError(
      "policy_denied",
      "memory.isolation_audit_failed",
      `${describeAudit(result)}: ${result.findings
        .slice(0, 5)
        .map((finding) => `${finding.path}/${finding.kind}`)
        .join(", ")}`,
      false,
    ),
  }
}

// ---------------------------------------------------------------------------
// Cross-boundary matrix
// ---------------------------------------------------------------------------

/**
 * The cross-project/node/role matrix the plan asks the audit to cover.
 *
 * A matrix rather than a list of test cases because the interesting property is
 * not "project A is denied to project B" but the *shape*: every boundary must
 * deny, for the same reason, and no boundary may be stricter than another in a
 * way that is not deliberate. `tests/integration/context-isolation.test.ts` walks
 * the whole matrix.
 */
export interface IsolationCase {
  readonly name: string
  readonly reader: MemoryQueryScope
  /** The record the reader must not see, described by identity only. */
  readonly record: {
    readonly memoryId: string
    readonly projectId: string
    readonly scopeKind: string
    readonly sensitivity: string
    readonly trust: string
    readonly visibleToNodeIds?: readonly string[]
    readonly visibleToRoleIds?: readonly string[]
    readonly redactionStatus: string
    readonly createdAt?: string
    readonly expiresAt?: string
  }
  /** The withholding reason the reader must receive. */
  readonly expectedReason: string
  /** Whether the reason may reveal the record's kind. */
  readonly expectedRevealsKind: boolean
  /**
   * Whether the record becomes a *candidate* the access policy then denies.
   *
   * `false` for the cross-project case, and the reason is the point rather than
   * an exception: a foreign record is dropped before the policy runs, so the
   * reader is told nothing at all — not even that an id exists. A
   * `project_mismatch` withholding would be a weaker guarantee, because a
   * withholding is an answer and an answer confirms existence.
   */
  readonly expectedCandidate: boolean
}

/**
 * Build a reader scope.
 *
 * A function rather than ten inline literals because `MemoryQueryScope.actor`
 * carries branded id types, and a hand-written literal would need a cast at
 * every site — ten casts in the file that is supposed to be the most carefully
 * read one. Parsing through the owning schema is also the point: a reader scope
 * that does not satisfy the identifier contract cannot be constructed.
 */
function reader(input: {
  projectId: string
  scope: "project" | "run"
  nodeId: string
  roleId: string
  clearance: Sensitivity
  userId?: string
  /** The run/task/session the reader is acting in. Required for a non-project scope. */
  runId?: string
  taskId?: string
}): MemoryQueryScope {
  const scope = readerScopeFor(input)
  return {
    projectId: projectIdSchema.parse(input.projectId),
    scope,
    nodeId: nodeIdSchema.parse(input.nodeId),
    roleId: roleIdSchema.parse(input.roleId),
    clearance: input.clearance,
    actor: { kind: "user", userId: userIdSchema.parse(input.userId ?? "user-auditor") },
  }
}

/**
 * A reader's full scope.
 *
 * A `run` reader is given a run id because a kind alone is not an identity —
 * that is the gap the `MemoryQueryScope` docblock records. Cases that exercise
 * cross-run isolation need the two runs to differ, so the default run is
 * `run-reader` and the "another run" case uses `run-other`.
 */
function readerScopeFor(input: {
  scope: "project" | "run"
  runId?: string
  taskId?: string
}): MemoryViewScope {
  if (input.scope === "project") return { kind: "project" }
  return { kind: "run", runId: runIdSchema.parse(input.runId ?? "run-reader") }
}

export const ISOLATION_CASES: readonly IsolationCase[] = Object.freeze([
  {
    name: "another project's record",
    reader: reader({ projectId: "project-a", scope: "project", nodeId: "node-a", roleId: "role-x", clearance: "restricted" }),
    record: { memoryId: "m-cross-project", projectId: "project-b", scopeKind: "project", sensitivity: "public_to_project", trust: "accepted", redactionStatus: "none" },
    // `revealsKind: false`, and the case is NOT a candidate at all.
    //
    // The M5.9 review found this entry asserting `true` while the
    // implementation returned `false`, with the disagreement untested because
    // the integration test returns early for `expectedCandidate: false`. The
    // flag here is the *correct* value; the earlier `true` was the docblock's
    // error, and both the contract text and this case now say `false`. The
    // matrix entry is kept rather than deleted because it records the
    // *stronger* property — a foreign record is not even a candidate — and
    // `tests/integration/context-isolation.test.ts` asserts that explicitly.
    expectedReason: "project_mismatch",
    expectedRevealsKind: false,
    expectedCandidate: false,
  },
  {
    name: "a record restricted to another node",
    reader: reader({ projectId: "project-a", scope: "project", nodeId: "node-a", roleId: "role-x", clearance: "restricted" }),
    record: { memoryId: "m-other-node", projectId: "project-a", scopeKind: "project", sensitivity: "public_to_project", trust: "accepted", visibleToNodeIds: ["node-b"], redactionStatus: "none" },
    expectedReason: "node_restricted",
    expectedRevealsKind: false,
    expectedCandidate: true,
  },
  {
    name: "a record restricted to another role",
    reader: reader({ projectId: "project-a", scope: "project", nodeId: "node-a", roleId: "role-x", clearance: "restricted" }),
    record: { memoryId: "m-other-role", projectId: "project-a", scopeKind: "project", sensitivity: "public_to_project", trust: "accepted", visibleToRoleIds: ["role-y"], redactionStatus: "none" },
    expectedReason: "role_restricted",
    expectedRevealsKind: false,
    expectedCandidate: true,
  },
  {
    name: "a restricted record read by a public_to_project reader",
    reader: reader({ projectId: "project-a", scope: "project", nodeId: "node-a", roleId: "role-x", clearance: "public_to_project" }),
    record: { memoryId: "m-restricted", projectId: "project-a", scopeKind: "project", sensitivity: "restricted", trust: "accepted", redactionStatus: "none" },
    expectedReason: "sensitivity_above_clearance",
    expectedRevealsKind: false,
    expectedCandidate: true,
  },
  {
    name: "a secret_reference_only record read by a restricted reader",
    reader: reader({ projectId: "project-a", scope: "project", nodeId: "node-a", roleId: "role-x", clearance: "restricted" }),
    record: { memoryId: "m-secret-ref", projectId: "project-a", scopeKind: "project", sensitivity: "secret_reference_only", trust: "accepted", redactionStatus: "none" },
    expectedReason: "sensitivity_above_clearance",
    expectedRevealsKind: false,
    expectedCandidate: true,
  },
  {
    name: "a prohibited record, read by a reader holding full clearance",
    reader: reader({ projectId: "project-a", scope: "project", nodeId: "node-a", roleId: "role-x", clearance: "secret_reference_only" }),
    record: { memoryId: "m-prohibited", projectId: "project-a", scopeKind: "project", sensitivity: "prohibited", trust: "accepted", redactionStatus: "prohibited" },
    expectedReason: "prohibited_content",
    expectedRevealsKind: false,
    expectedCandidate: true,
  },
  {
    name: "an untrusted record",
    reader: reader({ projectId: "project-a", scope: "project", nodeId: "node-a", roleId: "role-x", clearance: "restricted" }),
    record: { memoryId: "m-proposed", projectId: "project-a", scopeKind: "project", sensitivity: "public_to_project", trust: "proposed", redactionStatus: "none" },
    expectedReason: "not_trusted",
    expectedRevealsKind: true,
    expectedCandidate: true,
  },
  {
    name: "a record outside the reader's own run",
    reader: reader({ projectId: "project-a", scope: "run", nodeId: "node-a", roleId: "role-x", clearance: "restricted" }),
    record: { memoryId: "m-other-run", projectId: "project-a", scopeKind: "run", sensitivity: "public_to_project", trust: "accepted", redactionStatus: "none" },
    // The record belongs to `run-other`; the reader is in `run-reader`. Two
    // records of the same `run` KIND, and the identity is the only thing that
    // separates them.
    expectedReason: "scope_not_visible",
    expectedRevealsKind: true,
    expectedCandidate: true,
  },
  {
    name: "a redacted record whose content was removed",
    reader: reader({ projectId: "project-a", scope: "project", nodeId: "node-a", roleId: "role-x", clearance: "restricted" }),
    record: { memoryId: "m-redacted", projectId: "project-a", scopeKind: "project", sensitivity: "restricted", trust: "accepted", redactionStatus: "prohibited" },
    expectedReason: "redacted_unavailable",
    expectedRevealsKind: false,
    expectedCandidate: true,
  },
  {
    name: "an expired record",
    reader: reader({ projectId: "project-a", scope: "project", nodeId: "node-a", roleId: "role-x", clearance: "restricted" }),
    // Expired *relative to the reader's reference time* (2026-09-30), and still
    // after the record's own creation — a record cannot be created already
    // expired, and the schema says so.
    record: { memoryId: "m-expired", projectId: "project-a", scopeKind: "project", sensitivity: "public_to_project", trust: "accepted", redactionStatus: "none", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z" },
    expectedReason: "expired",
    expectedRevealsKind: true,
    expectedCandidate: true,
  },
])

/** Why the matrix has this shape, and what a gap in it would mean. */
export const ISOLATION_MATRIX_NOTES = Object.freeze({
  reasonsCovered: [
    "project_mismatch",
    "scope_not_visible",
    "not_trusted",
    "superseded",
    "sensitivity_above_clearance",
    "prohibited_content",
    "node_restricted",
    "role_restricted",
    "expired",
    "tombstoned",
    "redacted_unavailable",
  ],
  /**
   * `superseded` and `tombstoned` are the two view reasons rather than access
   * reasons, and they are not in the matrix above because a superseded record is
   * withheld by a *query switch*, not by a boundary. They are covered by
   * `tests/unit/memory/supersession.test.ts`. Listing them here without a case
   * would be a claim the matrix does not back.
   */
  viewOnlyReasons: ["superseded", "tombstoned"],
})

/** Re-exported so an integration test can assert a candidate id without importing two modules. */
export { sourceIdOf, assembleContext, renderContextWithContent }
export type { ContextCandidate, ContextTextRedactor, ContextAssemblyRequest }
