/**
 * Milestone 6 integration fixtures.
 *
 * # Why a NEW fixture file rather than reusing the per-module unit fixtures
 *
 * Those files are owned by the unit suites, and three of the four M6 gate test
 * files import from them today. Reusing them here would mean the gate's
 * acceptance evidence moves whenever a unit fixture is refactored — which is
 * exactly the coupling the gate exists to prevent. Every builder below is
 * therefore written here, against the SAME production schemas, and the
 * duplication is the point: a schema change that breaks one fixture set breaks
 * both, loudly, rather than silently making a gate assertion vacuous.
 *
 * # The three rules this file obeys
 *
 *  1. **One injected clock.** `FIXED_NOW` is the only instant any rule/template
 *     builder mentions. A fixture that read `Date.now()` would make every
 *     determinism assertion in the gate depend on when the suite ran.
 *  2. **Validate through the owning schema.** Every builder that can parse does,
 *     so a fixture that has drifted out of the language fails loudly at the first
 *     test that uses it rather than producing a subtly wrong input to a safety
 *     assertion. The two documented exceptions are the RAW rule builders, whose
 *     whole purpose is to produce documents the schema refuses.
 *  3. **No `Math.random`, no `Date.now`, no real I/O.** `seededLcg` is a
 *     deterministic generator and this file opens no file.
 *
 * # Import paths
 *
 * Everything subsystem-shaped goes through a barrel (`src/rules/index.js`,
 * `src/simulation/index.js`, `src/budgets/index.js`, `src/routing/index.js`,
 * `src/workflows/index.js`, `src/notifications/index.js`, `src/context/index.js`,
 * `src/orchestration/policy/index.js`). Two areas have no usable barrel and are
 * imported by path, which is the convention every existing test in this
 * repository already follows for them:
 *
 *   - `src/orchestration/{digest,errors,identifiers,schemas,types}.js` — the M0
 *     kernel surface, imported by path in `orchestration-flow.test.ts` too.
 *   - `src/application/{service,types}.js` — `InMemoryLocalApplicationService`,
 *     imported by path in `tests/unit/application/service.test.ts`. The runtime
 *     and terminal types come from `src/runtime/types.js` and
 *     `src/terminal/types.js` for the same reason.
 */

import {
  BudgetLedger,
  BUDGET_SCOPES,
  InMemoryBudgetLedgerStore,
  budgetReservationSchema,
  reservationIdSchema,
  reserveRequestSchema,
  replayDurableReservations,
  type BudgetLedgerStore,
  type BudgetLimits,
  type BudgetReservation,
} from "../../src/budgets/index.js"
import {
  buildNotificationTuiView,
  createNotificationBus,
  createNotificationStore,
  createNotificationTuiAdapter,
  initialNotificationTuiState,
  loadNotificationTuiEntries,
  auditNotificationPayload,
  notificationEnvelopeSchema,
  notificationNoticeLine,
  notificationRequestSchema,
  NOTIFICATION_EGRESS_PATHS,
  type NotificationAdapter,
  type NotificationCategory,
  type NotificationClock,
  type NotificationEnvelope,
  type NotificationQuieting,
  type NotificationRequest,
  type NotificationSeverity,
  type NotificationTimestamp,
} from "../../src/notifications/index.js"
import {
  evaluatePolicy,
  narrowPolicyState,
  renderPolicyExplanation,
  SAFETY_FLOOR,
  SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
  seedPolicyState,
  type EffectivePolicyState,
  type PolicyEvaluation,
} from "../../src/orchestration/policy/index.js"
import {
  compileRuleSet,
  ruleEvaluationContextSchema,
  ruleSourceDocumentSchema,
  type CompiledRule,
  type CompiledRuleSet,
  type RuleEvaluationContext,
  type RuleSourceDocument,
} from "../../src/rules/index.js"
import {
  rankNodes,
  routingNodeSnapshotSchema,
  type RoutingNodeSnapshot,
  type RoutingPreference,
  type RoutingRequest,
  type RoutingResult,
} from "../../src/routing/index.js"
import {
  createBudgetLedgerProbe,
  emptySinkTally,
  simulateDryRun,
  type BudgetStoreProbe,
  type DryRunPlan,
  type SimulatedDispatch,
  type SimulationPorts,
  type SimulationSinkTally,
} from "../../src/simulation/index.js"
import {
  RunTemplateRepository,
  type ResolvedStep,
  type RunTemplateInput,
} from "../../src/workflows/index.js"
import { InMemoryLocalApplicationService } from "../../src/application/service.js"
import { runtimeSessionSchema } from "../../src/runtime/schemas.js"
import {
  terminalInputOwnershipSchema,
  terminalReferenceSchema,
  terminalSnapshotSchema,
} from "../../src/terminal/schemas.js"
import type {
  LaunchOutcome,
  LocalApplicationDependencies,
  LocalProjectDefinition,
  LocalProjectRegistry,
  LaunchPathAuthorization,
  LaunchPathAuthorizationRequest,
} from "../../src/application/types.js"
import { contextManifestV2Schema, type ContextManifestV2 } from "../../src/context/index.js"
import { canonicalJson, digestJson } from "../../src/orchestration/digest.js"
import type { Digest } from "../../src/rules/index.js"
import type { ContractError, Result } from "../../src/orchestration/errors.js"
import {
  commandIdSchema,
  correlationIdSchema,
  dispatchIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  roleIdSchema,
  runIdSchema,
  sessionIdSchema,
  taskIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
  userIdSchema,
  type ApprovalId,
  type CommandId,
  type DispatchId,
  type NodeId,
  type ProjectId,
  type RunId,
} from "../../src/orchestration/identifiers.js"
import { dispatchEnvelopeSchema, roleTemplateSchema, ruleSchema } from "../../src/orchestration/schemas.js"
import type { DispatchEnvelope, RoleTemplate } from "../../src/orchestration/types.js"
import type { AgentRuntimeAdapter } from "../../src/runtime/types.js"
import type { TerminalBackend, TerminalChannel } from "../../src/terminal/types.js"

// ===========================================================================
// Identity and time
// ===========================================================================

export const PROJECT_ID: ProjectId = projectIdSchema.parse("proj-m6");
export const OTHER_PROJECT_ID: ProjectId = projectIdSchema.parse("proj-m6-other");
export const RUN_ID: RunId = runIdSchema.parse("run-m6-1");
export const PROJECT_PATH_ID = projectPathIdSchema.parse("path-m6-1");
export const ROLE_ID = roleIdSchema.parse("role-m6");
export const USER_ID = userIdSchema.parse("user-m6");
export const CORRELATION_ID = correlationIdSchema.parse("corr-m6-1");
export const INSTALLATION_ID = "inst-m6-1";

/** The session the scripted runtime mints, and the one the terminal is bound to. */
export const SESSION_ID = sessionIdSchema.parse("session-m6");

/**
 * The injected instant for rules, templates, registry snapshots and manifests.
 *
 * A Monday morning, so a schedule window a fixture declares is a window that
 * actually contains this instant.
 */
export const FIXED_NOW = "2026-06-01T09:00:00Z";

/** A second instant, for the tests that need two distinct clocks. */
export const LATER_NOW = "2026-06-02T18:00:00Z";

/** Before `FIXED_NOW`, so a rule carrying this `expiresAt` is expired by then. */
export const EARLIER_INSTANT = "2026-05-01T00:00:00Z";

/** The instant the application service's proposal flow records against. */
export const SERVICE_NOW = "2026-06-01T09:00:00.000Z";

/** The capabilities the fixture role grants. */
export const ROLE_CAPABILITIES = ["fs.read", "fs.write", "shell.run"] as const;

// ===========================================================================
// Result helpers
// ===========================================================================

/** A success `Result`. */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** A failure `Result`, in the kernel's `ContractError` shape. */
export function fail(category: ContractError["category"], code: string, message: string): Result<never> {
  return {
    ok: false,
    error: { schemaVersion: 1, category, code, message, retryable: false, correlationId: CORRELATION_ID },
  };
}

/** Unwraps a `Result`, throwing with the code attached. */
export function valueOf<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.category}/${result.error.code}: ${result.error.message}`);
  return result.value;
}

// ===========================================================================
// Deterministic helpers
// ===========================================================================

/**
 * A deterministic pseudo-random source.
 *
 * A linear congruential generator seeded explicitly, never `Math.random`. A
 * failure whose seed changes per run is a failure nobody can reproduce, which is
 * the one thing a determinism gate must not produce.
 */
export function seededLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * A Fisher-Yates shuffle driven by a seeded generator.
 *
 * Returns a NEW array; the input is never mutated, because a fixture the test
 * mutated would make the SECOND run the odd one out and the failure would read
 * as a determinism bug in the product.
 */
export function shuffled<T>(values: readonly T[], seed: number): T[] {
  const next = seededLcg(seed);
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    const left = copy[index]!;
    copy[index] = copy[swap]!;
    copy[swap] = left;
  }
  return copy;
}

/** A deep structural clone, so a mutation cannot reach back into a shared fixture. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** UTF-16 code-unit comparison, matching the shipped modules' own ordering. */
export function byCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// ===========================================================================
// Rule documents
// ===========================================================================

/**
 * A rule document WITHOUT validation.
 *
 * Both forms exist because the escalation tests must build documents the schema
 * is supposed to REFUSE — `allowDestructiveEffects: true`, a timeout above the
 * floor's ceiling — and a validating fixture cannot produce one. The construction
 * lives in a test file, so no production module contains a spelling of the
 * escalation.
 */
export function rawRuleDocument(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    languageVersion: 2,
    ruleId: "rule-m6-1",
    templateVersion: 1,
    projectId: PROJECT_ID,
    name: "deny the reviewer role",
    description: "A deny scoped to one role.",
    enabled: true,
    activation: {
      state: "activated",
      activatedAt: "2026-01-01T00:00:00Z",
      activatedBy: { kind: "user", userId: USER_ID },
    },
    predicates: [{ field: "roleId", operator: "eq", value: ROLE_ID }],
    actions: [{ kind: "deny_with_reason", reason: "reviewers may not dispatch" }],
    expiresAt: null,
    author: { kind: "user", userId: USER_ID },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** A validated rule document. */
export function ruleDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleSourceDocumentSchema.parse(rawRuleDocument(overrides));
}

/** A `deny_with_reason` rule scoped to one project. */
export function denyDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleDocument({
    ruleId: "rule-m6-deny",
    name: "deny every dispatch in this project",
    predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
    actions: [{ kind: "deny_with_reason", reason: "the m6 project freezes all dispatches" }],
    ...overrides,
  });
}

/** A `require_approval` rule scoped to one project. */
export function requireApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleDocument({
    ruleId: "rule-m6-approval",
    name: "ask before dispatching in this project",
    predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
    actions: [{ kind: "require_approval", requireApprovalForDispatch: true }],
    ...overrides,
  });
}

/**
 * A `pre_approve_within_bounds` rule scoped to one project AND one capability.
 *
 * Scoping on a capability is what makes `reach.capabilities` a set rather than
 * `unknown`; the other four reach axes stay unconstrained, which is the shape
 * ADR 0007 section 11 requires to be said in words rather than as an empty set.
 */
export function preApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleDocument({
    ruleId: "rule-m6-pre",
    name: "pre-approve reads on this project",
    predicates: [
      { field: "projectId", operator: "eq", value: PROJECT_ID },
      { field: "capability", operator: "any", value: ["fs.read"] },
    ],
    actions: [
      {
        kind: "pre_approve_within_bounds",
        approvedCapabilities: ["fs.read"],
        maximumTimeoutSeconds: 900,
        allowDestructiveEffects: false,
        allowExternalEffects: false,
        maximumFanOut: 4,
        maximumConcurrency: 2,
        maximumRetryLimit: 1,
        maximumSensitivity: "restricted",
      },
    ],
    ...overrides,
  });
}

/**
 * A pre-approval whose predicate is `all([])`: it PARSES and is then refused by
 * the compiler's universal check with `rule.universal_pre_approval`.
 */
export function universalPreApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return rawRuleDocument({
    ruleId: "rule-m6-universal-pre",
    name: "pre-approve reads everywhere",
    predicates: [],
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
  });
}

/** A `set_stricter_budget` rule. */
export function budgetDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleDocument({
    ruleId: "rule-m6-budget",
    name: "cap fan out at two",
    predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
    actions: [{ kind: "set_stricter_budget", budget: { maximumFanOut: 2 } }],
    ...overrides,
  });
}

/** A `select_routing_preference` rule naming one node. */
export function routingDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleDocument({
    ruleId: "rule-m6-route",
    name: "prefer the second node",
    predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
    actions: [{ kind: "select_routing_preference", preference: { preferredNodeIds: ["node-m6-b"] } }],
    ...overrides,
  });
}

/** A `require_approval` rule scoped to two projects: one half of an overlap pair. */
export function scopeApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleDocument({
    ruleId: "rule-m6-scope-approval",
    name: "ask before dispatching on two projects",
    predicates: [{ field: "projectId", operator: "in", value: [PROJECT_ID, OTHER_PROJECT_ID] }],
    actions: [{ kind: "require_approval", requireApprovalForDispatch: true }],
    ...overrides,
  });
}

/** A `require_approval` rule scoped to one role: the other half of the overlap pair. */
export function roleApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleDocument({
    ruleId: "rule-m6-role-approval",
    name: "ask before the reviewer role dispatches",
    predicates: [{ field: "roleId", operator: "eq", value: ROLE_ID }],
    actions: [{ kind: "require_approval", requireApprovalForDispatch: true }],
    ...overrides,
  });
}

/** A deny rule with NO predicates: `all([])`, which PROVABLY shadows a scoped deny. */
export function universalDenyDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleDocument({
    ruleId: "rule-m6-universal-deny",
    name: "deny everything",
    predicates: [],
    actions: [{ kind: "deny_with_reason", reason: "this project is frozen" }],
    ...overrides,
  });
}

/** A deny rule scoped to one role: the rule the universal deny above shadows. */
export function roleDenyDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleDocument({
    ruleId: "rule-m6-role-deny",
    name: "deny the reviewer role",
    predicates: [{ field: "roleId", operator: "eq", value: ROLE_ID }],
    actions: [{ kind: "deny_with_reason", reason: "reviewers may not dispatch" }],
    ...overrides,
  });
}

// ===========================================================================
// Compilation
// ===========================================================================

/** Compiles, or throws with the refusal attached. */
export function compileOrThrow(sources: readonly unknown[]): CompiledRuleSet {
  const compiled = compileRuleSet(sources);
  if (!compiled.ok) throw new Error(`compileRuleSet refused: ${compiled.error.code} — ${compiled.error.message}`);
  return compiled.value;
}

/**
 * `compileRuleSet([])` — the DEFAULT INSTALLATION.
 *
 * The real compiler, not a hand-built empty object, so the digest, the limits and
 * the deep freeze are the ones production produces.
 */
export function emptyRuleSet(): CompiledRuleSet {
  return compileOrThrow([]);
}

/** Compiles several documents, or throws. */
export function compiledFrom(...documents: readonly RuleSourceDocument[]): CompiledRuleSet {
  return compileOrThrow(documents);
}

/** The single rule of a one-document set, or throws. */
export function onlyRule(compiled: CompiledRuleSet): CompiledRule {
  const rule = compiled.rules[0];
  if (rule === undefined) throw new Error("expected exactly one compiled rule");
  return rule;
}

/** `ruleId@templateVersion`, the identity a rule and a trace share. */
export function identityOf(rule: { readonly ruleId: string; readonly templateVersion: number }): string {
  return `${rule.ruleId}@${rule.templateVersion}`;
}

// ===========================================================================
// Preview history
// ===========================================================================

/**
 * A history entry with every field the preview's own shape carries, populated.
 *
 * Returned UNVALIDATED on purpose: `historyEntrySchema` is a preview input
 * constraint, and the point of this builder is that the test file constructs the
 * entry and then builds the evaluation context from it INDEPENDENTLY. Parsing it
 * here would be correct but would hide which of the two constructions a failure
 * belongs to.
 */
export function historyEntry(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    dispatchId: "disp-1",
    runId: RUN_ID,
    taskId: "task-1",
    projectId: PROJECT_ID,
    roleId: ROLE_ID,
    roleVersion: 3,
    requestedCapabilities: ["fs.read"],
    runtimeKind: "opencode",
    targetNodeId: "node-m6-a",
    projectPathId: PROJECT_PATH_ID,
    taskLabels: ["release"],
    dependencyOutcomes: ["succeeded"],
    requestedFanOut: 2,
    requestedConcurrency: 2,
    requestedRetryLimit: 1,
    declaredTimeoutSeconds: 600,
    contextManifestSensitivity: "restricted",
    evaluatedAt: FIXED_NOW,
    state: "completed",
    ...overrides,
  };
}

/** A history, with both halves empty unless told otherwise. */
export function previewHistory(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { proposals: [], finishedDispatches: [], ...overrides };
}

/** The preview's options, with the activation confirmation recorded. */
export function previewOptions(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { now: FIXED_NOW, actorId: "user-m6-operator", activationConfirmed: true, ...overrides };
}

// ===========================================================================
// Registry snapshots
// ===========================================================================

export const NODE_A: NodeId = "node-m6-a" as NodeId;
export const NODE_B: NodeId = "node-m6-b" as NodeId;
export const NODE_UNAUTHORIZED: NodeId = "node-m6-unauthorized" as NodeId;
export const NODE_UNHEALTHY: NodeId = "node-m6-unhealthy" as NodeId;

interface NodeOverrides {
  readonly nodeId?: string;
  readonly displayName?: string;
  readonly livenessState?: RoutingNodeSnapshot["livenessState"];
  readonly projectIds?: readonly string[];
  readonly projectPathIds?: readonly string[];
  readonly runtimeKinds?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly maxConcurrentSessions?: number | null;
  readonly activeSessions?: number | null;
  readonly verdictEligible?: boolean;
  readonly verdictReason?: RoutingNodeSnapshot["verdictReason"];
  readonly sequence?: number;
}

/**
 * A registry node snapshot, parsed through `routingNodeSnapshotSchema`.
 *
 * `revoked`, `healthy` and `healthReason` are DERIVED from `livenessState`
 * rather than being independent knobs, because the schema's own `superRefine`
 * requires them to agree and a fixture that could produce a self-contradictory
 * projection would be a fixture for a state no adapter can build.
 */
export function registryNode(overrides: NodeOverrides = {}): RoutingNodeSnapshot {
  const livenessState = overrides.livenessState ?? "live";
  const healthReason =
    livenessState === "live"
      ? "liveness_live"
      : livenessState === "revoked"
        ? "liveness_revoked"
        : livenessState === "stale"
          ? "liveness_stale"
          : "liveness_never_seen";
  return routingNodeSnapshotSchema.parse({
    nodeId: overrides.nodeId ?? NODE_A,
    displayName: overrides.displayName ?? "m6 fixture node",
    revoked: livenessState === "revoked",
    projectIds: overrides.projectIds ?? [PROJECT_ID],
    projectPathIds: overrides.projectPathIds ?? [PROJECT_PATH_ID],
    runtimeKinds: overrides.runtimeKinds ?? ["opencode"],
    capabilities: overrides.capabilities ?? ["fs.read", "shell.run"],
    maxConcurrentSessions: overrides.maxConcurrentSessions ?? 4,
    activeSessions: overrides.activeSessions ?? 0,
    healthy: livenessState === "live",
    healthReason,
    livenessState,
    sequence: overrides.sequence ?? 1,
    observedAt: FIXED_NOW,
    verdictEligible: overrides.verdictEligible ?? true,
    verdictReason: overrides.verdictReason ?? "advertised",
  });
}

/** The default two-node mesh: both live, eligible, and advertising everything. */
export function twoEligibleNodes(): readonly RoutingNodeSnapshot[] {
  return [
    registryNode({ nodeId: NODE_A }),
    registryNode({ nodeId: NODE_B, capabilities: ["fs.read", "fs.write", "shell.run"] }),
  ];
}

// ===========================================================================
// Role snapshots
// ===========================================================================

interface RoleOverrides {
  readonly roleId?: string;
  readonly templateVersion?: number;
  readonly name?: string;
  readonly purpose?: string;
  readonly instructions?: string;
  readonly requiredCapabilities?: readonly string[];
  readonly allowedCapabilities?: readonly string[];
  readonly deniedCapabilities?: readonly string[];
  readonly approvalCapabilities?: readonly string[];
  readonly approvalDestructive?: boolean;
  readonly approvalExternal?: boolean;
}

/**
 * A role snapshot, parsed through `roleTemplateSchema`.
 *
 * `name`, `purpose` and `instructions` are the three free-text fields on this
 * shape and the three the no-secret tests seed canaries into.
 */
export function roleSnapshot(overrides: RoleOverrides = {}): RoleTemplate {
  return roleTemplateSchema.parse({
    schemaVersion: 1,
    roleId: overrides.roleId ?? ROLE_ID,
    templateVersion: overrides.templateVersion ?? 1,
    projectId: PROJECT_ID,
    name: overrides.name ?? "M6 Runner",
    purpose: overrides.purpose ?? "execute the planned steps",
    instructions: overrides.instructions ?? "Execute the task",
    requiredCapabilities: overrides.requiredCapabilities ?? [...ROLE_CAPABILITIES],
    preferredRuntimeKinds: ["opencode"],
    contextSelectionPolicyReference: { namespace: "m6", id: "ref-m6" },
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
  });
}

// ===========================================================================
// Context manifests
// ===========================================================================

interface ManifestOverrides {
  readonly manifestId?: string;
  readonly dispatchId?: string;
  readonly taskId?: string;
  readonly roleId?: string;
  readonly nodeId?: string;
  readonly sensitivity?: ContextManifestV2["destination"]["clearance"];
  readonly category?: string;
  readonly estimated?: number;
  readonly maximum?: number;
  readonly renderedDigest?: string | null;
}

/**
 * A context manifest, parsed through `contextManifestV2Schema`.
 *
 * One item by default, so `itemCount`, `categories` and `maximumSensitivity` are
 * all exercised without a fixture that has to keep four items consistent. The
 * manifest carries no CONTENT and no TEXT — only source ids, hashes, categories
 * and costs — which is why the no-secret test cannot seed a canary into one.
 */
export function contextManifest(overrides: ManifestOverrides = {}): ContextManifestV2 {
  const estimated = overrides.estimated ?? 120;
  return contextManifestV2Schema.parse({
    manifestId: overrides.manifestId ?? "manifest-m6-1",
    schemaVersion: 1,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    taskId: overrides.taskId ?? "task:build",
    dispatchId: overrides.dispatchId ?? "disp:build",
    roleSnapshotHash: digestJson({ role: "m6" }),
    items: [
      {
        sourceId: "source-m6-1",
        sourceHash: digestJson({ source: "m6" }),
        renderedHash: digestJson({ rendered: "m6" }),
        scope: { kind: "project" },
        category: overrides.category ?? "project_constraints",
        reason: "active_constraint",
        sensitivity: overrides.sensitivity ?? "public_to_project",
        sensitivityDecision: "within_clearance",
        orderingKey: "0003:1:source-m6-1",
        priority: 1,
        optional: false,
        estimatedCost: estimated,
      },
    ],
    excluded: [],
    budget: { maximum: overrides.maximum ?? 4_000, estimated, unit: "tokens" },
    policyVersion: "policy-m6-1",
    destination: {
      nodeId: overrides.nodeId ?? NODE_A,
      roleId: overrides.roleId ?? ROLE_ID,
      clearance: overrides.sensitivity ?? "public_to_project",
    },
    createdAt: FIXED_NOW,
    digest: digestJson({ manifest: overrides.manifestId ?? "manifest-m6-1" }),
    ...(overrides.renderedDigest === null
      ? {}
      : { renderedDigest: overrides.renderedDigest ?? digestJson({ rendered: "prompt" }) }),
  });
}

// ===========================================================================
// Run templates
// ===========================================================================

export const TEMPLATE_ID = "tmpl_m6";

/**
 * The steps every fixture template starts from: a two-step chain.
 *
 * A dependency edge exists, a stage boundary exists, and a test that adds a cycle
 * has something to add it to. `title` is the free text the no-secret test seeds a
 * canary into; `labelValues` binds a label to a PARAMETER BY NAME, so the value
 * that reaches the snapshot is whatever the caller supplies for `target_env`.
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
];

/** A valid template input, with every required field present. */
export function templateInput(overrides: Partial<RunTemplateInput> = {}): RunTemplateInput {
  return {
    templateId: TEMPLATE_ID,
    projectId: PROJECT_ID,
    name: "release",
    description: "Build and ship a release.",
    parameterDefinitions: [{ name: "target_env", type: "string", required: true, minLength: 1, maxLength: 16 }],
    steps: clone(BASE_STEPS) as RunTemplateInput["steps"],
    ruleSetDigest: null,
    author: { kind: "user", userId: USER_ID },
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

/**
 * Mutation counts, keyed by repository instance.
 *
 * A module-scoped `WeakMap` rather than a class field, and the reason is ordering
 * rather than taste: `RunTemplateRepository`'s CONSTRUCTOR calls `createTemplate`
 * for every initial fixture, and a subclass field is installed only AFTER
 * `super()` returns, so a `this.mutations` field would be `undefined` during the
 * very call the fixture depends on.
 */
const TEMPLATE_MUTATIONS = new WeakMap<CountedTemplateRepository, { create: number; update: number; clear: number }>();

/**
 * A `RunTemplateRepository` that counts its own mutations.
 *
 * The simulator takes a repository because `instantiateTemplate` takes one, so
 * "does the dry run write anything?" has to be answered about the repository too
 * — and the honest way to answer it is at the method rather than by inspecting
 * the repository afterwards.
 */
export class CountedTemplateRepository extends RunTemplateRepository {
  constructor(templates: readonly RunTemplateInput[] = []) {
    super(templates);
    TEMPLATE_MUTATIONS.set(this, { create: 0, update: 0, clear: 0 });
  }

  /** Post-construction mutation counts. Zero means the dry run wrote nothing. */
  get mutations(): { create: number; update: number; clear: number } {
    return TEMPLATE_MUTATIONS.get(this) ?? { create: 0, update: 0, clear: 0 };
  }

  override createTemplate(input: RunTemplateInput): ReturnType<RunTemplateRepository["createTemplate"]> {
    this.mutations.create += 1;
    return super.createTemplate(input);
  }

  override updateTemplate(
    ...args: Parameters<RunTemplateRepository["updateTemplate"]>
  ): ReturnType<RunTemplateRepository["updateTemplate"]> {
    this.mutations.update += 1;
    return super.updateTemplate(...args);
  }

  override clear(): void {
    this.mutations.clear += 1;
    super.clear();
  }
}

/** A repository holding the default two-step template. */
export function templateRepository(
  extra: readonly RunTemplateInput[] = [],
): CountedTemplateRepository {
  return new CountedTemplateRepository([templateInput(), ...extra]);
}

/** A role resolver granting `capabilities` to `ROLE_ID` and nothing to anyone else. */
export function roleCapabilitiesGranting(
  capabilities: readonly string[],
): (roleId: string) => readonly string[] | undefined {
  return (roleId) => (roleId === ROLE_ID ? [...capabilities] : undefined);
}

/** One resolved step, by step id. Throws rather than returning undefined. */
export function resolvedStep(
  snapshot: { readonly resolvedSteps: readonly ResolvedStep[] },
  stepId: string,
): ResolvedStep {
  const step = snapshot.resolvedSteps.find((candidate) => candidate.stepId === stepId);
  if (step === undefined) throw new Error(`snapshot has no step '${stepId}'`);
  return step;
}

// ===========================================================================
// Dry-run requests and ports
// ===========================================================================

interface RequestOverrides {
  readonly now?: string;
  readonly projectId?: string;
  readonly localDispatchNodeId?: string | null;
  readonly templateId?: string;
  readonly inputs?: Record<string, unknown>;
  readonly activationConfirmed?: boolean;
  readonly nodes?: readonly RoutingNodeSnapshot[];
  readonly roles?: readonly RoleTemplate[];
  readonly rules?: CompiledRuleSet;
  readonly manifests?: readonly unknown[];
  readonly baseBudget?: BudgetLimits;
  readonly observation?: Record<string, unknown>;
  readonly memoryRecordCount?: number;
}

/**
 * A valid dry-run request, defaulting to the DEFAULT INSTALLATION.
 *
 * Two nodes, one role, a compiled rule set with zero rules, one context manifest
 * and a budget with a concurrency ceiling — so a caller who changes nothing gets
 * the milestone's headline scenario, and every test that needs something else
 * changes exactly one member.
 */
export function simulationRequest(overrides: RequestOverrides = {}): Record<string, unknown> {
  return {
    now: overrides.now ?? FIXED_NOW,
    projectId: overrides.projectId ?? PROJECT_ID,
    runId: RUN_ID,
    installationId: INSTALLATION_ID,
    projectPathId: PROJECT_PATH_ID,
    controllerEpoch: 3,
    correlationId: CORRELATION_ID,
    localDispatchNodeId: overrides.localDispatchNodeId ?? null,
    proposal: {
      requestedBy: USER_ID,
      activationConfirmed: overrides.activationConfirmed ?? true,
      templateRef: { templateId: overrides.templateId ?? TEMPLATE_ID },
      inputs: { target_env: overrides.inputs?.["target_env"] ?? "canary", ...overrides.inputs },
    },
    registry: { nodes: overrides.nodes ?? twoEligibleNodes() },
    roles: overrides.roles ?? [roleSnapshot()],
    rules: overrides.rules ?? emptyRuleSet(),
    memory: { manifests: overrides.manifests ?? [contextManifest()], recordCount: overrides.memoryRecordCount ?? 4 },
    budget: {
      base: { maximumConcurrency: 4, maximumFanOut: 4, ...overrides.baseBudget },
      ...(overrides.observation === undefined ? {} : { observation: overrides.observation }),
    },
  };
}

export interface M6Ports extends SimulationPorts {
  /** The counted repository, under its own type, so a test can read its mutations. */
  readonly templates: CountedTemplateRepository;
  /** The probe, under its own name, so a test can read its counters. */
  readonly probe: BudgetStoreProbe;
  /** The tally the probe and the sinks share. */
  readonly tally: SimulationSinkTally;
}

/**
 * The ports, with a fresh probe and a fresh tally.
 *
 * The probe is created per call so a test's counters are its own, and the role
 * resolver is included by default so `roleCapabilityCheck` is `enforced` in the
 * common case.
 */
export function simulationPorts(overrides: Partial<M6Ports> = {}): M6Ports {
  const tally = overrides.tally ?? emptySinkTally();
  const probe = overrides.probe ?? createBudgetLedgerProbe({ tally });
  return {
    templates: overrides.templates ?? templateRepository(),
    budgetStore: probe,
    probe,
    tally,
    // `in` rather than `??`, so a test can pass `roleCapabilities: undefined` to
    // exercise the `skipped` branch, which is a branch.
    roleCapabilities:
      "roleCapabilities" in overrides
        ? overrides.roleCapabilities
        : roleCapabilitiesGranting(ROLE_CAPABILITIES),
  };
}

/**
 * Simulates, or throws with the refusal attached.
 *
 * Throwing rather than returning the `SimulationResult` is the point: a dry run's
 * refusals are values the product raises, so a test that WANTS one asserts on the
 * value by calling `simulateDryRun` directly. Every other test wants a plan, and a
 * plan that is not a plan should fail the test at the call rather than three
 * assertions later with `undefined` in the message.
 */
export async function planFor(
  request: unknown,
  ports: M6Ports = simulationPorts(),
): Promise<DryRunPlan> {
  const result = await simulateDryRun(request, ports);
  if (!result.ok) {
    throw new Error(`simulateDryRun refused: ${result.refusal.code} — ${result.refusal.message}`);
  }
  return result.value;
}

/**
 * The routing request a plan's first step would produce, as `src/simulation/plan.ts`
 * builds it.
 *
 * Written out here rather than imported, for the same reason `rule-preview.test.ts`
 * writes its own evaluation context: this is the ORACLE for the claim that the
 * plan's routing came from `rankNodes` and not from a second ranker. Deriving the
 * request from the plan's own reported task and the shipped fixture values is what
 * makes the digest comparison a comparison rather than a tautology.
 */
export function routingRequestForFirstStep(): RoutingRequest {
  return {
    projectId: PROJECT_ID,
    projectPathId: PROJECT_PATH_ID,
    // The `build` step's declared capabilities, sorted as the expander sorted them.
    requiredCapabilities: ["fs.read", "shell.run"],
    requiredRuntimeKinds: ["opencode"],
    requiredToolCategories: [],
    now: Date.parse(FIXED_NOW),
    excludeNodeIds: [],
  };
}

// ===========================================================================
// Dispatch envelopes and policy
// ===========================================================================

interface EnvelopeOverrides {
  readonly dispatchId?: string;
  readonly attempt?: number;
  readonly runId?: string;
  readonly taskId?: string;
  readonly targetNodeId?: string;
  readonly runtimeKind?: string;
  readonly prompt?: string;
  readonly role?: RoleTemplate;
  readonly ruleSnapshots?: DispatchEnvelope["ruleSnapshots"];
  readonly requestedCapabilities?: readonly string[];
  readonly permissionEnvelope?: DispatchEnvelope["permissionEnvelope"];
  readonly timeoutSeconds?: number;
  readonly controllerEpoch?: number;
  readonly model?: string;
  /**
   * The whole `contextManifest` member, for the test that has to reproduce the
   * simulator's own digest rather than the fixture's default. Named explicitly
   * rather than folded into the other members because it is the ONE member a
   * digest comparison is sensitive to and a test that got it wrong would be
   * comparing two different envelopes.
   */
  readonly contextManifestOverride?: DispatchEnvelope["contextManifest"];
  /** The `dependencies` member, for the step that is not first in the graph. */
  readonly dependencies?: DispatchEnvelope["dependencies"];
}

/**
 * A dispatch envelope, parsed through `dispatchEnvelopeSchema`.
 *
 * The envelope requires every requested capability to carry an explicit
 * permission decision, so `permissionEnvelope` is derived from
 * `requestedCapabilities` unless the caller states one — a fixture that requested
 * a capability its own permission envelope was silent about would be refused by
 * the schema, which is that rule doing its job rather than a fixture bug.
 */
export function dispatchEnvelope(overrides: EnvelopeOverrides = {}): DispatchEnvelope {
  const requestedCapabilities = overrides.requestedCapabilities ?? ["fs.read"];
  const permissionEnvelope =
    overrides.permissionEnvelope ??
    dispatchEnvelopeSchema.shape.permissionEnvelope.parse({
      allowedCapabilities: [...requestedCapabilities],
      deniedCapabilities: [],
      approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
    });
  return dispatchEnvelopeSchema.parse({
    schemaVersion: 1,
    dispatchId: overrides.dispatchId ?? "disp-m6-1",
    attempt: overrides.attempt ?? 1,
    projectId: PROJECT_ID,
    runId: overrides.runId ?? RUN_ID,
    taskId: overrides.taskId ?? "task-m6-1",
    targetNodeId: overrides.targetNodeId ?? NODE_A,
    installationId: INSTALLATION_ID,
    runtimeKind: overrides.runtimeKind ?? "opencode",
    projectPathId: PROJECT_PATH_ID,
    prompt: overrides.prompt ?? "do the m6 thing",
    roleSnapshot: overrides.role ?? roleSnapshot(),
    ruleSnapshots: overrides.ruleSnapshots ?? [],
    contextManifest: overrides.contextManifestOverride ?? { references: [], manifestDigest: digestJson({ references: [] }) },
    requestedCapabilities: [...requestedCapabilities],
    permissionEnvelope,
    dependencies: overrides.dependencies ?? [],
    timeoutSeconds: overrides.timeoutSeconds ?? 600,
    controllerEpoch: overrides.controllerEpoch ?? 1,
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
  });
}

/**
 * A dispatch envelope carrying a compiled rule set's M0 kernel projections.
 *
 * `kernelRule` is filtered to the rules that are actually present, so a compiled
 * rule with no M0 projection contributes nothing rather than a `null` the M0
 * schema would refuse.
 */
export function envelopeWithRules(
  compiled: CompiledRuleSet,
  overrides: EnvelopeOverrides = {},
): DispatchEnvelope {
  const ruleSnapshots = compiled.rules
    .map((rule) => rule.kernelRule)
    .filter((rule): rule is NonNullable<typeof rule> => rule !== null);
  return dispatchEnvelope({ ...overrides, ruleSnapshots });
}

/**
 * The M0 envelope the simulator builds for the `build` step of `BASE_STEPS`.
 *
 * # Why this is a fixture and not the product's own `buildEnvelope`
 *
 * `src/simulation/plan.ts:985` holds a private `buildEnvelope` that constructs
 * exactly this value. Reusing it would make the dry run's policy claim a
 * tautology — the plan would be compared against itself. This builder writes the
 * envelope out from the fixture values, so a field the simulator set wrongly shows
 * up as a digest mismatch rather than as agreement.
 *
 * The two values a test must supply are the ones the simulator derives from the
 * CONTEXT MANIFEST rather than from the template: `manifestDigest` is the bound
 * manifest's own digest when one is supplied for this dispatch, and the
 * `no-manifest` digest otherwise. `planFor` reports which one it used, so a test
 * asserts against the plan's report rather than against its own assumption.
 */
export function simulatorEnvelope(
  step: "build" | "ship",
  options: {
    readonly role: RoleTemplate;
    /** Branded `Digest`, because `contextManifest.manifestDigest` is one. */
    readonly manifestDigest: DispatchEnvelope["contextManifest"]["manifestDigest"];
    readonly ruleSnapshots?: DispatchEnvelope["ruleSnapshots"];
    readonly targetNodeId?: string;
  },
): DispatchEnvelope {
  const isBuild = step === "build";
  return dispatchEnvelope({
    dispatchId: `disp:${step}`,
    taskId: `task:${step}`,
    prompt: isBuild ? "Build the release" : "Ship the release",
    role: options.role,
    ruleSnapshots: options.ruleSnapshots ?? [],
    requestedCapabilities: isBuild ? ["fs.read", "shell.run"] : ["fs.read"],
    permissionEnvelope: options.role.permissionRestrictions,
    timeoutSeconds: isBuild ? 600 : 900,
    controllerEpoch: 3,
    ...(options.targetNodeId === undefined ? {} : { targetNodeId: options.targetNodeId }),
    contextManifestOverride: { references: [], manifestDigest: options.manifestDigest },
    ...(isBuild
      ? {}
      : {
          // Parsed rather than written: `TaskId` is branded, and a literal would
          // need an `as` — which is the unchecked assertion the rest of this file
          // refuses. `derivedTaskId`'s own algorithm is reproduced here rather than
          // imported, because a digest comparison against the simulator's envelope
          // must not share the function that built it.
          dependencies: [
            { taskId: taskIdSchema.parse(`task:build`), failurePolicy: "block" as const },
          ],
        }),
  });
}

/**
 * The digest the simulator uses when NO manifest is bound to a dispatch.
 *
 * `digestJson({ context: "none", dispatchId })` — a real digest over a statement
 * that there is no context, which is a different claim from a manifest with no
 * items. Exported so a test can reconstruct the envelope for a dispatch the plan
 * reported `context: null` for.
 */
export function absentManifestDigest(dispatchId: string): DispatchEnvelope["contextManifest"]["manifestDigest"] {
  return digestJson({ context: "none", dispatchId });
}

/**
 * The `RuleEvaluationContext` the simulator builds for the `build` step, written out
 * from the fixture values.
 *
 * The oracle for "the plan's rule verdicts came from `evaluateRules`". Written here
 * rather than imported from `src/simulation/plan.ts`'s private `ruleContext` for the
 * same reason `oracleContext` is written in `rule-preview.test.ts`: sharing the
 * builder would make the comparison a tautology.
 *
 * The members that are NOT obvious from the request are the ones the plan derives:
 * `requestedFanOut` and `requestedConcurrency` are the STAGE WIDTH (how many steps
 * share this stage), `requestedRetryLimit` is the composed budget's own limit or
 * `null` when none is in force, `nodeAdvertisedCapabilities` is the selected node's
 * own advertisement, and `contextManifestSensitivity` is the bound manifest's
 * highest item sensitivity — never rank 0 for an absent manifest.
 */
export function simulatorRuleContext(
  compiled: CompiledRuleSet,
  options: {
    readonly role: RoleTemplate;
    readonly nodeCapabilities: readonly string[] | null;
    readonly stageWidth: number;
    readonly maximumRetryLimit?: number;
    readonly manifestSensitivity: ContextManifestV2["destination"]["clearance"] | null;
  },
): RuleEvaluationContext {
  return ruleEvaluationContextSchema.parse({
    projectId: PROJECT_ID,
    roleId: options.role.roleId,
    roleVersion: options.role.templateVersion,
    requestedCapabilities: ["fs.read", "shell.run"],
    toolCategories: [],
    runtimeKind: "opencode",
    targetNodeId: NODE_A,
    nodeAdvertisedCapabilities: options.nodeCapabilities,
    projectPathId: PROJECT_PATH_ID,
    taskLabels: ["env"],
    dependencyOutcomes: [],
    requestedFanOut: options.stageWidth,
    requestedConcurrency: options.stageWidth,
    requestedRetryLimit: options.maximumRetryLimit ?? null,
    declaredTimeoutSeconds: 600,
    taskTitle: "Build the release",
    evaluatedAt: FIXED_NOW,
    contextManifestSensitivity: options.manifestSensitivity,
    currentBudget: { maximumConcurrency: 4, maximumFanOut: 4 },
  });
}

/**
 * Launches an approved proposal through the real service.
 *
 * The `ApplicationCommand` union is discriminated on `type` and every member's
 * identifier is branded, so a hand-built command object in a test would need four
 * `as` casts — the unchecked assertion the rest of this file refuses. This builder
 * takes the ids off the proposal the service itself produced, which is both honest
 * and the only way the command can be a valid one.
 */
export async function launchApprovedProposal(
  service: InMemoryLocalApplicationService,
  operationId: CommandId,
  runId: RunId,
  proposal: {
    readonly dispatch: {
      readonly envelope: { readonly dispatchId: DispatchId };
      readonly envelopeDigest: Digest;
    };
    readonly approval?: { readonly approvalId: ApprovalId };
  },
): Promise<Result<LaunchOutcome>> {
  if (proposal.approval === undefined) {
    return fail("validation", "fixture.no_approval", "The proposal carries no recorded approval.");
  }
  return service.execute({
    type: "dispatch.launch",
    operationId,
    correlationId: CORRELATION_ID,
    runId,
    dispatchId: proposal.dispatch.envelope.dispatchId,
    envelopeDigest: proposal.dispatch.envelopeDigest,
    approvalId: proposal.approval.approvalId,
  });
}

/** The kernel's own policy evaluation. Throws on refusal, by the kernel's design. */
export function policyFor(envelope: DispatchEnvelope, taskTitle?: string): PolicyEvaluation {
  return evaluatePolicy(taskTitle === undefined ? { envelope } : { envelope, taskTitle });
}

/**
 * The kernel's `evaluatePolicy` under its own name, for a test that wants to call the
 * KERNEL rather than the fixture. `policyFor` is the fixture-shaped wrapper; this is
 * the bare function, re-exported so a test file has one import path for the value and
 * so "the test called the product" is visible in the import rather than hidden behind a
 * helper whose name could mean anything.
 */
export const POLICY_EVALUATOR = evaluatePolicy;

/** The rendered policy explanation, for a claim that has to be readable. */
export function explanationFor(evaluation: PolicyEvaluation): string {
  return renderPolicyExplanation(evaluation);
}

/**
 * The safety floor applied to a dispatch, as the kernel's own state.
 *
 * A thin wrapper over `seedPolicyState` plus the floor's own narrowing, so a test
 * can ask "what does the floor alone permit?" without re-implementing the layer
 * order — and the floor's members are read from the shipped `SAFETY_FLOOR` value
 * rather than restated here.
 */
export function floorStateFor(envelope: DispatchEnvelope): EffectivePolicyState {
  return narrowPolicyState(seedPolicyState(envelope), "safety_floor", {
    deniedCapabilities: [],
    requireApprovalForCapabilities: [],
    requireApprovalForDispatch: SAFETY_FLOOR.requireApprovalForDispatch,
    requireApprovalForDestructiveEffects: SAFETY_FLOOR.requireApprovalForDestructiveEffects,
    requireApprovalForExternalEffects: SAFETY_FLOOR.requireApprovalForExternalEffects,
    allowDestructiveEffects: SAFETY_FLOOR.allowDestructiveEffects,
    allowExternalEffects: SAFETY_FLOOR.allowExternalEffects,
    maximumTimeoutSeconds: SAFETY_FLOOR.maximumTimeoutSeconds,
  }).state;
}

// ===========================================================================
// Budget ledger
// ===========================================================================

/** A budget with both ceilings the gate consults. */
export function concurrencyBudget(limit: number): BudgetLimits {
  return { maximumConcurrency: limit, maximumFanOut: limit };
}

/** A ledger over `limits`, with a store the caller can also hold. */
export function budgetLedger(
  limits: BudgetLimits,
  options?: { readonly store?: BudgetLedgerStore; readonly defaultLeaseSeconds?: number },
): { readonly ledger: BudgetLedger; readonly store: BudgetLedgerStore } {
  const store = options?.store ?? new InMemoryBudgetLedgerStore();
  const ledger = new BudgetLedger({
    store,
    resolveLimits: () => limits,
    ...(options?.defaultLeaseSeconds === undefined
      ? {}
      : { defaultLeaseSeconds: options.defaultLeaseSeconds }),
  });
  return { ledger, store };
}

/** A reservation request for `index`, so N dispatches do not need N literals. */
export function reserveRequestFor(
  index: number,
  overrides: Partial<{
    projectId: string;
    runId: string;
    taskId: string;
    dispatchId: string;
    reservationId: string;
    units: number;
    now: string;
    leaseSeconds: number;
    scope: "concurrency" | "fan_out";
  }> = {},
): Parameters<BudgetLedger["reserve"]>[0] {
  // Parsed through the ledger's own request schema, so a fixture that drifted out
  // of the contract fails here rather than inside a safety assertion.
  return reserveRequestSchema.parse({
    reservationId: `res-m6-${index}`,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    taskId: `task-m6-${index}`,
    dispatchId: `disp-m6-${index}`,
    scope: "concurrency",
    units: 1,
    now: FIXED_NOW,
    leaseSeconds: 600,
    ...overrides,
  });
}

/**
 * A reservation record, parsed through `budgetReservationSchema`.
 *
 * The owning schema rather than an object literal, because `taskId` and
 * `dispatchId` are BRANDED and a literal would need an `as` to satisfy the brand —
 * which is the unchecked assertion this milestone's other builders refuse. Parsing
 * also re-checks the `held`-lease-after-creation refinement, so a fixture cannot
 * mint a record the ledger would refuse.
 */
export function reservationRecord(overrides: Partial<BudgetReservation> = {}): BudgetReservation {
  return budgetReservationSchema.parse({
    reservationId: reservationIdSchema.parse("res-m6-durable"),
    projectId: PROJECT_ID,
    runId: RUN_ID,
    taskId: taskIdSchema.parse("task-m6-durable"),
    dispatchId: dispatchIdSchema.parse("disp-m6-durable"),
    scope: "concurrency",
    units: 1,
    state: "held",
    leaseExpiresAt: "2026-06-01T09:10:00.000Z",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  });
}

/** Every budget scope, for the sweep tests. */
export const ALL_SCOPES = BUDGET_SCOPES;

/**
 * The replay request for one project and one scope's ceiling.
 *
 * `replayDurableReservations` takes the ceiling as a CALLER value rather than
 * re-deriving it, because the budget in force at crash time may not be the one in
 * force now. A test that omits it is not exercising the admission path at all —
 * every occupying row is refused as `ceiling_undeclared` — so the helper states it.
 */
export function replayRequest(
  ceiling: number | null,
  scope: "concurrency" | "fan_out" = "concurrency",
  projectId: string = PROJECT_ID,
): Parameters<typeof replayDurableReservations>[2] {
  return { now: FIXED_NOW, ceilings: [{ projectId, scope, ceiling }] };
}

/**
 * The total units occupying `(projectId, scope)` across a reservation list.
 *
 * Computed here rather than read off a store index, because the invariant under
 * test is exactly that the index and the reservation list agree — a helper that
 * read the index would be asserting the index against itself.
 */
export function occupiedUnits(
  reservations: readonly BudgetReservation[],
  projectId: string,
  scope: "concurrency" | "fan_out",
): number {
  return reservations
    .filter(
      (reservation) =>
        reservation.projectId === projectId &&
        reservation.scope === scope &&
        (reservation.state === "held" || reservation.state === "committed"),
    )
    .reduce((total, reservation) => total + reservation.units, 0);
}

// ===========================================================================
// Notifications
// ===========================================================================

/** A literal instant, so nothing in the gate depends on when the suite ran. */
export const NOTIFICATION_NOW = "2026-06-01T09:00:00.000Z" as NotificationTimestamp;

/** A clock a test drives by hand. Nothing here reads ambient time. */
export function notificationClock(
  start: NotificationTimestamp = NOTIFICATION_NOW,
): NotificationClock & { set(value: NotificationTimestamp): void; advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
    advance: (ms) => {
      current = new Date(Date.parse(current) + ms).toISOString() as NotificationTimestamp;
    },
  };
}

interface NotificationRequestOverrides {
  readonly dedupeKey?: string;
  readonly category?: NotificationCategory;
  readonly severity?: NotificationSeverity;
  readonly summary?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly dispatchId?: string;
  readonly nodeId?: string;
  readonly ruleId?: string;
  readonly reasonCode?: string;
}

/** A valid notification request, with one field overridable. */
export function notificationRequest(overrides: NotificationRequestOverrides = {}): NotificationRequest {
  return {
    dedupeKey: "run_blocked:run-m6-1:task-m6-1:rule-m6-deny",
    category: "run_blocked",
    severity: "critical",
    summary: "Run run-m6-1 task-m6-1 blocked by rule rule-m6-deny (rule.denied)",
    runId: RUN_ID,
    taskId: "task-m6-1",
    ruleId: "rule-m6-deny",
    reasonCode: "rule.denied",
    ...overrides,
  } as NotificationRequest;
}

export interface RecordingAdapter extends NotificationAdapter {
  readonly calls: readonly NotificationEnvelope[];
  deliveredIds(): readonly string[];
}

/** An adapter that records what it was handed and always succeeds. */
export function recordingAdapter(id: string, available = true): RecordingAdapter {
  const calls: NotificationEnvelope[] = [];
  return {
    id,
    available: () => available,
    async deliver(envelope: NotificationEnvelope) {
      calls.push(envelope);
      return { delivered: true, notificationId: envelope.notificationId };
    },
    get calls() {
      return Object.freeze([...calls]);
    },
    deliveredIds: () => Object.freeze(calls.map((envelope) => envelope.notificationId)),
  };
}

/** An adapter whose `deliver` throws. */
export function throwingAdapter(id: string): NotificationAdapter {
  return {
    id,
    async deliver(): Promise<never> {
      throw new Error(`${id} is unavailable and says so by throwing`);
    },
  };
}

/** An adapter that reports itself unavailable through the `available` hook. */
export function unavailableAdapter(id: string): NotificationAdapter {
  return {
    id,
    available: () => false,
    async deliver(): Promise<never> {
      throw new Error("an unavailable adapter must not be asked to deliver");
    },
  };
}

export interface NotificationHarness {
  readonly clock: ReturnType<typeof notificationClock>;
  readonly store: ReturnType<typeof createNotificationStore>;
  readonly bus: ReturnType<typeof createNotificationBus>;
  readonly tui: ReturnType<typeof createNotificationTuiAdapter>;
  /** The store's entries at rest, for an audit's `inbox_at_rest` path. */
  readonly entriesAtRest: () => readonly unknown[];
  /** The rendered view's lines, built through the shipped reducer and view builder. */
  readonly renderedLines: () => readonly string[];
  /** The one-line notice the shell would show. */
  readonly noticeLine: () => string | null;
}

/**
 * A store, a bus, the shipped in-TUI adapter and a clock, wired the way M6.8
 * wires them.
 *
 * The rendered view goes through the REAL reducer and the REAL view builder, so a
 * no-secret assertion is made against text the product would actually show rather
 * than against a hand-written approximation of it.
 */
export function notificationHarness(
  options: { readonly quieting?: NotificationQuieting; readonly adapters?: readonly NotificationAdapter[] } = {},
): NotificationHarness {
  const clock = notificationClock();
  const store = createNotificationStore({ clock });
  const tui = createNotificationTuiAdapter();
  const bus = createNotificationBus({
    store,
    adapters: options.adapters ?? [tui],
    clock,
    ...(options.quieting === undefined ? {} : { quieting: options.quieting }),
  });
  const stateAt = () => loadNotificationTuiEntries(store, initialNotificationTuiState(clock.now()), clock.now());
  return {
    clock,
    store,
    bus,
    tui,
    entriesAtRest: () => store.entries(),
    renderedLines: () => buildNotificationTuiView(stateAt()).lines,
    noticeLine: () => notificationNoticeLine(stateAt()),
  };
}

// ===========================================================================
// The M3 application service (rule-edit invalidation)
// ===========================================================================

/**
 * A project definition whose rule snapshots a test controls.
 *
 * `LocalProjectDefinition.ruleSnapshots` is a member of the material fingerprint
 * the service compares, so this is the seam ADR 0007 names: a rule edit is a
 * change to this array, and the service must invalidate rather than silently
 * re-evaluate.
 */
export function serviceProjectDefinition(
  overrides: Partial<LocalProjectDefinition> = {},
): LocalProjectDefinition {
  const permissionEnvelope = {
    allowedCapabilities: ["filesystem.read", "filesystem.write"],
    deniedCapabilities: ["network.external"],
    approvalRequirements: {
      destructiveEffects: true,
      externalEffects: true,
      capabilities: ["filesystem.write"],
    },
  };
  return {
    project: {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      meshId: "mesh-m6" as never,
      name: "M6 fixture project",
      pathBindings: [
        {
          schemaVersion: 1,
          projectPathId: PROJECT_PATH_ID,
          projectId: PROJECT_ID,
          nodeId: NODE_A,
          configuredPath: "/workspace/m6-fixture",
          allowedCapabilities: ["filesystem.read", "filesystem.write"],
        },
      ],
    },
    projectPathId: PROJECT_PATH_ID,
    nodeContext: {
      schemaVersion: 1,
      nodeId: NODE_A,
      meshId: "mesh-m6" as never,
      platform: "fixture",
      architecture: "fixture",
    },
    installation: {
      schemaVersion: 1,
      installationId: INSTALLATION_ID as never,
      nodeId: NODE_A,
      runtimeKind: "scripted-opencode",
      displayName: "Scripted OpenCode",
      version: "fixture-1",
      capabilities: {
        structuredPermissions: true,
        nativeSessionRestore: true,
        reliableCompletion: true,
        modelSelection: true,
        usageData: false,
        hooks: false,
        transcriptExport: false,
      },
    },
    roleSnapshot: {
      schemaVersion: 1,
      roleId: ROLE_ID,
      templateVersion: 1,
      projectId: PROJECT_ID,
      name: "M6 test engineer",
      purpose: "Exercise the safety floor.",
      instructions: "Use only the deterministic fixture project.",
      requiredCapabilities: ["filesystem.read"],
      preferredRuntimeKinds: ["scripted-opencode"],
      contextSelectionPolicyReference: { namespace: "m6", id: "m6" },
      permissionRestrictions: permissionEnvelope,
      author: { kind: "system", name: "m6-fixture" },
      createdAt: SERVICE_NOW,
    },
    ruleSnapshots: [],
    contextManifest: { references: [], manifestDigest: digestJson({ references: [] }) },
    requestedCapabilities: ["filesystem.read", "filesystem.write"],
    permissionEnvelope,
    availableModels: ["fixture-model"],
    controller: { controllerNodeId: NODE_A, controllerEpoch: 1, leaseId: "lease-m6" as never },
    ...overrides,
  };
}

/**
 * An M0 `Rule`, parsed through the kernel's own `ruleSchema`.
 *
 * `LocalProjectDefinition.ruleSnapshots` is a list of the M0 shape, NOT of a
 * compiled M6 rule: the application service binds it into the dispatch envelope's
 * digest and into its material-definition fingerprint, so a test that wants to
 * perform a RULE EDIT has to produce a value this build can read. Parsing rather
 * than writing a literal is what makes the edit a real one — a hand-written
 * snapshot that `ruleSchema` refused would be refused by
 * `ProfileLocalProjectRegistry` as an invalid project configuration before the
 * service ever compared the fingerprint, and the test would be asserting a refusal
 * it thinks is a policy decision.
 */
export function kernelRuleSnapshot(
  overrides: Partial<Record<string, unknown>> = {},
): LocalProjectDefinition["ruleSnapshots"][number] {
  return ruleSchema.parse({
    schemaVersion: 1,
    ruleId: "rule-m6-kernel",
    templateVersion: 1,
    projectId: PROJECT_ID,
    enabled: true,
    match: { requestedCapabilitiesAny: ["filesystem.read"] },
    effect: {
      kind: "restrict",
      deniedCapabilities: [],
      requireApprovalForDestructiveEffects: true,
      requireApprovalForExternalEffects: true,
    },
    author: { kind: "user", userId: USER_ID },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  })
}

/** The same rule at a new version, which is what an edit looks like to the service. */
export function kernelRuleSnapshotAtVersion(
  templateVersion: number,
  overrides: Partial<Record<string, unknown>> = {},
): LocalProjectDefinition["ruleSnapshots"][number] {
  return kernelRuleSnapshot({ templateVersion, ...overrides })
}

/**
 * A `LocalProjectRegistry` over a mutable definition.
 *
 * `current` is public and assignable precisely so a test can perform a RULE EDIT
 * between two operations and watch what the service does.
 */
export class MutableProjectRegistry implements LocalProjectRegistry {
  current: LocalProjectDefinition;
  launchAuthorized = true;
  readonly authorizationRequests: LaunchPathAuthorizationRequest[] = [];

  constructor(current: LocalProjectDefinition = serviceProjectDefinition()) {
    this.current = current;
  }

  async listAuthorizedProjects(): Promise<Result<readonly LocalProjectDefinition[]>> {
    return ok([structuredClone(this.current)]);
  }

  async getAuthorizedProject(
    projectId: LocalProjectDefinition["project"]["projectId"],
  ): Promise<Result<LocalProjectDefinition>> {
    return projectId === this.current.project.projectId
      ? ok(structuredClone(this.current))
      : fail("policy_denied", "fixture.project_denied", "Project is not authorized.");
  }

  async authorizeLaunchPath(
    request: LaunchPathAuthorizationRequest,
  ): Promise<Result<LaunchPathAuthorization>> {
    this.authorizationRequests.push(structuredClone(request));
    return this.launchAuthorized
      ? ok({ ...request, realPath: request.configuredPath })
      : fail("policy_denied", "fixture.path_denied", "Project path authorization was revoked.");
  }
}

/** A clock that hands out `SERVICE_NOW` and can be moved by a test. */
export function serviceClock(): { now(): string; advanceTo(instant: string): void } {
  let current = SERVICE_NOW;
  return {
    now: () => current,
    advanceTo: (instant) => {
      current = instant;
    },
  };
}

/** An id source that hands out `kind-m6-N`, deterministically. */
export function serviceIds(): { next(kind: string): string; readonly issued: readonly string[] } {
  let sequence = 0;
  const issued: string[] = [];
  return {
    next: (kind) => {
      const id = `${kind}-m6-${++sequence}`;
      issued.push(id);
      return id;
    },
    get issued() {
      return Object.freeze([...issued]);
    },
  };
}

/** A deterministic operation-id sequence. */
export function operationIdFactory(): () => CommandId {
  let sequence = 0;
  return () => commandIdSchema.parse(`operation-m6-${++sequence}`);
}

/**
 * A real `InMemoryLocalApplicationService` over scripted runtime and terminal
 * adapters.
 *
 * The runtime and terminal are small but REAL implementations of the shipped
 * interfaces: they record what they were handed and return schema-valid values,
 * so the proposal → approval → launch path is the production one rather than a
 * shortcut past it.
 */
export function applicationService(
  registry: MutableProjectRegistry = new MutableProjectRegistry(),
): {
  readonly service: InMemoryLocalApplicationService;
  readonly registry: MutableProjectRegistry;
  /** Everything the runtime was asked to launch, in order. */
  readonly launches: readonly unknown[];
} {
  const launches: unknown[] = [];
  const dependencies: LocalApplicationDependencies = {
    runtime: scriptedRuntime(launches),
    terminal: scriptedTerminal(),
    clock: serviceClock(),
    ids: serviceIds(),
    projects: registry,
  };
  return { service: new InMemoryLocalApplicationService(dependencies), registry, launches };
}

/** A scripted runtime that records launches and returns a schema-valid session. */
function scriptedRuntime(launches: unknown[]): AgentRuntimeAdapter {
  return {
    kind: "scripted-opencode",
    capabilities: {
      structuredPermissions: true,
      nativeSessionRestore: true,
      reliableCompletion: true,
      modelSelection: true,
      usageData: false,
      hooks: false,
      transcriptExport: false,
    },
    async detect() {
      return ok([]);
    },
    async launch(request) {
      launches.push(clone(request));
      // Through `runtimeSessionSchema`, because the session is a branded M0 record
      // and a hand-written literal would need `as never` on four identifier fields.
      // The schema is also the authority on the lifecycle/observation pairing, so a
      // scripted runtime cannot claim a finished session at the instant it launched.
      return ok(
        runtimeSessionSchema.parse({
          schemaVersion: 1,
          sessionId: SESSION_ID,
          projectId: request.operation.projectId,
          runId: request.operation.runId,
          taskId: request.dispatchEnvelope.taskId,
          dispatchId: request.operation.dispatchId,
          nodeId: request.operation.nodeId,
          installationId: request.dispatchEnvelope.installationId,
          runtimeKind: request.dispatchEnvelope.runtimeKind,
          lifecycleState: "launching",
          observedState: "starting",
        }),
      );
    },
    async restore() {
      return fail("policy_denied", "fixture.restore", "Restore is unavailable.");
    },
    async prompt() {
      return ok(undefined);
    },
    async *observe() {
      // No observations queued; the service treats an empty stream as "no news".
      return;
    },
    async respond() {
      return ok(undefined);
    },
    async interrupt() {
      return ok(undefined);
    },
    async terminate() {
      return ok(undefined);
    },
    async collectResult() {
      return ok({
        schemaVersion: 1,
        outcome: "unknown",
        summary: "No verified completion evidence is available.",
      });
    },
  };
}

/**
 * The terminal reference this backend hands back, parsed through the real schema.
 *
 * `TERMINAL_ID` is a fixed literal rather than an allocated id because the
 * application service allocates the real terminal id itself and passes it in
 * `createTerminalRequest.terminalId`; the fixture's own id is only ever what a
 * direct terminal read returns.
 */
const TERMINAL_ID = terminalIdSchema.parse("terminal-m6");

/**
 * A scripted terminal that satisfies the REAL interface and returns schema-valid
 * values.
 *
 * `create` returns `ok(...)`, not the bare reference, and `attach` returns a channel
 * carrying `reference` — the two members a hand-written adapter most often omits,
 * and the two whose absence is exactly the kind of mismatch a branded identifier
 * surfaces as a wall of nominal-type errors rather than as a diagnostic. Every value
 * here is parsed by the terminal's own schema, so the fixture cannot drift out of the
 * contract it is supposed to satisfy.
 */
function scriptedTerminal(): TerminalBackend {
  const reference = terminalReferenceSchema.parse({
    schemaVersion: 1,
    terminalId: TERMINAL_ID,
    nodeId: NODE_A,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    backendKind: "scripted-terminal",
    adapterMetadata: { recoveryVersion: "1", fixture: "m6" },
  });
  const channel: TerminalChannel = {
    reference,
    clientId: terminalClientIdSchema.parse("client-m6"),
    async read() {
      return ok(new Uint8Array());
    },
    async write() {
      return ok(undefined);
    },
    async requestInputOwnership() {
      return ok(
        terminalInputOwnershipSchema.parse({
          schemaVersion: 1,
          terminalId: reference.terminalId,
          ownerClientId: channel.clientId,
          changedAt: SERVICE_NOW,
        }),
      );
    },
    async releaseInputOwnership() {
      return ok(
        terminalInputOwnershipSchema.parse({
          schemaVersion: 1,
          terminalId: reference.terminalId,
          ownerClientId: null,
          changedAt: SERVICE_NOW,
        }),
      );
    },
    async takeOverInput() {
      return ok(
        terminalInputOwnershipSchema.parse({
          schemaVersion: 1,
          terminalId: reference.terminalId,
          ownerClientId: channel.clientId,
          changedAt: SERVICE_NOW,
        }),
      );
    },
  };
  return {
    kind: "scripted-terminal",
    async create(request) {
      // The binding is echoed from the request, which is what the application
      // service checks against the session it was launched for.
      return ok(
        terminalReferenceSchema.parse({
          schemaVersion: 1,
          terminalId: request.terminalId,
          nodeId: request.operation.nodeId,
          projectId: request.operation.projectId,
          sessionId: request.sessionId,
          backendKind: request.backendKind,
          adapterMetadata: reference.adapterMetadata,
        }),
      );
    },
    async attach() {
      return ok(channel);
    },
    async resize() {
      return ok(undefined);
    },
    async snapshot(attached) {
      return ok(
        terminalSnapshotSchema.parse({
          schemaVersion: 1,
          terminalId: attached.terminalId,
          nodeId: attached.nodeId,
          projectId: attached.projectId,
          sessionId: attached.sessionId,
          capturedAt: SERVICE_NOW,
          byteCount: 0,
          truncated: false,
          data: new Uint8Array(),
        }),
      );
    },
    async detach() {
      return ok(undefined);
    },
    async terminate() {
      return ok(undefined);
    },
    async recover() {
      return ok([]);
    },
  };
}

// ===========================================================================
// Canaries
// ===========================================================================

/**
 * A canary per free-text field of the snapshots.
 *
 * Declared HERE, in the fixtures, rather than in the module under audit: an audit
 * whose canary list is produced by the code it audits is an audit that agrees
 * with whatever that code happens to carry. Each is a distinct literal, so a
 * finding names the field it came from rather than "a canary".
 */
export const CANARIES = Object.freeze({
  roleName: "canary-role-name-4f1a",
  rolePurpose: "canary-role-purpose-9c22",
  roleInstructions: "canary-role-instructions-7bd3",
  templateName: "canary-template-name-2e5b",
  templateDescription: "canary-template-description-8a17",
  stepTitle: "canary-step-title-6d90",
  nodeDisplayName: "canary-node-display-name-1c34",
  // At most sixteen characters: the template's `target_env` parameter declares
  // `maxLength: 16`, and a canary the schema refuses would never reach the
  // snapshot it is meant to poison.
  parameterValue: "canary-pm-7b02",
});

/** Every canary, sorted, for an audit's `seededCanaries` member. */
export function everyCanary(): readonly string[] {
  return Object.values(CANARIES).sort();
}

/** A dry-run request with a canary planted in every free-text field of every snapshot. */
export function canariedRequest(rules: CompiledRuleSet = emptyRuleSet()): Record<string, unknown> {
  return simulationRequest({
    rules,
    nodes: [
      registryNode({ nodeId: NODE_A, displayName: CANARIES.nodeDisplayName }),
      registryNode({
        nodeId: NODE_B,
        displayName: CANARIES.nodeDisplayName,
        capabilities: ["fs.read", "fs.write", "shell.run"],
      }),
    ],
    roles: [
      roleSnapshot({
        name: CANARIES.roleName,
        purpose: CANARIES.rolePurpose,
        instructions: CANARIES.roleInstructions,
      }),
    ],
    inputs: { target_env: CANARIES.parameterValue },
    manifests: [],
  });
}

/** The template whose every free-text field carries a canary. */
export function canariedTemplateInput(): RunTemplateInput {
  return templateInput({
    name: CANARIES.templateName,
    description: CANARIES.templateDescription,
    steps: BASE_STEPS.map((step) => ({
      ...clone(step),
      title: CANARIES.stepTitle,
    })) as RunTemplateInput["steps"],
  });
}

// ===========================================================================
// The structural audit
// ===========================================================================

/**
 * What the preview/plan audit reads.
 *
 * `unknown`, on purpose. A typed input would import the view model it was
 * checking, and adding a content-bearing field to that model would re-shape the
 * check into silence instead of into a failure — the reason
 * `src/context/isolation.ts:94-122` audits a structurally declared input.
 */
export interface M6AuditInput {
  readonly artifact: unknown;
  /** Any text a consumer rendered from it, checked in addition to the value. */
  readonly renderedText?: readonly string[];
  readonly seededCanaries: readonly string[];
}

/** Every encoding a value could plausibly arrive in. */
function encodingsOf(value: string): readonly string[] {
  return [
    value,
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("base64url"),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ];
}

/** Canonical JSON, or a marker if the value cannot be encoded. */
function canonical(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    return "<<unencodable: this value cannot be canonicalised, which is itself a finding>>";
  }
}

/**
 * Walks the whole artifact and every rendered line, in every encoding.
 *
 * Returns FINDINGS rather than a boolean: a boolean tells a reviewer that
 * something was wrong and not what. An empty list means "checked every canary in
 * every encoding against the whole value and found nothing", not "found nothing to
 * check".
 */
export function auditForCanaries(input: M6AuditInput): readonly string[] {
  const haystacks: readonly { label: string; text: string }[] = [
    { label: "artifact", text: canonical(input.artifact) },
    ...(input.renderedText ?? []).map((text, index) => ({ label: `renderedText[${index}]`, text })),
  ];
  const findings: string[] = [];
  for (const canary of input.seededCanaries) {
    for (const encoding of encodingsOf(canary)) {
      if (encoding.length === 0) continue;
      for (const haystack of haystacks) {
        if (haystack.text.includes(encoding)) {
          findings.push(`canary of ${encoding.length} chars found in ${haystack.label}`);
        }
      }
    }
  }
  return findings;
}

// ===========================================================================
// Re-exports, so a test needs one import path for a kernel value
// ===========================================================================

/**
 * Kernel and milestone values a test needs, re-exported so a test file has ONE
 * import path for a value.
 *
 * Every name here is already imported above for the fixtures' own use, so this is
 * a re-export rather than a second import — a second import of the same symbol
 * from the same module would be a duplicate the reader has to reconcile.
 */
export {
  SAFETY_FLOOR,
  SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
  auditNotificationPayload,
  compileRuleSet,
  evaluatePolicy,
  notificationEnvelopeSchema,
  notificationRequestSchema,
  NOTIFICATION_EGRESS_PATHS,
  rankNodes,
  ruleSourceDocumentSchema,
  simulateDryRun,
};
export type {
  DryRunPlan,
  EffectivePolicyState,
  RoutingPreference,
  RoutingRequest,
  RoutingResult,
  SimulatedDispatch,
};
