/**
 * Rendering: the rule explanation, the normalized predicate text, and the
 * pre-approval disclosure.
 *
 * ============================== THE SECRET RULE ==============================
 *
 * ADR 0007 section 12: rendered explanations, traces, disclosures and
 * notification payloads contain identifiers, enum values, numbers, digests, rule
 * metadata, and reason strings authored by a user for the purpose of explaining
 * a decision. They never contain prompt text, task descriptions, context manifest
 * item content, memory record content, capability payload bytes, terminal
 * output, environment values, bearer tokens, or provider credentials.
 *
 * This module ENFORCES that by construction rather than by redacting after the
 * fact. Every value rendered here comes from one of four places: the compiled
 * rule (authored metadata), the evaluation result (which contains only
 * identifiers, counts, enums, digests and authored reasons), or a constant in
 * this file. `renderRuleExplanation` is handed the RESULT and never the dispatch,
 * the envelope, the context manifest or any memory record, so there is no value
 * in scope that could be a secret — a redaction pass would have to be correct
 * about a set of fields this module never receives. The same reason
 * `src/context/isolation.ts` audits a structurally typed preview rather than
 * trusting the renderer it is checking: a redaction check that could be defeated
 * by a change to the thing it is checking is not a check.
 *
 * The tests assert the absence of a canary seeded into every context field, and
 * assert that the renderer is a pure function of the result.
 * ===========================================================================
 *
 * TWO RENDERING INVARIANTS:
 *
 *   1. DETERMINISTIC. Every collection is sorted by UTF-16 code unit and
 *      de-duplicated, and every map is iterated in sorted key order. Two
 *      evaluations of the same inputs render byte-identical text, which is what
 *      makes the rendered form usable as an audit artifact and comparable across
 *      machines.
 *
 *   2. BOUNDED. `MAX_EXPLANATION_TEXT_CHARS` is enforced here rather than
 *      hoped for. A 512-rule set with 64 predicates each can produce more text
 *      than a screen will hold, and an unbounded renderer turns "show me why"
 *      into an unresponsive process. The bound is applied by DROPPING WHOLE
 *      TRACE ENTRIES from the end and saying so, never by truncating a line
 *      mid-token: a truncated explanation that looks complete is worse than a
 *      short one that admits what it left out.
 */

import { MAX_EXPLANATION_TEXT_CHARS } from "./limits.js"
import { describePredicates, subtreeContainsNegation } from "./compile.js"
import { evaluateCompiledRule } from "./evaluate.js"
import {
  ruleEvaluationContextSchema,
  type CompiledRule,
  type PredicateOutcome,
  type RuleEvaluationContext,
  type RuleEvaluationResult,
  type RulePredicate,
} from "./types.js"

const INDENT = "  "

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits)
}

/**
 * Renders a rule evaluation as human-readable text.
 *
 * Takes the RESULT and nothing else. That is the whole security argument: the
 * function has no parameter through which a prompt, a task description, a context
 * manifest item or a memory record could arrive, so there is nothing for it to
 * leak. A renderer that also accepted the dispatch would have to be trusted to
 * pick the safe fields out of it.
 */
export function renderRuleExplanation(result: RuleEvaluationResult): string {
  const lines: string[] = []
  lines.push(`ruleLayer: language v${result.languageVersion}, project ${result.projectId}, evaluated at ${result.evaluatedAt}`)
  lines.push(`ruleSetDigest: ${result.ruleSetDigest}`)

  for (const trace of result.traces) {
    lines.push(`${trace.ruleId}@${trace.templateVersion}: ${trace.matchOutcome} — ${trace.reason}`)
    for (const outcome of trace.predicateOutcomes) {
      renderOutcome(outcome, 1, lines)
    }
    for (const action of trace.actions) {
      const detail = action.details.length === 0 ? "" : ` (${action.details.join("; ")})`
      lines.push(`${INDENT}${action.rank}:${action.kind} → ${action.disposition} — ${action.reason}${detail}`)
    }
  }

  lines.push(`deny: ${result.deny === null ? "none" : `${result.deny.ruleIds.join(",")} — ${result.deny.reason}`}`)
  lines.push(
    `restrictions: denied=[${result.restrictions.deniedCapabilities.join(",")}]` +
      ` allowed=${result.restrictions.allowedCapabilities === null ? "unconstrained" : `[${result.restrictions.allowedCapabilities.join(",")}]`}` +
      ` requireApprovalForDispatch=${String(result.restrictions.requireApprovalForDispatch)}` +
      ` maximumTimeoutSeconds=${result.restrictions.maximumTimeoutSeconds ?? "unconstrained"}`,
  )
  if (result.restrictions.unprojected.length > 0) {
    // Named rather than omitted, because "the kernel enforces everything" would
    // otherwise be a false claim about the members the M0 effect cannot carry.
    lines.push(`restrictionsNotProjectedIntoTheKernel: ${result.restrictions.unprojected.join(",")}`)
  }

  const budgetParts = Object.entries(result.budgets.limits)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, value]) => `${key}=${value}`)
  lines.push(`budgets: ${budgetParts.length === 0 ? "none" : budgetParts.join(" ")}`)
  for (const rejected of result.budgets.rejectedWidening) {
    lines.push(
      `${INDENT}rejected_widening: ${rejected.ruleId} ${rejected.field} ${rejected.attempted} over ${rejected.current}; ignored`,
    )
  }

  lines.push(
    `routing: preferred=[${result.routing.preferredNodeIds.join(",")}]` +
      ` excluded=[${result.routing.excludedNodeIds.join(",")}]` +
      ` requiredRuntimeKind=${result.routing.requiredRuntimeKind ?? "none"}` +
      ` requiredProjectPathId=${result.routing.requiredProjectPathId ?? "none"}`,
  )

  if (result.preApproval !== null) {
    lines.push(
      `preApproval: grantedBy=${result.preApproval.grantedBy ?? "none"}` +
        ` shadowed=[${result.preApproval.shadowed.join(",")}]` +
        ` blockedBy=${result.preApproval.blockedBy ?? "none"}`,
    )
    for (const candidate of result.preApproval.candidates) {
      lines.push(`${INDENT}${candidate.ruleId}@${candidate.templateVersion} boundsSatisfied=${String(candidate.boundsSatisfied)} — ${candidate.reason}`)
    }
  } else {
    lines.push("preApproval: none")
  }

  lines.push(`conflicts: ${result.conflicts.length === 0 ? "none" : result.conflicts.map(describeConflict).join("; ")}`)
  lines.push(
    `shadowing: ${
      result.shadowing.length === 0
        ? "none"
        : result.shadowing.map((entry) => `${entry.relation}:${entry.shadowingRuleId}>${entry.shadowedRuleId}`).join(" ")
    }`,
  )
  lines.push(`decisionDigest: ${result.decisionDigest}`)

  return boundText(lines)
}

function describeConflict(conflict: RuleEvaluationResult["conflicts"][number]): string {
  switch (conflict.kind) {
    case "deny_overrides_pre_approval":
      return `deny_overrides_pre_approval[${conflict.ruleIds.join(",")}]`
    case "multiple_deny":
      return `multiple_deny[${conflict.ruleIds.join(",")}]`
    case "multiple_pre_approval":
      return `multiple_pre_approval[grantedBy=${conflict.grantedBy};shadowed=${conflict.shadowed.join(",")}]`
    case "multiple_routing_preference":
      return `multiple_routing_preference[${conflict.ruleIds.join(",")}]`
  }
}

function renderOutcome(outcome: PredicateOutcome, depth: number, lines: string[]): void {
  const unknown = outcome.unevaluable ? " (unevaluable)" : ""
  lines.push(`${INDENT.repeat(depth)}${outcome.satisfaction}${unknown}: ${outcome.normalized} — ${outcome.reason}`)
  for (const child of outcome.children) {
    renderOutcome(child, depth + 1, lines)
  }
}

/**
 * Enforces `MAX_EXPLANATION_TEXT_CHARS` by dropping whole trace entries.
 *
 * The final line always says how many were dropped, so a short explanation can
 * never be mistaken for a complete one. Dropping from the END preserves the
 * leading decision context, which is the part a reader reads first and the part
 * that stays true about the dispatch as a whole.
 */
function boundText(lines: readonly string[]): string {
  const header = lines.slice(0, 2)
  const body = lines.slice(2)
  const headerText = header.join("\n")

  // The marker is added AFTER the fitting, so the bound has to be measured
  // against the marker too. Measuring only the body and appending the marker
  // afterwards would render an explanation OVER the bound by the length of the
  // sentence explaining that it respected the bound — which is exactly the kind of
  // off-by-one this module exists to not have.
  const markerFor = (dropped: number): string =>
    `… ${dropped} further line(s) were not rendered: the explanation exceeds the MAX_EXPLANATION_TEXT_CHARS of ${MAX_EXPLANATION_TEXT_CHARS}`

  // First pass: fit the body alone, to learn how many lines would be dropped.
  const fitted: string[] = []
  let used = headerText.length
  let dropped = 0
  for (const line of body) {
    if (used + line.length + 1 > MAX_EXPLANATION_TEXT_CHARS) {
      dropped += 1
      continue
    }
    fitted.push(line)
    used += line.length + 1
  }
  if (dropped === 0) return [...header, ...body].join("\n")

  // Second pass: re-fit with the marker reserved, because reserving it may free
  // room for another line, which would change the count the marker reports.
  const reserved = markerFor(dropped).length + 1
  const final: string[] = []
  let finalUsed = headerText.length + reserved
  let finalDropped = 0
  for (const line of body) {
    if (finalUsed + line.length + 1 > MAX_EXPLANATION_TEXT_CHARS) {
      finalDropped += 1
      continue
    }
    final.push(line)
    finalUsed += line.length + 1
  }
  return [...header, ...final, markerFor(finalDropped)].join("\n")
}

// ===========================================================================
// Normalized predicate description
// ===========================================================================

/**
 * The canonical single-line form of a predicate list.
 *
 * A re-export of the compiler's own renderer rather than a second
 * implementation. ADR 0007 section 11 requires that the form a user reads and
 * the form the compiler digests are the same string; two renderers would make
 * that a coincidence rather than a guarantee.
 */
export function describeNormalizedPredicate(predicates: readonly RulePredicate[]): string {
  return describePredicates(predicates)
}

// ===========================================================================
// Pre-approval disclosure (ADR 0007 section 11)
// ===========================================================================

/**
 * One reach axis of a pre-approval: the sorted, de-duplicated set of values it
 * can match, or `unknown`.
 *
 * `unknown` IS THE POINT and it is a distinct state rather than an empty set. An
 * empty set would render as `[]` and read as "matches nothing", which is the
 * opposite of the truth: an axis the predicate does not constrain matches
 * EVERYTHING, and a pre-approval that is unconstrained on projects is exactly the
 * shape the plan restricts. A disclosure that renders it as `[]` has told the
 * reader the opposite of what the rule does, and it has done so with a bracket
 * pair that looks like data.
 */
export type ReachAxis =
  | { readonly kind: "constrained"; readonly values: readonly string[]; readonly sources: readonly string[] }
  | { readonly kind: "unknown"; readonly sources: readonly string[] }

/** One declared bound of a pre-approval, from the action's declared values. */
export type DisclosureBound =
  | { readonly kind: "declared"; readonly value: number | string; readonly source: string }
  | { readonly kind: "unbounded"; readonly source: string }

export interface PreApprovalDisclosure {
  readonly ruleId: string
  readonly templateVersion: number
  readonly name: string
  readonly author: string
  readonly activation: { readonly state: string; readonly activatedAt: string | null; readonly activatedBy: string | null }
  readonly normalizedPredicate: string
  readonly reach: {
    readonly projects: ReachAxis
    readonly roles: ReachAxis
    readonly capabilities: ReachAxis
    readonly nodes: ReachAxis
    readonly projectPaths: ReachAxis
  }
  readonly bounds: {
    readonly fanOut: DisclosureBound
    readonly concurrency: DisclosureBound
    readonly retryLimit: DisclosureBound
    readonly timeoutSeconds: DisclosureBound
    readonly sensitivity: DisclosureBound
  }
  readonly historicalMatches: readonly { readonly dispatchId: string; readonly matched: boolean }[]
  readonly conflicts: readonly string[]
  readonly shadowing: readonly string[]
  readonly expiresAt: { readonly kind: "dated" | "no_expiry" | "expired"; readonly value: string | null }
  /** Everything the disclosure could not determine, in words rather than blanks. */
  readonly warnings: readonly string[]
}

/** Extras a caller supplies to the disclosure: history, conflicts, shadowing. */
export interface PreApprovalDisclosureExtras {
  /** Dispatches the rule would have matched, from a proposal or finished history. */
  readonly historicalDispatches?: readonly { readonly dispatchId: string; readonly context: unknown }[]
  readonly conflicts?: readonly string[]
  readonly shadowing?: readonly string[]
}

/**
 * Every field predicate in a document, with the source path it was read from.
 *
 * The path is carried all the way to the disclosure so that each reported value
 * names where it came from, which the plan's disclosure table requires item by
 * item and which a bare set of values cannot do.
 */
interface SourcedMembers {
  readonly values: readonly string[]
  readonly sources: readonly string[]
}

function collectReach(predicates: readonly RulePredicate[]): {
  projects: SourcedMembers[]
  roles: SourcedMembers[]
  capabilities: SourcedMembers[]
  nodes: SourcedMembers[]
  projectPaths: SourcedMembers[]
} {
  const projects: SourcedMembers[] = []
  const roles: SourcedMembers[] = []
  const capabilities: SourcedMembers[] = []
  const nodes: SourcedMembers[] = []
  const projectPaths: SourcedMembers[] = []

  const visit = (predicate: RulePredicate, path: string): void => {
    // A subtree that mentions a negation contributes no reach OF ITS OWN, but the
    // walk still descends when the subtree is a CONJUNCTION — `all(P, not Q)` is
    // exactly `P`, and P is a real bound that must still be disclosed.
    //
    // The compiler refuses such a subtree as a scope (`subtreeContainsNegation` in
    // `compile.ts`), so a rule that survives compilation reaches this walk only via an
    // enclosing `all`, and `all([any(A, not A)], B)` is `TRUE AND B` — i.e. just `B`.
    // Descending into the `any` anyway cited the dead branch's atom as a bound, so the
    // disclosure asserted `reach.roles = ["role-1"]` for a rule matching EVERY role,
    // and the kernel returned `allow` for a role the author never named. That is F-3.
    //
    // The rule that fixes it: a DISJUNCTION containing a negation is not a set on any
    // axis, so it yields nothing — same question the compiler asks, same answer. A
    // CONJUNCTION containing one is still a conjunction of its positive members, so it
    // is walked member by member. Returning early for `all` would be wrong, and was:
    // it silently emptied `all(projectId eq p, not(roleId eq r))` of its entire reach.
    //
    // Two walks over one tree, with no shared notion of a meaningful node, is the root
    // cause of HIGH-1, F-1 and F-3 alike. Both now call the same exported predicate.
    if (predicate.field === "any" && subtreeContainsNegation(predicate)) return
    switch (predicate.field) {
      case "projectId":
        projects.push({ values: identifierValues(predicate.value), sources: [path] })
        break
      case "roleId":
        roles.push({ values: identifierValues(predicate.value), sources: [path] })
        break
      case "projectPathId":
        projectPaths.push({ values: identifierValues(predicate.value), sources: [path] })
        break
      case "targetNodeId":
        nodes.push({ values: identifierValues(predicate.value), sources: [path] })
        break
      case "capability":
        // `none` does NOT constrain the capability axis: asserting the absence
        // of a set is a claim about the request rather than a bound on it, and
        // reporting it as a reach set would understate what the rule matches.
        if (predicate.operator !== "none") {
          capabilities.push({ values: [...predicate.value], sources: [path] })
        }
        break
      case "all":
      case "any":
        predicate.predicates.forEach((child, index) => visit(child, `${path}.${predicate.field}[${index}]`))
        break
      case "not":
        // A negation constrains nothing to a known set.
        break
      default:
        break
    }
  }

  predicates.forEach((predicate, index) => visit(predicate, `predicates[${index}]`))
  return { projects, roles, capabilities, nodes, projectPaths }
}

function identifierValues(value: string | readonly string[]): readonly string[] {
  return Array.isArray(value) ? [...value] : [value as string]
}

function axisOf(collected: readonly SourcedMembers[]): ReachAxis {
  if (collected.length === 0) {
    return { kind: "unknown", sources: [] }
  }
  return {
    kind: "constrained",
    values: sortedUnique(collected.flatMap((entry) => entry.values)),
    sources: sortedUnique(collected.flatMap((entry) => entry.sources)),
  }
}

/** The literal text an unconstrained axis renders as. Named, so it cannot drift. */
export const UNKNOWN_REACH_TEXT = "unknown"

/**
 * Builds the pre-approval disclosure (ADR 0007 section 11).
 *
 * Every one of the plan's eight required items is present and names its source
 * field, and the bounds come from the ACTION'S DECLARED VALUES rather than from
 * a computed narrowing. That distinction is not cosmetic: a computed narrowing
 * would show the tighter of the declared bound and whatever the floor imposes,
 * and the reader would conclude the rule grants up to the tighter number when the
 * disclosure that justified activating it said nothing about the wider one. The
 * declared bound is what the author asked for and therefore what they should be
 * shown.
 *
 * A bound the action did not declare renders as `unbounded`, NOT as the
 * language ceiling: "no fan-out maximum declared" and "fan-out maximum 256" are
 * different statements and only the first is true.
 */
export function buildPreApprovalDisclosure(
  rule: CompiledRule,
  extras: PreApprovalDisclosureExtras = {},
): PreApprovalDisclosure {
  const reach = collectReach(rule.predicates)
  const warnings: string[] = []

  const axes = {
    projects: axisOf(reach.projects),
    roles: axisOf(reach.roles),
    capabilities: axisOf(reach.capabilities),
    nodes: axisOf(reach.nodes),
    projectPaths: axisOf(reach.projectPaths),
  }
  for (const [name, axis] of Object.entries(axes)) {
    if (axis.kind === "unknown") {
      warnings.push(
        `The predicate is unconstrained on '${name}', so this pre-approval can match any value on that axis. The reach is shown as '${UNKNOWN_REACH_TEXT}' and not as an empty set, because an empty set would read as "matches nothing" and the truth is "matches everything".`,
      )
    }
  }

  const preApproval = rule.actions.find((action) => action.kind === "pre_approve_within_bounds")
  const boundOf = (
    declared: number | undefined,
    name: string,
  ): DisclosureBound =>
    declared === undefined
      ? { kind: "unbounded", source: `actions[pre_approve_within_bounds].${name}` }
      : { kind: "declared", value: declared, source: `actions[pre_approve_within_bounds].${name}` }

  const bounds = {
    fanOut: preApproval === undefined || preApproval.kind !== "pre_approve_within_bounds"
      ? ({ kind: "unbounded", source: "actions[pre_approve_within_bounds].maximumFanOut" } as const)
      : boundOf(preApproval.maximumFanOut, "maximumFanOut"),
    concurrency: preApproval === undefined || preApproval.kind !== "pre_approve_within_bounds"
      ? ({ kind: "unbounded", source: "actions[pre_approve_within_bounds].maximumConcurrency" } as const)
      : boundOf(preApproval.maximumConcurrency, "maximumConcurrency"),
    retryLimit: preApproval === undefined || preApproval.kind !== "pre_approve_within_bounds"
      ? ({ kind: "unbounded", source: "actions[pre_approve_within_bounds].maximumRetryLimit" } as const)
      : boundOf(preApproval.maximumRetryLimit, "maximumRetryLimit"),
    timeoutSeconds: preApproval === undefined || preApproval.kind !== "pre_approve_within_bounds"
      ? ({ kind: "unbounded", source: "actions[pre_approve_within_bounds].maximumTimeoutSeconds" } as const)
      : boundOf(preApproval.maximumTimeoutSeconds, "maximumTimeoutSeconds"),
    sensitivity: preApproval === undefined || preApproval.kind !== "pre_approve_within_bounds"
      ? ({ kind: "unbounded", source: "actions[pre_approve_within_bounds].maximumSensitivity" } as const)
      : ({
          kind: "declared",
          value: preApproval.maximumSensitivity,
          source: "actions[pre_approve_within_bounds].maximumSensitivity",
        } as const),
  }
  for (const [name, bound] of Object.entries(bounds)) {
    if (bound.kind === "unbounded") {
      warnings.push(`The pre-approval declares no '${name}' bound, so it renders as 'unbounded' rather than as the language ceiling; the two are different statements.`)
    }
  }

  // Historical matches are EVALUATED, not asserted by the caller: the same
  // `evaluateRules` entry point decides, so a disclosure cannot claim a history
  // that the evaluator would not agree with. A history entry whose context does
  // not satisfy the context schema is reported as not matched with a warning
  // rather than silently dropped, because a silently dropped history entry reads
  // as "this rule never matched that dispatch".
  const historicalMatches: { dispatchId: string; matched: boolean }[] = []
  for (const entry of extras.historicalDispatches ?? []) {
    const parsed = ruleEvaluationContextSchema.safeParse(entry.context)
    if (!parsed.success) {
      historicalMatches.push({ dispatchId: entry.dispatchId, matched: false })
      warnings.push(`History entry '${entry.dispatchId}' does not satisfy the evaluation context schema and was reported as not matched rather than omitted.`)
      continue
    }
    historicalMatches.push({
      dispatchId: entry.dispatchId,
      matched: matchesRule(rule, parsed.data as RuleEvaluationContext),
    })
  }

  const expiresAt =
    rule.expiresAt === null
      ? ({ kind: "no_expiry", value: null } as const)
      : ({ kind: "dated", value: rule.expiresAt } as const)
  if (rule.expiresAt === null) {
    warnings.push("The rule declares no expiry ('no expiry'). It remains effective until it is revoked or disabled, and there is no date at which it will stop applying on its own.")
  }

  return {
    ruleId: rule.ruleId,
    templateVersion: rule.templateVersion,
    name: rule.name,
    author: describeActor(rule.source.author),
    activation: {
      state: rule.activation.state,
      activatedAt: rule.activation.activatedAt,
      activatedBy: rule.activation.activatedBy === null ? null : describeActor(rule.activation.activatedBy),
    },
    normalizedPredicate: rule.normalizedPredicate,
    reach: axes,
    bounds,
    historicalMatches,
    // Sorted AND de-duplicated. A conflict reported by two evaluation paths would
    // otherwise appear twice, and a reader would wonder whether it happened twice.
    conflicts: sortedUnique(extras.conflicts ?? []),
    shadowing: sortedUnique(extras.shadowing ?? []),
    expiresAt,
    warnings: [...warnings].sort(compareCodeUnits),
  }
}

/**
 * The actor's identity, as an identifier.
 *
 * `Actor` is a discriminated union of user / node / session / system ids, all of
 * which are opaque identifiers, so rendering the id is rendering an identifier —
 * inside the section 12 boundary. No actor carries free text except `system.name`,
 * which is a short label the system itself supplies and is therefore not user
 * content.
 */
function describeActor(actor: CompiledRule["source"]["author"]): string {
  switch (actor.kind) {
    case "user":
      return `user:${actor.userId}`
    case "node":
      return `node:${actor.nodeId}`
    case "session":
      return `session:${actor.sessionId}`
    case "system":
      return `system:${actor.name}`
  }
}

/**
 * Whether the rule matched this dispatch, for the disclosure's history check.
 *
 * Delegates to the evaluator's own single-rule entry rather than re-walking the
 * predicate tree, so the disclosure and the runtime cannot disagree about what a
 * rule matches. The single-rule path exists because the disclosure asks about
 * ONE rule against a historical context, and answering that by constructing a
 * throwaway `CompiledRuleSet` would mean the disclosure depends on the set
 * compiler and on supersession, neither of which is a property of a single
 * historical dispatch.
 */
function matchesRule(rule: CompiledRule, context: RuleEvaluationContext): boolean {
  return evaluateCompiledRule(rule, context).matchOutcome === "matched"
}
