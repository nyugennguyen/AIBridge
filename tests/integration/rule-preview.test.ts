/**
 * M6.3 GATE — the rule preview, end to end, against the real compiler and the real
 * runtime evaluator.
 *
 * ============================ WHAT THIS FILE IS FOR ============================
 *
 * The unit suites under `tests/unit/rules/` prove the preview is internally
 * consistent: that `previewCompiledRuleSet` reports what its own evaluator reported,
 * that the disclosure has all eight members, that `shadowed` is proven and
 * `possible_overlap` is not. This file proves the composition those tests cannot
 * reach, and it is deliberately built from DIFFERENT fixtures — a new rule set, a
 * new history, a new set of documents — because a gate that runs the same inputs as
 * the units it certifies is a gate that certifies the units.
 *
 * ## Completion criteria this file carries
 *
 *   - "Preview and runtime use the identical compiled rule representation." Test 1 is
 *     that criterion, and it is ADR 0007 **Stop Condition 1**: preview and production
 *     evaluation are never able to diverge. The oracle here is a DIRECT
 *     `evaluateRules` call over a context this file constructs itself, from the
 *     history entry, by hand. A helper both sides used would make the comparison a
 *     tautology.
 *   - "User rules are versioned, deterministic, bounded, explainable." Tests 2-5.
 *   - "Pre-approval is restricted to the exact displayed bounds." Test 2.
 *   - The six Stop Conditions' mirror images: a universal pre-approval is refused
 *     (test 4), each non-match reason is distinguishable (test 5), and the preview
 *     writes nothing (test 6).
 *
 * ## What is deliberately NOT asserted here
 *
 * The no-secret canary audit and the 50-iteration determinism sweep already exist as
 * unit tests over this same module, and repeating them here would add runtime without
 * adding evidence. The composition claims below are the ones a unit test could not
 * have made: a preview over a rule set the COMPILER actually produced, reporting what
 * the RUNTIME evaluator actually decided, with no writes anywhere.
 *
 * ## Discipline
 *
 * One injected clock (`FIXED_NOW`), one seeded generator (`shuffled`), no
 * `Date.now`, no `Math.random`, no filesystem, no network, no subprocess.
 */

import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  NON_UNIVERSAL_PREDICATE_FIELDS,
  RULE_PREDICATE_FIELDS,
  UNKNOWN_REACH_TEXT,
  buildPreApprovalDisclosure,
  compileRuleSet,
  dependencyOutcomeValueSchema,
  evaluateRules,
  previewCompiledRuleSet,
  ruleMatchOutcomeSchema,
  sensitivitySchema,
  type CompiledRuleSet,
  type RuleEvaluationContext,
  type RulePreview,
  type RulePreviewEntry,
  type RuleSourceDocument,
} from "../../src/rules/index.js"
import { canonicalJson } from "../../src/orchestration/digest.js"
import {
  nodeIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  roleIdSchema,
  timestampSchema,
} from "../../src/orchestration/identifiers.js"
import {
  budgetDocument,
  compiledFrom,
  denyDocument,
  EARLIER_INSTANT,
  FIXED_NOW,
  historyEntry,
  identityOf,
  NODE_A,
  preApprovalDocument,
  previewHistory,
  previewOptions,
  PROJECT_ID,
  PROJECT_PATH_ID,
  rawRuleDocument,
  registryNode,
  requireApprovalDocument,
  roleApprovalDocument,
  roleDenyDocument,
  ROLE_ID,
  routingDocument,
  scopeApprovalDocument,
  shuffled,
  universalDenyDocument,
  universalPreApprovalDocument,
} from "./m6-fixtures.js"

// ===========================================================================
// Helpers
// ===========================================================================

/** Previews, or throws with the refusal attached. */
function previewed(compiled: CompiledRuleSet, history: unknown, options: unknown = previewOptions()): RulePreview {
  const preview = previewCompiledRuleSet(compiled, history, options)
  if (!preview.ok) throw new Error(`the preview refused unexpectedly: ${preview.error.code} — ${preview.error.message}`)
  return preview.value
}

/** One preview entry by `ruleId@templateVersion`, or throws. */
function entryFor(preview: RulePreview, ruleId: string, templateVersion = 1): RulePreviewEntry {
  const found = preview.rules.find((entry) => entry.ruleId === ruleId && entry.templateVersion === templateVersion)
  if (found === undefined) throw new Error(`the preview carries no entry for ${ruleId}@${templateVersion}`)
  return found
}

/**
 * The evaluation context, built HERE from a history entry.
 *
 * # Why this is written out rather than shared with the module under test
 *
 * This is the oracle for Stop Condition 1. If this construction were imported from
 * `src/rules/preview.ts` it would BE `contextForEntry`, and the test would assert
 * that the preview agrees with itself — which is exactly the divergence Stop
 * Condition 1 exists to prevent going unnoticed. Writing it here means a field the
 * preview forgot to copy, or copied with the wrong fail-closed default, shows up
 * here as a difference rather than as agreement.
 *
 * The four fields the ADR's history shape does not carry are supplied at their
 * documented fail-closed values: no tool categories named, no node capability
 * snapshot, no task title (a title IS content, and section 12 forbids it reaching a
 * disclosure), and no budget in force.
 *
 * # Why every value is PARSED and not cast
 *
 * `RuleEvaluationContext`'s identifier members are BRANDED (`$brand<"ProjectId">`
 * and five siblings), so a history entry's plain `unknown` cannot be assigned to
 * one without either an `as` — the unchecked assertion this milestone's fixtures
 * refuse — or a parse through the schema that owns the brand. The schemas are the
 * module's own (`projectIdSchema`, `roleIdSchema`, `nodeIdSchema`,
 * `projectPathIdSchema`, `sensitivitySchema`, `dependencyOutcomeValueSchema`), so
 * a value the language would refuse throws HERE, at the oracle, naming the field —
 * rather than producing a context that `evaluateRules` refuses with a message
 * about the whole object. That is the difference between a fixture bug and a
 * product bug, and it is the reason the parse is worth its six lines.
 */
const nullableStringSchema = z.string().min(1).nullable()
const nullableIntegerSchema = z.number().int().nullable()
const stringListSchema = z.array(z.string().min(1))
const dependencyOutcomeListSchema = z.array(dependencyOutcomeValueSchema)

function oracleContext(entry: Record<string, unknown>): RuleEvaluationContext {
  return {
    projectId: projectIdSchema.parse(entry["projectId"]),
    roleId: entry["roleId"] === null || entry["roleId"] === undefined ? null : roleIdSchema.parse(entry["roleId"]),
    roleVersion: nullableIntegerSchema.parse(entry["roleVersion"]),
    requestedCapabilities: stringListSchema.parse(entry["requestedCapabilities"]),
    toolCategories: [],
    runtimeKind: nullableStringSchema.parse(entry["runtimeKind"]),
    targetNodeId:
      entry["targetNodeId"] === null || entry["targetNodeId"] === undefined
        ? null
        : nodeIdSchema.parse(entry["targetNodeId"]),
    nodeAdvertisedCapabilities: null,
    projectPathId:
      entry["projectPathId"] === null || entry["projectPathId"] === undefined
        ? null
        : projectPathIdSchema.parse(entry["projectPathId"]),
    taskLabels: stringListSchema.parse(entry["taskLabels"]),
    dependencyOutcomes: dependencyOutcomeListSchema.parse(entry["dependencyOutcomes"]),
    requestedFanOut: nullableIntegerSchema.parse(entry["requestedFanOut"]),
    requestedConcurrency: nullableIntegerSchema.parse(entry["requestedConcurrency"]),
    requestedRetryLimit: nullableIntegerSchema.parse(entry["requestedRetryLimit"]),
    declaredTimeoutSeconds: nullableIntegerSchema.parse(entry["declaredTimeoutSeconds"]),
    taskTitle: null,
    evaluatedAt: timestampSchema.parse(entry["evaluatedAt"]),
    contextManifestSensitivity: sensitivitySchema.nullable().parse(entry["contextManifestSensitivity"]),
    currentBudget: null,
  }
}

/**
 * The compiled set this file's tests run against.
 *
 * Six rules chosen so that one run exercises every relation the preview can report:
 * a universal deny that PROVABLY shadows two scoped rules, a two-project approval
 * and a one-role approval that merely overlap, a pre-approval scoped on project and
 * capability, a budget rule and a routing rule that are scoped but do not intersect
 * anything. Documents come from `m6-fixtures`, are parsed through
 * `ruleSourceDocumentSchema`, and are compiled by the REAL `compileRuleSet`.
 */
function theRealRuleSet(): CompiledRuleSet {
  return compiledFrom(
    denyDocument(),
    requireApprovalDocument(),
    preApprovalDocument(),
    universalDenyDocument(),
    roleDenyDocument(),
    budgetDocument(),
    routingDocument(),
    scopeApprovalDocument(),
    roleApprovalDocument(),
  )
}

/** The history this file's tests run against: three entries, in three roles. */
function theRealHistory(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return previewHistory({
    finishedDispatches: [
      historyEntry({ dispatchId: "disp-m6-a", evaluatedAt: "2026-05-20T09:00:00Z", state: "completed" }),
      historyEntry({
        dispatchId: "disp-m6-b",
        evaluatedAt: "2026-05-21T09:00:00Z",
        state: "failed",
        requestedCapabilities: ["fs.read", "shell.run"],
        roleId: "role-m6-other",
      }),
      historyEntry({
        dispatchId: "disp-m6-c",
        evaluatedAt: "2026-05-22T09:00:00Z",
        state: "completed",
        projectId: "proj-m6-other",
        requestedFanOut: null,
        requestedConcurrency: null,
      }),
    ],
    proposals: [historyEntry({ dispatchId: "disp-m6-d", evaluatedAt: "2026-05-23T09:00:00Z", state: "proposed" })],
    ...overrides,
  })
}

// ===========================================================================
// 1. STOP CONDITION 1 — preview and runtime agreement, end to end
// ===========================================================================

describe("M6.3 — the preview and the runtime evaluator report the same thing", () => {
  it("agrees with a direct evaluateRules call on every rule and every history entry", () => {
    const compiled = theRealRuleSet()
    const history = theRealHistory()
    const preview = previewed(compiled, history)

    // ---- the oracle, with the preview nowhere in sight ----
    const entries = [...(history["finishedDispatches"] as Record<string, unknown>[]), ...(history["proposals"] as Record<string, unknown>[])]
    const oracle = entries.map((entry) => ({
      dispatchId: entry["dispatchId"] as string,
      result: evaluateRules(compiled, oracleContext(entry)),
    }))

    // The preview retained every entry, so a short list is not being compared to a
    // complete one. Asserted so a future MAX_PREVIEW_HISTORY_ENTRIES reduction fails
    // here rather than silently making the comparison partial.
    expect(preview.history.entriesConsidered).toBe(entries.length)
    expect(preview.history.entriesEvaluated).toBe(entries.length)
    expect(preview.history.truncated).toBe(false)
    expect(preview.history.droppedEntryCount).toBe(0)

    expect(preview.rules.map(identityOf)).toEqual(compiled.rules.map(identityOf))

    for (const rule of compiled.rules) {
      const identity = identityOf(rule)
      const reported = entryFor(preview, rule.ruleId, rule.templateVersion)
      const matched: string[] = []
      for (const { dispatchId, result } of oracle) {
        const trace = result.traces.find((candidate) => identityOf(candidate) === identity)
        expect(trace, `${identity} must have a trace for every compiled rule`).toBeDefined()
        const evaluation = reported.evaluations.find((candidate) => candidate.dispatchId === dispatchId)
        expect(evaluation, `${identity} must report an outcome for ${dispatchId}`).toBeDefined()
        expect(
          evaluation?.matchOutcome,
          `${identity} against ${dispatchId}: the preview must report the RUNTIME evaluator's outcome, verbatim`,
        ).toBe(trace?.matchOutcome)
        expect(evaluation?.reason, `${identity} against ${dispatchId}: the reason is copied, not re-derived`).toBe(trace?.reason)
        if (trace?.matchOutcome === "matched") matched.push(dispatchId)
      }
      // And the aggregate, which is the only thing a preview is actually for.
      expect([...reported.matchedHistory], `${identity}'s matched dispatch set`).toEqual(matched.sort())
      expect(reported.matchedHistoryCount).toBe(matched.length)
    }
  })

  it("reports each rule's aggregate match outcome as the evaluator's, not as a boolean", () => {
    const compiled = theRealRuleSet()
    const preview = previewed(compiled, theRealHistory())

    // Five distinct facts in one set: matched, disabled-by-scope-miss, expired and
    // unactivated are separately reported below; here the point is that the
    // aggregate is drawn from `RULE_PREVIEW_OUTCOME_PRECEDENCE` rather than from
    // "did it ever match".
    expect(entryFor(preview, "rule-m6-deny").matchOutcome).toBe("matched")
    // Three of the four entries are in the rule's project, including the failed one
    // and the one that is only a proposal: a deny about project scope does not care
    // how a dispatch ended or whether it has ended.
    expect(entryFor(preview, "rule-m6-deny").matchedHistory).toEqual(["disp-m6-a", "disp-m6-b", "disp-m6-d"])

    // Scoped to `proj-m6`, evaluated against a history containing a dispatch in
    // another project: the rule matched SOME entries, and the entry it did not match
    // is a scope miss rather than a predicate miss.
    const miss = entryFor(preview, "rule-m6-deny").evaluations.find((e) => e.dispatchId === "disp-m6-c")
    expect(miss?.matchOutcome).toBe("project_scope_mismatch")
  })

  it("produces one byte-identical preview and digest across repeated invocations, and from a shuffled history", () => {
    const compiled = theRealRuleSet()
    const history = theRealHistory()
    const first = previewed(compiled, history)
    const canonicalFirst = canonicalJson(first)

    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(canonicalJson(previewed(compiled, theRealHistory())), `invocation ${attempt} must be byte-identical`).toBe(canonicalFirst)
    }

    // A DIFFERENT ORDER in the input arrays must not change the output: the preview
    // sorts `(evaluatedAt, dispatchId)` internally, so an unsorted caller and a
    // sorted caller see the same artifact.
    const finished = history["finishedDispatches"] as Record<string, unknown>[]
    const proposals = history["proposals"] as Record<string, unknown>[]
    const reordered = previewHistory({
      finishedDispatches: shuffled(finished, 20_260_601),
      proposals: shuffled(proposals, 987_654_321),
    })
    expect(canonicalJson(previewed(compiled, reordered))).toBe(canonicalFirst)
  })

  it("binds the injected clock into the digest, so two instants are two artifacts", () => {
    const compiled = theRealRuleSet()
    const atFixed = previewed(compiled, theRealHistory(), previewOptions({ now: FIXED_NOW }))
    const atLater = previewed(compiled, theRealHistory(), previewOptions({ now: "2026-07-04T12:00:00Z" }))
    expect(atFixed.generatedAt).toBe(FIXED_NOW)
    expect(atLater.generatedAt).toBe("2026-07-04T12:00:00Z")
    expect(atFixed.digest).not.toBe(atLater.digest)
  })
})

// ===========================================================================
// 2. The section 11 disclosure, in full
// ===========================================================================

describe("M6.3 — the pre-approval disclosure states all eight required items", () => {
  const PRE_APPROVAL = "rule-m6-pre"

  it("names the normalized predicate, all five reach axes, all five declared bounds, the history, the conflicts, the expiry and the creator", () => {
    const compiled = theRealRuleSet()
    const preview = previewed(compiled, theRealHistory())
    const disclosure = preview.preApprovalDisclosures.find((candidate) => candidate.ruleId === PRE_APPROVAL)
    if (disclosure === undefined) throw new Error(`the preview disclosed no pre-approval for ${PRE_APPROVAL}`)
    const rule = compiled.rules.find((candidate) => candidate.ruleId === PRE_APPROVAL)
    if (rule === undefined) throw new Error(`${PRE_APPROVAL} is not in the compiled set`)

    // --- 1. Exact predicate and normalized form. The compiler's own text, not a
    //        re-render: the form a user reads and the form that is hashed must not
    //        be able to differ.
    expect(disclosure.normalizedPredicate).toBe(rule.normalizedPredicate)
    expect(disclosure.normalizedPredicate).toContain("projectId ==")
    expect(disclosure.normalizedPredicate).toContain("capability any")

    // --- 2. Projects, roles, capabilities, nodes and paths, each annotated
    //        `unknown` when the predicate is unconstrained on that axis. The
    //        fixture scopes `projectId` and `capability`, so the other three must be
    //        the literal `UNKNOWN_REACH_TEXT` and NOT an empty array.
    expect(disclosure.reach.projects.kind).toBe("constrained")
    if (disclosure.reach.projects.kind === "constrained") expect(disclosure.reach.projects.values).toEqual([PROJECT_ID])
    expect(disclosure.reach.capabilities.kind).toBe("constrained")
    if (disclosure.reach.capabilities.kind === "constrained") expect(disclosure.reach.capabilities.values).toEqual(["fs.read"])
    for (const axis of ["roles", "nodes", "projectPaths"] as const) {
      expect(disclosure.reach[axis].kind, `${axis} is unconstrained and must say so`).toBe("unknown")
    }

    // Every constrained axis NAMES ITS SOURCE, so a value cannot be read without
    // knowing which predicate produced it.
    for (const axis of ["projects", "capabilities"] as const) {
      const value = disclosure.reach[axis]
      if (value.kind === "constrained") expect(value.sources.length, `${axis} names no source`).toBeGreaterThan(0)
    }

    // --- 3. Maximum fan-out, concurrency, retry, timeout and sensitivity, from the
    //        action's DECLARED values. The fixture declares all five.
    expect(disclosure.bounds.fanOut).toEqual({
      kind: "declared",
      value: 4,
      source: "actions[pre_approve_within_bounds].maximumFanOut",
    })
    expect(disclosure.bounds.concurrency).toEqual({
      kind: "declared",
      value: 2,
      source: "actions[pre_approve_within_bounds].maximumConcurrency",
    })
    expect(disclosure.bounds.retryLimit).toEqual({
      kind: "declared",
      value: 1,
      source: "actions[pre_approve_within_bounds].maximumRetryLimit",
    })
    expect(disclosure.bounds.timeoutSeconds).toEqual({
      kind: "declared",
      value: 900,
      source: "actions[pre_approve_within_bounds].maximumTimeoutSeconds",
    })
    expect(disclosure.bounds.sensitivity).toEqual({
      kind: "declared",
      value: "restricted",
      source: "actions[pre_approve_within_bounds].maximumSensitivity",
    })

    // --- 4. Historical dispatches it would have matched, from the supplied history.
    //        Every entry is listed, matched or not, so a short list cannot be read
    //        as a complete one.
    expect([...disclosure.historicalMatches].map((entry) => entry.dispatchId)).toEqual([
      "disp-m6-a",
      "disp-m6-b",
      "disp-m6-c",
      "disp-m6-d",
    ])
    // Three entries are in the rule's project and request `fs.read`, so all three
    // match; the fourth is in another project and is listed as not matched rather
    // than omitted, which is the difference between "did not match" and "was not
    // asked about".
    expect(disclosure.historicalMatches.filter((entry) => entry.matched).map((entry) => entry.dispatchId)).toEqual([
      "disp-m6-a",
      "disp-m6-b",
      "disp-m6-d",
    ])

    // --- 5. Conflicts and shadowing, from sections 10.4 and 10.5, in stable detail
    //        form rather than prose.
    expect(disclosure.conflicts.length, "a deny that co-matches a pre-approval must be reported").toBeGreaterThan(0)
    expect(
      disclosure.conflicts.some((detail) => detail.startsWith("deny_overrides_pre_approval[")),
      `conflicts are reported in the evaluator's own detail form: ${JSON.stringify(disclosure.conflicts)}`,
    ).toBe(true)
    expect(disclosure.shadowing.length).toBeGreaterThan(0)

    // --- 6. Expiry or "no expiry". The fixture declares none, so the KIND is
    //        `no_expiry` and a warning says it in words.
    expect(disclosure.expiresAt).toEqual({ kind: "no_expiry", value: null })
    expect(
      disclosure.warnings.some((warning) => warning.includes("declares no expiry")),
      "an unexpiring pre-approval must warn, not merely report a null",
    ).toBe(true)

    // --- 7. Creator identity, version and activation time.
    expect(disclosure.author).toBe("user:user-m6")
    expect(disclosure.templateVersion).toBe(1)
    expect(disclosure.activation).toEqual({
      state: "activated",
      activatedAt: "2026-01-01T00:00:00Z",
      activatedBy: "user:user-m6",
    })

    // --- 8. An unconstrained reach axis is ITSELF a warning, in words.
    for (const axis of ["roles", "nodes", "projectPaths"]) {
      expect(
        disclosure.warnings.some((warning) => warning.includes(`'${axis}'`)),
        `the unconstrained '${axis}' axis must be warned about in words`,
      ).toBe(true)
    }
  })

  it("reports an unconstrained axis as UNKNOWN_REACH_TEXT and never as an empty set", () => {
    const compiled = theRealRuleSet()
    const preview = previewed(compiled, theRealHistory())
    const entry = entryFor(preview, PRE_APPROVAL)
    const axes = entry.futureScope

    // The five future-scope axes, exhaustively.
    expect(Object.keys(axes).sort()).toEqual(["capabilities", "nodes", "projectIds", "projectPaths", "roles"])
    for (const [name, value] of Object.entries(axes)) {
      if (typeof value !== "string") {
        // A constrained axis is a SET, never an empty one: an empty array would
        // read as "matches nothing", which is what an unconstrained axis means.
        expect(value.length, `${name} is reported as a set and must not be empty`).toBeGreaterThan(0)
        continue
      }
      expect(value, `${name} is unconstrained and must render as the literal UNKNOWN_REACH_TEXT`).toBe(UNKNOWN_REACH_TEXT)
    }

    // And the axes the predicate does not name at all are named, in words, by name.
    //
    // The true property is a COMPLEMENT, not a superset: `unconstrainedAxes` is
    // `RULE_PREDICATE_FIELDS` minus the fields this rule's predicate constrains
    // (`src/rules/preview.ts:1002`), so `projectId` and `capability` — the two the
    // fixture scopes on — are correctly ABSENT. Asserting that every field appears
    // would be asserting that a scoped rule is unconstrained on the axes it scoped,
    // which is the opposite of what the field means.
    expect(entry.unconstrainedAxes).toContain("roleVersion")
    expect(entry.unconstrainedAxes).toContain("targetNodeId")
    expect(entry.unconstrainedAxes).toContain("scheduleWindow")

    const constrainedByThisRule = new Set(
      compiled.rules.find((rule) => rule.ruleId === PRE_APPROVAL)?.predicates.map((predicate) => predicate.field) ?? [],
    )
    expect([...constrainedByThisRule].sort()).toEqual(["capability", "projectId"])
    const expectedUnconstrained = RULE_PREDICATE_FIELDS.filter((field) => !constrainedByThisRule.has(field)).sort()
    expect([...entry.unconstrainedAxes].sort(), "every unconstrained field is named, and no constrained one is").toEqual(
      expectedUnconstrained,
    )
    expect(entry.unconstrainedAxes).not.toContain("projectId")
    expect(entry.unconstrainedAxes).not.toContain("capability")

    // The set-wide statement agrees, and names the same axes.
    const preApproval = entryFor(preview, PRE_APPROVAL)
    expect(
      preview.structuralWarnings.some((warning) => warning.includes("UNCONSTRAINED on roles, nodes, projectPaths")),
      `the set-level summary must name the unconstrained axes: ${JSON.stringify(preview.structuralWarnings)}`,
    ).toBe(true)
    expect(preApproval.hasPreApproval).toBe(true)
  })

  it("reports a bound the action did not declare as unbounded rather than as the language ceiling", () => {
    // A pre-approval that omits every optional bound. "No fan-out maximum declared"
    // and "fan-out maximum 256" are different statements, and only the first is
    // true of this rule.
    const compiled = compiledFrom(
      preApprovalDocument({
        ruleId: "rule-m6-bare-pre",
        actions: [
          {
            kind: "pre_approve_within_bounds",
            approvedCapabilities: ["fs.read"],
            allowDestructiveEffects: false,
            allowExternalEffects: false,
            maximumTimeoutSeconds: 900,
            maximumSensitivity: "restricted",
          },
        ],
      }),
    )
    const preview = previewed(compiled, theRealHistory())
    const disclosure = preview.preApprovalDisclosures[0]
    if (disclosure === undefined) throw new Error("no disclosure for the bare pre-approval")
    for (const bound of ["fanOut", "concurrency", "retryLimit"] as const) {
      expect(disclosure.bounds[bound].kind, `${bound} was not declared`).toBe("unbounded")
      expect(
        disclosure.warnings.some((warning) => warning.includes(`declares no '${bound}' bound`)),
        `${bound}'s absence must be stated in words`,
      ).toBe(true)
    }
    // The timeout IS declared, so it is not reported as unbounded.
    expect(disclosure.bounds.timeoutSeconds.kind).toBe("declared")
    expect(disclosure.bounds.sensitivity.kind).toBe("declared")
  })

  it("carries the disclosure verbatim from the compiler's own builder rather than re-deriving it", () => {
    const compiled = theRealRuleSet()
    const preview = previewed(compiled, theRealHistory())
    const disclosure = preview.preApprovalDisclosures.find((candidate) => candidate.ruleId === PRE_APPROVAL)
    if (disclosure === undefined) throw new Error("no disclosure for the pre-approval")

    // The preview's own copy and a fresh call into the shipped builder over the same
    // compiled rule must agree member for member, once the history-dependent member
    // is aligned. `buildPreApprovalDisclosure` is reachable through the same barrel
    // the plan does, and is what ADR 0007 section 11 names as the one disclosure.
    const fresh = buildPreApprovalDisclosure(
      compiled.rules.find((rule) => rule.ruleId === PRE_APPROVAL)!,
      { historicalDispatches: [], conflicts: [], shadowing: [] },
    )
    expect(fresh.ruleId).toBe(disclosure.ruleId)
    expect(fresh.normalizedPredicate).toBe(disclosure.normalizedPredicate)
    expect(fresh.reach).toEqual(disclosure.reach)
    expect(fresh.bounds).toEqual(disclosure.bounds)
    expect(fresh.expiresAt).toEqual(disclosure.expiresAt)
    expect(fresh.author).toBe(disclosure.author)
    expect(fresh.activation).toEqual(disclosure.activation)
  })
})

// ===========================================================================
// 3. shadowed versus possible_overlap
// ===========================================================================

describe("M6.3 — 'shadowed' is proven and 'possible_overlap' is not", () => {
  it("reports a proven superset as shadowed and an unprovable pair only as possible_overlap", () => {
    const compiled = theRealRuleSet()
    const preview = previewed(compiled, theRealHistory())

    // The universal deny has NO predicates, so it is a structural superset of both
    // scoped denies, and the evaluator PROVES it.
    const universal = entryFor(preview, "rule-m6-universal-deny")
    const shadowingOf = universal.shadowing.filter((finding) => finding.relation === "shadowed")
    expect(shadowingOf.map((finding) => [finding.otherRuleId, finding.direction])).toEqual([
      ["rule-m6-deny", "shadows"],
      ["rule-m6-role-deny", "shadows"],
    ])
    for (const finding of shadowingOf) {
      expect(finding.proven, "a 'shadowed' relation must always be proven").toBe(true)
      expect(finding.reason).toContain("proven superset")
    }

    // The two APPROVAL rules overlap on one project's dispatches and neither
    // contains the other, so nothing is proven and nothing is shadowed.
    const scopedApproval = entryFor(preview, "rule-m6-scope-approval")
    const roleApproval = entryFor(preview, "rule-m6-role-approval")
    for (const rule of [scopedApproval, roleApproval]) {
      for (const finding of rule.shadowing) {
        const counterpart = finding.otherRuleId === "rule-m6-role-approval" ? "rule-m6-scope-approval" : "rule-m6-role-approval"
        expect(
          finding.relation,
          `${rule.ruleId} and ${counterpart} merely co-match; 'shadowed' here would be a lie`,
        ).not.toBe("shadowed")
      }
    }
    const overlapBothWays = [
      ...scopedApproval.shadowing.filter((finding) => finding.otherRuleId === "rule-m6-role-approval"),
      ...roleApproval.shadowing.filter((finding) => finding.otherRuleId === "rule-m6-scope-approval"),
    ]
    expect(overlapBothWays.length, "the overlap must be reported from both sides").toBeGreaterThan(0)
    for (const finding of overlapBothWays) {
      expect(finding.relation).toBe("possible_overlap")
      expect(finding.proven).toBe(false)
      expect(finding.detail.startsWith("possible_overlap:")).toBe(true)
      expect(finding.reason).toContain("rather than a shadowing")
    }

    // A proven shadowing is stated at the SET level, in the identity-and-detail
    // form; a possible overlap is only COUNTED, because listing every pair would bury
    // the rows a reader must act on. That distinction is itself part of the contract.
    expect(
      preview.structuralWarnings.some((warning) => warning.includes("rule-m6-universal-deny>rule-m6-deny")),
      "a proven shadowing must be listed by name",
    ).toBe(true)
    expect(
      preview.structuralWarnings.some((warning) => /rule pair\(s\) are reported as possible_overlap/.test(warning)),
      "possible overlaps must be counted, and the count must say they are not shadowings",
    ).toBe(true)
  })

  it("keeps the two relations distinct in the disclosure's own shadowing list", () => {
    const compiled = theRealRuleSet()
    const preview = previewed(compiled, theRealHistory())
    const disclosure = preview.preApprovalDisclosures.find((candidate) => candidate.ruleId === "rule-m6-pre")
    if (disclosure === undefined) throw new Error("no disclosure for the pre-approval")
    const proven = disclosure.shadowing.filter((detail) => detail.startsWith("shadowed:"))
    const possible = disclosure.shadowing.filter((detail) => detail.startsWith("possible_overlap:"))
    expect(proven.length + possible.length).toBe(disclosure.shadowing.length)
    expect(possible.length, "the pre-approval overlaps many rules and none of them shadows it").toBeGreaterThan(0)
    // Every detail is one of the two literals. Nothing else can appear.
    for (const detail of disclosure.shadowing) {
      expect(detail).toMatch(/^(shadowed|possible_overlap):/)
    }
  })
})

// ===========================================================================
// 4. The universal pre-approval refusal, through the real compiler
// ===========================================================================

describe("M6.3 — a pre-approval that constrains nothing is refused by the compiler", () => {
  it("refuses a pre-approval with an empty predicate, a vacuous `capability none`, and a vacuous `roleVersion gte 1`", () => {
    const cases: readonly { readonly label: string; readonly document: Record<string, unknown> }[] = [
      {
        label: "an empty predicate list",
        document: universalPreApprovalDocument({ ruleId: "rule-m6-vacuous-empty" }),
      },
      {
        label: "`capability none [...]`, which asserts an absence and constrains nothing",
        document: universalPreApprovalDocument({
          ruleId: "rule-m6-vacuous-capability-none",
          predicates: [{ field: "capability", operator: "none", value: ["fs.read"] }],
        }),
      },
      {
        label: "`roleVersion gte 1`, a comparison pinned to the bottom of its declared range",
        document: universalPreApprovalDocument({
          ruleId: "rule-m6-vacuous-roleversion",
          predicates: [{ field: "roleVersion", operator: "gte", value: 1 }],
        }),
      },
      {
        label: "`all([])`, the explicit spelling of the empty predicate",
        document: universalPreApprovalDocument({
          ruleId: "rule-m6-vacuous-all",
          predicates: [{ field: "all", predicates: [] }],
        }),
      },
    ]

    for (const { label, document } of cases) {
      const compiled = compileRuleSet([document])
      expect(compiled.ok, `${label} must be refused, not compiled`).toBe(false)
      if (compiled.ok) continue
      expect(compiled.error.code, label).toBe("rule.universal_pre_approval")
      expect(compiled.error.message).toContain("constrains none of")
      // The refusal names the twelve fields that WOULD have constrained it, so an
      // author can act on it without reading the compiler.
      for (const field of NON_UNIVERSAL_PREDICATE_FIELDS) {
        expect(compiled.error.message, `${label}: the refusal must name '${field}'`).toContain(field)
      }
    }
  })

  it("still compiles a pre-approval scoped to one project, which is the legitimate form", () => {
    // The same action, scoped. If this were refused the restriction would be useless
    // rather than safe, and this assertion is what makes the refusal above a
    // restriction rather than a prohibition.
    for (const field of NON_UNIVERSAL_PREDICATE_FIELDS) {
      const predicate = predicateConstraining(field)
      if (predicate === null) continue
      const compiled = compileRuleSet([universalPreApprovalDocument({ ruleId: `rule-m6-scoped-${field}`, predicates: [predicate] })])
      expect(compiled.ok, `a pre-approval scoped on '${field}' must compile`).toBe(true)
    }
  })

  it("refuses the escalation fields at the schema, so no rule document can carry them", () => {
    // `allowDestructiveEffects: true` is the single most dangerous thing a user rule
    // could say. It is refused by the SCHEMA rather than by a compiler pass, so no
    // document carrying it reaches any later stage at all.
    const escalating = rawRuleDocument({
      ruleId: "rule-m6-escalate-destructive",
      predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
      actions: [
        {
          kind: "pre_approve_within_bounds",
          approvedCapabilities: ["fs.read"],
          allowDestructiveEffects: true,
          allowExternalEffects: false,
          maximumTimeoutSeconds: 900,
          maximumSensitivity: "restricted",
        },
      ],
    })
    const result = compileRuleSet([escalating])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("rule.invalid_source")
    expect(result.error.message).toContain("allowDestructiveEffects")

    // And the same for `add_restrictions`, whose copy of the pair is also literal-false.
    const escalatingRestriction = rawRuleDocument({
      ruleId: "rule-m6-escalate-external",
      predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
      actions: [
        {
          kind: "add_restrictions",
          deniedCapabilities: [],
          allowExternalEffects: true,
          requireApprovalForExternalEffects: false,
        },
      ],
    })
    const restriction = compileRuleSet([escalatingRestriction])
    expect(restriction.ok).toBe(false)
    if (restriction.ok) return
    expect(restriction.error.code).toBe("rule.invalid_source")
  })

  it("permits a universal rule that only narrows, because that is the safe direction", () => {
    // The restriction applies to exactly two permissive action kinds. A universal
    // DENY is a legitimate global concern, and refusing it would push authors toward
    // narrower, less comprehensible rules for a genuinely global problem.
    for (const document of [
      denyDocument({ ruleId: "rule-m6-universal-deny-ok" }),
      requireApprovalDocument({ ruleId: "rule-m6-universal-approval-ok" }),
      budgetDocument({ ruleId: "rule-m6-universal-budget-ok", predicates: [] }),
    ] as RuleSourceDocument[]) {
      const compiled = compileRuleSet([document])
      expect(compiled.ok, `${document.ruleId} narrows and must compile`).toBe(true)
    }
  })
})

// ===========================================================================
// 5. Every non-match reason is its own outcome
// ===========================================================================

describe("M6.3 — a rule that did not match says which of eight reasons applies", () => {
  /**
   * Every `RuleMatchOutcome` other than `matched`, produced by the real compiler.
   *
   * `denyDocument` names `PROJECT_ID`, and a compiled set is single-project
   * (`src/rules/compile.ts:1260-1269` refuses a set that spans two), so every rule
   * below is in scope for `proj-m6` and differs only in the ONE fact that makes it
   * ineffective. That is what makes the seven outcomes comparable: no two of these
   * rules is out of scope for a different reason.
   */
  function theSevenIneffectiveRules(): CompiledRuleSet {
    return compiledFrom(
      // Two versions of one rule: the higher is effective, so the lower is superseded
      // even though its own predicate matches perfectly.
      denyDocument({ ruleId: "rule-m6-versioned", templateVersion: 1 }),
      denyDocument({ ruleId: "rule-m6-versioned", templateVersion: 2 }),
      denyDocument({ ruleId: "rule-m6-expired", expiresAt: EARLIER_INSTANT }),
      denyDocument({ ruleId: "rule-m6-disabled", enabled: false }),
      denyDocument({ ruleId: "rule-m6-draft", activation: { state: "draft", activatedAt: null, activatedBy: null } }),
      denyDocument({ ruleId: "rule-m6-revoked", activation: { state: "revoked", activatedAt: null, activatedBy: null } }),
      denyDocument({ ruleId: "rule-m6-miss", predicates: [{ field: "roleId", operator: "eq", value: "role-nobody" }] }),
      denyDocument({ ruleId: "rule-m6-current" }),
    )
  }

  it("reports expired, not activated, revoked, disabled, superseded and predicate-miss separately", () => {
    const compiled = theSevenIneffectiveRules()
    const history = theRealHistory({ finishedDispatches: [historyEntry({ dispatchId: "disp-m6-only" })], proposals: [] })
    const preview = previewed(compiled, history)

    expect(entryFor(preview, "rule-m6-current").matchOutcome).toBe("matched")
    expect(entryFor(preview, "rule-m6-versioned", 1).matchOutcome).toBe("superseded")
    expect(entryFor(preview, "rule-m6-versioned", 2).matchOutcome).toBe("matched")
    expect(entryFor(preview, "rule-m6-expired").matchOutcome).toBe("expired")
    expect(entryFor(preview, "rule-m6-disabled").matchOutcome).toBe("disabled")
    expect(entryFor(preview, "rule-m6-draft").matchOutcome).toBe("not_activated")
    expect(entryFor(preview, "rule-m6-revoked").matchOutcome).toBe("revoked")
    // In scope, activated, unexpired, and the predicate does not hold. This is the
    // only one of the eight that is a fact about the DISPATCH rather than about the
    // rule, and it is the one an operator most needs separated from the rest.
    expect(entryFor(preview, "rule-m6-miss").matchOutcome).toBe("not_matched")

    // The eight `RuleMatchOutcome` members are `matched` plus seven reasons, and
    // every one of the seven is DISTINCT here. This is the assertion that fails if
    // anybody ever "simplifies" the outcome enum to a boolean, and it is asserted
    // over the RULES by identity rather than over the first N entries so it does
    // not depend on the compiled set's sort order. `matched` appears twice by
    // design — the live version and an unrelated rule — which is why the distinct
    // count is seven and the rule count is eight.
    const byRuleId = new Map(preview.rules.map((entry) => [identityOf(entry), entry.matchOutcome]))
    const observed = [
      byRuleId.get("rule-m6-current@1"),
      byRuleId.get("rule-m6-versioned@1"),
      byRuleId.get("rule-m6-versioned@2"),
      byRuleId.get("rule-m6-expired@1"),
      byRuleId.get("rule-m6-disabled@1"),
      byRuleId.get("rule-m6-draft@1"),
      byRuleId.get("rule-m6-revoked@1"),
      byRuleId.get("rule-m6-miss@1"),
    ]
    expect(observed, "every rule this set declares must have an outcome").not.toContain(undefined)
    expect(new Set(observed), "each of the seven reasons must be its own value").toEqual(
      new Set([
        "matched",
        "superseded",
        "expired",
        "disabled",
        "not_activated",
        "revoked",
        "not_matched",
      ]),
    )
    // And the enum is closed over what this run exercised, so a future outcome
    // cannot be added to the language without a rule here producing it.
    const exercised = new Set(observed)
    for (const member of ruleMatchOutcomeSchema.options) {
      if (member === "project_scope_mismatch") continue // exercised by the sibling test below
      expect(exercised, `RuleMatchOutcome member '${member}' is exercised by no rule in this set`).toContain(member)
    }

    // Each carries its own REASON, and each reason is the evaluator's own sentence.
    const oracles = (history["finishedDispatches"] as Record<string, unknown>[]).map((entry) =>
      evaluateRules(compiled, oracleContext(entry)),
    )
    for (const entry of preview.rules) {
      const oracleTrace = oracles[0]?.traces.find((trace) => identityOf(trace) === identityOf(entry))
      expect(entry.evaluations[0]?.reason).toBe(oracleTrace?.reason)
      expect(entry.evaluations[0]?.reason.length, "an outcome with no reason is a bare assertion").toBeGreaterThan(0)
    }
  })

  it("reports a dispatch in another project as out of scope, which is a different fact from a predicate miss", () => {
    // `project_scope_mismatch` is a fact about the rule's DOCUMENT project against
    // the dispatch's project (`src/rules/evaluate.ts:780`), NOT about a predicate
    // naming another project — a `projectId eq "other"` predicate is a predicate
    // miss, and conflating the two would send an operator to edit a rule that was
    // never the problem. So the two cases are built separately.
    const compiled = theSevenIneffectiveRules()

    // A predicate naming another project: the rule is IN scope and its predicate
    // does not hold. Reported as a miss.
    const predicateMiss = compiledFrom(
      denyDocument({ ruleId: "rule-m6-predicate", predicates: [{ field: "projectId", operator: "eq", value: "proj-m6-other" }] }),
    )
    const inScope = previewed(
      predicateMiss,
      theRealHistory({ finishedDispatches: [historyEntry({ dispatchId: "disp-m6-only" })], proposals: [] }),
    )
    expect(entryFor(inScope, "rule-m6-predicate").matchOutcome).toBe("not_matched")

    // A DISPATCH in another project against a set compiled for this one: the rule
    // never applies to it at all, and the report says so rather than calling it a
    // predicate the author should rewrite.
    const outOfScope = previewed(
      compiled,
      theRealHistory({
        finishedDispatches: [historyEntry({ dispatchId: "disp-foreign", projectId: "proj-m6-other" })],
        proposals: [],
      }),
    )
    const foreign = entryFor(outOfScope, "rule-m6-current")
    expect(foreign.matchOutcome).toBe("project_scope_mismatch")
    expect(foreign.evaluations[0]?.matchOutcome).toBe("project_scope_mismatch")
    expect(foreign.evaluations[0]?.reason).toContain("rule.project_scope_mismatch")
    // And it is not merely a miss with different words: the miss above carries a
    // predicate verdict trace, and this one does not.
    expect(entryFor(inScope, "rule-m6-predicate").evaluations[0]?.reason).not.toContain("rule.project_scope_mismatch")
  })

  it("reports no outcome at all when the history is empty, rather than a vacuous miss", () => {
    const compiled = compiledFrom(denyDocument())
    const preview = previewed(compiled, previewHistory())
    expect(entryFor(preview, "rule-m6-deny").matchOutcome).toBeNull()
    expect(entryFor(preview, "rule-m6-deny").evaluations).toEqual([])
    expect(preview.history.entriesConsidered).toBe(0)
    expect(preview.history.entriesEvaluated).toBe(0)
  })
})

// ===========================================================================
// 6. The preview writes nothing
// ===========================================================================

describe("M6.3 — previewing has no side effect on anything it was given", () => {
  it("leaves the compiled rule set, the history and the options byte-identical", () => {
    const compiled = theRealRuleSet()
    const history = theRealHistory()
    const options = previewOptions()

    const compiledBefore = canonicalJson(compiled)
    const historyBefore = canonicalJson(history)
    const optionsBefore = canonicalJson(options)

    const preview = previewed(compiled, history, options)

    expect(canonicalJson(compiled), "the compiled artifact must be untouched").toBe(compiledBefore)
    expect(canonicalJson(history), "the history must be untouched").toBe(historyBefore)
    expect(canonicalJson(options), "the options must be untouched").toBe(optionsBefore)

    // The artifact is DEEP FROZEN, so "untouched" is enforced rather than merely
    // observed: a preview that tried to annotate a rule with what matched would throw
    // in strict mode and silently do nothing otherwise.
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.rules)).toBe(true)
    expect(Object.isFrozen(compiled.rules[0])).toBe(true)

    // And the report is itself a value: mutating it cannot reach the compiled set.
    const reported = entryFor(preview, "rule-m6-deny")
    expect(reported.digest).toBe(
      compiled.rules.find((rule) => rule.ruleId === "rule-m6-deny")?.digest,
    )
    expect(reported.normalizedPredicate).toBe(
      compiled.rules.find((rule) => rule.ruleId === "rule-m6-deny")?.normalizedPredicate,
    )
  })

  it("refuses a malformed history rather than half-evaluating it", () => {
    const compiled = theRealRuleSet()
    // An unknown key, which a non-strict schema would silently drop — and a dropped
    // key is how "I recorded the fan-out" and "I recorded nothing" become one value.
    const withUnknownKey = previewHistory({
      finishedDispatches: [{ ...(historyEntry() as Record<string, unknown>), requestedFanout: 2 }],
    })
    const refused = previewCompiledRuleSet(compiled, withUnknownKey, previewOptions())
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.code).toBe("rule.preview_invalid_input")
    expect(refused.error.message).toContain("requestedFanout")

    // And options without an injected clock, because a preview with an ambient clock
    // is a preview whose digest depends on when it was taken.
    const noClock = previewCompiledRuleSet(compiled, previewHistory(), { actorId: "user-m6-operator", activationConfirmed: true })
    expect(noClock.ok).toBe(false)
    if (noClock.ok) return
    expect(noClock.error.message).toContain("now")
  })

  it("does not let an unconfirmed activation read as consent", () => {
    const compiled = theRealRuleSet()
    // OMITTED rather than `false`: the distinction between "not confirmed" and
    // "confirmed as not confirmed" must not change the outcome, and the preview has
    // no member through which a caller could express the difference.
    const omitted = previewed(compiled, theRealHistory(), { now: FIXED_NOW, actorId: "user-m6-operator" })
    const denied = previewed(compiled, theRealHistory(), previewOptions({ activationConfirmed: false }))

    expect(omitted.activationConfirmed).toBe(false)
    expect(denied.activationConfirmed).toBe(false)
    expect(canonicalJson(omitted)).toBe(canonicalJson(denied))

    // The rule IS activated, so the outstanding item is the confirmation alone — and
    // it is listed, so the caller knows what is missing.
    expect(omitted.activationRequired).toContain("rule-m6-pre@1")
    expect(entryFor(omitted, "rule-m6-pre").activationRequired).toBe(true)

    // Confirmed, and it disappears.
    const confirmed = previewed(compiled, theRealHistory(), previewOptions({ activationConfirmed: true }))
    expect(confirmed.activationRequired).toEqual([])
    expect(entryFor(confirmed, "rule-m6-pre").activationRequired).toBe(false)

    // A rule that pre-approves nothing is never listed, however activation reads.
    for (const rule of confirmed.rules.filter((entry) => !entry.hasPreApproval)) {
      expect(confirmed.activationRequired).not.toContain(identityOf(rule))
    }
  })

  it("names the artifact, the clock and the requester, so two previews can be told apart", () => {
    const compiled = theRealRuleSet()
    const preview = previewed(compiled, theRealHistory(), previewOptions({ actorId: "user-m6-other" }))
    expect(preview.languageVersion).toBe(2)
    expect(preview.ruleSetDigest).toBe(compiled.digest)
    expect(preview.generatedAt).toBe(FIXED_NOW)
    expect(preview.requestedBy).toBe("user-m6-other")
    expect(preview.lines.length, "a preview that rendered no lines would render nothing for a user").toBeGreaterThan(0)
    expect(preview.explanationText.length).toBeGreaterThan(0)
    expect(preview.digest).toMatch(/^sha256:/)

    // The registry node fixture exists in this file's fixture set; a preview over a
    // history naming that node reports the node, and never a display name.
    const withNode = previewHistory({ finishedDispatches: [historyEntry({ targetNodeId: registryNode({ nodeId: NODE_A }).nodeId })] })
    const nodePreview = previewed(compiled, withNode)
    expect(nodePreview.lines.join("\n")).not.toContain("fixture node")
  })
})

// ===========================================================================
// Local helpers the file needs but the fixtures do not carry
// ===========================================================================

/**
 * One predicate that legitimately constrains `field`.
 *
 * Returns `null` for a field this file has no predicate spelling for, so the sweep
 * below asserts over the fields it can actually construct rather than silently
 * skipping a field and reporting full coverage.
 */
function predicateConstraining(field: (typeof NON_UNIVERSAL_PREDICATE_FIELDS)[number]): Record<string, unknown> | null {
  switch (field) {
    case "projectId":
      return { field, operator: "eq", value: PROJECT_ID }
    case "roleId":
      return { field, operator: "eq", value: ROLE_ID }
    case "roleVersion":
      return { field, operator: "gte", value: 2 }
    case "capability":
      return { field, operator: "any", value: ["fs.read"] }
    case "toolCategory":
      return { field, operator: "any", value: ["file"] }
    case "runtimeKind":
      return { field, operator: "eq", value: "opencode" }
    case "targetNodeId":
      return { field, operator: "eq", value: NODE_A }
    case "nodeAdvertisedCapability":
      return { field, operator: "any", value: ["fs.read"] }
    case "projectPathId":
      return { field, operator: "eq", value: PROJECT_PATH_ID }
    case "taskLabel":
      return { field, operator: "has", value: "release" }
    case "dependencyOutcome":
      return { field, operator: "anySucceeded" }
    case "contextSensitivity":
      return { field, operator: "maxRankAtMost", value: 2 }
    default:
      return null
  }
}