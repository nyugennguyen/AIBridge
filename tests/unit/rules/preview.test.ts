/**
 * M6.3 — the rule preview.
 *
 * ============================== THE TEST THAT MATTERS ==============================
 *
 * "the preview reports exactly what evaluateRules reports" is the first test in
 * this file and it is the one the milestone exists to have. ADR 0007 stop
 * condition 1 says implementation halts if preview and production evaluation are
 * found able to diverge, "including by a change to one of them that does not
 * touch the other". The only way that property is more than a promise is a test
 * that calls `evaluateRules` DIRECTLY and compares, so that is what the first
 * test does: it builds the context from the history entry itself, calls the
 * runtime entry point, and asserts the preview's per-rule, per-entry
 * `matchOutcome` and matched-dispatch set are the values the evaluator produced.
 *
 * The context is built in this file rather than shared with the module on
 * purpose. A helper both sides used would make the comparison a tautology; a
 * helper written HERE that spreads the entry and fills the four fields the
 * history does not carry is an INDEPENDENT construction, so a field the preview
 * forgot to copy would show up here as a schema failure rather than agreeing
 * with itself.
 *
 * The remaining claims, each in its own place:
 *
 *   - FUTURE SCOPE. A rule that matched nothing still has to say what it would
 *     match, and an unconstrained axis must render as `unknown` rather than as
 *     an empty set — an empty set reads as "matches nothing", which is the
 *     opposite of the truth and looks like data while saying it.
 *   - THE DISCLOSURE. Every item ADR 0007 section 11 requires is asserted by
 *     EXACT PRESENCE, not by `toContain` on a paragraph. A requirement a test
 *     cannot name is a requirement nobody implemented.
 *   - THE ACTIVATION GATE. ADR 0007 section 18: a pre-approval that is merely
 *     `enabled` does not pre-approve. Both halves of that are tested — the
 *     activation state and the operator's confirmation.
 *   - `shadowed` VERSUS `possible_overlap`. Section 10.5 is explicit that
 *     conflating them trains the user to ignore the field. The tests construct a
 *     pair that PROVABLY shadows and a pair that merely overlaps, and assert
 *     that the second is not reported as the first.
 *   - NO SECRETS, NO MUTATION, DETERMINISM. ADR 0007 section 12's canary
 *     discipline, a `structuredClone` comparison against the inputs, and 50
 *     byte-identical invocations including a shuffled history.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { evaluateRules, renderRuleExplanation, type CompiledRuleSet, type RuleEvaluationContext } from "../../../src/rules/index.js"
import { digestJson } from "../../../src/orchestration/digest.js"
import {
  MAX_PREVIEW_HISTORY_ENTRIES,
  RULE_PREVIEW_CODES,
  RULE_PREVIEW_OUTCOME_PRECEDENCE,
  auditRulePreviewForSecrets,
  previewCompiledRuleSet,
  type ProposalHistoryEntry,
  type RulePreview,
  type RulePreviewEntry,
} from "../../../src/rules/preview.js"
import {
  HISTORY_INSTANT,
  PREVIEW_NOW,
  capabilityOnlyPreApprovalDocument,
  conflictingPreApprovalDocument,
  previewHistory,
  previewOptions,
  projectDenyDocument,
  proposalEntry,
  rawHistoryEntry,
  roleApprovalDocument,
  roleDenyDocument,
  scopeApprovalDocument,
  scopedPreApprovalDocument,
  setOf,
  twoProjectPreApprovalDocument,
  universalDenyDocument,
} from "./preview.fixtures.js"

const PREVIEW_SOURCE = join(import.meta.dirname, "../../../src/rules/preview.ts")

/**
 * A canary, seeded into every history field that could plausibly carry content.
 *
 * "It does not leak" is not a claim a comment can make falsifiable. A canary is:
 * seed it, run the preview, and assert it appears nowhere. The same shape as
 * `explain.test.ts` uses for the renderer, and for the same reason — the
 * preview is a second reader of the same data, so the absence has to be
 * re-established for it rather than inherited.
 */
const CANARY = "CANARY-CONTENT-MUST-NOT-APPEAR"

function canaryEntry(overrides: Partial<Record<string, unknown>> = {}): ProposalHistoryEntry {
  return proposalEntry({
    taskLabels: [CANARY],
    requestedCapabilities: [CANARY],
    ...overrides,
  })
}

/**
 * Builds a preview, throwing on refusal.
 *
 * A test about the preview's CONTENT should not have to unwrap a `Result` at
 * every call site; the refusals have their own describe block, which asserts the
 * `Result` directly.
 */
function previewOf(compiled: CompiledRuleSet, history: unknown, options: unknown): RulePreview {
  const result = previewCompiledRuleSet(compiled, history, options)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

/**
 * The evaluation context for one history entry, built HERE.
 *
 * An omit-and-fill construction rather than the module's field-by-field copy, so
 * it is a genuinely different construction rather than a shared helper — a
 * helper both sides used would make the divergence comparison a tautology. The
 * omitted keys are the four the history records for ITS OWN sake
 * (`dispatchId`, `runId`, `taskId`, `state`) and the four the ADR's per-entry
 * shape does not carry, filled at their fail-closed values: a title is content
 * (ADR 0007 section 12), the two category/snapshot fields are not in the shape,
 * and a replay has no budget in force.
 */
function historyContext(entry: ProposalHistoryEntry): RuleEvaluationContext {
  const {
    dispatchId: _dispatchId,
    runId: _runId,
    taskId: _taskId,
    state: _state,
    ...carried
  } = entry
  return {
    ...carried,
    toolCategories: [],
    nodeAdvertisedCapabilities: null,
    taskTitle: null,
    currentBudget: null,
  }
}

/** The identity a rule and a trace share. */
function identityOf(rule: { ruleId: string; templateVersion: number }): string {
  return `${rule.ruleId}@${rule.templateVersion}`
}

/**
 * Strips block and line comments, so a source scan reads CODE.
 *
 * The module's docblock names `Date.now`, `new RegExp` and
 * `evaluateCompiledRule` in order to say it does not use them, so a scan over the
 * raw text would fail on the documentation of the property. Crude on purpose —
 * but asserted below, because a stripper that silently did nothing would make
 * every "the code does not contain X" assertion pass for the wrong reason.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n"']*\/\/.*$/gm, "")
}

function entryFor(preview: RulePreview, ruleId: string, templateVersion = 1): RulePreviewEntry {
  const found = preview.rules.find((entry) => entry.ruleId === ruleId && entry.templateVersion === templateVersion)
  if (found === undefined) throw new Error(`no preview entry for ${ruleId}@${templateVersion}`)
  return found
}

// ===========================================================================
// 1. The divergence guard
// ===========================================================================

describe("the preview reports exactly what the runtime evaluator reports", () => {
  it("agrees with a direct evaluateRules call on every rule, for every history entry", () => {
    const compiled = setOf([
      scopedPreApprovalDocument(),
      capabilityOnlyPreApprovalDocument(),
      universalDenyDocument(),
      roleDenyDocument(),
      scopeApprovalDocument(),
    ])
    const history = previewHistory({
      finishedDispatches: [
        canaryEntry({ dispatchId: "disp-2" }),
        proposalEntry({ dispatchId: "disp-1", projectId: "proj-2" }),
        proposalEntry({ dispatchId: "disp-3", roleId: null, evaluatedAt: "2026-02-03T12:00:00Z" }),
      ],
    })
    const preview = previewOf(compiled, history, previewOptions())

    // The oracle, computed without the preview anywhere in sight.
    const oracle = history.finishedDispatches.map((entry) => ({
      dispatchId: entry.dispatchId,
      result: evaluateRules(compiled, historyContext(entry)),
    }))

    expect(preview.rules.length).toBe(compiled.rules.length)
    for (const rule of compiled.rules) {
      const reported = entryFor(preview, rule.ruleId, rule.templateVersion)
      const matched: string[] = []
      for (const { dispatchId, result } of oracle) {
        const trace = result.traces.find((candidate) => identityOf(candidate) === identityOf(rule))
        expect(trace, `${identityOf(rule)} has no trace`).toBeDefined()
        const reportedEvaluation = reported.evaluations.find((evaluation) => evaluation.dispatchId === dispatchId)
        expect(reportedEvaluation, `${identityOf(rule)} has no evaluation for ${dispatchId}`).toBeDefined()
        expect(
          reportedEvaluation?.matchOutcome,
          `${identityOf(rule)} against ${dispatchId} must report the evaluator's outcome`,
        ).toBe(trace?.matchOutcome)
        expect(reportedEvaluation?.reason).toBe(trace?.reason)
        if (trace?.matchOutcome === "matched") matched.push(dispatchId)
      }
      // And the aggregated set, which is the only thing a preview is really for.
      expect([...reported.matchedHistory].sort(), `${identityOf(rule)} matched history`).toEqual(matched.sort())
      expect(reported.matchedHistoryCount).toBe(matched.length)
    }
  })

  it("reports a rule's match outcome as the evaluator stated it, not as a boolean", () => {
    // A disabled rule, a draft rule and a predicate miss are three different
    // facts. A preview that collapsed them into "did not match" could not answer
    // "why did my rule not fire", which is the question a user opens a preview
    // with.
    const compiled = setOf([
      projectDenyDocument({ ruleId: "rule-enabled" }),
      projectDenyDocument({ ruleId: "rule-disabled", enabled: false }),
      projectDenyDocument({
        ruleId: "rule-draft",
        activation: { state: "draft" as const, activatedAt: null, activatedBy: null },
      }),
      projectDenyDocument({ ruleId: "rule-miss", predicates: [{ field: "roleId", operator: "eq" as const, value: "role-nobody" }] }),
    ])
    const preview = previewOf(compiled, previewHistory({ finishedDispatches: [proposalEntry()] }), previewOptions())

    expect(entryFor(preview, "rule-enabled").matchOutcome).toBe("matched")
    expect(entryFor(preview, "rule-disabled").matchOutcome).toBe("disabled")
    expect(entryFor(preview, "rule-draft").matchOutcome).toBe("not_activated")
    expect(entryFor(preview, "rule-miss").matchOutcome).toBe("not_matched")
  })

  it("reports no match outcome at all when there is no history to judge against", () => {
    // `null` rather than `not_matched`: "no dispatch was asked about" and "every
    // dispatch was asked and none matched" are different facts, and a preview
    // that said the second when it meant the first would be lying about the one
    // thing a user is checking.
    const compiled = setOf([projectDenyDocument()])
    const preview = previewOf(compiled, previewHistory(), previewOptions())
    expect(entryFor(preview, "rule-project-deny").matchOutcome).toBeNull()
    expect(entryFor(preview, "rule-project-deny").evaluations).toEqual([])
    expect(preview.history).toEqual({
      entriesConsidered: 0,
      entriesEvaluated: 0,
      truncated: false,
      droppedEntryCount: 0,
      limit: MAX_PREVIEW_HISTORY_ENTRIES,
    })
  })

  it("publishes the order in which non-matching outcomes are summarised", () => {
    // The aggregate reports ONE outcome for a rule that matched nothing, so the
    // choice has to be inspectable rather than implied. A draft outranks a
    // predicate miss because a draft is the state a user can act on.
    expect(RULE_PREVIEW_OUTCOME_PRECEDENCE).toContain("not_activated")
    expect(RULE_PREVIEW_OUTCOME_PRECEDENCE.indexOf("not_activated")).toBeLessThan(RULE_PREVIEW_OUTCOME_PRECEDENCE.indexOf("not_matched"))
    expect(RULE_PREVIEW_OUTCOME_PRECEDENCE).not.toContain("matched")
    expect(new Set(RULE_PREVIEW_OUTCOME_PRECEDENCE).size).toBe(RULE_PREVIEW_OUTCOME_PRECEDENCE.length)
  })

  it("imports the one evaluator and the one disclosure, and names no second matcher", () => {
    // The structural half of the divergence guard. A reviewer reading the module
    // cannot tell whether `summarizeAxes` is a matcher, so the claim is asserted
    // against the source: the preview must call `evaluateRules`, must reuse
    // `buildPreApprovalDisclosure` and `renderRuleExplanation`, and must not
    // reach for the evaluator's single-rule entry point or the bounded pattern
    // matcher, either of which would be a second way to decide a match.
    const source = readFileSync(PREVIEW_SOURCE, "utf8")
    expect(source).toMatch(/evaluateRules\b/)
    expect(source).toMatch(/buildPreApprovalDisclosure/)
    expect(source).toMatch(/renderRuleExplanation/)

    const imports = [...source.matchAll(/import\s[^;]*?from\s+"[^"]+"/g)].map((match) => match[0]).join("\n")
    expect(imports).toContain('from "./evaluate.js"')
    expect(imports).toContain('from "./explain.js"')
    expect(imports).not.toMatch(/\bevaluateCompiledRule\b/)
    expect(imports).not.toMatch(/\bmatchesBounded\b/)
    expect(imports).not.toMatch(/\bcompileSafePattern\b/)

    const code = stripComments(source)
    expect(code).not.toMatch(/new\s+RegExp/)
    expect(code).not.toMatch(/\bDate\.now\s*\(/)
    expect(code).not.toMatch(/\bMath\.random\s*\(/)
    expect(code).not.toMatch(/\.localeCompare\s*\(/)
  })
})

// ===========================================================================
// 2. Future scope
// ===========================================================================

describe("a rule that matched nothing still says what it would match", () => {
  it("reports the declared project set for a rule that names two projects, and unknown for a rule that names none", () => {
    // `unknown` is the load-bearing half. An empty set would read as "matches
    // nothing"; the truth is "matches everything", and the plan restricts exactly
    // that shape for a pre-approval.
    const compiled = setOf([twoProjectPreApprovalDocument(), capabilityOnlyPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory(), previewOptions())

    const named = entryFor(preview, "rule-pre-two-projects")
    expect(named.futureScope.projectIds).toEqual(["proj-1", "proj-2"])
    expect(named.futureScope.capabilities).toEqual(["fs.read"])
    expect(named.futureScope.roles).toBe("unknown")
    expect(named.futureScope.nodes).toBe("unknown")
    expect(named.futureScope.projectPaths).toBe("unknown")

    const unnamed = entryFor(preview, "rule-pre-capability-only")
    expect(unnamed.futureScope.projectIds).toBe("unknown")
    expect(unnamed.futureScope.capabilities).toEqual(["fs.read"])

    // Distinguishable as VALUES, not only in the rendered text: one is an array
    // and one is a string, so a caller cannot confuse them.
    expect(Array.isArray(named.futureScope.projectIds)).toBe(true)
    expect(Array.isArray(unnamed.futureScope.projectIds)).toBe(false)
  })

  it("names the unconstrained reach axes of a pre-approval in words, not as blanks", () => {
    const compiled = setOf([capabilityOnlyPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory(), previewOptions())
    const entry = entryFor(preview, "rule-pre-capability-only")

    const reachWarnings = entry.warnings.filter((warning) => warning.includes("UNCONSTRAINED on"))
    expect(reachWarnings).toHaveLength(4)
    for (const axis of ["projects", "roles", "nodes", "projectPaths"]) {
      expect(reachWarnings.some((warning) => warning.includes(`UNCONSTRAINED on ${axis};`))).toBe(true)
    }
    expect(reachWarnings.some((warning) => warning.includes("UNCONSTRAINED on capabilities;"))).toBe(false)
    expect(
      preview.structuralWarnings.some(
        (warning) => warning.includes("rule-pre-capability-only@1") && warning.includes("UNCONSTRAINED on projects, roles, nodes, projectPaths"),
      ),
    ).toBe(true)
  })

  it("reports the same reach as the disclosure it embeds, so the two cannot disagree", () => {
    // The preview reads the axes off the predicate AST and the disclosure reads
    // them off the same AST inside `explain.ts`. Two readings of one document are
    // two implementations, so this pins them against each other: a divergence
    // here would mean the disclosure a user approves against says something
    // different from the preview they read.
    const compiled = setOf([scopedPreApprovalDocument(), capabilityOnlyPreApprovalDocument(), twoProjectPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory({ finishedDispatches: [proposalEntry()] }), previewOptions())

    expect(preview.preApprovalDisclosures).toHaveLength(3)
    for (const disclosure of preview.preApprovalDisclosures) {
      const entry = entryFor(preview, disclosure.ruleId, disclosure.templateVersion)
      const axis = (reach: { kind: string; values?: readonly string[] }): unknown =>
        reach.kind === "unknown" ? "unknown" : [...(reach.values ?? [])].sort()
      expect(entry.futureScope.projectIds, `${disclosure.ruleId} projects`).toEqual(axis(disclosure.reach.projects))
      expect(entry.futureScope.roles, `${disclosure.ruleId} roles`).toEqual(axis(disclosure.reach.roles))
      expect(entry.futureScope.capabilities, `${disclosure.ruleId} capabilities`).toEqual(axis(disclosure.reach.capabilities))
      expect(entry.futureScope.nodes, `${disclosure.ruleId} nodes`).toEqual(axis(disclosure.reach.nodes))
      expect(entry.futureScope.projectPaths, `${disclosure.ruleId} projectPaths`).toEqual(axis(disclosure.reach.projectPaths))
    }
  })

  it("reports every axis a rule leaves unconstrained, at the rule and across the set", () => {
    const compiled = setOf([twoProjectPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory(), previewOptions())

    const perRule = entryFor(preview, "rule-pre-two-projects").unconstrainedAxes
    expect(perRule).not.toContain("projectId")
    expect(perRule).not.toContain("capability")
    expect(perRule).toContain("roleId")
    expect(perRule).toContain("targetNodeId")
    expect(perRule).toContain("projectPathId")
    // Sorted by code unit, never by locale: the ADR's own ordering rationale.
    expect([...perRule].sort()).toEqual(perRule)
    // And the same field is unconstrained across the whole set, because no rule
    // in it names a role.
    expect(preview.unconstrainedAxes).toEqual(perRule)
  })

  it("treats an axis constrained only by negation or by asserting an absence as unconstrained", () => {
    // `capability none ["fs.write"]` is a claim about what the request must NOT
    // contain, not a bound on what it may contain. Reporting the wrapped member
    // as the axis's reach would understate the rule in the direction that hides a
    // grant, so the axis is `unknown` and the fact is a named warning.
    const compiled = setOf([
      projectDenyDocument({
        ruleId: "rule-none-capability",
        predicates: [
          { field: "capability", operator: "none", value: ["fs.write"] },
          { field: "roleId", operator: "eq", value: "role-1" },
        ],
      }),
    ])
    const preview = previewOf(compiled, previewHistory(), previewOptions())
    const entry = entryFor(preview, "rule-none-capability")
    expect(entry.futureScope.capabilities).toBe("unknown")
    expect(entry.warnings.some((warning) => warning.includes("constrains 'capability' only by NEGATION"))).toBe(true)
  })
})

// ===========================================================================
// 3. The pre-approval warning
// ===========================================================================

describe("every pre-approval names every item ADR 0007 section 11 requires", () => {
  it("carries the normalized predicate, the reach sets, every declared bound, the history, the conflicts, the author, the version and the activation facts", () => {
    const compiled = setOf([scopedPreApprovalDocument(), projectDenyDocument({ ruleId: "rule-deny" })])
    const history = previewHistory({ finishedDispatches: [proposalEntry({ dispatchId: "disp-1" }), proposalEntry({ dispatchId: "disp-2" })] })
    const preview = previewOf(compiled, history, previewOptions())

    const entry = entryFor(preview, "rule-pre-scoped")
    const warning = entry.preApprovalWarning
    expect(warning).not.toBeNull()

    // The exact predicate and normalized form, read back off the compiled rule so
    // the assertion is against the artifact rather than against a literal here.
    const rule = compiled.rules.find((candidate) => candidate.ruleId === "rule-pre-scoped")
    expect(warning).toContain(`normalizedPredicate=${rule?.normalizedPredicate}`)

    // Projects, roles, capabilities, nodes and paths, each a sorted set or the
    // literal `unknown`. Parsed out of the clause rather than matched as prose,
    // so the assertion is about the values and not about this module's format.
    const reachClause = (warning ?? "").split("; ").find((part) => part.startsWith("reach="))
    expect(reachClause).toBeDefined()
    const reach = new Map(
      (reachClause ?? "")
        .slice("reach=".length)
        .split(", ")
        .map((pair) => pair.split("=") as [string, string]),
    )
    expect(reach.get("projects")).toBe("[proj-1]")
    expect(reach.get("capabilities")).toBe("[fs.read]")
    expect(reach.get("roles")).toBe("unknown")
    expect(reach.get("nodes")).toBe("unknown")
    expect(reach.get("projectPaths")).toBe("unknown")

    // Maximum fan-out, concurrency, retry, timeout and sensitivity, from the
    // action's DECLARED values.
    expect(warning).toContain("maximumFanOut=4")
    expect(warning).toContain("maximumConcurrency=2")
    expect(warning).toContain("maximumRetryLimit=1")
    expect(warning).toContain("maximumTimeoutSeconds=900")
    expect(warning).toContain("maximumSensitivity=restricted")
    expect(warning).toContain("approvedCapabilities=[fs.read]")

    // Historical dispatches it would have matched.
    expect(warning).toContain("history=matched 2 of 2 supplied history entries: disp-1,disp-2")

    // Conflicts and shadowing, named.
    expect(warning).toContain("conflicts=[deny_overrides_pre_approval[")
    expect(warning).toContain("shadowing=[")

    // Expiry, or the literal words.
    expect(warning).toContain("expiry=no expiry")

    // Creator identity, version, activation time and activator.
    expect(warning).toContain("author=user:user-1")
    expect(warning).toContain("version=1")
    expect(warning).toContain("activationState=activated")
    expect(warning).toContain("activationTime=2026-01-01T00:00:00Z")
    expect(warning).toContain("activatedBy=user:user-1")
    expect(warning).toContain("active=yes")
  })

  it("says 'no expiry' when the rule has no date, and the date when it has one", () => {
    const compiled = setOf([
      scopedPreApprovalDocument({ ruleId: "rule-permanent" }),
      scopedPreApprovalDocument({ ruleId: "rule-dated", expiresAt: "2026-12-31T00:00:00Z" }),
    ])
    const preview = previewOf(compiled, previewHistory(), previewOptions())

    expect(entryFor(preview, "rule-permanent").preApprovalWarning).toContain("expiry=no expiry")
    expect(entryFor(preview, "rule-dated").preApprovalWarning).toContain("expiry=2026-12-31T00:00:00Z")
    expect(entryFor(preview, "rule-permanent").preApprovalWarning).not.toContain("expiry=null")
  })

  it("reports a bound the action did not declare as unbounded rather than as the language ceiling", () => {
    // "No fan-out maximum declared" and "fan-out maximum 256" are different
    // statements and only the first is true. The ceiling would read as a promise
    // the rule never made.
    const compiled = setOf([capabilityOnlyPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory(), previewOptions())
    expect(preview.preApprovalDisclosures[0]?.bounds.fanOut).toEqual({
      kind: "unbounded",
      source: "actions[pre_approve_within_bounds].maximumFanOut",
    })
    // And the maximum it DOES declare is still reported as declared.
    expect(preview.preApprovalDisclosures[0]?.bounds.timeoutSeconds).toEqual({
      kind: "declared",
      value: 900,
      source: "actions[pre_approve_within_bounds].maximumTimeoutSeconds",
    })
  })

  it("gives a pre-approval that could never fire yet its disclosure, marked as not active", () => {
    // Withholding the disclosure until activation would mean the screen a user
    // must read BEFORE activating does not exist yet, which is the one screen
    // whose absence is a safety problem.
    const compiled = setOf([capabilityOnlyPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory(), previewOptions({ activationConfirmed: false }))

    expect(preview.preApprovalDisclosures).toHaveLength(1)
    expect(preview.preApprovalDisclosures[0]?.normalizedPredicate).toContain("capability any")
    expect(entryFor(preview, "rule-pre-capability-only").preApprovalWarning).toContain("active=no")
  })

  it("emits no pre-approval warning for a rule that pre-approves nothing", () => {
    const compiled = setOf([projectDenyDocument()])
    const preview = previewOf(compiled, previewHistory(), previewOptions())
    expect(entryFor(preview, "rule-project-deny").preApprovalWarning).toBeNull()
    expect(entryFor(preview, "rule-project-deny").hasPreApproval).toBe(false)
    expect(preview.preApprovalDisclosures).toEqual([])
  })
})

// ===========================================================================
// 4. The activation gate
// ===========================================================================

describe("a pre-approval cannot fire before it is activated and confirmed", () => {
  it("lists a draft pre-approval in activationRequired and marks its warning inactive", () => {
    const compiled = setOf([
      capabilityOnlyPreApprovalDocument({
        ruleId: "rule-draft-pre",
        activation: { state: "draft" as const, activatedAt: null, activatedBy: null },
      }),
    ])
    const preview = previewOf(compiled, previewHistory(), previewOptions())

    expect(preview.activationRequired).toEqual(["rule-draft-pre@1"])
    const entry = entryFor(preview, "rule-draft-pre")
    expect(entry.activationRequired).toBe(true)
    expect(entry.preApprovalWarning).toContain("activationState=draft")
    expect(entry.preApprovalWarning).toContain("active=no")
    expect(entry.warnings.some((warning) => warning.includes("CANNOT pre-approve"))).toBe(true)
    // The disclosure still exists, and it still says the rule is a draft.
    expect(preview.preApprovalDisclosures).toHaveLength(1)
    expect(preview.preApprovalDisclosures[0]?.activation.state).toBe("draft")
  })

  it("lists an activated pre-approval when the operator's confirmation is absent", () => {
    // ADR 0007 section 18: activation requires an explicit confirmation that
    // DISPLAYS the disclosure. The flag is the record that it was displayed, so
    // its absence is reported rather than assumed away.
    const compiled = setOf([capabilityOnlyPreApprovalDocument()])
    const confirmed = previewOf(compiled, previewHistory(), previewOptions({ activationConfirmed: true }))
    const unconfirmed = previewOf(compiled, previewHistory(), previewOptions({ activationConfirmed: false }))

    expect(confirmed.activationRequired).toEqual([])
    expect(entryFor(confirmed, "rule-pre-capability-only").preApprovalWarning).toContain("active=yes")

    expect(unconfirmed.activationRequired).toEqual(["rule-pre-capability-only@1"])
    expect(entryFor(unconfirmed, "rule-pre-capability-only").preApprovalWarning).toContain("active=no")
    expect(
      entryFor(unconfirmed, "rule-pre-capability-only").warnings.some((warning) => warning.includes("activationConfirmed flag is false")),
    ).toBe(true)
  })

  it("treats an omitted activationConfirmed as unconfirmed rather than as consent", () => {
    const compiled = setOf([capabilityOnlyPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory(), previewOptions({ activationConfirmed: undefined }))
    expect(preview.activationConfirmed).toBe(false)
    expect(preview.activationRequired).toEqual(["rule-pre-capability-only@1"])
  })

  it("never lists a rule that pre-approves nothing, however its activation reads", () => {
    const compiled = setOf([
      projectDenyDocument({ ruleId: "rule-deny-draft", activation: { state: "draft" as const, activatedAt: null, activatedBy: null } }),
    ])
    const preview = previewOf(compiled, previewHistory({ finishedDispatches: [proposalEntry()] }), previewOptions())
    expect(preview.activationRequired).toEqual([])
    expect(entryFor(preview, "rule-deny-draft").activationRequired).toBe(false)
  })
})

// ===========================================================================
// 5. Historical matches
// ===========================================================================

describe("the historical match set is what the evaluator matched, sorted and de-duplicated", () => {
  it("matches the evaluator's answer and reports the ids once each in code-unit order", () => {
    const compiled = setOf([projectDenyDocument()])
    const history = previewHistory({
      // Deliberately out of order, with `disp-2` appearing in BOTH halves.
      finishedDispatches: [proposalEntry({ dispatchId: "disp-9", projectId: "proj-2" }), proposalEntry({ dispatchId: "disp-2" })],
      proposals: [proposalEntry({ dispatchId: "disp-1" }), proposalEntry({ dispatchId: "disp-2", state: "proposed" })],
    })
    const preview = previewOf(compiled, history, previewOptions())

    const oracle = evaluateRules(compiled, historyContext(proposalEntry({ dispatchId: "disp-1" })))
    expect(oracle.traces[0]?.matchOutcome).toBe("matched")

    const entry = entryFor(preview, "rule-project-deny")
    expect(entry.matchedHistory).toEqual(["disp-1", "disp-2"])
    expect(entry.matchedHistoryCount).toBe(2)
    expect(new Set(entry.matchedHistory).size).toBe(entry.matchedHistory.length)
    // Sorted by code unit, so `disp-9` (a project-scope miss) is absent rather
    // than merely last, and `disp-2` is not repeated for appearing twice.
    expect(entry.matchedHistory).toEqual([...entry.matchedHistory].sort())
    expect(entry.evaluations.map((evaluation) => evaluation.dispatchId)).toEqual(["disp-1", "disp-2", "disp-9"])
  })

  it("keeps the later observation when one dispatch appears in both history halves", () => {
    // A dispatch that was proposed and then finished is one dispatch, and the
    // later statement is the current one. The preview must not evaluate it twice
    // or count it twice.
    const compiled = setOf([projectDenyDocument()])
    const history = previewHistory({
      proposals: [proposalEntry({ dispatchId: "disp-1", state: "proposed", evaluatedAt: HISTORY_INSTANT })],
      finishedDispatches: [proposalEntry({ dispatchId: "disp-1", state: "completed", evaluatedAt: "2026-02-05T00:00:00Z" })],
    })
    const preview = previewOf(compiled, history, previewOptions())
    const entry = entryFor(preview, "rule-project-deny")

    expect(entry.evaluations).toHaveLength(1)
    expect(entry.evaluations[0]?.state).toBe("completed")
    expect(entry.evaluations[0]?.evaluatedAt).toBe("2026-02-05T00:00:00Z")
    expect(preview.history.entriesConsidered).toBe(1)
  })
})

// ===========================================================================
// 6. Conflicts and shadowing
// ===========================================================================

describe("a proven shadowing and a possible overlap are reported as different things", () => {
  it("reports a provable superset as shadowed and an unprovable pair only as possible_overlap", () => {
    // Four rules, two pairs. `rule-universal-deny` has the universal predicate
    // `all([])`, which is TOP, and a deny, so it PROVABLY covers `rule-role-deny`.
    // `rule-scope-approval` and `rule-role-approval` constrain different fields,
    // so neither is a proven superset of the other and neither is provably
    // disjoint: the only honest answer is that they might both fire.
    const compiled = setOf([
      universalDenyDocument(),
      roleDenyDocument(),
      scopeApprovalDocument(),
      roleApprovalDocument(),
    ])
    const preview = previewOf(compiled, previewHistory({ finishedDispatches: [proposalEntry()] }), previewOptions())

    // The evaluator reports BOTH directions of a pair, and each direction gets
    // its own relation: `all([])` is provably a superset of `roleId == "role-1"`,
    // while the converse is not provable. The preview carries each through
    // unchanged rather than merging them into one verdict about the pair.
    const shadowed = entryFor(preview, "rule-role-deny").shadowing.find(
      (finding) => finding.otherRuleId === "rule-universal-deny" && finding.relation === "shadowed",
    )
    expect(shadowed?.proven).toBe(true)
    expect(shadowed?.direction).toBe("shadowed_by")

    const shadower = entryFor(preview, "rule-universal-deny").shadowing.find(
      (finding) => finding.otherRuleId === "rule-role-deny" && finding.relation === "shadowed",
    )
    expect(shadower?.direction).toBe("shadows")

    const overlap = entryFor(preview, "rule-scope-approval").shadowing.find((finding) => finding.otherRuleId === "rule-role-approval")
    expect(overlap?.relation).toBe("possible_overlap")
    expect(overlap?.proven).toBe(false)

    // The load-bearing negative: the overlap pair is NEVER reported as shadowed,
    // in either direction, anywhere in the preview. A field that says "shadowed"
    // when it means "might" is the field a user learns to skip.
    const shadowedMentions = preview.rules.flatMap((entry) => entry.shadowing.filter((finding) => finding.relation === "shadowed"))
    for (const finding of shadowedMentions) {
      expect(finding.detail).not.toContain("rule-scope-approval")
      expect(finding.detail).not.toContain("rule-role-approval")
    }
    const provenRelations = preview.rules.flatMap((entry) => entry.shadowing).filter((finding) => finding.proven)
    expect(provenRelations.every((finding) => finding.relation === "shadowed")).toBe(true)
  })

  it("says in words that a possible overlap is not shadowing", () => {
    const compiled = setOf([scopeApprovalDocument(), roleApprovalDocument()])
    const preview = previewOf(compiled, previewHistory({ finishedDispatches: [proposalEntry()] }), previewOptions())
    const warnings = entryFor(preview, "rule-scope-approval").warnings
    expect(warnings.some((warning) => warning.includes("possible_overlap") && warning.includes("is NOT shadowing"))).toBe(true)
  })

  it("reports a conflict only on the rules the conflict names", () => {
    // A `deny_overrides_pre_approval` between two OTHER rules says nothing about
    // a third, and listing it there would fill the field with rows the reader has
    // to re-read to learn they are irrelevant.
    const compiled = setOf([projectDenyDocument(), conflictingPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory({ finishedDispatches: [proposalEntry()] }), previewOptions())

    expect(entryFor(preview, "rule-project-deny").conflicts.map((conflict) => conflict.kind)).toContain("deny_overrides_pre_approval")
    expect(entryFor(preview, "rule-pre-conflict").conflicts.map((conflict) => conflict.kind)).toContain("deny_overrides_pre_approval")

    const unrelated = setOf([projectDenyDocument()])
    const alone = previewOf(unrelated, previewHistory({ finishedDispatches: [proposalEntry()] }), previewOptions())
    expect(entryFor(alone, "rule-project-deny").conflicts).toEqual([])
  })

  it("de-duplicates a conflict reported identically by more than one history entry", () => {
    // A conflict found for five dispatches happened once as a fact about the rule
    // set, and reporting it five times would leave a reader wondering whether it
    // happened five times.
    const compiled = setOf([projectDenyDocument(), conflictingPreApprovalDocument()])
    const history = previewHistory({
      finishedDispatches: [
        proposalEntry({ dispatchId: "disp-1" }),
        proposalEntry({ dispatchId: "disp-2", evaluatedAt: "2026-02-03T12:00:00Z" }),
        proposalEntry({ dispatchId: "disp-3", evaluatedAt: "2026-02-04T12:00:00Z" }),
      ],
    })
    const preview = previewOf(compiled, history, previewOptions())
    const details = entryFor(preview, "rule-project-deny").conflicts.map((conflict) => conflict.detail)
    expect(new Set(details).size).toBe(details.length)
    expect(details).toEqual([...details].sort())
  })
})

// ===========================================================================
// 7. No secrets
// ===========================================================================

describe("the preview carries no dispatch content", () => {
  it("finds no canary anywhere in the preview, its rendered text, or the explanations it embeds", () => {
    const compiled = setOf([scopedPreApprovalDocument(), universalDenyDocument()])
    const history = previewHistory({
      finishedDispatches: [canaryEntry({ dispatchId: "disp-1" }), canaryEntry({ dispatchId: "disp-2", evaluatedAt: "2026-02-03T12:00:00Z" })],
    })
    const preview = previewOf(compiled, history, previewOptions())

    const rendered = [preview.explanationText, ...preview.rules.map((entry) => entry.matchedDispatchExplanation ?? "")]
    expect(
      auditRulePreviewForSecrets({ preview, renderedText: rendered, seededCanaries: [CANARY] }),
    ).toEqual([])
    expect(preview.explanationText).not.toContain(CANARY)
  })

  it("finds a canary that IS present, so the audit is not a vacuous pass", () => {
    // The other half of a canary test. An audit that never fires proves nothing,
    // and the failure mode is a green test file, so the audit is shown firing on
    // a value that really does carry the canary.
    const compiled = setOf([scopedPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory({ finishedDispatches: [canaryEntry()] }), previewOptions())

    const smuggled = { ...preview, leakedField: CANARY }
    expect(auditRulePreviewForSecrets({ preview: smuggled, seededCanaries: [CANARY] }).length).toBeGreaterThan(0)
    expect(
      auditRulePreviewForSecrets({ preview, renderedText: [`a line containing ${CANARY}`], seededCanaries: [CANARY] }).length,
    ).toBeGreaterThan(0)
    // And the encodings matter: a percent-encoded canary is still a canary.
    expect(
      auditRulePreviewForSecrets({ preview: { field: encodeURIComponent(CANARY) }, seededCanaries: [CANARY] }).length,
    ).toBeGreaterThan(0)
  })

  it("reuses the renderer's own output rather than rendering the evaluation a second time", () => {
    // The explanation the preview carries must be the renderer's, byte for byte.
    // A preview that grew its own renderer would be a second implementation of
    // the same prose, and the two would drift.
    const compiled = setOf([scopedPreApprovalDocument()])
    const history = previewHistory({ finishedDispatches: [proposalEntry()] })
    const preview = previewOf(compiled, history, previewOptions())
    const expected = evaluateRules(compiled, historyContext(proposalEntry()))
    // `preview.rules[0].matchedDispatchExplanation` is the renderer's text for the
    // matched dispatch; comparing it to the renderer's own output on the same
    // result is the assertion.
    expect(entryFor(preview, "rule-pre-scoped").matchedDispatchExplanation).toBe(renderRuleExplanation(expected))
  })

  it("has no parameter through which a task title could arrive", () => {
    // The structural argument, asserted as the history schema's key list: the
    // preview's per-entry shape has no `taskTitle`, so there is no value in scope
    // that could be one. A rule that matches on a title pattern therefore reports
    // `not_matched` against every history entry, and says so, rather than
    // guessing at a title it was never given.
    const compiled = setOf([
      projectDenyDocument({
        ruleId: "rule-title",
        predicates: [{ field: "taskTitlePattern", pattern: "deploy.*" }],
      }),
    ])
    const preview = previewOf(compiled, previewHistory({ finishedDispatches: [proposalEntry()] }), previewOptions())
    const entry = entryFor(preview, "rule-title")
    expect(entry.evaluations[0]?.matchOutcome).toBe("not_matched")
    expect(Object.keys(rawHistoryEntry())).not.toContain("taskTitle")
  })
})

// ===========================================================================
// 8. Determinism
// ===========================================================================

describe("the same inputs produce the same preview, byte for byte", () => {
  it("produces one identical preview and digest across 50 invocations", () => {
    const compiled = setOf([scopedPreApprovalDocument(), universalDenyDocument(), roleDenyDocument(), scopeApprovalDocument()])
    const history = previewHistory({
      finishedDispatches: [proposalEntry({ dispatchId: "disp-2" }), proposalEntry({ dispatchId: "disp-1" })],
      proposals: [proposalEntry({ dispatchId: "disp-3", evaluatedAt: "2026-02-04T12:00:00Z" })],
    })
    const options = previewOptions()

    const digests = new Set<string>()
    const texts = new Set<string>()
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const preview = previewOf(compiled, history, options)
      digests.add(preview.digest)
      texts.add(preview.explanationText)
    }
    expect(digests.size).toBe(1)
    expect(texts.size).toBe(1)
  })

  it("produces an identical preview from a shuffled history, in either half", () => {
    // The preview sorts and de-duplicates before it evaluates, so the order the
    // caller happened to build the arrays in cannot reach the output. A preview
    // whose digest moved when the caller's array order moved would be an
    // artifact that could not be compared between two operators looking at the
    // same rule set.
    const compiled = setOf([scopedPreApprovalDocument(), universalDenyDocument()])
    const entries = [
      proposalEntry({ dispatchId: "disp-1" }),
      proposalEntry({ dispatchId: "disp-2", evaluatedAt: "2026-02-03T12:00:00Z" }),
      proposalEntry({ dispatchId: "disp-3", evaluatedAt: "2026-02-04T12:00:00Z" }),
      proposalEntry({ dispatchId: "disp-4", projectId: "proj-2", evaluatedAt: "2026-02-05T12:00:00Z" }),
    ]
    const options = previewOptions()
    const straight = previewOf(compiled, previewHistory({ finishedDispatches: entries }), options)
    const shuffled = previewOf(
      compiled,
      previewHistory({ finishedDispatches: [entries[3]!, entries[0]!, entries[2]!, entries[1]!], proposals: entries.slice().reverse() }),
      options,
    )

    expect(shuffled.digest).toBe(straight.digest)
    expect(shuffled.explanationText).toBe(straight.explanationText)
  })

  it("binds the injected clock into the digest, so two instants are two artifacts", () => {
    const compiled = setOf([scopedPreApprovalDocument()])
    const history = previewHistory({ finishedDispatches: [proposalEntry()] })
    const early = previewOf(compiled, history, previewOptions({ now: "2026-03-01T00:00:00Z" }))
    const late = previewOf(compiled, history, previewOptions({ now: "2026-03-02T00:00:00Z" }))

    expect(early.generatedAt).toBe("2026-03-01T00:00:00Z")
    expect(late.generatedAt).toBe("2026-03-02T00:00:00Z")
    expect(early.digest).not.toBe(late.digest)
  })

  it("digests the structure and neither its own digest nor its rendered text", () => {
    // The digest has to cover the structure and NOT `lines` / `explanationText`,
    // for the reason `RuleEvaluationResult` documents: both are functions of the
    // rest, so including them would make the digest cover a derivation of itself
    // and a renderer change would move the digest of an unchanged rule set.
    const compiled = setOf([scopedPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory({ finishedDispatches: [proposalEntry()] }), previewOptions())

    const { digest, lines, explanationText, ...structure } = preview
    void lines
    void explanationText
    expect(digestJson(structure)).toBe(digest)
    // And a different rendered form of the same structure keeps the same digest.
    expect(digestJson({ ...structure, lines: ["a completely different rendering"], explanationText: "one line" })).not.toBe(digest)
    expect(preview.explanationText).toBe(preview.lines.join("\n"))
  })
})

// ===========================================================================
// 9. No writes
// ===========================================================================

describe("the preview mutates nothing it was given", () => {
  it("leaves the compiled rule set, the history and the options exactly as they arrived", () => {
    const compiled = setOf([scopedPreApprovalDocument(), universalDenyDocument(), roleDenyDocument()])
    const history = previewHistory({ finishedDispatches: [proposalEntry(), proposalEntry({ dispatchId: "disp-2" })] })
    const options = previewOptions()

    const compiledBefore = structuredClone(compiled)
    const historyBefore = structuredClone(history)
    const optionsBefore = structuredClone(options)

    previewOf(compiled, history, options)

    expect(compiled).toEqual(compiledBefore)
    expect(history).toEqual(historyBefore)
    expect(options).toEqual(optionsBefore)
    // And the artifact stayed frozen, which is what makes "there is nowhere to
    // put preview state" a property rather than a hope.
    expect(Object.isFrozen(compiled.rules)).toBe(true)
    expect(Object.isFrozen(compiled.rules[0])).toBe(true)
  })

  it("does not annotate the compiled rules with what matched", () => {
    // ADR 0007 section 3: `CompiledRuleSet.rules` is deep-frozen precisely so a
    // preview has nowhere to record "what matched". If a key appeared on a rule
    // after a preview, the runtime evaluation of the same set would be reading
    // state the preview wrote.
    const compiled = setOf([projectDenyDocument()])
    const keysBefore = Object.keys(compiled.rules[0] ?? {}).sort()
    previewOf(compiled, previewHistory({ finishedDispatches: [proposalEntry()] }), previewOptions())
    expect(Object.keys(compiled.rules[0] ?? {}).sort()).toEqual(keysBefore)
  })
})

// ===========================================================================
// 10. Bounded history
// ===========================================================================

describe("an oversized history is truncated explicitly, never silently", () => {
  it("keeps the most recent entries, names the bound, and says how many were dropped", () => {
    // TRUNCATION, not refusal: refusing would remove the disclosure from exactly
    // the busy user a pre-approval is for. What is not allowed is a shortened
    // list that reads as a complete one, so the count is in the structure, in
    // `structuralWarnings`, and in the rendered text.
    const entries = Array.from({ length: MAX_PREVIEW_HISTORY_ENTRIES + 5 }, (_unused, index) =>
      proposalEntry({
        dispatchId: `disp-${String(index).padStart(4, "0")}`,
        evaluatedAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T12:00:00Z`,
      }),
    )
    const compiled = setOf([projectDenyDocument()])
    const preview = previewOf(compiled, previewHistory({ finishedDispatches: entries }), previewOptions())

    expect(preview.history).toEqual({
      entriesConsidered: MAX_PREVIEW_HISTORY_ENTRIES + 5,
      entriesEvaluated: MAX_PREVIEW_HISTORY_ENTRIES,
      truncated: true,
      droppedEntryCount: 5,
      limit: MAX_PREVIEW_HISTORY_ENTRIES,
    })
    expect(entryFor(preview, "rule-project-deny").evaluations).toHaveLength(MAX_PREVIEW_HISTORY_ENTRIES)
    expect(
      preview.structuralWarnings.some(
        (warning) => warning.includes(`${MAX_PREVIEW_HISTORY_ENTRIES + 5} entries`) && warning.includes("5 were dropped"),
      ),
    ).toBe(true)
    expect(preview.explanationText).toContain("5 dropped by the limit of 256")
  })

  it("reports no truncation at exactly the bound", () => {
    // A limit that fires on its own boundary is a different limit from the one
    // documented, and the off-by-one would silently drop the oldest dispatch a
    // user still recognises.
    const entries = Array.from({ length: MAX_PREVIEW_HISTORY_ENTRIES }, (_unused, index) =>
      proposalEntry({ dispatchId: `disp-${String(index).padStart(4, "0")}`, evaluatedAt: `2026-01-01T12:00:00Z` }),
    )
    const preview = previewOf(setOf([projectDenyDocument()]), previewHistory({ finishedDispatches: entries }), previewOptions())
    expect(preview.history.truncated).toBe(false)
    expect(preview.history.droppedEntryCount).toBe(0)
    expect(preview.history.entriesEvaluated).toBe(MAX_PREVIEW_HISTORY_ENTRIES)
  })
})

// ===========================================================================
// 11. Refusals
// ===========================================================================

describe("a malformed history or options object is refused with a named code", () => {
  it("refuses a history entry that does not satisfy its own schema", () => {
    const compiled = setOf([projectDenyDocument()])
    const result = previewCompiledRuleSet(compiled, { proposals: [{ dispatchId: "disp-1" }], finishedDispatches: [] }, previewOptions())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("rule.preview_invalid_input")
    expect(RULE_PREVIEW_CODES).toContain("rule.preview_invalid_input")
    expect(result.error.message).toContain("rule.preview_invalid_input")
  })

  it("refuses a history entry carrying an unknown key rather than dropping it", () => {
    // A silently dropped key is the mechanism by which "I recorded the task title"
    // and "I recorded nothing" become the same document, and a task title is
    // exactly what ADR 0007 section 12 forbids this module from holding.
    const compiled = setOf([projectDenyDocument()])
    const result = previewCompiledRuleSet(
      compiled,
      { proposals: [rawHistoryEntry({ taskTitle: CANARY })], finishedDispatches: [] },
      previewOptions(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("rule.preview_invalid_input")
  })

  it("refuses options without an injected clock", () => {
    const compiled = setOf([projectDenyDocument()])
    const result = previewCompiledRuleSet(compiled, previewHistory(), { actorId: "user-x" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("rule.preview_invalid_input")
    expect(result.error.message).toContain("options")
  })

  it("refuses options whose clock is not a UTC instant", () => {
    // An unvalidated options object, because the fixture validates and this case
    // is precisely about an invalid one.
    const compiled = setOf([projectDenyDocument()])
    const result = previewCompiledRuleSet(compiled, previewHistory(), {
      now: "2026-03-02 09:00 local",
      actorId: "user-operator-7",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("rule.preview_invalid_input")
  })

  it("strips comments before scanning source, so the scan is not vacuous", () => {
    // The other half of the source scan above: a stripper that returned its
    // input unchanged would make every "the code does not contain X" assertion
    // pass for the wrong reason, and the first thing it would wrongly fail on is
    // this file's own docblock naming the tokens it forbids.
    const probe = ['/* Math.random() in prose */', '// Date.now() in prose', 'const kept = 1'].join("\n")
    expect(stripComments(probe)).toBe("\n\nconst kept = 1")
  })
})

// ===========================================================================
// 12. The preview is a structure
// ===========================================================================

describe("the preview is a structured model with text derived from it", () => {
  it("reports the artifact, the clock and the requester, so two previews can be told apart", () => {
    const compiled = setOf([scopedPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory(), previewOptions())

    expect(preview.languageVersion).toBe(2)
    expect(preview.ruleSetDigest).toBe(compiled.digest)
    expect(preview.generatedAt).toBe(PREVIEW_NOW)
    expect(preview.requestedBy).toBe("user-operator-7")
    expect(preview.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("puts one entry per compiled rule, in the compiled set's own evaluation order", () => {
    const compiled = setOf([universalDenyDocument(), roleDenyDocument(), scopeApprovalDocument(), roleApprovalDocument()])
    const preview = previewOf(compiled, previewHistory(), previewOptions())

    expect(preview.rules.map((entry) => entry.ruleId)).toEqual(compiled.rules.map((rule) => rule.ruleId))
    // Code-unit order, which is also why `role-approval` precedes `role-deny`.
    expect(preview.rules.map((entry) => entry.ruleId)).toEqual([...preview.rules.map((entry) => entry.ruleId)].sort())
  })

  it("reports each rule's own digest, normalized predicate and action kinds", () => {
    const compiled = setOf([scopedPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory(), previewOptions())
    const entry = entryFor(preview, "rule-pre-scoped")

    expect(entry.digest).toBe(compiled.rules[0]?.digest)
    expect(entry.normalizedPredicate).toBe(compiled.rules[0]?.normalizedPredicate)
    expect(entry.actionKinds).toEqual(["pre_approve_within_bounds"])
    expect(entry.author).toBe("user:user-1")
    expect(entry.activation).toEqual({ state: "activated", activatedAt: "2026-01-01T00:00:00Z", activatedBy: "user:user-1" })
    expect(entry.enabled).toBe(true)
    expect(entry.expiresAt).toBeNull()
  })

  it("renders lines that name every rule, and states an empty set of rules as empty", () => {
    const compiled = setOf([scopedPreApprovalDocument()])
    const preview = previewOf(compiled, previewHistory({ finishedDispatches: [proposalEntry()] }), previewOptions())

    expect(preview.lines.some((line) => line.includes("rule-pre-scoped@1: matched"))).toBe(true)
    expect(preview.lines.some((line) => line.includes("future scope: projects=[proj-1]"))).toBe(true)
    expect(preview.lines.some((line) => line.includes(`digest: ${preview.digest}`))).toBe(true)

    const empty = previewOf(setOf([]), previewHistory(), previewOptions())
    expect(empty.rules).toEqual([])
    expect(empty.lines).toContain("  (none)")
  })

  it("gives the renderer's explanation to the first matched rules and says how many had none", () => {
    // An unexplained `null` reads as "there was nothing to explain" rather than
    // "the bound fired", so the omission is counted and stated.
    const documents = Array.from({ length: 12 }, (_unused, index) =>
      projectDenyDocument({ ruleId: `rule-${String(index).padStart(2, "0")}` }),
    )
    const preview = previewOf(setOf(documents), previewHistory({ finishedDispatches: [proposalEntry()] }), previewOptions())

    const rendered = preview.rules.filter((entry) => entry.matchedDispatchExplanation !== null)
    expect(rendered).toHaveLength(8)
    expect(rendered.map((entry) => entry.ruleId)).toEqual(documents.slice(0, 8).map((document) => document.ruleId as string))
    expect(
      preview.structuralWarnings.some((warning) => warning.includes("4 matched rule(s) carried no rendered explanation")),
    ).toBe(true)
  })
})
