/**
 * M6.7 — template expansion, by the production expander.
 *
 * # What this file is
 *
 * The first third of ADR 0007 section 16's answer: the expanded tasks and the
 * dependency graph. It is small, and it is small on purpose, because the whole
 * point of the milestone is that this file contains no expander.
 *
 * Exactly three production functions are called:
 *
 *   - `instantiateTemplate` (`src/workflows/instantiate.ts`) — the ONLY way a
 *     template becomes a run snapshot. Every refusal it raises, including a cycle,
 *     an unbound label, a capability above the role's grant, and a timeout past the
 *     safety floor, arrives here unchanged and is relayed with its `workflow.*`
 *     code intact. This module does not bind a parameter, does not resolve a label,
 *     does not check role containment, does not compute a digest, and does not
 *     decide that a graph is ordered.
 *   - `resolveStepDependencyGraph` (`src/workflows/instantiate.ts`) — the ONLY
 *     ordering and cycle check, called on the RESOLVED steps so the order the plan
 *     reports is the order a scheduler would receive. `tests/unit/workflows/
 *     instantiate.test.ts` already pins this function's verdicts against the
 *     scheduler's own `validateDag`; this module only carries the answer.
 *   - `findStepDependencyCycle` (`src/workflows/types.ts`) — called on the REJECTED
 *     path, and only to name the offending step ids in a structured field. ADR 0007
 *     section 16's requirement is that "a cycle is refused with the offending ids",
 *     and `resolveStepDependencyGraph`'s message contains them as prose; a plan whose
 *     only record of a cycle is a sentence cannot be asserted on, so the ids are
 *     lifted out by the same detector that found them rather than by a second
 *     traversal. It is the reason the plan carries `refusal.detail.cycleStepIds`
 *     and the reason the graph's `cycleDetected` member is a `z.literal(false)`: a
 *     plan with a cycle in it is not a plan, it is a refusal.
 *
 * # Named invariants
 *
 * - **E1 — The order is the planner's, verbatim.** `SimulatedExpansion.graph.order`
 *   is `resolveStepDependencyGraph`'s return value, unmodified and unre-sorted. A
 *   simulator that re-sorted the order would be a second scheduler, and a second
 *   scheduler is exactly the divergence ADR 0007 stop condition 1 describes.
 * - **E2 — Stages are a projection of the order, not a second ordering.** `stages`
 *   is the Kahn layering — every step at depth `N`, code-unit sorted within a
 *   stage — derived from the resolved steps' own `dependsOn`. It answers "which
 *   steps could run at the same time", which the total order does not.
 * - **E3 — Ids are derived, never minted (ADR 0007 `types.ts` I8).** `taskId`,
 *   `dispatchId` and `reservationId` are functions of the step id. No clock, no
 *   randomness, no counter that survives between calls, so two invocations over the
 *   same template produce the same ids and the same digest.
 * - **E4 — No content leaves the snapshot (ADR 0007 `types.ts` I2).** A `ResolvedStep`
 *   carries `title` and `labelValues`; neither reaches a `SimulatedTask`. What
 *   reaches it is `labelKeys` — the label NAMES, which are identifiers and are what
 *   a dispatch is filtered on. The title is reachable only through the dispatch
 *   envelope the envelope needs, and the envelope's own `envelopeDigest` is what the
 *   plan reports.
 * - **E5 — The digest is the expander's.** `SimulatedExpansion.snapshotDigest` is
 *   `RunTemplateSnapshot.snapshotDigest`, which `instantiateTemplate` computed with
 *   `computeRunTemplateSnapshotDigest`. This module does not recompute it, so a
 *   reader can verify an instantiated snapshot against the plan with the same
 *   function that produced it.
 *
 * # Stop conditions
 *
 * - **S1 — If a needed fact about the template is not on `RunTemplateSnapshot`, it
 *   does not get computed here.** It gets added to the snapshot by `src/workflows/`,
 *   because a fact only the simulator can derive is a fact the real run does not
 *   have, and a plan built from facts the run lacks is a plan of something else.
 * - **S2 — If `resolveStepDependencyGraph` and this module ever disagree about the
 *   order, stop.** They cannot, because there is only one of them; the assertion
 *   `tests/unit/simulation/expand.test.ts` makes is that the plan's `order` is
 *   element-wise equal to a fresh call, so a future edit here that re-sorted it
 *   would fail rather than pass unnoticed.
 */

import { dispatchIdSchema, taskIdSchema } from "../orchestration/identifiers.js"
import { createContractError } from "../orchestration/errors.js"
import {
  findStepDependencyCycle,
  instantiateTemplate,
  resolveStepDependencyGraph,
  WorkflowTemplateError,
  type ResolvedStep,
  type RunTemplate,
  type RunTemplateSnapshot,
} from "../workflows/index.js"
import {
  simulatedExpansionSchema,
  simulatedGraphSchema,
  simulatedTaskSchema,
  simulationRefuse,
  type SimulatedExpansion,
  type SimulatedTask,
  type SimulationPorts,
  type SimulationRefusalCode,
  type SimulationResult,
  type SimulationTemplateRef,
} from "./types.js"

// ===========================================================================
// Derived identifiers
// ===========================================================================

/**
 * The prefix every derived id carries.
 *
 * Prefixed rather than bare so a reader can tell a PROPOSED id from a minted one at
 * a glance, which is the whole of the known limitation `types.ts` I8 records. The
 * prefixes use `:` from inside the kernel's opaque-id alphabet
 * (`^[A-Za-z0-9][A-Za-z0-9._:-]*$`), so a derived id passes exactly the identifier
 * schemas a real id does — a derived id that could not be a real id would be
 * useless for correlating a plan with a run.
 */
const TASK_ID_PREFIX = "task:"
const DISPATCH_ID_PREFIX = "disp:"

/** The task id for a step. `~` is inside the opaque-id alphabet and outside a path. */
export function derivedTaskId(stepId: string): string {
  return taskIdSchema.parse(`${TASK_ID_PREFIX}${stepId}`)
}

/** The dispatch id for a step. Same discipline as `derivedTaskId`. */
export function derivedDispatchId(stepId: string): string {
  return dispatchIdSchema.parse(`${DISPATCH_ID_PREFIX}${stepId}`)
}

// ===========================================================================
// The request
// ===========================================================================

/** Everything expansion needs, and nothing it does not. */
export interface ExpansionRequest {
  /** The injected clock. Becomes the snapshot's `capturedAt` and nothing else. */
  readonly now: string
  readonly templateRef: SimulationTemplateRef
  readonly inputs: Readonly<Record<string, unknown>>
  /** The project's own id, checked against the template's. */
  readonly projectId: string
  /** The compiled rule set's digest, for the template's declared-digest comparison. */
  readonly ruleSetDigest: string
}

// ===========================================================================
// Stages
// ===========================================================================

/**
 * The Kahn layering, code-unit sorted within each stage.
 *
 * Depth of a step is `0` when it depends on nothing and otherwise
 * `1 + max(depth(dependency))`. That is the LONGEST path from a root, which is the
 * number a reader wants: a step at stage 2 cannot start until everything on the
 * path to it has finished, so it is the earliest it could possibly run. A shortest
 * path would understate the wait, and a stage grouping computed from the total
 * order would be a guess.
 *
 * Unreachable steps (a cycle) are omitted, because the only caller that can reach
 * this function with one already refused.
 */
function stageByStepId(steps: readonly ResolvedStep[]): ReadonlyMap<string, number> {
  const dependencies = new Map(steps.map((step) => [step.stepId, [...step.dependsOn].sort()]))
  const depths = new Map<string, number>()

  const depthOf = (stepId: string, visiting: ReadonlySet<string>): number => {
    const cached = depths.get(stepId)
    if (cached !== undefined) return cached
    if (visiting.has(stepId)) return 0
    const parents = dependencies.get(stepId) ?? []
    if (parents.length === 0) {
      depths.set(stepId, 0)
      return 0
    }
    const next = new Set(visiting)
    next.add(stepId)
    const depth = 1 + Math.max(...parents.map((parent) => depthOf(parent, next)))
    depths.set(stepId, depth)
    return depth
  }

  for (const stepId of [...dependencies.keys()].sort()) depthOf(stepId, new Set())
  return depths
}

/** The stages themselves: `stages[n]` is every step at depth `n`, code-unit sorted. */
function stagesOf(depths: ReadonlyMap<string, number>, stepIds: readonly string[]): string[][] {
  const widest = Math.max(0, ...stepIds.map((stepId) => depths.get(stepId) ?? 0))
  const stages: string[][] = []
  for (let depth = 0; depth <= widest; depth += 1) {
    stages.push(stepIds.filter((stepId) => (depths.get(stepId) ?? 0) === depth).sort())
  }
  return stages
}

/** The edges, `(dependency, dependent)`, sorted by `from` then `to`. */
function edgesOf(steps: readonly ResolvedStep[]): { from: string; to: string }[] {
  const edges: { from: string; to: string }[] = []
  for (const step of steps) {
    for (const dependency of [...step.dependsOn].sort()) edges.push({ from: dependency, to: step.stepId })
  }
  return edges.sort((left, right) => {
    if (left.from !== right.from) return left.from < right.from ? -1 : 1
    if (left.to === right.to) return 0
    return left.to < right.to ? -1 : 1
  })
}

// ===========================================================================
// Expansion
// ===========================================================================

/**
 * The outcome of an expansion.
 *
 * TWO members, and the second is deliberately not in the plan. `expansion` is the
 * reported, schema-validated artifact — identifiers, digests, capabilities, order,
 * nothing else. `snapshot` is the production `RunTemplateSnapshot` the expander
 * produced, carried so `./plan.js` can build a `DispatchEnvelope` from it: the
 * envelope schema REQUIRES a `prompt`, and the only prompt a dry run has is the
 * step's title.
 *
 * That is the one place a plan's inputs hold content, and it is a place content has
 * to be: the M0 envelope cannot be built without it, so refusing to hold it would
 * mean refusing to call `evaluatePolicy`, which is the milestone's headline
 * composition. The content stops at the envelope. What reaches the plan is the
 * envelope's `envelopeDigest`, and `auditDryRunPlanForSecrets` asserts that no
 * seeded content appears in the plan, its `lines`, or its `explanationText`.
 */
export interface ExpansionOutcome {
  readonly expansion: SimulatedExpansion
  readonly snapshot: RunTemplateSnapshot
}

/**
 * Expands a template into tasks, a graph, and a digest.
 *
 * Returns a `SimulationResult` rather than throwing for every expected failure,
 * because every failure here is a decision about an authored document and the
 * caller — the TUI, a bridge handler, this milestone's integration tests — wants to
 * render the refusal rather than catch it. `instantiateTemplate` already returns a
 * `Result` for exactly this reason, and relaying it is the whole of this function's
 * error handling.
 */
export function expandRunTemplate(ports: SimulationPorts, request: ExpansionRequest): SimulationResult<ExpansionOutcome> {
  // The AUTHORED template, read once. Two things need it and neither is a decision
  // this module may make from anything else: the project scope (which the
  // instantiated snapshot does not carry — `runTemplateSnapshotSchema` has no
  // `projectId` member) and, on the refusal path, the offending cycle ids. The
  // not-found decision is NOT made here; `instantiateTemplate` owns it.
  const authored = readAuthoredTemplate(ports, request)

  // A template is scoped to one project, and nothing downstream can catch a
  // mismatch: the M0 envelope cross-checks its role and rule snapshots against the
  // envelope's project, and a template is neither. So the check is here, with a
  // simulation-level code because no owning module raises one.
  if (authored !== null && authored.projectId !== request.projectId) {
    return simulationRefuse(
      "simulation.project_scope_mismatch",
      `The proposed workflow's template belongs to project '${authored.projectId}', and this run is for project '${request.projectId}'; a template is scoped to one project and the two cannot be reconciled by a dry run`,
      {
        origin: null,
        detail: { templateId: authored.templateId, templateProject: authored.projectId, runProject: request.projectId },
      },
    )
  }

  // ==== the one expander ====
  // Wrapped because `RunTemplateRepository` THROWS (`WorkflowTemplateError`) where
  // `instantiateTemplate` returns a `Result`, and a repository implementation that
  // did not validate a document on registration can throw from `getTemplate` too.
  // A dry run that crashed on a malformed snapshot would be a dry run a caller
  // cannot render, so the throw is converted to a refusal with the same code the
  // `Result` path would have carried.
  const instantiated = instantiateSafely(ports, request)
  if (!instantiated.ok) {
    // The offending ids have to be STRUCTURED, not only prose: a refusal whose only
    // record of a cycle is a sentence cannot be asserted on, and ADR 0007
    // section 16 requires the refusal to name them. The ids come from
    // `findStepDependencyCycle` — the same detector `resolveStepDependencyGraph`
    // uses, run over the AUTHORED steps, because instantiation refused before it
    // produced a resolved snapshot to inspect.
    const cycle = authored === null ? null : findStepDependencyCycle(authored.steps)
    if (cycle !== null) {
      return simulationRefuse(
        "simulation.dependency_cycle",
        `The proposed workflow's dependency graph is not a DAG, so it was not expanded: ${instantiated.error.message}`,
        {
          origin: instantiated.error.code,
          detail: {
            templateId: request.templateRef.templateId,
            templateVersion: String(request.templateRef.templateVersion ?? "latest"),
            cycleType: cycle.cycleType,
            cycleStepIds: cycle.cycle.join(","),
          },
        },
      )
    }
    return simulationRefuse(
      "simulation.template_not_instantiable",
      `The proposed workflow could not be instantiated, so nothing was expanded: ${instantiated.error.message}`,
      {
        origin: instantiated.error.code,
        detail: {
          templateId: request.templateRef.templateId,
          templateVersion: String(request.templateRef.templateVersion ?? "latest"),
          category: instantiated.error.category,
        },
      },
    )
  }
  const snapshot: RunTemplateSnapshot = instantiated.value

  // ==== the one ordering, on the RESOLVED graph ====
  // The ORDER comes from here and is carried verbatim (E1). The refusal branch is
  // unreachable for any snapshot `instantiateTemplate` produced, because that
  // function re-checks the resolved graph itself and returns a `Result` — the same
  // defence-in-depth pattern `resolveStepDependencyGraph` documents internally. It
  // is kept because a graph check that can be defeated by an arithmetic slip is not
  // a check, and because a caller supplying a hand-built `ExpansionOutcome`-shaped
  // snapshot is a case this file's types permit.
  const graph = resolveStepDependencyGraph(snapshot.resolvedSteps)
  if (!graph.ok) {
    const cycle = findStepDependencyCycle(snapshot.resolvedSteps)
    return simulationRefuse(
      "simulation.dependency_cycle",
      `The proposed workflow's dependency graph is not a DAG, so it was not expanded: ${graph.error.message}`,
      {
        origin: graph.error.code,
        detail: {
          templateId: snapshot.templateId,
          templateVersion: String(snapshot.templateVersion),
          cycleType: cycle?.cycleType ?? "unknown",
          cycleStepIds: cycle === null ? "" : cycle.cycle.join(","),
        },
      },
    )
  }

  // ---- the derived projections ----
  const order = graph.value
  const depths = stageByStepId(snapshot.resolvedSteps)
  const stages = stagesOf(depths, order)
  const parsedGraph = simulatedGraphSchema.safeParse({
    order: [...order],
    stages,
    edges: edgesOf(snapshot.resolvedSteps),
    // A literal, not a boolean: a plan that could carry `cycleDetected: true` would
    // be a plan describing a graph it refuses to schedule, and the type would
    // permit it. The refusal above is where a cycle lives.
    cycleDetected: false as const,
  })
  if (!parsedGraph.success) {
    return internalFailure("the derived dependency graph does not satisfy simulatedGraphSchema", parsedGraph.error.issues)
  }

  const tasks: SimulatedTask[] = []
  for (const [index, stepId] of order.entries()) {
    const step = snapshot.resolvedSteps.find((candidate) => candidate.stepId === stepId)
    // Unreachable for an order the graph function returned over these very steps,
    // and checked rather than indexed because an `undefined` step would otherwise
    // become a task with no role and no capabilities — a plan entry that looks
    // complete and is not.
    if (step === undefined) {
      return internalFailure(`the ordering named step '${stepId}', which is not a step of the instantiated snapshot`, [
        { path: [stepId], message: "no such step" },
      ])
    }
    const task = simulatedTaskSchema.safeParse({
      stepId: step.stepId,
      taskId: derivedTaskId(step.stepId),
      dispatchId: derivedDispatchId(step.stepId),
      kind: step.kind,
      roleId: step.roleId,
      runtimeKind: step.runtimeKind,
      capabilities: [...step.capabilities],
      // NAMES, not values (E4).
      labelKeys: Object.keys(step.labelValues).sort(),
      declaredTimeoutSeconds: step.timeoutSeconds,
      dependsOn: [...step.dependsOn].sort(),
      stage: depths.get(stepId) ?? 0,
      order: index,
    })
    if (!task.success) {
      return internalFailure(`the expansion of step '${stepId}' does not satisfy simulatedTaskSchema`, task.error.issues)
    }
    tasks.push(task.data)
  }

  const expansion = simulatedExpansionSchema.safeParse({
    templateId: snapshot.templateId,
    templateVersion: snapshot.templateVersion,
    snapshotDigest: snapshot.snapshotDigest,
    declaredRuleSetDigest: snapshot.ruleSetDigest,
    tasks,
    graph: parsedGraph.data,
  })
  if (!expansion.success) {
    return internalFailure("the derived expansion does not satisfy simulatedExpansionSchema", expansion.error.issues)
  }
  return { ok: true, value: { expansion: expansion.data, snapshot } }
}

/**
 * `instantiateTemplate`, with its throws converted to `Result`s.
 *
 * `RunTemplateRepository` throws `WorkflowTemplateError` (its documented split: a
 * missing template is a programming error at the call site, an invalid document is
 * a user-visible outcome) while `instantiateTemplate` returns a `Result`. A
 * simulator's caller wants to RENDER a refusal, so the throw is caught here and
 * mapped onto the same `ContractError` shape the `Result` path carries — which is
 * exactly what `WorkflowTemplateError.toContractError` produces, so the two paths
 * are indistinguishable to a caller.
 */
function instantiateSafely(
  ports: SimulationPorts,
  request: ExpansionRequest,
): ReturnType<typeof instantiateTemplate> {
  try {
    return instantiateTemplate(
      ports.templates,
      request.templateRef,
      request.inputs,
      ports.roleCapabilities === undefined ? { now: request.now } : { now: request.now, roleCapabilities: ports.roleCapabilities },
    )
  } catch (error) {
    if (error instanceof WorkflowTemplateError) {
      return { ok: false, error: error.toContractError() }
    }
    return {
      ok: false,
      error: createContractError(
        "validation",
        "workflow.invalid_template",
        `Instantiating the proposed workflow raised an unexpected error, which is refused rather than thrown: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4_096),
      ),
    }
  }
}

/**
 * The AUTHORED template, or `null`.
 *
 * A read of the same repository `instantiateTemplate` will read, performed because
 * two of this function's answers need the document as authored: the project scope
 * (which the instantiated snapshot does not carry) and the cycle ids (which exist
 * only on a document that failed to instantiate). A repository that cannot be read
 * yields `null` and the instantiation refusal stands on its own — a diagnostic that
 * cannot be reached must not become the reason a request is refused.
 */
function readAuthoredTemplate(ports: SimulationPorts, request: ExpansionRequest): RunTemplate | null {
  try {
    return ports.templates.getTemplate(request.templateRef) ?? null
  } catch {
    return null
  }
}

/**
 * A refusal for a value this module assembled that its own schema refuses.
 *
 * `internal_failure` and not a decision about the request: a plan that does not
 * parse is a bug in the simulator, and reporting it as `simulation.input_invalid`
 * would send a reader looking at their snapshot instead of at the code.
 */
function internalFailure(
  message: string,
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): SimulationResult<never> {
  return simulationRefuse(
    "simulation.internal_failure",
    `simulation.internal_failure: ${message}: ${issues
      .map((issue) => `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`)
      .join("; ")}`,
  )
}

export type { SimulationRefusalCode }
