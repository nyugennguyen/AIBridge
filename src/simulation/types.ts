/**
 * M6.7 — the side-effect-free dry run: types.
 *
 * # What this module is
 *
 * The shapes of ADR 0007 section 16's simulator, and nothing else. The behaviour
 * lives in `./plan.js` (composition), `./expand.js` (template expansion) and
 * `./sinks.js` (the fail-closed command sinks).
 *
 * ```
 * simulation  ->  rules, workflows, budgets, routing, orchestration, context
 * ```
 *
 * That edge list is ADR 0007 section 1's, and it is one-directional on purpose:
 * nothing under `src/orchestration/`, `src/rules/`, `src/routing/`,
 * `src/workflows/`, `src/budgets/`, `src/application/` or `src/tui/` may import
 * this module. A reverse edge would hand the rule engine a way to reach the
 * kernel that the kernel does not know about, and — worse for this milestone —
 * would let a "dry run" flag be threaded backwards into production code, which is
 * the second code path section 16 exists to prevent.
 * `tests/unit/simulation/barrel.test.ts` asserts the direction by source scan.
 *
 * # The load-bearing design constraint
 *
 * > The simulator is composed of the SAME pure planners and evaluators as
 * > production, with every command sink replaced by a fail-closed fake whose only
 * > implementation throws. There is no "dry-run mode" flag threaded through
 * > production code, because a flag is a second code path and a second code path
 * > is where divergence starts.
 *
 * Every type in this file therefore exists to make one of two things checkable:
 *
 *   1. a DECISION that some other module already owns, restated as a copy of that
 *      module's own output type — so a test can compare the dry run's answer with
 *      `evaluateRules`, `rankNodes`, `composeBudgets` or `evaluatePolicy` directly,
 *      and a divergence fails the test rather than passing quietly; and
 *   2. a SINK that would have to be faked — see `./sinks.js`.
 *
 * Nothing here restates a rule predicate, a budget, a routing check, a policy
 * layer, or a template grammar.
 *
 * # Named invariants
 *
 * - **I1 — Composition, never re-derivation.** Every decision-shaped member of
 *   `DryRunPlan` is either a verbatim member of the owning module's return value
 *   (`RoutingResult.candidates`, `PolicyEvaluation.decision`, `BudgetRefusal`) or
 *   a projection of three ADR 0007 section 13.1 members with no arithmetic
 *   (`toBudgetDecision`). A member that had to be *computed* is a second
 *   implementation of something, and this module contains none.
 *
 * - **I2 — No free text crosses into a plan (ADR 0007 section 12).** A rendered
 *   plan carries identifiers, enum members, numbers, digests, counts and reason
 *   strings authored for the purpose of explaining a decision. It never carries a
 *   step title, a role name, a role purpose, role instructions, a template name or
 *   description, a bound parameter value, a task label VALUE, a node display
 *   name, a context item, a memory record, or any capability payload. Every
 *   exclusion is stated at the declaration that would otherwise have carried the
 *   field, and `auditDryRunPlanForSecrets` walks the finished artifact anyway, with
 *   a STRUCTURALLY declared input, because a check that imported the type it was
 *   checking could be defeated by a change to that type.
 *
 * - **I3 — Purity.** No clock, no randomness, no filesystem, no network, no
 *   process, no `node:` import. `now` arrives on the request; every identifier
 *   this module mints is DERIVED from a caller-supplied one by a pure function, so
 *   the same request yields byte-identical plans. `tests/unit/simulation/
 * determinism.test.ts` asserts this over fifty invocations with the snapshot
 *   arrays shuffled, and asserts the absence of `Date.now` and `Math.random` by
 *   source scan.
 *
 * - **I4 — Refusals are values.** Every way the simulator says no is a
 *   `SimulationRefusal` with a code from the closed `SIMULATION_REFUSALS` set. An
 *   expected refusal is never thrown. The one exception is
 *   `SimulationSideEffectError` in `./sinks.js`, which is by construction not an
 *   expected outcome: it means a sink was reached, and a dry run that reached a
 *   sink is broken.
 *
 * - **I5 — Code-unit ordering, never `localeCompare`.** Every list this module
 *   emits is sorted with the `<` operator, so two machines with different ICU
 *   locale data produce the same plan and the same digest.
 *
 * - **I6 — The plan is a digest-bound artifact.** `DryRunPlan.digest` is
 *   `digestJson` over everything else, excluding `digest`, `lines` and
 *   `explanationText` — the three members that are functions of the rest. This is
 *   the reason `RulePreview`, `RoutingResult` and `RuleEvaluationResult` all
 *   exclude their own rendered text, and it is restated here because a plan whose
 *   digest covered its own rendering could never be recomputed by a reader.
 *
 * - **I7 — Warnings are not refusals.** An unenforceable budget, an unavailable
 *   capability, and a pre-approval still awaiting activation are all WARNINGS.
 *   Only an unroutable or policy-denied dispatch is refused work, and it appears
 *   in `DryRunPlan.rejected` with the refusing module's own code. A simulator that
 *   turned a warning into a refusal would be reporting a decision it is not
 *   entitled to make; one that turned a refusal into a warning would be reporting
 *   success for a run that cannot happen.
 *
 * - **I8 — Derived ids are derived, not minted.** `taskId`, `dispatchId` and
 *   `reservationId` in a plan are functions of the template's step id. A real run
 *   mints its own ids at launch, so a plan's ids are PROPOSED ids. Recorded as a
 *   known limitation rather than hidden, because a reader comparing a plan against
 *   a launched run will notice.
 *
 * # Stop conditions
 *
 * - **S1 — If a decision the plan must report cannot be obtained by CALLING its
 *   owning module, stop and return to ADR 0007.** The tempting shape — "the
 *   simulator needs to know whether X, and no exported function answers that, so
 *   it will work it out" — is exactly the second evaluator section 16 forbids. The
 *   fix is an export from the owning module, never a local re-derivation.
 * - **S2 — If a plan member cannot be built from identifiers, enums, numbers,
 *   digests and decision reasons, it does not belong in the plan.** The answer to
 *   "I need the step title in here to make this readable" is a digest or a step
 *   id, not the title (I2).
 * - **S3 — If the simulator ever needs to know something only a live system can
 *   tell it — a node's current session count, an adapter's usage figure, a
 *   reservation's held total — it is supplied on the request as a snapshot fact.**
 *   A simulator that asks a live question is a real run wearing a dry-run label.
 */

import { z } from "zod"
import {
  budgetEnforceabilityRecordSchema,
  budgetLimitsSchema,
  budgetObservationSchema,
  budgetRefusalSchema,
  budgetScopeSchema,
  budgetReservationSchema,
  type BudgetLedgerStore,
  type BudgetDecision,
  type BudgetEnforceability,
  type BudgetLimits,
  type BudgetObservation,
  type BudgetRefusal,
  type BudgetReservation,
  type UsageAdmission,
} from "../budgets/index.js"
import type { ContextManifestV2 } from "../context/types.js"
import {
  capabilitySchema,
  correlationIdSchema,
  digestSchema,
  dispatchIdSchema,
  nodeIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  roleIdSchema,
  ruleIdSchema,
  runIdSchema,
  taskIdSchema,
  timestampSchema,
} from "../orchestration/identifiers.js"
import { roleTemplateSchema } from "../orchestration/schemas.js"
import {
  routingCandidateResultSchema,
  routingHealthReasonSchema,
  routingIgnoredPreferenceSchema,
  routingNodeSnapshotSchema,
} from "../routing/index.js"
import type { CompiledRuleSet } from "../rules/index.js"
import { templateIdentifierSchema } from "../workflows/index.js"
import type { RoleCapabilityResolver, RunTemplateRepository } from "../workflows/index.js"

// ===========================================================================
// Bounds
// ===========================================================================

/**
 * The simulator's own bounds, in one place.
 *
 * They exist so the input schema is `.strict()` about size as well as shape: a
 * dry run that accepted an unbounded registry snapshot would be a denial of
 * service wearing a plan. The numbers are the M6 language's own registry-scale
 * bound rather than invented ones, so a mesh this repository can register at all
 * can be simulated at all.
 */
export const SIMULATION_MAX_NODES = 512
export const SIMULATION_MAX_ROLES = 64
export const SIMULATION_MAX_MANIFESTS = 512
export const SIMULATION_MAX_PARAMETERS = 32
export const SIMULATION_MAX_LINES = 4_096

// ===========================================================================
// Refusals
// ===========================================================================

/**
 * Every way the simulator itself says no, in UTF-16 code-unit order.
 *
 * Closed, for the reason `BUDGET_REFUSALS` in `src/budgets/types.ts` is closed: a
 * refusal vocabulary nobody can enumerate is a vocabulary nobody can handle. Every
 * member is a decision about a REQUEST (a malformed snapshot, an unroutable
 * dispatch, a template that will not instantiate); a decision about the WORLD is
 * never a refusal here — a denied dispatch appears in `DryRunPlan.rejected`, and
 * an unenforceable budget appears in `DryRunPlan.warnings` (I7).
 */
export const SIMULATION_REFUSALS = [
  "simulation.dependency_cycle",
  "simulation.input_invalid",
  "simulation.internal_failure",
  "simulation.policy_evaluation_failed",
  "simulation.preview_failed",
  "simulation.project_scope_mismatch",
  "simulation.template_not_instantiable",
] as const

export type SimulationRefusalCode = (typeof SIMULATION_REFUSALS)[number]

/**
 * A refusal, carrying the deciding module's own code beside this module's code.
 *
 * `detail` is a `Record<string, string>` of IDENTIFIERS and reason codes — never
 * content. A refusal that could only be understood by reading a plan would not be
 * a refusal an operator could act on from a log line.
 */
export const simulationRefusalSchema = z
  .object({
    code: z.enum(SIMULATION_REFUSALS),
    message: z.string().min(1).max(4_096),
    /**
     * The code the DECIDING module raised, when one did.
     *
     * `workflow.dependency_cycle`, `routing.request_invalid`,
     * `budget.request_invalid` and so on. Kept rather than flattened, because
     * "the dry run refused" and "the dry run refused because the template graph
     * has a cycle" are different answers and a caller that has to grep the message
     * to tell them apart is doing string comparison on prose.
     */
    origin: z.string().min(1).max(128).nullable(),
    detail: z.record(z.string(), z.string()),
  })
  .strict()

export type SimulationRefusal = z.infer<typeof simulationRefusalSchema>

/** `Result<T>` over `SimulationRefusal`, so an expected refusal is never thrown (I4). */
export type SimulationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: SimulationRefusal }

/** Builds a refusal. `detail` is identifiers and codes only (I2). */
export function simulationRefuse(
  code: SimulationRefusalCode,
  message: string,
  options: { readonly origin?: string | null; readonly detail?: Record<string, string> } = {},
): SimulationResult<never> {
  return {
    ok: false,
    refusal: simulationRefusalSchema.parse({
      code,
      message: message.slice(0, 4_096),
      origin: options.origin ?? null,
      detail: options.detail ?? {},
    }),
  }
}

/** True when a `SimulationResult` is a refusal. Narrows without a cast. */
export function isSimulationRefusal<T>(result: SimulationResult<T>): result is { readonly ok: false; readonly refusal: SimulationRefusal } {
  return result.ok === false
}

// ===========================================================================
// Warnings
// ===========================================================================

/**
 * What a plan must warn about, in UTF-16 code-unit order.
 *
 * ADR 0007 section 16 names three ("unavailable, unknown, or unenforceable
 * capabilities"); the rest are the warnings this milestone's own composition can
 * produce, and they are here rather than in a comment so a caller can exhaustively
 * switch on them.
 *
 * The three ADR-named kinds, and what each is a claim ABOUT:
 *
 *   - `capability_unavailable` — a capability a step requests that NO node in the
 *     registry snapshot advertises. A fact about the mesh, not about policy.
 *   - `capability_unknown_to_role` — a capability a step requests that the role
 *     snapshot bound to that step does not grant. A fact about authority: the
 *     request cannot be satisfied by ANY node, because the role is the ceiling.
 *   - `budget_not_enforceable` — a budget field whose enforceability is
 *     `not_enforceable`, naming the field. The requirement is that this produces a
 *     warning and NOT a refusal: refusing a cost budget the system cannot measure
 *     would report a cost nobody knows, and claiming it is enforced would be the
 *     dishonesty ADR 0007 section 13.1's enforceability table exists to prevent.
 */
export const SIMULATION_WARNING_KINDS = [
  "budget_not_enforceable",
  "capability_unavailable",
  "capability_unknown_to_role",
  "context_manifest_absent",
  "context_manifest_dispatch_mismatch",
  "dispatch_rejected",
  "pre_approval_activation_outstanding",
  "preview_structural",
  "role_snapshot_absent",
  "routing_local_fallback",
  "routing_no_eligible_node",
  "rule_set_digest_mismatch",
  "scope_unbounded",
  "usage_not_measurable",
] as const

export type SimulationWarningKind = (typeof SIMULATION_WARNING_KINDS)[number]

/**
 * One warning.
 *
 * `detail` is a sorted, de-duplicated list of IDENTIFIERS, enum members, numbers
 * and reason codes. `message` is assembled here from those and from `kind` alone,
 * so a warning's prose is a function of its structured members and two runs that
 * agree on the members cannot disagree on the sentence.
 */
export const simulationWarningSchema = z
  .object({
    kind: z.enum(SIMULATION_WARNING_KINDS),
    /** `null` for a warning about the run as a whole rather than one member. */
    subject: z.string().min(1).max(256).nullable(),
    message: z.string().min(1).max(2_048),
    /** Sorted and de-duplicated, by code unit. */
    detail: z.array(z.string().min(1).max(512)).max(64),
  })
  .strict()

export type SimulationWarning = z.infer<typeof simulationWarningSchema>

/**
 * Builds one warning.
 *
 * `message` is a fixed template per kind, and the caller supplies only values. A
 * caller cannot hand in its own sentence, so a warning's text can never become a
 * channel for content (I2) — which is the same discipline `describeRoutingExclusion`
 * follows in `src/routing/rank.ts`.
 */
const WARNING_TEMPLATES: Readonly<Record<SimulationWarningKind, (detail: string) => string>> = Object.freeze({
  budget_not_enforceable: (detail) =>
    `The ${detail} budget is declared but NOT enforceable right now, so the plan does not claim it is being applied; no work is refused for it`,
  capability_unavailable: (detail) => `No node in the registry snapshot advertises the requested capability [${detail}]`,
  capability_unknown_to_role: (detail) => `The role snapshot bound to this dispatch does not grant [${detail}], so no node can supply it`,
  context_manifest_absent: () => "No context manifest was supplied for this dispatch, so the plan reports no context summary for it",
  context_manifest_dispatch_mismatch: (detail) =>
    `The context manifest is bound to a different dispatch [${detail}], so its summary is reported against the dispatch it names rather than the one being planned`,
  dispatch_rejected: (detail) => `This dispatch is not launchable: [${detail}]`,
  preview_structural: (detail) => `The rule preview reported a structural finding: ${detail}`,
  pre_approval_activation_outstanding: (detail) =>
    `A pre-approval is still awaiting activation or confirmation [${detail}], so it grants nothing yet`,
  role_snapshot_absent: (detail) =>
    `No role snapshot was supplied for [${detail}], so the dispatch could not be evaluated against a role and is reported as unresolved rather than as allowed`,
  routing_local_fallback: (detail) =>
    `Routing selected no node, so the dispatch is planned against the caller's local node [${detail}]; the registry snapshot alone does not justify a target`,
  routing_no_eligible_node: (detail) => `No node satisfied every hard routing check: [${detail}]`,
  rule_set_digest_mismatch: (detail) =>
    `The proposed workflow declares a starting rule set [${detail}] that is not the compiled set supplied to the dry run, so the mismatch is reported rather than resolved`,
  scope_unbounded: (detail) =>
    `The composed budget declares no maximum for [${detail}], so nothing may be reserved against it; 'no budget' is not 'unlimited budget'`,
  usage_not_measurable: (detail) =>
    `Usage was not measured reliably, so a usage budget of [${detail}] cannot be checked; the work is admitted and the limit is reported as unenforceable`,
})

/** Builds one warning. Sorted, de-duplicated detail; a fixed sentence per kind. */
export function simulationWarning(
  kind: SimulationWarningKind,
  subject: string | null,
  detail: Iterable<string> = [],
): SimulationWarning {
  const members = [...new Set(detail)].sort()
  return simulationWarningSchema.parse({
    kind,
    subject,
    message: WARNING_TEMPLATES[kind](members.join(",")),
    detail: members,
  })
}

// ===========================================================================
// The request
// ===========================================================================

/**
 * Which template to expand, and with what.
 *
 * `templateVersion` omitted means "the latest", exactly as
 * `instantiateTemplate` means it. A caller that wants a reproducible plan states
 * the version, because "latest" is a moving target — and the simulator reports
 * the version it actually used either way, in the expansion.
 */
export const simulationTemplateRefSchema = z
  .object({
    templateId: templateIdentifierSchema,
    templateVersion: z.number().int().min(1).max(1_000).optional(),
  })
  .strict()

export type SimulationTemplateRef = z.infer<typeof simulationTemplateRefSchema>

/** Who is asking, and whether the section 11 disclosure was confirmed. */
export const simulationProposalSchema = z
  .object({
    /** An identifier, in the same vocabulary `rulePreviewOptionsSchema.actorId` uses. */
    requestedBy: capabilitySchema,
    /**
     * The caller's record that the ADR 0007 section 11 disclosure was shown and
     * confirmed. Absent is reported, not assumed: `previewCompiledRuleSet` treats
     * it the same way, so a dry run and a preview answer identically about whether
     * a pre-approval is live.
     */
    activationConfirmed: z.boolean().optional(),
    templateRef: simulationTemplateRefSchema,
    inputs: z.record(z.string(), z.unknown()),
  })
  .strict()

export type SimulationProposal = z.infer<typeof simulationProposalSchema>

/** The registry, as the projection routing ranks over. Not a registry. */
export const simulationRegistrySnapshotSchema = z
  .object({
    nodes: z.array(routingNodeSnapshotSchema).max(SIMULATION_MAX_NODES),
  })
  .strict()

export type SimulationRegistrySnapshot = z.infer<typeof simulationRegistrySnapshotSchema>

/**
 * Memory and context metadata.
 *
 * A COUNT and the manifests, never a record. ADR 0007 section 12 forbids memory
 * record CONTENT in a rendered artifact, and the only reason this module needs the
 * manifests at all is to report the section 11-style summary of what a dispatch
 * would carry — item counts, categories, the highest sensitivity, the budget, and
 * the manifest's own digest. A summary that could not be produced from the
 * manifest alone is a summary that would have needed the content.
 */
export const simulationMemorySnapshotSchema = z
  .object({
    manifests: z.array(z.unknown()).max(SIMULATION_MAX_MANIFESTS),
    recordCount: z.number().int().nonnegative().safe(),
  })
  .strict()

export type SimulationMemorySnapshot = z.infer<typeof simulationMemorySnapshotSchema>

/** The budget the project is already under, and what the adapter reported. */
export const simulationBudgetInputSchema = z
  .object({
    /** The project's own limits. Composed, never overridden (elementwise `min`). */
    base: budgetLimitsSchema,
    /**
     * The runtime adapter's usage report for the run in progress.
     *
     * Absent means `NO_BUDGET_OBSERVATION`, which is the pessimistic answer:
     * `reportedUsageObservation` exists for a caller that HAS such a report, and a
     * dry run that defaulted to "reliable" would claim an enforcement nobody
     * performed.
     */
    observation: budgetObservationSchema.optional(),
  })
  .strict()

export type SimulationBudgetInput = z.infer<typeof simulationBudgetInputSchema>

/**
 * Is this a `CompiledRuleSet`?
 *
 * A SHAPE guard, not a parser, and the distinction is load-bearing. ADR 0007
 * section 3 makes `compileRuleSet` the only way to produce a compiled set and
 * makes it deep-freeze what it returns; `previewCompiledRuleSet` records the same
 * reasoning for trusting its artifact rather than re-validating it, because
 * re-validating would add a second parser without adding a check. This guard
 * exists only so a caller that hands the simulator an arbitrary object is refused
 * with `simulation.input_invalid` instead of producing a plan that reports a rule
 * set it never read.
 */
function isCompiledRuleSetShaped(value: unknown): value is CompiledRuleSet {
  if (value === null || typeof value !== "object") return false
  const candidate = value as { languageVersion?: unknown; rules?: unknown; limits?: unknown; digest?: unknown }
  if (candidate.languageVersion !== 2) return false
  if (typeof candidate.digest !== "string") return false
  if (candidate.limits === null || typeof candidate.limits !== "object") return false
  return Array.isArray(candidate.rules)
}

/** The compiled rule set, passed through unchanged and validated only for shape. */
const compiledRuleSetGuardSchema = z.custom<CompiledRuleSet>(isCompiledRuleSetShaped, {
  message:
    "A dry run takes a CompiledRuleSet as its one rules artifact (ADR 0007 section 3); an object that is not one cannot be simulated, and re-parsing rule sources here would be the second parser section 3 forbids",
})

/**
 * The whole request.
 *
 * `now` is the injected clock and the ONLY clock. It is a `timestampSchema`
 * string rather than a number because every consumer of it — `previewCompiledRuleSet`,
 * `instantiateTemplate`, `addBudgetSeconds` — takes one, and converting once here
 * beats converting in each planner.
 *
 * `localDispatchNodeId` is the one judgement call in the whole input, and it is
 * here rather than inferred because the honest alternative is worse. A default
 * single-machine install has an empty registry snapshot, so "no node is eligible"
 * is the true answer and reporting it as a rejection for every dispatch would make
 * the plan useless exactly where a dry run is most wanted. When it is `null` and
 * routing selects nothing, the dispatch is REJECTED and every candidate's
 * exclusions are reported. When it is set, the dispatch is planned against it and
 * a `routing_local_fallback` warning says the registry snapshot alone did not
 * justify the target.
 */
export const simulationRequestSchema = z
  .object({
    now: timestampSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    installationId: capabilitySchema,
    projectPathId: projectPathIdSchema,
    /** The controller epoch every planned dispatch would be minted at. */
    controllerEpoch: z.number().int().nonnegative().safe(),
    /** For the correlation a real command would carry. Reported, never invented. */
    correlationId: correlationIdSchema,
    /** `null` means "no local fallback", which is the default-install-safe answer. */
    localDispatchNodeId: nodeIdSchema.nullable(),
    proposal: simulationProposalSchema,
    registry: simulationRegistrySnapshotSchema,
    roles: z.array(roleTemplateSchema).max(SIMULATION_MAX_ROLES),
    rules: compiledRuleSetGuardSchema,
    memory: simulationMemorySnapshotSchema,
    budget: simulationBudgetInputSchema,
  })
  .strict()

export type SimulationRequest = z.infer<typeof simulationRequestSchema>

/**
 * The ports the simulator needs from outside itself.
 *
 * Two, and both are READS. `templates` is a `RunTemplateRepository` because
 * `instantiateTemplate` takes one — it is the only production entry point for
 * expansion, and hand-rolling a snapshot to avoid the repository would be a second
 * expander. The simulator calls `getTemplate` and nothing else, which
 * `tests/unit/simulation/no-side-effects.test.ts` asserts by counting mutations on
 * a subclass.
 *
 * `budgetStore` is the fail-closed `BudgetLedgerStore` fake; see `./sinks.js`.
 */
export interface SimulationPorts {
  readonly templates: RunTemplateRepository
  readonly budgetStore: BudgetLedgerStore & {
    reservationForDispatch(dispatchId: string): BudgetReservation | null
  }
  /**
   * What each role grants, for `instantiateTemplate`'s containment check.
   *
   * Optional because the production entry point makes it optional, and a dry run
   * that invented the default would be deciding a containment question the
   * template's own caller decides. Omitted means the check does not run, and the
   * plan says the role capability check was skipped.
   */
  readonly roleCapabilities?: RoleCapabilityResolver
}

// ===========================================================================
// Budget projection
// ===========================================================================

/**
 * ADR 0007 section 13.1's `BudgetDecision`, projected explicitly.
 *
 * `composeBudgets` returns a `BudgetComposition`, which EXTENDS `BudgetDecision`
 * with a `rejectedWidening` member, and `budgetDecisionSchema` is `.strict()` — so
 * a composition does not parse against the ADR shape and must not be cast to it.
 * This projector copies the three ADR members and nothing else, so the plan
 * carries the ADR's decision and `rejectedWidening` is reported separately, where
 * a reader can see that it is the simulator relaying a decision `src/budgets`
 * already made rather than a narrowing this module applied (I1).
 */
export const budgetDecisionProjectionSchema = z
  .object({
    limits: budgetLimitsSchema,
    enforceability: budgetEnforceabilityRecordSchema,
    warnings: z.array(z.string().min(1)).max(32),
  })
  .strict()

export type BudgetDecisionProjection = z.infer<typeof budgetDecisionProjectionSchema>

/** Projects a `BudgetComposition` onto the ADR's three members. No arithmetic. */
export function toBudgetDecision(composition: { readonly limits: BudgetLimits; readonly enforceability: Readonly<Record<string, BudgetEnforceability>>; readonly warnings: readonly string[] }): BudgetDecisionProjection {
  const projection = budgetDecisionProjectionSchema.safeParse({
    limits: composition.limits,
    enforceability: composition.enforceability,
    warnings: composition.warnings,
  })
  if (!projection.success) {
    // Unreachable for a value `composeBudgets` produced, because that function
    // validates its own output through `budgetDecisionSchema` before returning.
    // Thrown rather than coerced: a coerced budget decision would be a decision
    // whose meaning was settled by this module's tolerance for a bad value.
    throw new Error(
      `a composed budget does not satisfy budgetDecisionProjectionSchema: ${projection.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    )
  }
  return projection.data
}

/** The ADR `BudgetDecision` this projection stands for, re-exported for callers. */
export type { BudgetDecision, BudgetLimits, BudgetObservation, BudgetRefusal, UsageAdmission }

// ===========================================================================
// Vocabulary borrowed, restated, and proved equal
// ===========================================================================

/**
 * The context sensitivity lattice, restated as literals.
 *
 * The authority is `sensitivitySchema` in `src/memory/ontology.ts`, which
 * `src/context/types.ts` uses for `ContextManifestV2`. ADR 0007 section 1 gives
 * `simulation` the edge `context` and not `memory`, so the members are spelled
 * here rather than imported — and the spelling cannot drift silently, because:
 *
 *   1. the array is ANNOTATED with `ContextManifestV2["destination"]["clearance"]`,
 *      so adding, removing or renaming a rung in the memory lattice is a compile
 *      error in this file rather than a runtime mismatch; and
 *   2. `tests/unit/simulation/no-side-effects.test.ts` asserts the runtime
 *      equality of this array with `sensitivitySchema.options`, which is the
 *      check the type annotation cannot make.
 *
 * The alternative — a `simulation -> memory` import for one enum — would add a
 * dependency edge to the milestone's declared shape for the sake of a spelling.
 */
const CONTEXT_SENSITIVITY_MEMBERS = [
  "public_to_project",
  "restricted",
  "secret_reference_only",
  "prohibited",
] as const satisfies readonly ContextManifestV2["destination"]["clearance"][]

/** The `SENSITIVITY_LEVELS` order, which is also the ascending rank order. */
export const CONTEXT_SENSITIVITY_LEVELS: readonly ContextManifestV2["destination"]["clearance"][] =
  CONTEXT_SENSITIVITY_MEMBERS

const contextSensitivitySchema = z.enum(CONTEXT_SENSITIVITY_MEMBERS)

/**
 * `ContextManifestV2.budget.unit`, restated for the same reason and with the same
 * two guards. It is deliberately NOT `src/budgets`' `usageUnitSchema`: a context
 * manifest measures `tokens` or `bytes` and never a provider cost, and a summary
 * that could say `provider_cost_micros` would be describing a measurement the
 * manifest does not carry.
 */
const CONTEXT_MANIFEST_UNITS = ["tokens", "bytes"] as const satisfies readonly z.infer<
  ContextManifestV2["budget"]["unit"]
>[]

const contextManifestUnitSchema = z.enum(CONTEXT_MANIFEST_UNITS)

/**
 * The rank of a sensitivity, for the summary's "highest among the included items".
 *
 * An INDEX into the lattice rather than a table of numbers, so the ordering and the
 * names cannot come apart: adding a rung at the wrong end of the array changes the
 * meaning of "highest" and is caught by the annotation above.
 */
export function contextSensitivityRank(value: ContextManifestV2["destination"]["clearance"]): number {
  return CONTEXT_SENSITIVITY_MEMBERS.indexOf(value)
}

// ===========================================================================
// Plan members
// ===========================================================================

/** The stage a step belongs to: its depth in the dependency DAG, zero-based. */
export const simulationStageSchema = z.number().int().nonnegative().safe()
export type SimulationStage = z.infer<typeof simulationStageSchema>

/**
 * One expanded task.
 *
 * `labelKeys` and never `labelValues`: a bound label value is authored CONTENT
 * (it came from a template parameter), and a plan that carried it would be a plan
 * carrying content, which is I2. The keys are identifiers and are what a dispatch
 * would be FILTERED on, so they are what a reader needs.
 */
export const simulatedTaskSchema = z
  .object({
    stepId: z.string().min(1).max(64),
    taskId: taskIdSchema,
    dispatchId: dispatchIdSchema,
    kind: z.enum(["task", "dispatch"]),
    roleId: roleIdSchema,
    runtimeKind: z.string().min(1).max(128),
    /** Sorted and de-duplicated, by code unit. */
    capabilities: z.array(capabilitySchema).max(128),
    /** Sorted label NAMES. Values are withheld (I2). */
    labelKeys: z.array(capabilitySchema).max(32),
    declaredTimeoutSeconds: z.number().int().min(1).safe(),
    dependsOn: z.array(z.string().min(1).max(64)).max(64),
    stage: simulationStageSchema,
    /** Position in the topological order. A total order, tie-broken by code unit. */
    order: z.number().int().nonnegative().safe(),
  })
  .strict()

export type SimulatedTask = z.infer<typeof simulatedTaskSchema>

/**
 * The dependency graph, in the three forms a reader needs.
 *
 * `stages` is the Kahn layering — every step at depth N, code-unit sorted within
 * a stage — because that is what "can these run at the same time" means.
 * `order` is the flattened total order `resolveStepDependencyGraph` returned,
 * carried verbatim so the plan cannot disagree with the planner about sequence.
 * `edges` is the graph itself, for a reader who wants adjacency rather than order.
 */
export const simulatedGraphSchema = z
  .object({
    order: z.array(z.string().min(1).max(64)).max(64),
    stages: z.array(z.array(z.string().min(1).max(64)).max(64)).max(64),
    edges: z
      .array(
        z
          .object({
            /** The step that must finish first. */
            from: z.string().min(1).max(64),
            /** The step that waits. */
            to: z.string().min(1).max(64),
          })
          .strict(),
      )
      .max(256),
    cycleDetected: z.literal(false),
  })
  .strict()

export type SimulatedGraph = z.infer<typeof simulatedGraphSchema>

/** The template, expanded. */
export const simulatedExpansionSchema = z
  .object({
    templateId: z.string().min(1).max(64),
    templateVersion: z.number().int().min(1).max(1_000),
    /** `computeRunTemplateSnapshotDigest`'s own value, carried verbatim. */
    snapshotDigest: digestSchema,
    /** The template's declared starting rule set, or `null` for "none declared". */
    declaredRuleSetDigest: digestSchema.nullable(),
    tasks: z.array(simulatedTaskSchema).max(64),
    graph: simulatedGraphSchema,
  })
  .strict()

export type SimulatedExpansion = z.infer<typeof simulatedExpansionSchema>

/** The effective role summary: what the role permits, never what it says. */
export const simulatedRoleSummarySchema = z
  .object({
    roleId: roleIdSchema,
    templateVersion: z.number().int().min(1).safe(),
    requiredCapabilities: z.array(capabilitySchema).max(256),
    allowedCapabilities: z.array(capabilitySchema).max(256),
    deniedCapabilities: z.array(capabilitySchema).max(256),
    approvalRequiredCapabilities: z.array(capabilitySchema).max(256),
    requireApprovalForDestructiveEffects: z.boolean(),
    requireApprovalForExternalEffects: z.boolean(),
    preferredRuntimeKinds: z.array(z.string().min(1).max(128)).max(256),
  })
  .strict()

export type SimulatedRoleSummary = z.infer<typeof simulatedRoleSummarySchema>

/**
 * The effective context manifest summary.
 *
 * Counts, categories, the highest sensitivity, the budget and the manifest's own
 * digests. `ContextManifestV2` carries no content — it carries source ids and
 * costs — and this summary carries neither, so it is the intersection of what the
 * manifest has and what a plan may show.
 */
export const simulatedContextSummarySchema = z
  .object({
    manifestId: z.string().min(1).max(128),
    manifestDigest: digestSchema,
    renderedDigest: digestSchema.nullable(),
    roleSnapshotHash: digestSchema,
    policyVersion: z.string().min(1).max(64),
    itemCount: z.number().int().nonnegative().safe(),
    excludedCount: z.number().int().nonnegative().safe(),
    /** Category names present in `items`, sorted and de-duplicated. */
    categories: z.array(z.string().min(1).max(64)).max(32),
    /** The highest sensitivity among `items`, or `null` for an empty manifest. */
    maximumSensitivity: contextSensitivitySchema.nullable(),
    /** The destination's clearance, which bounds what a dispatch may read. */
    clearance: contextSensitivitySchema,
    destinationNodeId: z.string().min(1).max(128),
    destinationRoleId: roleIdSchema,
    /**
     * The manifest's own unit vocabulary — `tokens | bytes` — which is NARROWER
     * than `src/budgets`' `usageUnit`. Stated separately rather than borrowed from
     * the budget module, because reusing a wider enum here would let a context
     * manifest claim a unit only a provider adapter can report.
     */
    budgetUnit: contextManifestUnitSchema,
    budgetEstimated: z.number().int().nonnegative().safe(),
    budgetMaximum: z.number().int().positive().safe(),
  })
  .strict()

export type SimulatedContextSummary = z.infer<typeof simulatedContextSummarySchema>

/** One rule's verdict for one dispatch, copied from `evaluateRules`. */
export const simulatedRuleVerdictSchema = z
  .object({
    ruleId: z.string().min(1).max(128),
    templateVersion: z.number().int().min(1).safe(),
    matchOutcome: z.enum([
      "matched",
      "not_matched",
      "disabled",
      "not_activated",
      "expired",
      "revoked",
      "superseded",
      "project_scope_mismatch",
    ]),
    /**
     * The evaluator's own reason string, verbatim.
     *
     * Permitted by ADR 0007 section 12: a reason authored for the purpose of
     * explaining a decision is exactly what an explanation is allowed to carry.
     */
    reason: z.string().min(1).max(4_096),
  })
  .strict()

export type SimulatedRuleVerdict = z.infer<typeof simulatedRuleVerdictSchema>

/** Routing's answer for one dispatch, copied from `rankNodes`. */
export const simulatedRoutingSchema = z
  .object({
    /** `rankNodes`' own digest over its stable members. */
    digest: digestSchema,
    /**
     * `rankNodes`' own answer, verbatim.
     *
     * `string` rather than `nodeIdSchema`: `RoutingResult.selectedNodeId` is a
     * plain `string | null`, and narrowing the plan to a branded type the source
     * does not claim would be a cast — and a cast here would fail for a node id
     * `rankNodes` legitimately returned.
     */
    selectedNodeId: z.string().min(1).max(128).nullable(),
    /** `rankNodes`' own candidate list, verbatim and already code-unit sorted. */
    candidates: z.array(routingCandidateResultSchema).max(SIMULATION_MAX_NODES),
    preferenceIgnored: z.array(routingIgnoredPreferenceSchema).max(SIMULATION_MAX_NODES),
    demotedNodeIds: z.array(z.string().min(1).max(128)).max(SIMULATION_MAX_NODES),
    preferenceApplied: z.boolean(),
    tieBreakApplied: z.boolean(),
    consideredCount: z.number().int().nonnegative().safe(),
    eligibleCount: z.number().int().nonnegative().safe(),
    excludedCount: z.number().int().nonnegative().safe(),
  })
  .strict()

export type SimulatedRouting = z.infer<typeof simulatedRoutingSchema>

/** The effective policy state, projected onto the members a plan may show. */
export const simulatedPolicySchema = z
  .object({
    /** `evaluatePolicy`'s own `decisionDigest`. */
    decisionDigest: digestSchema,
    envelopeDigest: digestSchema,
    decision: z.enum(["allow", "require_approval", "deny"]),
    allowed: z.boolean(),
    declaredTimeoutSeconds: z.number().int().positive().safe(),
    effectiveTimeoutSeconds: z.number().int().positive().safe(),
    allowedCapabilities: z.array(capabilitySchema).max(256),
    deniedCapabilities: z.array(capabilitySchema).max(256),
    approvalRequiredCapabilities: z.array(capabilitySchema).max(256),
    /** Layer ids demanding a dispatch approval, in the kernel's own order. */
    dispatchApprovalDemands: z.array(z.string().min(1).max(64)).max(8),
    requireApprovalForDestructiveEffects: z.boolean(),
    requireApprovalForExternalEffects: z.boolean(),
    maximumTimeoutSeconds: z.number().int().positive().safe(),
    grantedPreApprovals: z.array(capabilitySchema).max(256),
    preApprovalBasis: z
      .object({
        /** `PreApprovalBasis`, which is `ruleIdSchema`-branded upstream. */
        ruleId: ruleIdSchema,
        ruleVersion: z.number().int().min(1).safe(),
      })
      .strict()
      .nullable(),
    outstandingApprovals: z.array(z.string().min(1).max(256)).max(256),
    denials: z
      .array(
        z
          .object({
            code: z.string().min(1).max(128),
            message: z.string().min(1).max(4_096),
            capabilities: z.array(capabilitySchema).max(256),
            layer: z.string().min(1).max(64).optional(),
            subject: z.string().min(1).max(256).optional(),
          })
          .strict(),
      )
      .max(256),
    /** The kernel's root widening attempts, sorted and de-duplicated. */
    wideningAttempts: z.array(z.string().min(1).max(4_096)).max(64),
  })
  .strict()

export type SimulatedPolicy = z.infer<typeof simulatedPolicySchema>

/**
 * The reservation a dispatch WOULD hold.
 *
 * `state` is a literal `"held"` because that is the only state that makes a
 * dispatch eligible, and reporting any other state would be a claim about capacity
 * this module did not consume. The value is `src/budgets`' own
 * `BudgetReservation`, validated through its own schema — so it is the shape the
 * ledger would have written, and the plan says the ledger decided it while the
 * store retained nothing.
 */
export const simulatedReservationSchema = budgetReservationSchema
export type SimulatedReservation = z.infer<typeof simulatedReservationSchema>

/**
 * What the budget gate said about one dispatch.
 *
 * `usage` is `admitUsage`'s own `UsageAdmission`, passed through a SHAPE GUARD
 * rather than restated as a schema, for the reason `compiledRuleSetGuardSchema`
 * exists: `src/budgets` declares the admission as a TypeScript union and publishes
 * no schema for it, and re-declaring its members here would be a second copy of a
 * decision another module owns. The guard exists so a garbage value is refused
 * rather than carried into a digest.
 */
export const simulatedBudgetPlanSchema = z
  .object({
    /** The composed decision for THIS dispatch's contributions. */
    decision: budgetDecisionProjectionSchema,
    /** The contributions handed to `composeBudgets`, in the order supplied. */
    contributions: z
      .array(
        z
          .object({
            /** A rule-set digest, a template ref, or a step id. Never free text. */
            source: z.string().min(1).max(256),
            limits: budgetLimitsSchema,
          })
          .strict(),
      )
      .max(32),
    /** `composeBudgets`' own `rejectedWidening`, relayed, never re-derived. */
    rejectedWidening: z
      .array(
        z
          .object({
            source: z.string().min(1).max(256),
            field: z.string().min(1).max(64),
            attempted: z.number().int().safe(),
            current: z.number().int().safe(),
          })
          .strict(),
      )
      .max(32),
    /** `admitUsage`'s own answer, verbatim. */
    usage: z.custom<UsageAdmission>(isUsageAdmissionShaped, {
      message: "A dry run relays `admitUsage`'s own `UsageAdmission`; a value that is not one cannot be reported as one",
    }),
    /** The scope the reservation was sought against. */
    scope: budgetScopeSchema,
    /** `null` when the gate refused; the refusal is then populated. */
    reservation: simulatedReservationSchema.nullable(),
    refusal: budgetRefusalSchema.nullable(),
    /** Always `true`: nothing was retained. Recorded, not asserted in prose. */
    reserved: z.literal(false),
  })
  .strict()

/** Is this an `admitUsage` answer? A shape guard, not a re-derivation. */
function isUsageAdmissionShaped(value: unknown): value is UsageAdmission {
  if (value === null || typeof value !== "object") return false
  const candidate = value as {
    admitted?: unknown
    enforceability?: unknown
    reason?: unknown
    warnings?: unknown
    observed?: unknown
    refusal?: unknown
  }
  if (typeof candidate.admitted !== "boolean") return false
  if (candidate.enforceability !== "enforceable" && candidate.enforceability !== "not_enforceable") return false
  if (typeof candidate.reason !== "string" || candidate.reason.length === 0) return false
  if (!Array.isArray(candidate.warnings)) return false
  if (candidate.observed === null || typeof candidate.observed !== "object") return false
  // The refusal is required exactly when the answer refuses, and absent otherwise —
  // the same constraint the union states, checked here because there is no schema to
  // check it with.
  if (candidate.admitted) return candidate.refusal === undefined
  return candidate.refusal !== null && typeof candidate.refusal === "object"
}

export type SimulatedBudgetPlan = z.infer<typeof simulatedBudgetPlanSchema>

/** One required approval. */
export const simulatedApprovalRequirementSchema = z
  .object({
    dispatchId: dispatchIdSchema,
    stepId: z.string().min(1).max(64),
    /** `evaluatePolicy`'s own outstanding-approval strings, verbatim. */
    outstanding: z.array(z.string().min(1).max(256)).max(256),
    required: z.boolean(),
  })
  .strict()

export type SimulatedApprovalRequirement = z.infer<typeof simulatedApprovalRequirementSchema>

/** One matched pre-approval, with the basis the kernel actually granted it by. */
export const simulatedPreApprovalMatchSchema = z
  .object({
    dispatchId: dispatchIdSchema,
    stepId: z.string().min(1).max(64),
    /**
     * `null` when the M6 evaluator named a grant candidate but the kernel's own
     * post-narrowing re-check did not grant it. Reported as a distinct value
     * rather than as "no pre-approval", because the two are different facts and
     * conflating them would report the evaluator as the grantor.
     */
    ruleId: z.string().min(1).max(128).nullable(),
    templateVersion: z.number().int().min(1).safe().nullable(),
    capabilities: z.array(capabilitySchema).max(256),
    /** `evaluateRules`' candidates, verbatim, so a reader sees why it did not grant. */
    candidates: z
      .array(
        z
          .object({
            ruleId: z.string().min(1).max(128),
            templateVersion: z.number().int().min(1).safe(),
            boundsSatisfied: z.boolean(),
            reason: z.string().min(1).max(4_096),
          })
          .strict(),
      )
      .max(32),
    granted: z.boolean(),
  })
  .strict()

export type SimulatedPreApprovalMatch = z.infer<typeof simulatedPreApprovalMatchSchema>

/** Work the real run would refuse, with the refusing module's own code. */
export const simulatedRejectionSchema = z
  .object({
    dispatchId: dispatchIdSchema,
    stepId: z.string().min(1).max(64),
    stage: z.enum(["expansion", "rules", "routing", "policy", "budget"]),
    /** The refusing module's code: `workflow.*`, `routing.*`, `policy.*`, `budget.*`. */
    code: z.string().min(1).max(128),
    reason: z.string().min(1).max(4_096),
    /** Sorted rule ids, when a rule layer is what refused. */
    ruleIds: z.array(z.string().min(1).max(128)).max(64),
  })
  .strict()

export type SimulatedRejection = z.infer<typeof simulatedRejectionSchema>

/** One planned dispatch: the whole answer for one step. */
export const simulatedDispatchSchema = z
  .object({
    task: simulatedTaskSchema,
    role: simulatedRoleSummarySchema.nullable(),
    rules: z
      .object({
        /** `evaluateRules`' `decisionDigest`, carried verbatim. */
        decisionDigest: digestSchema,
        verdicts: z.array(simulatedRuleVerdictSchema).max(64),
        /** `null` when no deny rule matched. */
        denied: z
          .object({
            ruleIds: z.array(z.string().min(1).max(128)).max(64),
            reason: z.string().min(1).max(4_096),
          })
          .strict()
          .nullable(),
        /** The M6 composition's members a plan may show. */
        restrictions: z
          .object({
            deniedCapabilities: z.array(capabilitySchema).max(256),
            requireApprovalForDispatch: z.boolean(),
            requireApprovalForCapabilities: z.array(capabilitySchema).max(256),
            maximumTimeoutSeconds: z.number().int().min(1).safe().nullable(),
          })
          .strict(),
        /** `ruleSet`-relative, so a reader can see which set decided. */
        ruleSetDigest: digestSchema,
      })
      .strict(),
    /** `null` when the rule layer denied and no policy evaluation was possible. */
    policy: simulatedPolicySchema.nullable(),
    /** `null` when routing refused to name a target. */
    routing: simulatedRoutingSchema.nullable(),
    context: simulatedContextSummarySchema.nullable(),
    budget: simulatedBudgetPlanSchema,
    approval: simulatedApprovalRequirementSchema,
    preApproval: simulatedPreApprovalMatchSchema.nullable(),
    rejection: simulatedRejectionSchema.nullable(),
  })
  .strict()

export type SimulatedDispatch = z.infer<typeof simulatedDispatchSchema>

/**
 * One node's health, for the plan's registry summary.
 *
 * `healthReason` is routing's own closed enum. `displayName` is DELIBERATELY
 * ABSENT: it is the one free-text field on `RoutingNodeSnapshot`, and a plan that
 * carried it would carry node-supplied content (I2, and routing's own I6).
 */
export const simulatedNodeSummarySchema = z
  .object({
    nodeId: nodeIdSchema,
    healthy: z.boolean(),
    healthReason: routingHealthReasonSchema,
    runtimeKinds: z.array(z.string().min(1).max(128)).max(128),
    capabilities: z.array(capabilitySchema).max(256),
    projectPathIds: z.array(z.string().min(1).max(128)).max(256),
    activeSessions: z.number().int().nonnegative().safe().nullable(),
    maxConcurrentSessions: z.number().int().nonnegative().safe().nullable(),
    /** A routing exclusion code this node carries, or `null` when eligible. */
    excludedBy: z.string().min(1).max(64).nullable(),
  })
  .strict()

export type SimulatedNodeSummary = z.infer<typeof simulatedNodeSummarySchema>
