/**
 * M6.7 — the dry-run composer.
 *
 * # What this file is
 *
 * ADR 0007 section 16, composed:
 *
 * > The simulator receives immutable snapshots of the registry, roles, rules,
 * > memory metadata, and the proposed workflow. It returns the expanded task and
 * > dependency graph, candidate and selected targets with reasons, effective
 * > role/policy/context manifest summaries, required and matched pre-approvals,
 * > budget reservations and rejected work, and warnings for unavailable, unknown,
 * > or unenforceable capabilities.
 *
 * Every clause of that sentence is a CALL into the module that owns the decision.
 * This file contains no predicate evaluator, no budget algebra, no routing check,
 * no policy layer and no template grammar. Its entire job is to arrange the calls
 * so each one's input is another's output, project the results onto the shapes in
 * `./types.ts`, and assemble a digest.
 *
 * # The exact list of production functions called
 *
 * Every one of these is the shipped entry point for its decision, and the
 * acceptance tests compare this module's answers against each of them directly:
 *
 * | Call | Owner | What the plan relays |
 * | --- | --- | --- |
 * | `instantiateTemplate` | `src/workflows` | the snapshot digest, the resolved steps |
 * | `resolveStepDependencyGraph` | `src/workflows` | the order, verbatim |
 * | `findStepDependencyCycle` | `src/workflows` | the offending ids on a refusal |
 * | `evaluateRules` | `src/rules` | per-rule verdicts, the deny, the restrictions, the budget composition, the routing preference, the pre-approval candidates, the kernel rules |
 * | `previewCompiledRuleSet` | `src/rules` | the section 11 disclosures, the activation list, the structural warnings, the per-history verdicts |
 * | `rankNodes` | `src/routing` | every candidate, its exclusions, its rank, the selected node, the digest |
 * | `composeBudgets` | `src/budgets` | the effective limits, the enforceability record, the warnings, the rejected widenings |
 * | `admitUsage` | `src/budgets` | the usage admission verdict |
 * | `BudgetLedger.reserve` | `src/budgets` | the reservation, or the refusal |
 * | `evaluatePolicy` | `src/orchestration/policy` | the decision, the effective state, the outstanding approvals, the denials, the granted pre-approvals, the decision digest |
 * | `contextManifestV2Schema` | `src/context` | the manifest's own validity, before any of it is summarized |
 * | `digestJson` | `src/orchestration/digest` | the plan's own digest |
 *
 * # The two-pass rule evaluation, and why it is not a second evaluator
 *
 * Routing needs the rules' preference; a `targetNodeId` predicate needs a target;
 * the target comes from routing. The cycle is real, and it is broken by calling
 * `evaluateRules` TWICE per dispatch rather than by re-implementing anything:
 *
 *   1. **The target-agnostic pass** evaluates with `targetNodeId: null` and
 *      `nodeAdvertisedCapabilities: null`. The language DEFINES those as failing
 *      closed — "an absent node (local dispatch) is `unsatisfied` for
 *      `targetNodeId`", and a node with no capability snapshot is `unsatisfied` for
 *      `any`/`all` (ADR 0007 section 6, rows 7 and 8) — so a target-scoped rule
 *      contributes no preference, which is the correct reading: a preference from a
 *      rule that applies to one specific node must not reorder the set that chooses
 *      which node that is. This pass exists to obtain `evaluation.routing`, and
 *      only that.
 *   2. **The target-bound pass** evaluates again, with the selected node, and its
 *      `traces`, `deny`, `restrictions`, `budgets`, `preApproval` and `kernelRules`
 *      are what the plan REPORTS. It is the dispatch-bound evaluation, and it is
 *      the one a real run would perform.
 *
 * Both calls are the same function over the same compiled artifact.
 * `tests/unit/simulation/determinism.test.ts` calls `evaluateRules` itself with the
 * context the plan reports and asserts the verdicts are identical.
 *
 * # Named invariants
 *
 * - **P1 — Two evaluators would be visible here.** Every member of
 *   `SimulatedDispatch` that is a DECISION is a member of one of the calls above or
 *   a projection of one (`types.ts` I1). The only arithmetic in this file is a
 *   stage's width, a dependency's `failurePolicy`, `Date.parse` of the injected
 *   clock for routing's millisecond field, a digest, and refusal messages assembled
 *   from identifiers.
 * - **P2 — The plan reports what the real run would do.** When `rankNodes` selects
 *   nothing and the caller supplied a local node, the dispatch is planned against
 *   the local node AND warned about. When no local node was supplied, it is
 *   rejected with every candidate's exclusion codes. Neither branch invents a
 *   target.
 * - **P3 — The budget gate is entered and nothing is kept.** `BudgetLedger.reserve`
 *   runs against the counting probe in `./sinks.js`; the plan reports the
 *   reservation the ledger would have written and carries `reserved: false` as a
 *   Zod literal on every budget plan, because a plan that said it had reserved
 *   would be lying about capacity nobody consumed.
 * - **P4 — A warning is never a refusal and a refusal is never a warning**
 *   (`types.ts` I7). An unenforceable cost budget is a warning naming the field; a
 *   policy denial is rejected work carrying `policy.capability_denied`.
 * - **P5 — `lines` and `explanationText` are functions of the structure.** Derived
 *   at the end from the plan's own members, excluded from the digest, and built
 *   only from identifiers, enum members, numbers and reason codes already present
 *   in the structure.
 * - **P6 — One clock.** `request.now` reaches the expander, the evaluator contexts,
 *   the preview, the ledger and the routing request, and is the only instant
 *   anything reads.
 *
 * # Stop conditions
 *
 * - **S1 — If a decision the plan must report needs a function that does not exist,
 *   stop and return to ADR 0007** (the same rule as `types.ts` S1).
 * - **S2 — If the two-pass rule evaluation ever needs a third pass, the dependency
 *   is not a cycle in the planners, it is a missing decision somewhere, and the fix
 *   is upstream.**
 * - **S3 — If a plan member could only be produced by reading something live, it
 *   does not go in the plan.** The live fact belongs on the request.
 */

import {
  admitUsage,
  BUDGET_FIELDS,
  BudgetLedger,
  composeBudgets,
  NO_BUDGET_OBSERVATION,
  type BudgetComposition,
  type BudgetContribution,
  type BudgetLedgerStore,
  type BudgetLimits,
  type BudgetObservation,
  type BudgetRefusal,
  type BudgetReservation,
  type UsageAdmission,
} from "../budgets/index.js"
import { contextManifestV2Schema, type ContextManifestV2 } from "../context/types.js"
import { digestJson } from "../orchestration/digest.js"
import { nodeIdSchema, type Digest } from "../orchestration/identifiers.js"
import { evaluatePolicy } from "../orchestration/policy/evaluate.js"
import type { PolicyEvaluation } from "../orchestration/policy/types.js"
import { dispatchEnvelopeSchema } from "../orchestration/schemas.js"
import type { DispatchEnvelope, RoleTemplate } from "../orchestration/types.js"
import { rankNodes, type RoutingNodeSnapshot, type RoutingPreference, type RoutingResult } from "../routing/index.js"
import {
  evaluateRules,
  previewCompiledRuleSet,
  ruleEvaluationContextSchema,
  type CompiledRuleSet,
  type PreApprovalDisclosure,
  type RuleEvaluationContext,
  type RuleEvaluationResult,
  type RulePreviewHistory,
} from "../rules/index.js"
import type { ResolvedStep } from "../workflows/index.js"
import { derivedTaskId, expandRunTemplate, type ExpansionOutcome } from "./expand.js"
import { isBudgetStoreProbe } from "./sinks.js"
import {
  contextSensitivityRank,
  simulationRefuse,
  simulatedApprovalRequirementSchema,
  simulatedBudgetPlanSchema,
  simulatedContextSummarySchema,
  simulatedDispatchSchema,
  simulatedNodeSummarySchema,
  simulatedPolicySchema,
  simulatedPreApprovalMatchSchema,
  simulatedRejectionSchema,
  simulatedRoleSummarySchema,
  simulatedRoutingSchema,
  simulationRequestSchema,
  simulationWarning,
  toBudgetDecision,
  type BudgetDecisionProjection,
  type SimulatedApprovalRequirement,
  type SimulatedBudgetPlan,
  type SimulatedContextSummary,
  type SimulatedDispatch,
  type SimulatedNodeSummary,
  type SimulatedPreApprovalMatch,
  type SimulatedRejection,
  type SimulatedRoleSummary,
  type SimulatedRouting,
  type SimulatedTask,
  type SimulationPorts,
  type SimulationRequest,
  type SimulationResult,
  type SimulationWarning,
} from "./types.js"

type Warn = (warning: SimulationWarning) => void

// ===========================================================================
// The plan
// ===========================================================================

/**
 * The plan.
 *
 * An INTERFACE rather than a Zod schema, and the precedent is `RulePreview`
 * (`src/rules/preview.ts`): a plan has to carry `PreApprovalDisclosure` verbatim,
 * and that is an interface owned by `src/rules/explain.ts` with no schema behind it.
 * Re-declaring its fields here would be a second disclosure — exactly the kind of
 * restatement this milestone forbids — and inventing a schema for it would be
 * worse. Every OTHER member of this interface is a `z.infer` of a schema declared in
 * `./types.ts`, or a member of another module's own output, so the only unvalidated
 * part of a plan is the part this module did not build.
 */
export interface DryRunPlan {
  /** The shape version of this plan. `1` while ADR 0007 section 16 is unchanged. */
  readonly languageVersion: 1
  /** `request.now`. Never `Date.now()`. */
  readonly generatedAt: string
  readonly requestedBy: string
  readonly correlationId: string
  readonly projectId: string
  readonly runId: string
  /** The one compiled artifact every rule decision in this plan came from. */
  readonly ruleSetDigest: Digest
  /**
   * Whether `instantiateTemplate`'s role-containment check ran.
   *
   * `skipped` when the caller supplied no `roleCapabilities` resolver, which is the
   * production entry point's own documented default. A plan that claimed `enforced`
   * when the check did not run would be asserting a containment guarantee it does
   * not have.
   */
  readonly roleCapabilityCheck: "enforced" | "skipped"
  readonly expansion: ExpansionOutcome["expansion"]
  /** One summary per role snapshot supplied, sorted by `roleId` then version. */
  readonly roles: readonly SimulatedRoleSummary[]
  /** One summary per registry node, sorted by `nodeId`. Never a display name. */
  readonly nodes: readonly SimulatedNodeSummary[]
  readonly dispatches: readonly SimulatedDispatch[]
  readonly approvals: {
    readonly required: readonly SimulatedApprovalRequirement[]
    readonly matchedPreApprovals: readonly SimulatedPreApprovalMatch[]
    /** `previewCompiledRuleSet`'s own disclosures, verbatim. Never re-disclosed. */
    readonly preApprovalDisclosures: readonly PreApprovalDisclosure[]
    /** `ruleId@templateVersion` awaiting activation or confirmation, sorted. */
    readonly activationRequired: readonly string[]
    /**
     * `true` when there is at least one dispatch with a policy evaluation and EVERY
     * one of them reported `require_approval`.
     *
     * This is the milestone's headline guarantee as a value rather than as prose: on
     * a default installation — zero enabled rules — the safety floor's
     * `requireApprovalForDispatch` leaves every dispatch demanding approval, and this
     * member is where a reader sees it. It is `false`, not vacuously `true`, over an
     * empty set of evaluated dispatches.
     */
    readonly everyDispatchRequiresApproval: boolean
  }
  readonly budgets: {
    readonly base: BudgetLimits
    readonly observation: BudgetObservation
    /** The composition of the base budget alone, before any contribution. */
    readonly decision: BudgetDecisionProjection
    /**
     * Always empty.
     *
     * Present so the claim is a VALUE rather than an omission: a caller looking for
     * the reservations a plan took finds a list, and the list is empty.
     */
    readonly reserved: readonly BudgetReservation[]
  }
  readonly rejected: readonly SimulatedRejection[]
  /** Sorted by `(kind, subject, detail)` and de-duplicated, so two plans diff. */
  readonly warnings: readonly SimulationWarning[]
  /** `digestJson` over everything above, excluding `digest`, `lines` and `explanationText`. */
  readonly digest: Digest
  readonly lines: readonly string[]
  readonly explanationText: string
}

/** The plan's digest input, named so a reader can recompute it. */
export function dryRunPlanDigestInput(plan: DryRunPlan): Record<string, unknown> {
  return {
    languageVersion: plan.languageVersion,
    generatedAt: plan.generatedAt,
    requestedBy: plan.requestedBy,
    correlationId: plan.correlationId,
    projectId: plan.projectId,
    runId: plan.runId,
    ruleSetDigest: plan.ruleSetDigest,
    roleCapabilityCheck: plan.roleCapabilityCheck,
    expansion: plan.expansion,
    roles: plan.roles,
    nodes: plan.nodes,
    dispatches: plan.dispatches,
    approvals: plan.approvals,
    budgets: plan.budgets,
    rejected: plan.rejected,
    warnings: plan.warnings,
  }
}

/** Recomputes a plan's digest, with the function that produced it. */
export function computeDryRunPlanDigest(plan: DryRunPlan): Digest {
  return digestJson(dryRunPlanDigestInput(plan))
}

// ===========================================================================
// The entry point
// ===========================================================================

/**
 * Plans a run and performs nothing.
 *
 * `async` for exactly one reason, and the reason is inherited rather than chosen:
 * `BudgetLedger.reserve` is `async` because its `resolveLimits` port is a store read
 * in production. Everything else here is synchronous, and there is no `await`
 * between two operations that could be reordered into a transaction. Each
 * reservation is awaited immediately after it is requested, so no two reservations
 * are ever in flight and the ledger's compare-and-set is asked exactly the question
 * it would be asked in production — against an empty scope, because the probe holds
 * nothing.
 *
 * Returns a `SimulationResult` for every expected refusal. The one thing that
 * escapes as an exception is `SimulationSideEffectError` from `./sinks.js`, and it
 * means the PLAN is broken rather than that the answer is "no".
 */
export async function simulateDryRun(input: unknown, ports: SimulationPorts): Promise<SimulationResult<DryRunPlan>> {
  // ---- the request: the only untrusted value in the whole plan ----
  const parsed = simulationRequestSchema.safeParse(input)
  if (!parsed.success) {
    return simulationRefuse(
      "simulation.input_invalid",
      `A dry run needs a request matching simulationRequestSchema, and this one does not: ${parsed.error.issues
        .slice(0, 12)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    )
  }
  const request = parsed.data

  // ---- the budget store, refused rather than defaulted ----
  // `BudgetLedger`'s own default is `new InMemoryBudgetLedgerStore()`, which is a
  // REAL store: a caller who forgot the port would get a ledger that really
  // reserves, and the plan's `reserved: false` would be a lie. A missing or
  // unrecognised store is therefore a refusal, not a default. This check is the
  // runtime half of `SimulationPorts.budgetStore`'s type, and it exists because the
  // failure it prevents is precisely the one this milestone claims cannot happen.
  if (!isBudgetStoreProbe(ports.budgetStore)) {
    return simulationRefuse(
      "simulation.input_invalid",
      "A dry run must be given a BudgetLedgerStore, and the value supplied is not one. `BudgetLedger` would otherwise fall back to `InMemoryBudgetLedgerStore`, which really does reserve; use `createBudgetLedgerProbe` from `./sinks.js`.",
    )
  }

  // ---- the template: the one expander ----
  const expanded = expandRunTemplate(ports, {
    now: request.now,
    templateRef: request.proposal.templateRef,
    inputs: request.proposal.inputs,
    projectId: request.projectId,
    ruleSetDigest: request.rules.digest,
  })
  if (!expanded.ok) return expanded
  const { expansion, snapshot } = expanded.value
  const stepsById = new Map<string, ResolvedStep>(snapshot.resolvedSteps.map((step) => [step.stepId, step]))

  // ---- warnings are accumulated in one place, so the output is sorted once ----
  const warnings: SimulationWarning[] = []
  const warn: Warn = (warning) => {
    warnings.push(warning)
  }

  // ---- the base budget, composed ONCE. Everything below narrows it. ----
  const observation: BudgetObservation = request.budget.observation ?? NO_BUDGET_OBSERVATION
  const baseComposition = composeBudgets(request.budget.base, [], observation)

  // The template's declared starting rule set, if any, against the compiled set.
  // `null` means "no declared starting rule set", which is the default
  // installation's shape (ADR 0007 section 18 ships zero enabled rules) and is NOT a
  // mismatch.
  if (expansion.declaredRuleSetDigest !== null && expansion.declaredRuleSetDigest !== request.rules.digest) {
    warn(
      simulationWarning("rule_set_digest_mismatch", `${expansion.templateId}@${expansion.templateVersion}`, [
        `declared=${expansion.declaredRuleSetDigest}`,
        `supplied=${request.rules.digest}`,
      ]),
    )
  }

  // ---- roles: the supplied snapshots, summarised ----
  const rolesById = new Map<string, RoleTemplate[]>()
  for (const role of request.roles) {
    const existing = rolesById.get(role.roleId)
    if (existing === undefined) rolesById.set(role.roleId, [role])
    else existing.push(role)
  }
  const roleSummaries: SimulatedRoleSummary[] = request.roles.map(summarizeRole).sort(compareRoleSummaries)

  // ---- per-dispatch planning ----
  const stageWidths = new Map<number, number>()
  for (const task of expansion.tasks) {
    stageWidths.set(task.stage, (stageWidths.get(task.stage) ?? 0) + 1)
  }

  const dispatches: SimulatedDispatch[] = []
  const historyProposals: RulePreviewHistory["proposals"][number][] = []
  let usedLocalFallback = false

  for (const task of expansion.tasks) {
    const step = stepsById.get(task.stepId)
    if (step === undefined) {
      return simulationRefuse(
        "simulation.internal_failure",
        `The expansion named step '${task.stepId}', which is not a step of the instantiated snapshot`,
      )
    }
    const role = newestRole(rolesById.get(task.roleId) ?? [])
    if (role === undefined) {
      warn(simulationWarning("role_snapshot_absent", task.dispatchId, [task.roleId]))
    }
    const manifest = findManifest(request, task.dispatchId)
    if (manifest === null) {
      warn(simulationWarning("context_manifest_absent", task.dispatchId))
    }
    const manifestSummary = manifest === null ? null : summarizeManifest(manifest)
    const stageWidth = stageWidths.get(task.stage) ?? 1

    // ============ PASS 1: the target-agnostic rule evaluation ============
    const targetAgnostic = evaluateRules(
      request.rules,
      ruleContext(request, task, role, null, null, manifestSummary, stageWidth, baseComposition.limits, step),
    )

    // ============ routing: the one ranker ============
    const routingResult = rankNodes(
      request.registry.nodes,
      routingRequestFor(request, task, targetAgnostic),
      preferenceOf(targetAgnostic),
    )
    if (!routingResult.ok) {
      return simulationRefuse(
        "simulation.input_invalid",
        `Routing refused the request for dispatch '${task.dispatchId}': ${routingResult.error.message}`,
        { origin: routingResult.error.code, detail: { dispatchId: task.dispatchId } },
      )
    }
    const routing = routingResult.value
    warnCapabilityWarnings(task, role, request.registry.nodes, warn)

    let targetNodeId = routing.selectedNodeId
    if (targetNodeId === null && request.localDispatchNodeId !== null) {
      targetNodeId = request.localDispatchNodeId
      usedLocalFallback = true
      warn(simulationWarning("routing_local_fallback", task.dispatchId, [request.localDispatchNodeId]))
    }
    const routingSummary = summarizeRouting(routing)
    const nodeSnapshot = request.registry.nodes.find((node) => node.nodeId === targetNodeId) ?? null

    // ============ PASS 2: the target-bound rule evaluation ============
    const bound = evaluateRules(
      request.rules,
      ruleContext(request, task, role, targetNodeId, nodeSnapshot?.capabilities ?? null, manifestSummary, stageWidth, baseComposition.limits, step),
    )

    // ============ the budget gate: the one ledger, against a probe ============
    const contributions: BudgetContribution[] = []
    if (step.budget !== undefined) {
      contributions.push({
        source: `template:${snapshot.templateId}@${snapshot.templateVersion}#${task.stepId}`,
        limits: step.budget,
      })
    }
    if (Object.keys(bound.budgets.limits).length > 0) {
      // The rule engine already composed its own contributions
      // (`RuleBudgetComposition` is the EVALUATOR's answer, and re-composing them
      // here would be a second implementation of the section 7.6 algebra). It is
      // handed to `composeBudgets` as ONE attributed contribution, which is the seam
      // `src/budgets` documents (C7).
      contributions.push({ source: `rules:${request.rules.digest}`, limits: bound.budgets.limits })
    }
    const composition = composeBudgets(request.budget.base, contributions, observation)
    const usage = admitUsage(composition.limits, observation, manifestSummary?.budgetEstimated ?? 0)
    const gate = await reserveThroughGate(ports.budgetStore, request, task, composition)
    if (gate.refusal !== null && gate.refusal.code === "budget.scope_unbounded") {
      warn(simulationWarning("scope_unbounded", task.dispatchId, ["concurrency"]))
    }
    for (const field of BUDGET_FIELDS) {
      // Only a DECLARED field can be unenforceable-in-use. An absent field is
      // `not_enforceable` by construction — there is no limit in force, so there is
      // nothing to enforce — and warning about it would say "declared but not
      // enforceable" about a budget nobody declared, which is the kind of false
      // claim this milestone's whole refusal to lie is about.
      if (composition.limits[field] === undefined) continue
      if (composition.enforceability[field] === "not_enforceable") {
        // A cost budget the adapter cannot measure produces a warning NAMING the
        // field, and never a refusal: refusing it would report a cost nobody knows,
        // and reporting it as enforced would be the dishonesty the enforceability
        // table exists to prevent (P4).
        warn(simulationWarning("budget_not_enforceable", task.dispatchId, [field]))
      }
    }
    if (!usage.admitted || usage.enforceability === "not_enforceable") {
      if (usage.reason !== "usage_no_budget") {
        // `usage_no_budget` means no usage budget was declared, which is not a
        // warning: nobody asked for one. Every other unmeasurable reason is a budget
        // that WAS declared and cannot be checked, which is worth saying out loud.
        warn(simulationWarning("usage_not_measurable", task.dispatchId, [usage.reason]))
      }
    }

    // ============ the policy evaluation: the one kernel ============
    let policy: PolicyEvaluation | null = null
    let rejection: SimulatedRejection | null = null
    const envelope =
      role === undefined || targetNodeId === null
        ? null
        : buildEnvelope(request, task, step, role, targetNodeId, bound, manifestSummary)

    if (bound.deny !== null) {
      rejection = reject(task, "rules", "rule.denied", bound.deny.reason, bound.deny.ruleIds)
    } else if (targetNodeId === null) {
      rejection = reject(task, "routing", "routing.no_eligible_node", describeNoEligibleNode(routing), [])
    } else if (role === undefined) {
      // A dispatch cannot be evaluated without the role it runs under, and the plan
      // says so rather than evaluating it against a fabricated role (P2).
      rejection = reject(task, "policy", "policy.role_snapshot_absent", `No role snapshot was supplied for role '${task.roleId}', so this dispatch has no authority to be evaluated under.`, [])
    } else if (envelope === null) {
      rejection = reject(
        task,
        "policy",
        "policy.envelope_unrepresentable",
        "The dispatch envelope could not be built from the supplied snapshots; the most common cause is a step requesting a capability its role neither allows nor denies, which the envelope schema requires an explicit decision for.",
        [],
      )
    } else {
      policy = evaluatePolicySafely(envelope, step)
      if (policy === null) {
        rejection = reject(task, "policy", "policy.evaluation_failed", "The kernel's policy evaluation refused an envelope this module built, which is a bug rather than a decision.", [])
      } else if (policy.denials.length > 0) {
        rejection = reject(
          task,
          "policy",
          policy.denials[0]?.code ?? "policy.denied",
          policy.denials.map((denial) => denial.message).join("; "),
          [],
        )
      } else if (gate.refusal !== null) {
        rejection = reject(task, "budget", gate.refusal.code, gate.refusal.message, [])
      }
    }
    if (rejection !== null) warn(simulationWarning("dispatch_rejected", task.dispatchId, [rejection.code]))

    // ============ assemble the dispatch ============
    const dispatch = simulatedDispatchSchema.safeParse({
      task,
      role: role === undefined ? null : summarizeRole(role),
      rules: summarizeRules(bound, request.rules),
      policy: policy === null ? null : summarizePolicy(policy),
      routing: routingSummary,
      context: manifestSummary,
      budget: buildBudgetPlan(composition, bound.budgets.rejectedWidening, contributions, usage, gate),
      approval: approvalRequirement(task, policy, rejection),
      preApproval: preApprovalMatch(task, bound, policy),
      rejection,
    })
    if (!dispatch.success) {
      return simulationRefuse(
        "simulation.internal_failure",
        `The plan for dispatch '${task.dispatchId}' does not satisfy simulatedDispatchSchema: ${dispatch.error.issues
          .slice(0, 8)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      )
    }
    dispatches.push(dispatch.data)

    // Every dispatch that reached a rule evaluation becomes a PROPOSAL in the
    // preview's own history. That is what makes the divergence guard exact: the
    // preview's per-rule verdict for a dispatch must equal the one this plan
    // reports, and the two can only be compared if they are looking at the same
    // subject.
    historyProposals.push({
      dispatchId: task.dispatchId,
      runId: request.runId,
      taskId: task.taskId,
      projectId: request.projectId,
      roleId: role?.roleId ?? null,
      roleVersion: role?.templateVersion ?? null,
      requestedCapabilities: [...task.capabilities],
      runtimeKind: task.runtimeKind,
      targetNodeId: targetNodeId === null ? null : nodeIdSchema.parse(targetNodeId),
      projectPathId: request.projectPathId,
      taskLabels: [...task.labelKeys],
      dependencyOutcomes: [],
      requestedFanOut: stageWidth,
      requestedConcurrency: stageWidth,
      requestedRetryLimit: baseComposition.limits.maximumRetryLimit ?? null,
      declaredTimeoutSeconds: task.declaredTimeoutSeconds,
      contextManifestSensitivity: manifestSummary?.maximumSensitivity ?? null,
      evaluatedAt: request.now,
      state: "proposed",
    })
  }

  // ============ the preview: the one previewer, over OUR OWN dispatches ============
  const preview = previewCompiledRuleSet(
    request.rules,
    { proposals: historyProposals, finishedDispatches: [] },
    {
      now: request.now,
      actorId: request.proposal.requestedBy,
      ...(request.proposal.activationConfirmed === undefined ? {} : { activationConfirmed: request.proposal.activationConfirmed }),
    },
  )
  if (!preview.ok) {
    return simulationRefuse("simulation.preview_failed", `The rule preview refused the dry run's own dispatch history: ${preview.error.message}`, {
      origin: preview.error.code,
      detail: { dispatchCount: String(historyProposals.length) },
    })
  }
  for (const structural of preview.value.structuralWarnings) {
    warn(simulationWarning("preview_structural", null, [structural]))
  }
  for (const outstanding of preview.value.activationRequired) {
    warn(simulationWarning("pre_approval_activation_outstanding", null, [outstanding]))
  }
  if (usedLocalFallback) {
    // A run-level entry, so a reader scanning only the warnings sees that the run
    // touched a local fallback at all. The per-dispatch entries name which
    // dispatches; this one does not repeat them, so a de-duplicated sort keeps both.
    warn(simulationWarning("routing_local_fallback", "run", [request.localDispatchNodeId ?? "none"]))
  }

  // ============ assemble the plan ============
  const withDigests: DryRunPlan = {
    languageVersion: 1,
    generatedAt: request.now,
    requestedBy: request.proposal.requestedBy,
    correlationId: request.correlationId,
    projectId: request.projectId,
    runId: request.runId,
    ruleSetDigest: request.rules.digest,
    roleCapabilityCheck: ports.roleCapabilities === undefined ? "skipped" : "enforced",
    expansion,
    roles: roleSummaries,
    nodes: summarizeNodes(request.registry.nodes, dispatches),
    dispatches,
    approvals: {
      required: dispatches.map((entry) => entry.approval).filter((entry) => entry.required).sort(byDispatchId),
      matchedPreApprovals: dispatches.flatMap((entry) => (entry.preApproval === null ? [] : [entry.preApproval])),
      preApprovalDisclosures: preview.value.preApprovalDisclosures,
      activationRequired: [...preview.value.activationRequired],
      everyDispatchRequiresApproval: everyDispatchRequiresApproval(dispatches),
    },
    budgets: {
      base: baseComposition.limits,
      observation,
      decision: toBudgetDecision(baseComposition),
      reserved: [],
    },
    rejected: dispatches.flatMap((entry) => (entry.rejection === null ? [] : [entry.rejection])),
    warnings: sortWarnings(warnings),
    // A placeholder that is still a REAL digest, so the type never has to be
    // asserted and a reader tracing the assembly sees that the member is replaced
    // two lines later. `digestJson({ pending: true })` is the honest spelling of
    // "a digest that is not this plan's yet".
    digest: digestJson({ pending: true }),
    lines: [],
    explanationText: "",
  }
  const sealed: DryRunPlan = { ...withDigests, digest: computeDryRunPlanDigest(withDigests) }
  const lines = renderLines(sealed)
  return { ok: true, value: Object.freeze({ ...sealed, lines, explanationText: lines.join("\n") }) }
}

// ===========================================================================
// Helpers: the request's facts, projected
// ===========================================================================

/**
 * The context manifest bound to a dispatch, parsed on the way out.
 *
 * Parsed HERE rather than in the request schema, and deliberately: the manifest is
 * not re-declared in `simulationRequestSchema` (that would be a second manifest
 * shape), and a manifest that does not satisfy `contextManifestV2Schema` is simply
 * not a manifest this module may summarize. An unreadable one is reported as
 * ABSENT rather than half-parsed, because a summary built from a manifest that
 * failed its own schema is a summary of a fiction.
 */
function findManifest(request: SimulationRequest, dispatchId: string): ContextManifestV2 | null {
  for (const candidate of request.memory.manifests) {
    const parsed = contextManifestV2Schema.safeParse(candidate)
    if (parsed.success && parsed.data.dispatchId === dispatchId) return parsed.data
  }
  return null
}

/** The role summary: identifiers and permissions only. Never name, purpose or instructions. */
function summarizeRole(role: RoleTemplate): SimulatedRoleSummary {
  return simulatedRoleSummarySchema.parse({
    roleId: role.roleId,
    templateVersion: role.templateVersion,
    requiredCapabilities: [...role.requiredCapabilities].sort(),
    allowedCapabilities: [...role.permissionRestrictions.allowedCapabilities].sort(),
    deniedCapabilities: [...role.permissionRestrictions.deniedCapabilities].sort(),
    approvalRequiredCapabilities: [...role.permissionRestrictions.approvalRequirements.capabilities].sort(),
    requireApprovalForDestructiveEffects: role.permissionRestrictions.approvalRequirements.destructiveEffects,
    requireApprovalForExternalEffects: role.permissionRestrictions.approvalRequirements.externalEffects,
    preferredRuntimeKinds: [...role.preferredRuntimeKinds].sort(),
  })
}

/** The highest `templateVersion` for a role id, or `undefined`. Total, because versions are unique per role. */
function newestRole(candidates: readonly RoleTemplate[]): RoleTemplate | undefined {
  let newest: RoleTemplate | undefined
  for (const candidate of candidates) {
    if (newest === undefined || candidate.templateVersion > newest.templateVersion) newest = candidate
  }
  return newest
}

function compareRoleSummaries(left: SimulatedRoleSummary, right: SimulatedRoleSummary): number {
  if (left.roleId !== right.roleId) return left.roleId < right.roleId ? -1 : 1
  return left.templateVersion - right.templateVersion
}

/** The context manifest summary: counts, categories, sensitivity, budget, digests. */
function summarizeManifest(manifest: ContextManifestV2): SimulatedContextSummary {
  const categories = [...new Set(manifest.items.map((item) => item.category))].sort()
  let highest: SimulatedContextSummary["maximumSensitivity"] = null
  let highestRank = -1
  for (const item of manifest.items) {
    const rank = sensitivityRankOf(item.sensitivity)
    if (rank > highestRank) {
      highestRank = rank
      highest = item.sensitivity
    }
  }
  return simulatedContextSummarySchema.parse({
    manifestId: manifest.manifestId,
    manifestDigest: manifest.digest,
    renderedDigest: manifest.renderedDigest ?? null,
    roleSnapshotHash: manifest.roleSnapshotHash,
    policyVersion: manifest.policyVersion,
    itemCount: manifest.items.length,
    excludedCount: manifest.excluded.length,
    categories,
    maximumSensitivity: highest,
    clearance: manifest.destination.clearance,
    destinationNodeId: manifest.destination.nodeId,
    destinationRoleId: manifest.destination.roleId,
    budgetUnit: manifest.budget.unit,
    budgetEstimated: manifest.budget.estimated,
    budgetMaximum: manifest.budget.maximum,
  })
}

/**
 * The rank of a manifest item's sensitivity.
 *
 * `contextSensitivityRank` from `./types.ts`, which indexes the lattice declared
 * there with the two guards that declaration documents (a compile-time annotation
 * against `ContextManifestV2`'s own type, and a runtime equality assertion in the
 * tests). Using it here means the summary's `maximumSensitivity` and the rule
 * context's `contextManifestSensitivity` cannot come from two different ladders.
 */
const sensitivityRankOf = contextSensitivityRank

/** The `RuleEvaluationContext` for one pass. Every member is a fact the request supplied. */
function ruleContext(
  request: SimulationRequest,
  task: SimulatedTask,
  role: RoleTemplate | undefined,
  targetNodeId: string | null,
  nodeAdvertisedCapabilities: readonly string[] | null,
  manifest: SimulatedContextSummary | null,
  stageWidth: number,
  currentBudget: BudgetLimits,
  step: ResolvedStep,
): RuleEvaluationContext {
  return ruleEvaluationContextSchema.parse({
    projectId: request.projectId,
    roleId: role?.roleId ?? null,
    roleVersion: role?.templateVersion ?? null,
    requestedCapabilities: [...task.capabilities],
    // No tool-category snapshot is supplied, so this is EMPTY rather than invented:
    // a `toolCategory` predicate then reports `unsatisfied` for `any`/`all`, which is
    // the language's defined fail-closed reading for "no categories named".
    toolCategories: [],
    runtimeKind: task.runtimeKind,
    targetNodeId,
    nodeAdvertisedCapabilities: nodeAdvertisedCapabilities === null ? null : [...nodeAdvertisedCapabilities],
    projectPathId: request.projectPathId,
    // Label NAMES, not values.
    taskLabels: [...task.labelKeys],
    // No run exists yet, so there are no dependency outcomes. A `dependencyOutcome`
    // predicate therefore reports `unsatisfied` for every operator except `none`,
    // which is exactly what the language defines for a task with no dependencies.
    dependencyOutcomes: [],
    requestedFanOut: stageWidth,
    requestedConcurrency: stageWidth,
    requestedRetryLimit: currentBudget.maximumRetryLimit ?? null,
    declaredTimeoutSeconds: task.declaredTimeoutSeconds,
    // The only content the rule engine sees, and it is the subject of the
    // `taskTitlePattern` predicate family — the one family that needs it.
    taskTitle: step.title,
    evaluatedAt: request.now,
    contextManifestSensitivity: manifest?.maximumSensitivity ?? null,
    currentBudget,
  })
}

/** The routing request for one dispatch. Every member is the dispatch's own declared need. */
function routingRequestFor(request: SimulationRequest, task: SimulatedTask, evaluation: RuleEvaluationResult): Parameters<typeof rankNodes>[1] {
  return {
    projectId: request.projectId,
    projectPathId: request.projectPathId,
    requiredCapabilities: [...task.capabilities],
    requiredRuntimeKinds: [task.runtimeKind],
    requiredToolCategories: [],
    // The injected clock, as milliseconds: the only conversion this file performs on
    // a timestamp, and the only reason it touches `Date` at all. A malformed `now`
    // was already refused by `timestampSchema`.
    now: Date.parse(request.now),
    excludeNodeIds: evaluation.routing.excludedNodeIds.map((nodeId) => nodeIdSchema.parse(nodeId)),
  }
}

/** The rule engine's preference, handed to routing by shape. Never rebuilt here. */
function preferenceOf(evaluation: RuleEvaluationResult): RoutingPreference {
  return {
    preferredNodeIds: [...evaluation.routing.preferredNodeIds],
    excludedNodeIds: [...evaluation.routing.excludedNodeIds],
    requiredRuntimeKind: evaluation.routing.requiredRuntimeKind,
    requiredProjectPathId: evaluation.routing.requiredProjectPathId,
  }
}

// ===========================================================================
// Helpers: the decisions, relayed
// ===========================================================================

/** The rule section. Every member is copied from `evaluateRules`. */
function summarizeRules(evaluation: RuleEvaluationResult, compiled: CompiledRuleSet): SimulatedDispatch["rules"] {
  return {
    decisionDigest: evaluation.decisionDigest,
    verdicts: evaluation.traces.map((trace) => ({
      ruleId: trace.ruleId,
      templateVersion: trace.templateVersion,
      matchOutcome: trace.matchOutcome,
      reason: trace.reason,
    })),
    denied: evaluation.deny === null ? null : { ruleIds: [...evaluation.deny.ruleIds], reason: evaluation.deny.reason },
    restrictions: {
      deniedCapabilities: [...evaluation.restrictions.deniedCapabilities],
      requireApprovalForDispatch: evaluation.restrictions.requireApprovalForDispatch,
      requireApprovalForCapabilities: [...evaluation.restrictions.requireApprovalForCapabilities],
      maximumTimeoutSeconds: evaluation.restrictions.maximumTimeoutSeconds,
    },
    ruleSetDigest: compiled.digest,
  }
}

/** The routing section: `rankNodes`' own candidate list, digest and counters, unchanged. */
function summarizeRouting(routing: RoutingResult): SimulatedRouting {
  return simulatedRoutingSchema.parse({
    digest: routing.digest,
    selectedNodeId: routing.selectedNodeId,
    candidates: routing.candidates,
    preferenceIgnored: routing.preferenceIgnored,
    demotedNodeIds: routing.demotedNodeIds,
    preferenceApplied: routing.preferenceApplied,
    tieBreakApplied: routing.tieBreakApplied,
    consideredCount: routing.consideredCount,
    eligibleCount: routing.eligibleCount,
    excludedCount: routing.excludedCount,
  })
}

/** The policy section: `evaluatePolicy`'s own decision, digests and state, projected. */
function summarizePolicy(policy: PolicyEvaluation): SimulatedDispatch["policy"] {
  return simulatedPolicySchema.parse({
    decisionDigest: policy.decisionDigest,
    envelopeDigest: policy.envelopeDigest,
    decision: policy.decision,
    allowed: policy.allowed,
    declaredTimeoutSeconds: policy.declaredTimeoutSeconds,
    effectiveTimeoutSeconds: policy.effectiveTimeoutSeconds,
    allowedCapabilities: [...policy.effective.allowedCapabilities],
    deniedCapabilities: [...policy.effective.deniedCapabilities],
    approvalRequiredCapabilities: [...policy.effective.approvalRequiredCapabilities],
    dispatchApprovalDemands: [...policy.effective.dispatchApprovalDemands],
    requireApprovalForDestructiveEffects: policy.effective.requireApprovalForDestructiveEffects,
    requireApprovalForExternalEffects: policy.effective.requireApprovalForExternalEffects,
    maximumTimeoutSeconds: policy.effective.maximumTimeoutSeconds,
    grantedPreApprovals: [...policy.grantedPreApprovals],
    preApprovalBasis: policy.preApprovalBasis,
    outstandingApprovals: [...policy.outstandingApprovals],
    denials: policy.denials.map((denial) => ({
      code: denial.code,
      message: denial.message,
      capabilities: [...denial.capabilities],
      ...(denial.layer === undefined ? {} : { layer: denial.layer }),
      ...(denial.subject === undefined ? {} : { subject: denial.subject }),
    })),
    wideningAttempts: [...policy.explanation.wideningAttempts],
  })
}

/**
 * One approval requirement, read off `evaluatePolicy`'s own outstanding list.
 *
 * A dispatch that will not launch is not "approved pending": it is refused, and
 * reporting an approval requirement for it would put an operator in front of a
 * prompt that cannot lead anywhere.
 */
function approvalRequirement(
  task: SimulatedTask,
  policy: PolicyEvaluation | null,
  rejection: SimulatedRejection | null,
): SimulatedApprovalRequirement {
  const outstanding = policy === null ? [] : [...policy.outstandingApprovals]
  const required = policy !== null && policy.decision === "require_approval" && rejection === null
  return simulatedApprovalRequirementSchema.parse({
    dispatchId: task.dispatchId,
    stepId: task.stepId,
    outstanding,
    required,
  })
}

/** One pre-approval match, carrying BOTH answers: the evaluator's candidates and the kernel's grant. */
function preApprovalMatch(
  task: SimulatedTask,
  evaluation: RuleEvaluationResult,
  policy: PolicyEvaluation | null,
): SimulatedPreApprovalMatch | null {
  const candidates = evaluation.preApproval?.candidates ?? []
  const basis = policy?.preApprovalBasis ?? null
  if (candidates.length === 0 && basis === null) return null
  return simulatedPreApprovalMatchSchema.parse({
    dispatchId: task.dispatchId,
    stepId: task.stepId,
    ruleId: basis?.ruleId ?? null,
    templateVersion: basis?.ruleVersion ?? null,
    capabilities: policy === null ? [] : [...policy.grantedPreApprovals],
    candidates: candidates.map((candidate) => ({
      ruleId: candidate.ruleId,
      templateVersion: candidate.templateVersion,
      boundsSatisfied: candidate.boundsSatisfied,
      reason: candidate.reason,
    })),
    granted: basis !== null,
  })
}

/** One rejection, carrying the refusing module's own code. */
function reject(
  task: SimulatedTask,
  stage: SimulatedRejection["stage"],
  code: string,
  reason: string,
  ruleIds: readonly string[],
): SimulatedRejection {
  return simulatedRejectionSchema.parse({
    dispatchId: task.dispatchId,
    stepId: task.stepId,
    stage,
    code,
    reason: reason.slice(0, 4_096),
    ruleIds: [...new Set(ruleIds)].sort(),
  })
}

/** Why no node was eligible, from the candidates' own exclusion codes. Never a guess. */
function describeNoEligibleNode(routing: RoutingResult): string {
  const codes = [...new Set(routing.candidates.flatMap((candidate) => candidate.exclusions.map((exclusion) => exclusion.code)))].sort()
  return codes.length === 0
    ? "The registry snapshot is empty, so no node could be considered."
    : `Every candidate failed a hard check: [${codes.join(",")}]`
}

// ===========================================================================
// Helpers: the envelope and the gate
// ===========================================================================

/**
 * The dispatch envelope, built from the snapshots and the kernel rules.
 *
 * Returns `null` rather than throwing when the envelope is not representable,
 * which is a real outcome: the M0 envelope requires every requested capability to
 * carry an explicit permission decision, so a step asking for something the role
 * neither allows nor denies cannot be dispatched. That is a rejection with a code,
 * not a crash.
 *
 * `prompt` is the step's title — the only content this module holds (see
 * `./expand.js`'s `ExpansionOutcome`). It is required: `dispatchEnvelopeSchema` has
 * no default for it, and refusing to supply one would mean refusing to call
 * `evaluatePolicy`.
 *
 * `timeoutSeconds` is the step's own declared value, which `resolvedStepSchema`
 * already caps at the safety floor's ceiling — so no `min` against
 * `SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS` is needed here, and adding one would be a
 * second place that bound is applied.
 */
function buildEnvelope(
  request: SimulationRequest,
  task: SimulatedTask,
  step: ResolvedStep,
  role: RoleTemplate,
  targetNodeId: string,
  evaluation: RuleEvaluationResult,
  manifest: SimulatedContextSummary | null,
): DispatchEnvelope | null {
  const manifestDigest = manifest?.manifestDigest ?? digestJson({ context: "none", dispatchId: task.dispatchId })
  const requestedCapabilities = [...task.capabilities]
  const parsed = dispatchEnvelopeSchema.safeParse({
    schemaVersion: 1,
    dispatchId: task.dispatchId,
    attempt: 1,
    projectId: request.projectId,
    runId: request.runId,
    taskId: task.taskId,
    targetNodeId,
    installationId: request.installationId,
    runtimeKind: task.runtimeKind,
    projectPathId: request.projectPathId,
    prompt: step.title,
    roleSnapshot: role,
    // The M0 projections of the rules that MATCHED this dispatch, and nothing else.
    // `evaluateRules` is the only sanctioned way to obtain them, and they are
    // dispatch-bound by construction (ADR 0007 section 3.1).
    ruleSnapshots: evaluation.kernelRules,
    contextManifest: { references: [], manifestDigest },
    requestedCapabilities,
    permissionEnvelope: role.permissionRestrictions,
    dependencies: task.dependsOn.map((stepId) => ({ taskId: derivedTaskId(stepId), failurePolicy: "block" as const })),
    timeoutSeconds: task.declaredTimeoutSeconds,
    controllerEpoch: request.controllerEpoch,
  })
  return parsed.success ? (parsed.data as DispatchEnvelope) : null
}

/**
 * `evaluatePolicy`, which THROWS on a malformed input. Turned into `null`, never a
 * crash: the plan's own envelope was parsed through the M0 schema first, so this
 * branch means a bug, and a dry run that crashed would be less useful than one that
 * reported the dispatch as unevaluated.
 */
function evaluatePolicySafely(envelope: DispatchEnvelope, step: ResolvedStep): PolicyEvaluation | null {
  try {
    return evaluatePolicy({ envelope, taskTitle: step.title })
  } catch {
    return null
  }
}

interface GateOutcome {
  readonly reservation: BudgetReservation | null
  readonly refusal: BudgetRefusal | null
}

/**
 * The budget gate, entered through the production ledger against the probe.
 *
 * The ledger is built PER DISPATCH with the composed limits as its resolver's
 * answer, rather than once with a resolver that looked up "the dispatch currently
 * being planned". A resolver that had to know which dispatch was in flight would be
 * a second planner with mutable state; a ledger whose options are a pure function of
 * one dispatch's composition is not. The probe is shared, so its counters accumulate
 * across the whole plan.
 *
 * `units` is always 1: a reservation is a dispatch's own claim on a concurrency
 * slot, and a fan-out reservation is a separate claim in a real run. Asking for more
 * would be inventing a claim the plan has no basis for.
 */
async function reserveThroughGate(
  store: SimulationPorts["budgetStore"],
  request: SimulationRequest,
  task: SimulatedTask,
  composition: BudgetComposition,
): Promise<GateOutcome> {
  const ledger = new BudgetLedger({ store, resolveLimits: () => composition.limits })
  const result = await ledger.reserve({
    reservationId: `res:${task.stepId}`,
    projectId: request.projectId,
    runId: request.runId,
    taskId: task.taskId,
    dispatchId: task.dispatchId,
    scope: "concurrency",
    units: 1,
    now: request.now,
  })
  return result.ok ? { reservation: result.value, refusal: null } : { reservation: null, refusal: result.refusal }
}

/**
 * The budget plan for one dispatch, with `reserved: false` as a Zod literal on every one.
 *
 * `rejectedWidening` carries the union of BOTH rejections, and the union is the
 * point. A `set_stricter_budget` action wider than the budget in force is refused by
 * the RULE ENGINE (ADR 0007 section 7.6), which caps its own contribution and records
 * the attempt; and a contribution wider than the base is refused by `composeBudgets`.
 * Reporting only the second would make a rule that tried to widen look like it had
 * never been applied, and reporting only the first would hide a template step budget
 * that tried to widen. Neither list is recomputed here: both are relayed, with the
 * rule engine's `ruleId` and `composeBudgets`' `source` both mapped onto `source`.
 */
function buildBudgetPlan(
  composition: BudgetComposition,
  ruleRejections: readonly { readonly ruleId: string; readonly field: string; readonly attempted: number; readonly current: number }[],
  contributions: readonly BudgetContribution[],
  usage: UsageAdmission,
  gate: GateOutcome,
): SimulatedBudgetPlan {
  const rejections = [
    ...composition.rejectedWidening.map((attempt) => ({
      source: attempt.source,
      field: attempt.field,
      attempted: attempt.attempted,
      current: attempt.current,
    })),
    ...ruleRejections.map((attempt) => ({
      source: attempt.ruleId,
      field: attempt.field,
      attempted: attempt.attempted,
      current: attempt.current,
    })),
  ]
  const seen = new Set<string>()
  const unique = rejections
    .filter((attempt) => {
      const identity = `${attempt.field} ${attempt.source} ${attempt.attempted} ${attempt.current}`
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
    .sort((left, right) =>
      left.field === right.field ? (left.source < right.source ? -1 : left.source > right.source ? 1 : 0) : left.field < right.field ? -1 : 1,
    )
  return simulatedBudgetPlanSchema.parse({
    decision: toBudgetDecision(composition),
    contributions: contributions.map((contribution) => ({ source: contribution.source, limits: contribution.limits })),
    rejectedWidening: unique,
    usage,
    scope: "concurrency",
    reservation: gate.reservation,
    refusal: gate.refusal,
    reserved: false as const,
  })
}

// ===========================================================================
// Helpers: warnings, summaries, lines
// ===========================================================================

/**
 * The capability warnings.
 *
 * Two distinct facts, two distinct kinds, and keeping them apart is the point:
 * `capability_unavailable` is about the MESH (no node advertises it) and
 * `capability_unknown_to_role` is about AUTHORITY (the role that would run the
 * dispatch neither allows nor denies it, so no node could supply it either way).
 * Collapsing them would report a missing advertisement as a missing grant, and an
 * operator would go looking at the wrong configuration.
 */
function warnCapabilityWarnings(
  task: SimulatedTask,
  role: RoleTemplate | undefined,
  nodes: readonly RoutingNodeSnapshot[],
  warn: Warn,
): void {
  if (task.capabilities.length === 0) return
  const advertised = new Set<string>()
  for (const node of nodes) for (const capability of node.capabilities) advertised.add(capability)
  for (const capability of task.capabilities) {
    if (!advertised.has(capability)) warn(simulationWarning("capability_unavailable", task.dispatchId, [capability]))
  }
  if (role === undefined) return
  const declared = new Set([...role.permissionRestrictions.allowedCapabilities, ...role.permissionRestrictions.deniedCapabilities])
  for (const capability of task.capabilities) {
    if (!declared.has(capability)) warn(simulationWarning("capability_unknown_to_role", task.dispatchId, [capability]))
  }
}

/** Node summaries, one per snapshot node, with the exclusion codes the plan's routings saw. */
function summarizeNodes(nodes: readonly RoutingNodeSnapshot[], dispatches: readonly SimulatedDispatch[]): SimulatedNodeSummary[] {
  const exclusionsByNode = new Map<string, Set<string>>()
  for (const dispatch of dispatches) {
    for (const candidate of dispatch.routing?.candidates ?? []) {
      if (candidate.exclusions.length === 0) continue
      const set = exclusionsByNode.get(candidate.nodeId) ?? new Set<string>()
      for (const exclusion of candidate.exclusions) set.add(exclusion.code)
      exclusionsByNode.set(candidate.nodeId, set)
    }
  }
  return nodes
    .map((node) => {
      const codes = [...(exclusionsByNode.get(node.nodeId) ?? [])].sort()
      return simulatedNodeSummarySchema.parse({
        nodeId: node.nodeId,
        healthy: node.healthy,
        healthReason: node.healthReason,
        runtimeKinds: [...node.runtimeKinds],
        capabilities: [...node.capabilities],
        projectPathIds: [...node.projectPathIds],
        activeSessions: node.activeSessions,
        maxConcurrentSessions: node.maxConcurrentSessions,
        // A comma-joined code list rather than an array, because the summary is
        // "one line about this node" and a node is excluded for a SET of reasons.
        // The vocabulary is routing's own closed `ROUTING_EXCLUSION_REASONS`.
        excludedBy: codes.length === 0 ? null : codes.join(","),
      })
    })
    .sort((left, right) => (left.nodeId === right.nodeId ? 0 : left.nodeId < right.nodeId ? -1 : 1))
}

/** The headline guarantee, as a value. `false` over an empty set, never vacuously `true`. */
function everyDispatchRequiresApproval(dispatches: readonly SimulatedDispatch[]): boolean {
  const evaluated = dispatches.filter((entry) => entry.policy !== null)
  return evaluated.length > 0 && evaluated.every((entry) => entry.policy?.decision === "require_approval")
}

function byDispatchId(left: { readonly dispatchId: string }, right: { readonly dispatchId: string }): number {
  return left.dispatchId === right.dispatchId ? 0 : left.dispatchId < right.dispatchId ? -1 : 1
}

/** Sorted by `(kind, subject, detail)` and de-duplicated, so two plans diff. */
function sortWarnings(warnings: readonly SimulationWarning[]): SimulationWarning[] {
  const key = (warning: SimulationWarning): string => `${warning.kind} ${warning.subject ?? ""} ${warning.detail.join(",")}`
  const seen = new Set<string>()
  const unique: SimulationWarning[] = []
  for (const warning of [...warnings].sort((left, right) => (key(left) === key(right) ? 0 : key(left) < key(right) ? -1 : 1))) {
    const identity = key(warning)
    if (seen.has(identity)) continue
    seen.add(identity)
    unique.push(warning)
  }
  return unique
}

/**
 * The rendered plan.
 *
 * One header block, one line per stage, per dispatch, per rejection and per warning.
 * Every string is assembled from identifiers, enum members, numbers and reason codes
 * already present in the structure (P5). Excluded from the digest for the reason
 * `RulePreview`, `RoutingResult` and `RuleEvaluationResult` all exclude their own
 * rendered text: a digest covering a derivation of itself cannot be recomputed.
 */
function renderLines(plan: DryRunPlan): readonly string[] {
  const lines: string[] = [
    `dry-run: project=${plan.projectId} run=${plan.runId} generatedAt=${plan.generatedAt}`,
    `dry-run: template=${plan.expansion.templateId}@${plan.expansion.templateVersion} snapshotDigest=${plan.expansion.snapshotDigest}`,
    `dry-run: ruleSetDigest=${plan.ruleSetDigest} roleCapabilityCheck=${plan.roleCapabilityCheck} tasks=${plan.expansion.tasks.length}`,
    `dry-run: nodes=${plan.nodes.length} dispatches=${plan.dispatches.length} rejected=${plan.rejected.length} warnings=${plan.warnings.length}`,
    `dry-run: everyDispatchRequiresApproval=${plan.approvals.everyDispatchRequiresApproval}`,
    `dry-run: budgets reserved=${plan.budgets.reserved.length} baseLimits=[${describeLimits(plan.budgets.base)}]`,
  ]
  plan.expansion.graph.stages.forEach((stage, index) => {
    lines.push(`dry-run: graph stage ${index} [${stage.join(",")}]`)
  })
  for (const dispatch of plan.dispatches) {
    const target = dispatch.routing?.selectedNodeId ?? "none"
    const decision = dispatch.policy === null ? "unevaluated" : dispatch.policy.decision
    const reservation = dispatch.budget.reservation === null ? "none" : dispatch.budget.reservation.reservationId
    lines.push(
      `dry-run: dispatch ${dispatch.task.dispatchId} step=${dispatch.task.stepId} stage=${dispatch.task.stage} node=${target} policy=${decision} reservation=${reservation} rejected=${dispatch.rejection?.code ?? "no"}`,
    )
  }
  for (const rejection of plan.rejected) {
    lines.push(`dry-run: rejected ${rejection.dispatchId} stage=${rejection.stage} code=${rejection.code}`)
  }
  for (const warning of plan.warnings) {
    lines.push(`dry-run: warning ${warning.kind} subject=${warning.subject ?? "-"} [${warning.detail.join(",")}]`)
  }
  return lines
}

/** A limits object as `field=value` pairs, sorted, so a diff of two plans is readable. */
function describeLimits(limits: BudgetLimits): string {
  return Object.entries(limits)
    .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
    .map(([field, value]) => `${field}=${String(value)}`)
    .join(",")
}
