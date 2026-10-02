/**
 * Shared fixtures for `tests/unit/simulation/`.
 *
 * # WHY these live in one file
 *
 * Every test in this directory needs a valid registry snapshot, a valid role
 * snapshot, a compiled rule set, a context manifest and a valid dry-run request,
 * and a fixture that differs subtly between files is a fixture whose differences
 * nobody can account for. Every builder applies its overrides at the TOP level and
 * validates through the OWNING module's schema before returning — a registry
 * snapshot that has drifted out of `routingNodeSnapshotSchema` is then a loud
 * failure at the first test that uses it rather than a subtly wrong input to the
 * simulator.
 *
 * # The one clock, injected everywhere
 *
 * `FIXED_NOW` is the only instant any fixture mentions. A fixture that called
 * `new Date()` would make every determinism assertion in this directory depend on
 * when the suite ran, which is the exact failure mode `plan.ts` invariant P6
 * forbids.
 *
 * # The default installation is a fixture, not a special case
 *
 * `emptyRuleSet()` is `compileRuleSet([])`: a compiled set with zero rules, which
 * is what ADR 0007 section 18 says a default installation ships. The milestone's
 * headline guarantee — every dispatch demands approval — is only testable against
 * that shape, so it is the DEFAULT for `aRequest()` rather than something a test
 * has to remember to opt into.
 */

import { compileRuleSet, ruleSourceDocumentSchema, type CompiledRuleSet, type RuleSourceDocument } from "../../../src/rules/index.js"
import { contextManifestV2Schema, type ContextManifestV2 } from "../../../src/context/types.js"
import { digestJson } from "../../../src/orchestration/digest.js"
import {
  correlationIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  roleIdSchema,
  runIdSchema,
  userIdSchema,
  type NodeId,
} from "../../../src/orchestration/identifiers.js"
import { roleTemplateSchema } from "../../../src/orchestration/schemas.js"
import { routingNodeSnapshotSchema, type RoutingNodeSnapshot } from "../../../src/routing/index.js"
import { RunTemplateRepository, type RunTemplateInput } from "../../../src/workflows/index.js"
import {
  createBudgetLedgerProbe,
  emptySinkTally,
  type BudgetStoreProbe,
  type SimulationPorts,
  type SimulationSinkTally,
} from "../../../src/simulation/index.js"

// ===========================================================================
// Identity and time
// ===========================================================================

export const PROJECT_ID = projectIdSchema.parse("proj-sim")
export const RUN_ID = runIdSchema.parse("run-sim-1")
export const PROJECT_PATH_ID = projectPathIdSchema.parse("path-sim-1")
export const ROLE_ID = roleIdSchema.parse("role-sim")
export const USER_ID = userIdSchema.parse("user-sim")
export const CORRELATION_ID = correlationIdSchema.parse("corr-sim-1")
export const INSTALLATION_ID = "inst-sim-1"

/** The injected instant. Every fixture uses this one and only this one. */
export const FIXED_NOW = "2026-05-04T09:30:00Z"

/** A second instant, for the tests that need two distinct clocks. */
export const LATER_NOW = "2026-05-05T18:00:00Z"

/** The capabilities every fixture role grants. */
export const ROLE_CAPABILITIES = ["fs.read", "fs.write", "shell.run"] as const

// ===========================================================================
// Rules
// ===========================================================================

/**
 * The DEFAULT INSTALLATION: a compiled set with zero rules.
 *
 * `compileRuleSet([])` is the real compiler, not a hand-built empty object, so the
 * digest, the limits and the deep freeze are the ones production would produce. A
 * fixture that hand-wrote `{ languageVersion: 2, rules: [], ... }` would be testing
 * the simulator against an artifact the compiler never emits.
 */
export function emptyRuleSet(): CompiledRuleSet {
  const compiled = compileRuleSet([])
  if (!compiled.ok) throw new Error(`compileRuleSet([]) was refused: ${compiled.error.code} — ${compiled.error.message}`)
  return compiled.value
}

/** A valid rule document, for the tests that need a rule to exist. */
export function aRuleDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleSourceDocumentSchema.parse({
    languageVersion: 2,
    ruleId: "rule-sim-1",
    templateVersion: 1,
    projectId: PROJECT_ID,
    name: "require approval for every dispatch in this project",
    description: "A narrowing rule scoped to one project.",
    enabled: true,
    activation: { state: "activated", activatedAt: "2026-01-01T00:00:00Z", activatedBy: { kind: "user", userId: USER_ID } },
    predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
    actions: [{ kind: "require_approval", requireApprovalForDispatch: true }],
    expiresAt: null,
    author: { kind: "user", userId: USER_ID },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  })
}

/** A `deny_with_reason` rule, so the "rejected work" path has a subject. */
export function aDenyDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return aRuleDocument({
    ruleId: "rule-sim-deny",
    name: "deny every dispatch in this project",
    actions: [{ kind: "deny_with_reason", reason: "the simulation project freezes all dispatches" }],
    ...overrides,
  })
}

/** A `set_stricter_budget` rule, so the budget section has a rule contribution. */
export function aBudgetDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return aRuleDocument({
    ruleId: "rule-sim-budget",
    name: "cap fan out at two",
    actions: [{ kind: "set_stricter_budget", budget: { maximumFanOut: 2 } }],
    ...overrides,
  })
}

/** A `select_routing_preference` rule, so the routing section has a preference. */
export function aRoutingDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return aRuleDocument({
    ruleId: "rule-sim-route",
    name: "prefer node-b for this project",
    actions: [{ kind: "select_routing_preference", preference: { preferredNodeIds: ["node-b"] } }],
    ...overrides,
  })
}

/** A `pre_approve_within_bounds` rule, so the pre-approval path has a disclosure. */
export function aPreApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return aRuleDocument({
    ruleId: "rule-sim-pre",
    name: "pre-approve reads in this project",
    actions: [
      {
        kind: "pre_approve_within_bounds",
        approvedCapabilities: ["fs.read"],
        maximumTimeoutSeconds: 900,
        allowDestructiveEffects: false,
        allowExternalEffects: false,
        maximumSensitivity: "restricted",
      },
    ],
    ...overrides,
  })
}

/** Compiles the given documents, or throws with the refusal attached. */
export function compiledFrom(...documents: readonly RuleSourceDocument[]): CompiledRuleSet {
  const compiled = compileRuleSet(documents)
  if (!compiled.ok) throw new Error(`compileRuleSet was refused: ${compiled.error.code} — ${compiled.error.message}`)
  return compiled.value
}

// ===========================================================================
// Registry
// ===========================================================================

export const NODE_A = "node-a" as NodeId
export const NODE_B = "node-b" as NodeId
export const NODE_REVOKED = "node-revoked" as NodeId

interface NodeOverrides {
  readonly nodeId?: string
  readonly displayName?: string
  readonly revoked?: boolean
  readonly healthy?: boolean
  readonly healthReason?: RoutingNodeSnapshot["healthReason"]
  readonly livenessState?: RoutingNodeSnapshot["livenessState"]
  readonly projectIds?: readonly string[]
  readonly projectPathIds?: readonly string[]
  readonly runtimeKinds?: readonly string[]
  readonly capabilities?: readonly string[]
  readonly maxConcurrentSessions?: number | null
  readonly activeSessions?: number | null
  readonly verdictEligible?: boolean
  readonly verdictReason?: RoutingNodeSnapshot["verdictReason"]
  readonly sequence?: number
}

/**
 * A registry node snapshot, parsed through `routingNodeSnapshotSchema`.
 *
 * `revoked` and `healthy` are DERIVED from `livenessState` rather than being
 * independent knobs, because the schema's own `superRefine` requires them to agree
 * and a fixture that could produce a self-contradictory projection would be a
 * fixture for testing a state no adapter can build.
 */
export function aNode(overrides: NodeOverrides = {}): RoutingNodeSnapshot {
  const revoked = overrides.revoked ?? false
  const livenessState = overrides.livenessState ?? (revoked ? "revoked" : "live")
  return routingNodeSnapshotSchema.parse({
    nodeId: overrides.nodeId ?? "node-a",
    displayName: overrides.displayName ?? "fixture node",
    revoked,
    projectIds: overrides.projectIds ?? [PROJECT_ID],
    projectPathIds: overrides.projectPathIds ?? [PROJECT_PATH_ID],
    runtimeKinds: overrides.runtimeKinds ?? ["opencode"],
    capabilities: overrides.capabilities ?? ["fs.read", "shell.run"],
    maxConcurrentSessions: overrides.maxConcurrentSessions ?? 4,
    activeSessions: overrides.activeSessions ?? 0,
    healthy: overrides.healthy ?? livenessState === "live",
    healthReason: overrides.healthReason ?? (livenessState === "live" ? "liveness_live" : "liveness_revoked"),
    livenessState,
    sequence: overrides.sequence ?? 1,
    observedAt: FIXED_NOW,
    verdictEligible: overrides.verdictEligible ?? true,
    verdictReason: overrides.verdictReason ?? "advertised",
  })
}

/** The default two-node mesh: `node-a` and `node-b`, both live and eligible. */
export function twoEligibleNodes(): readonly RoutingNodeSnapshot[] {
  return [aNode({ nodeId: "node-a" }), aNode({ nodeId: "node-b", capabilities: ["fs.read", "fs.write", "shell.run"] })]
}

// ===========================================================================
// Roles
// ===========================================================================

interface RoleOverrides {
  readonly roleId?: string
  readonly templateVersion?: number
  readonly name?: string
  readonly purpose?: string
  readonly instructions?: string
  readonly requiredCapabilities?: readonly string[]
  readonly preferredRuntimeKinds?: readonly string[]
  readonly allowedCapabilities?: readonly string[]
  readonly deniedCapabilities?: readonly string[]
  readonly approvalCapabilities?: readonly string[]
  readonly approvalDestructive?: boolean
  readonly approvalExternal?: boolean
}

/**
 * A role snapshot, parsed through `roleTemplateSchema`.
 *
 * `name`, `purpose` and `instructions` are the three free-text fields on this shape
 * and the three the no-secret test seeds canaries into: they are the only authored
 * prose a role snapshot carries, and ADR 0007 section 12 forbids prose in a plan.
 */
export function aRole(overrides: RoleOverrides = {}): ReturnType<typeof roleTemplateSchema.parse> {
  return roleTemplateSchema.parse({
    schemaVersion: 1,
    roleId: overrides.roleId ?? ROLE_ID,
    templateVersion: overrides.templateVersion ?? 1,
    projectId: PROJECT_ID,
    name: overrides.name ?? "Simulation Runner",
    purpose: overrides.purpose ?? "execute the simulated steps",
    instructions: overrides.instructions ?? "Execute the task",
    requiredCapabilities: overrides.requiredCapabilities ?? [...ROLE_CAPABILITIES],
    preferredRuntimeKinds: overrides.preferredRuntimeKinds ?? ["opencode"],
    contextSelectionPolicyReference: { namespace: "simulation", id: "ref-sim" },
    permissionRestrictions: {
      allowedCapabilities: overrides.allowedCapabilities ?? [...ROLE_CAPABILITIES],
      deniedCapabilities: overrides.deniedCapabilities ?? [],
      approvalRequirements: {
        destructiveEffects: overrides.approvalDestructive ?? false,
        externalEffects: overrides.approvalExternal ?? false,
        capabilities: overrides.approvalCapabilities ?? [],
      },
    },
    author: { kind: "user", userId: USER_ID },
    createdAt: "2026-01-01T00:00:00Z",
  })
}

// ===========================================================================
// Context manifests
// ===========================================================================

interface ManifestOverrides {
  readonly manifestId?: string
  readonly dispatchId?: string
  readonly taskId?: string
  readonly roleId?: string
  readonly sensitivity?: ContextManifestV2["destination"]["clearance"]
  readonly items?: readonly Record<string, unknown>[]
  readonly estimated?: number
  readonly maximum?: number
  readonly renderedDigest?: string | null
}

/**
 * A context manifest, parsed through `contextManifestV2Schema`.
 *
 * One item by default, so `itemCount`, `categories` and `maximumSensitivity` are
 * all exercised without a fixture that has to keep four items consistent. The
 * manifest carries no CONTENT and no TEXT — only source ids, hashes, categories and
 * costs — which is why the no-secret test cannot seed a canary into one and has to
 * seed it into the fields around it instead.
 */
export function aManifest(overrides: ManifestOverrides = {}): ContextManifestV2 {
  const estimated = overrides.estimated ?? 120
  return contextManifestV2Schema.parse({
    manifestId: overrides.manifestId ?? "manifest-sim-1",
    schemaVersion: 1,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    taskId: overrides.taskId ?? "task:build",
    dispatchId: overrides.dispatchId ?? "disp:build",
    roleSnapshotHash: digestJson({ role: "sim" }),
    items: overrides.items ?? [
      {
        sourceId: "source-sim-1",
        sourceHash: digestJson({ source: "sim" }),
        renderedHash: digestJson({ rendered: "sim" }),
        scope: { kind: "project" },
        category: "project_constraints",
        reason: "active_constraint",
        sensitivity: overrides.sensitivity ?? "public_to_project",
        sensitivityDecision: "within_clearance",
        orderingKey: "0003:1:source-sim-1",
        priority: 1,
        optional: false,
        estimatedCost: estimated,
      },
    ],
    excluded: [],
    budget: { maximum: overrides.maximum ?? 4_000, estimated, unit: "tokens" },
    policyVersion: "policy-sim-1",
    destination: { nodeId: "node-a", roleId: overrides.roleId ?? ROLE_ID, clearance: overrides.sensitivity ?? "public_to_project" },
    createdAt: FIXED_NOW,
    digest: digestJson({ manifest: overrides.manifestId ?? "manifest-sim-1" }),
    ...(overrides.renderedDigest === null ? {} : { renderedDigest: overrides.renderedDigest ?? digestJson({ rendered: "prompt" }) }),
  })
}

// ===========================================================================
// Templates
// ===========================================================================

export const TEMPLATE_ID = "tmpl_sim"

/**
 * The steps every fixture template starts from: a two-step chain, so a dependency
 * edge exists, a stage boundary exists, and a test that adds a cycle has something
 * to add it to.
 *
 * `title` is the free text the no-secret test seeds a canary into; `labelValues`
 * binds a label to a PARAMETER BY NAME, so the value that reaches the snapshot is
 * whatever the caller supplies for `target_env` — which is where the second canary
 * goes.
 */
export const BASE_STEPS: readonly RunTemplateInput["steps"][number][] = [
  {
    stepId: "build",
    kind: "task",
    title: "Build the release",
    roleId: ROLE_ID,
    dependsOn: [],
    capabilities: ["shell.run", "fs.read"],
    runtimeKind: "opencode",
    timeoutSeconds: 600,
    labelValues: { env: "target_env" },
  },
  {
    stepId: "ship",
    kind: "dispatch",
    title: "Ship the release",
    roleId: ROLE_ID,
    dependsOn: ["build"],
    capabilities: ["fs.read"],
    runtimeKind: "opencode",
    timeoutSeconds: 900,
    labelValues: { env: "target_env" },
  },
]

/** A minimal VALID template input, with every required field present. */
export function aTemplateInput(overrides: Partial<RunTemplateInput> = {}): RunTemplateInput {
  return {
    templateId: TEMPLATE_ID,
    projectId: PROJECT_ID,
    name: "release",
    description: "Build and ship a release.",
    parameterDefinitions: [{ name: "target_env", type: "string", required: true, minLength: 1, maxLength: 16 }],
    steps: structuredClone(BASE_STEPS) as RunTemplateInput["steps"],
    ruleSetDigest: null,
    author: { kind: "user", userId: USER_ID },
    createdAt: FIXED_NOW,
    ...overrides,
  }
}

/**
 * Mutation counts, keyed by repository instance.
 *
 * A module-scoped `WeakMap` rather than a class field, and the reason is ordering
 * rather than taste: `RunTemplateRepository`'s CONSTRUCTOR calls `createTemplate`
 * for every initial fixture, and a subclass field is installed only AFTER `super()`
 * returns. A `this.mutations` field would therefore be `undefined` during the very
 * call the fixture depends on, and the override would throw before the repository
 * had registered a single template.
 */
const MUTATION_COUNTS = new WeakMap<ProbedRunTemplateRepository, { createTemplate: number; updateTemplate: number; clear: number }>()

/**
 * A `RunTemplateRepository` that COUNTS its own mutations.
 *
 * The simulator takes a repository because `instantiateTemplate` takes one, and
 * `instantiateTemplate` is the only production expander. So the question "does the
 * dry run write anything?" has to be answered about the repository too, and the
 * honest way to answer it is at the method: this subclass counts every call that
 * would change state and exposes the tally. The counts start at zero AFTER the
 * constructor has registered the initial fixtures, which is exactly the window a
 * dry run happens in.
 */
export class ProbedRunTemplateRepository extends RunTemplateRepository {
  constructor(templates: readonly RunTemplateInput[] = []) {
    super(templates)
    MUTATION_COUNTS.set(this, { createTemplate: 0, updateTemplate: 0, clear: 0 })
  }

  /** Post-construction mutation counts. Zero means the dry run wrote nothing. */
  get mutations(): { createTemplate: number; updateTemplate: number; clear: number } {
    return MUTATION_COUNTS.get(this) ?? { createTemplate: 0, updateTemplate: 0, clear: 0 }
  }

  override createTemplate(input: RunTemplateInput): ReturnType<RunTemplateRepository["createTemplate"]> {
    this.mutations.createTemplate += 1
    return super.createTemplate(input)
  }

  override updateTemplate(
    ...args: Parameters<RunTemplateRepository["updateTemplate"]>
  ): ReturnType<RunTemplateRepository["updateTemplate"]> {
    this.mutations.updateTemplate += 1
    return super.updateTemplate(...args)
  }

  override clear(): void {
    this.mutations.clear += 1
    super.clear()
  }
}

/** A repository holding the default two-step template. */
export function aTemplateRepository(overrides: readonly RunTemplateInput[] = []): ProbedRunTemplateRepository {
  return new ProbedRunTemplateRepository([aTemplateInput(), ...overrides])
}

/** A role resolver granting `ROLE_CAPABILITIES` to `ROLE_ID` and nothing to anyone else. */
export function roleCapabilitiesGranting(capabilities: readonly string[]): (roleId: string) => readonly string[] | undefined {
  return (roleId) => (roleId === ROLE_ID ? [...capabilities] : undefined)
}

// ===========================================================================
// The dry-run request
// ===========================================================================

interface RequestOverrides {
  readonly now?: string
  readonly projectId?: string
  readonly runId?: string
  readonly localDispatchNodeId?: string | null
  readonly templateId?: string
  readonly templateVersion?: number
  readonly inputs?: Record<string, unknown>
  readonly activationConfirmed?: boolean
  readonly requestedBy?: string
  readonly nodes?: readonly RoutingNodeSnapshot[]
  readonly roles?: readonly ReturnType<typeof roleTemplateSchema.parse>[]
  readonly rules?: CompiledRuleSet
  readonly manifests?: readonly unknown[]
  readonly baseBudget?: Record<string, number | string | undefined>
  readonly observation?: Record<string, unknown>
  readonly memoryRecordCount?: number
}

/**
 * A valid dry-run request, defaulting to the DEFAULT INSTALLATION.
 *
 * Two nodes, one role, a compiled rule set with zero rules, one context manifest,
 * and a budget with a concurrency ceiling — so a caller who changes nothing gets
 * the milestone's headline scenario, and every test that needs something else
 * changes exactly one member.
 */
export function aRequest(overrides: RequestOverrides = {}): Record<string, unknown> {
  return {
    now: overrides.now ?? FIXED_NOW,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    installationId: INSTALLATION_ID,
    projectPathId: PROJECT_PATH_ID,
    controllerEpoch: 3,
    correlationId: CORRELATION_ID,
    localDispatchNodeId: overrides.localDispatchNodeId ?? null,
    proposal: {
      requestedBy: overrides.requestedBy ?? USER_ID,
      activationConfirmed: overrides.activationConfirmed ?? true,
      templateRef: {
        templateId: overrides.templateId ?? TEMPLATE_ID,
        ...(overrides.templateVersion === undefined ? {} : { templateVersion: overrides.templateVersion }),
      },
      inputs: { target_env: overrides.inputs?.["target_env"] ?? "canary", ...overrides.inputs },
    },
    registry: { nodes: overrides.nodes ?? twoEligibleNodes() },
    roles: overrides.roles ?? [aRole()],
    rules: overrides.rules ?? emptyRuleSet(),
    memory: { manifests: overrides.manifests ?? [aManifest()], recordCount: overrides.memoryRecordCount ?? 4 },
    budget: {
      base: { maximumConcurrency: 4, maximumFanOut: 4, ...overrides.baseBudget },
      ...(overrides.observation === undefined ? {} : { observation: overrides.observation }),
    },
  }
}

// ===========================================================================
// Ports
// ===========================================================================

export interface SimulatedPorts extends SimulationPorts {
  /** The probed repository, under its own type, so a test can read its mutation counts. */
  readonly templates: ProbedRunTemplateRepository
  /** The probe, under its own name, so a test can read its counters. */
  readonly probe: BudgetStoreProbe
  /** The shared tally the probe increments. */
  readonly tally: SimulationSinkTally
}

/**
 * The ports, with a fresh probe and a fresh tally.
 *
 * The probe is created per call so a test's counters are its own, and the role
 * resolver is included by default so `roleCapabilityCheck` is `enforced` in the
 * common case — a test that omits it is testing the `skipped` branch on purpose.
 */
export function simulatedPorts(overrides: Partial<SimulatedPorts> = {}): SimulatedPorts {
  const tally = overrides.tally ?? emptySinkTally()
  const probe = overrides.probe ?? createBudgetLedgerProbe({ tally })
  return {
    templates: overrides.templates ?? aTemplateRepository(),
    budgetStore: probe,
    probe,
    tally,
    // `in` rather than `??`, so a test can pass `roleCapabilities: undefined` to
    // exercise the `skipped` branch — which is a branch, and `??` would make it
    // unreachable from the fixture.
    roleCapabilities: "roleCapabilities" in overrides ? overrides.roleCapabilities : roleCapabilitiesGranting(ROLE_CAPABILITIES),
  }
}

// ===========================================================================
// Canaries
// ===========================================================================

/**
 * A canary per free-text field of the snapshots.
 *
 * Each is a distinct literal, so a finding names the field it came from rather
 * than "a canary". The list is the audit's input and it is declared HERE, in the
 * test fixtures, rather than in the module under audit: an audit whose canary list
 * is produced by the code it audits is an audit that agrees with whatever that code
 * happens to carry.
 */
export const CANARIES = Object.freeze({
  roleName: "canary-role-name-4f1a",
  rolePurpose: "canary-role-purpose-9c22",
  roleInstructions: "canary-role-instructions-7bd3",
  templateName: "canary-template-name-2e5b",
  templateDescription: "canary-template-description-8a17",
  stepTitle: "canary-step-title-6d90",
  nodeDisplayName: "canary-node-display-name-1c34",
  // At most sixteen characters, because the template's `target_env` parameter
  // declares `maxLength: 16` and a canary the schema refuses would never reach the
  // snapshot it is meant to poison — the audit would pass for the wrong reason.
  parameterValue: "canary-pm-7b02",
})

/** Every canary, sorted, for the audit's `seededCanaries` member. */
export function everyCanary(): readonly string[] {
  return Object.values(CANARIES).sort()
}

/**
 * Every snapshot, with a canary planted in every free-text field.
 *
 * One builder, so the no-secret test cannot accidentally audit a subset. The
 * `displayName` on a node is the reason `RoutingNodeSnapshot` documents that field
 * as "the only free-text field on this shape": it is node-supplied, and a plan that
 * carried it would carry whatever a machine chose to call itself.
 */
export function canariedRequest(rules: CompiledRuleSet = emptyRuleSet()): Record<string, unknown> {
  const nodes = [
    aNode({ nodeId: "node-a", displayName: CANARIES.nodeDisplayName }),
    aNode({
      nodeId: "node-b",
      displayName: CANARIES.nodeDisplayName,
      capabilities: ["fs.read", "fs.write", "shell.run"],
    }),
  ]
  return aRequest({
    rules,
    nodes,
    roles: [
      aRole({
        name: CANARIES.roleName,
        purpose: CANARIES.rolePurpose,
        instructions: CANARIES.roleInstructions,
      }),
    ],
    inputs: { target_env: CANARIES.parameterValue },
    manifests: [],
  })
}

/** The template whose every free-text field carries a canary. */
export function canariedTemplateInput(): RunTemplateInput {
  return aTemplateInput({
    name: CANARIES.templateName,
    description: CANARIES.templateDescription,
    steps: BASE_STEPS.map((step) => ({ ...structuredClone(step), title: CANARIES.stepTitle })) as RunTemplateInput["steps"],
  })
}
