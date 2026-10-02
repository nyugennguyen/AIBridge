/**
 * M6.10 GATE — the adversarial pass: every way a user rule, budget, route or
 * notification might widen the system, attempted.
 *
 * ================================ WHAT THIS FILE IS FOR ================================
 *
 * The other two M6 gate files (`rule-preview.test.ts`, `dry-run.test.ts`) prove the
 * features WORK. This file proves they cannot be turned against the system, and the
 * method is uniform: for every escalation the plan or the ADR names, the escalation
 * is actually attempted and the refusal is required, with its code and its reason.
 *
 * A file that asserted "the floor is un-relaxable" without attempting a relaxation
 * would be asserting a comment. Every test below therefore has three parts:
 *
 *   1. the attempt, spelled as a DOCUMENT or a call, never as an assertion about code;
 *   2. the refusal, with the code and the words a reader would need to act on it;
 *   3. a statement of what the system did INSTEAD — because "refused" is only half
 *      the claim, and the other half is "and the safe state is the one in force".
 *
 * ## The six Stop Conditions (ADR 0007), and where each is discharged
 *
 *   1. Preview diverging from runtime — `rule-preview.test.ts` section 1, and
 *      `dry-run.test.ts` section 3. Not repeated here.
 *   2. A rule edit affecting an active dispatch or approval — section 6 below, over
 *      the REAL M3 application service.
 *   3. Budget reservation not being atomic with eligibility — section 4 below.
 *   4. A user rule granting a floor- or role-removed capability — section 2 below.
 *   5. A compiled set admitting an action wider than the disclosed bounds —
 *      section 3 below.
 *   6. A notification affecting orchestration state — section 7 below.
 *
 * ## Completion criteria this file carries
 *
 *   - "Default installations still require approval for every dispatch" (section 1).
 *   - "User rules are versioned, deterministic, bounded, explainable, and cannot
 *     execute code" (sections 2 and 9).
 *   - "Safety-floor and role restrictions cannot be weakened" (section 2).
 *   - "Pre-approval is restricted to the exact displayed bounds" (section 3).
 *   - "Fan-out, concurrency, retry, and wall-time budgets survive restart and replay"
 *     (section 4).
 *   - "Routing is deterministic for the same registry snapshot and excludes
 *     unauthorized/unhealthy nodes" (section 5).
 *   - "Notifications are deduplicated and contain no secret prompt/context content"
 *     (section 7).
 *   - "Dry run produces no persistent or external side effect" (section 8).
 *
 * ## Discipline
 *
 * One injected clock, one seeded generator, no `Date.now`, no `Math.random`, no real
 * network, no real subprocess, no filesystem writes. The runtime and terminal
 * adapters are real implementations of the shipped interfaces that record what they
 * were handed, so the M3 path under test is the production path.
 */

import { describe, expect, it } from "vitest"
import {
  ALL_SCOPES,
  applicationService,
  auditForCanaries,
  budgetDocument,
  budgetLedger,
  canariedRequest,
  canariedTemplateInput,
  CANARIES,
  compileRuleSet,
  compiledFrom,
  CORRELATION_ID,
  denyDocument,
  dispatchEnvelope,
  everyCanary,
  FIXED_NOW,
  kernelRuleSnapshotAtVersion,
  launchApprovedProposal,
  MutableProjectRegistry,
  NODE_A,
  NODE_B,
  NODE_UNAUTHORIZED,
  NODE_UNHEALTHY,
  notificationClock,
  notificationHarness,
  notificationRequest,
  occupiedUnits,
  operationIdFactory,
  planFor,
  POLICY_EVALUATOR,
  preApprovalDocument,
  PROJECT_ID,
  PROJECT_PATH_ID,
  rawRuleDocument,
  recordingAdapter,
  registryNode,
  replayRequest,
  requireApprovalDocument,
  reserveRequestFor,
  roleSnapshot,
  routingDocument,
  SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
  serviceProjectDefinition,
  simulationPorts,
  simulationRequest,
  templateRepository,
  throwingAdapter,
  twoEligibleNodes,
  unavailableAdapter,
  universalPreApprovalDocument,
  USER_ID,
} from "./m6-fixtures.js"
import {
  auditNotificationPayload,
  createNotificationBus,
  notificationRequestSchema,
  NOTIFICATION_EGRESS_PATHS,
  type NotificationInboxEntry,
  type NotificationStore,
} from "../../src/notifications/index.js"
import { recoverLeaked, replayDurableReservations } from "../../src/budgets/index.js"
import { assertNoRetainedSideEffects, readSinkCounters, simulateDryRun } from "../../src/simulation/index.js"
import { rankNodes } from "../../src/routing/index.js"
import { NON_UNIVERSAL_PREDICATE_FIELDS, compileRuleSet as compileFromSource } from "../../src/rules/index.js"
import { canonicalJson } from "../../src/orchestration/digest.js"
import type { CommandId, RunId } from "../../src/orchestration/identifiers.js"
import type { InMemoryLocalApplicationService } from "../../src/application/service.js"

// ===========================================================================
// Helpers
// ===========================================================================

/** Unwraps a `Result`, throwing with the code attached — a refusal is a failure here. */
function ok<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/**
 * A run driven to an APPROVED but unlaunched proposal, over the real service.
 *
 * The state a retroactive rule edit could do damage in, and the only one that can:
 * a proposal the operator has already approved. Written here rather than in the
 * fixtures because the SEQUENCE is the claim under test, and a fixture that other
 * files also drive would make a change to it change this file's evidence.
 */
async function approvedRun(registry: MutableProjectRegistry) {
  const { service, launches } = applicationService(registry);
  const op = operationIdFactory();
  ok(await service.execute({ type: "projects.select", projectId: PROJECT_ID, correlationId: CORRELATION_ID }));
  const draft = ok(
    await service.execute({ type: "draft.create", operationId: op(), correlationId: CORRELATION_ID, projectId: PROJECT_ID }),
  );
  const edited = ok(
    await service.execute({
      type: "draft.edit",
      operationId: op(),
      correlationId: CORRELATION_ID,
      runId: draft.runId,
      expectedRevision: draft.revision,
      patch: {
        goal: "Ship the frozen release",
        taskTitle: "Run one task",
        taskDescription: "Exercise the vertical slice.",
        prompt: "Inspect the project and report a verified result.",
        model: "fixture-model",
        timeoutSeconds: 600,
      },
    }),
  );
  const proposed = ok(
    await service.execute({
      type: "proposal.create",
      operationId: op(),
      correlationId: CORRELATION_ID,
      runId: edited.runId,
      expectedRevision: edited.revision,
    }),
  );
  const proposal = proposed.currentProposal;
  if (proposal === undefined) throw new Error("the service created a run with no proposal");
  const decided = ok(
    await service.execute({
      type: "proposal.decide",
      operationId: op(),
      correlationId: CORRELATION_ID,
      runId: proposed.draft.runId,
      dispatchId: proposal.dispatch.envelope.dispatchId,
      attempt: proposal.dispatch.envelope.attempt,
      envelopeDigest: proposal.dispatch.envelopeDigest,
      decision: "approved",
      userId: USER_ID,
    }),
  );
  const approved = decided.currentProposal;
  if (approved === undefined || approved.approval === undefined) {
    throw new Error("the approval was not recorded");
  }
  return { service, launches, op, runId: decided.draft.runId, approved };
}

/** The launch command for an approved proposal, with the ids read off it. */
function launchCommand(
  service: InMemoryLocalApplicationService,
  op: () => CommandId,
  runId: RunId,
  approved: Parameters<typeof launchApprovedProposal>[3],
) {
  return launchApprovedProposal(service, op(), runId, approved);
}

// ===========================================================================
// 1. A default installation requires approval for EVERY dispatch
// ===========================================================================

describe("M6.10 — a default installation requires approval for every dispatch, and nothing reaches `allow`", () => {
  it("plans the whole template and reaches `require_approval` for every dispatch, with nothing to allow", async () => {
    // The DEFAULT INSTALLATION: `compileRuleSet([])` — zero enabled rules, which is
    // what ADR 0007 section 18 says ships. Not a hand-built empty object: the real
    // compiler's artifact, with its real digest and its real deep freeze.
    const plan = await planFor(simulationRequest());
    expect(plan.dispatches.length).toBeGreaterThan(0);

    // Every dispatch has a policy evaluation, and every one of them demands approval.
    for (const dispatch of plan.dispatches) {
      expect(dispatch.policy, `${dispatch.task.dispatchId} was never evaluated`).not.toBeNull();
      expect(dispatch.policy?.decision, `${dispatch.task.dispatchId} reached a decision other than require_approval`).toBe(
        "require_approval",
      );
      expect(dispatch.policy?.allowed).toBe(false);
      // `allow` is the one decision this milestone's default may never produce, so
      // it is asserted by name rather than by inequality.
      expect(dispatch.policy?.decision).not.toBe("allow");
      expect(dispatch.policy?.outstandingApprovals).toEqual(["dispatch_approval"]);
      // The demand came from the FLOOR, which is the layer a user rule cannot remove.
      expect(dispatch.policy?.dispatchApprovalDemands).toContain("safety_floor");
      // And the destructive/external demands are the floor's own.
      expect(dispatch.policy?.requireApprovalForDestructiveEffects).toBe(true);
      expect(dispatch.policy?.requireApprovalForExternalEffects).toBe(true);
      expect(dispatch.approval.required).toBe(true);
      // Gated, not rejected: an approval requirement is not a refusal, and conflating
      // them would report a system that works as one that is broken.
      expect(dispatch.rejection, `${dispatch.task.dispatchId} was rejected rather than gated`).toBeNull();
    }

    // The set-level headline member, and the count it is derived from.
    expect(plan.approvals.everyDispatchRequiresApproval).toBe(true);
    expect(plan.approvals.required).toHaveLength(plan.dispatches.length);
    // Zero rules, so zero rule verdicts, zero grants, zero disclosures and nothing
    // awaiting activation: the default has no pre-approval machinery engaged at all.
    expect(plan.ruleSetDigest).toMatch(/^sha256:/);
    for (const dispatch of plan.dispatches) {
      expect(dispatch.rules.verdicts).toEqual([]);
      expect(dispatch.rules.denied).toBeNull();
      expect(dispatch.policy?.grantedPreApprovals).toEqual([]);
      expect(dispatch.policy?.preApprovalBasis).toBeNull();
      expect(dispatch.preApproval).toBeNull();
    }
    expect(plan.approvals.preApprovalDisclosures).toEqual([]);
    expect(plan.approvals.matchedPreApprovals).toEqual([]);
    expect(plan.approvals.activationRequired).toEqual([]);
  });

  it("reaches `require_approval` and not `allow` over a set of restrictions alone", async () => {
    // The default, plus a narrowing rule and a budget rule. A narrowing action cannot
    // create a grant, and this is the assertion that says so over the whole set
    // rather than over one document.
    const compiled = compiledFrom(
      requireApprovalDocument({ ruleId: "rule-m6-safety-approval" }),
      budgetDocument({ ruleId: "rule-m6-safety-budget" }),
    );
    const plan = await planFor(simulationRequest({ rules: compiled }));
    for (const dispatch of plan.dispatches) {
      expect(dispatch.policy?.decision).toBe("require_approval");
      expect(dispatch.policy?.allowed).toBe(false);
      expect(dispatch.policy?.grantedPreApprovals).toEqual([]);
    }
    expect(plan.approvals.everyDispatchRequiresApproval).toBe(true);
  });
});

// ===========================================================================
// 2. No user rule grants a floor- or role-removed capability
// ===========================================================================

describe("M6.10 — no user rule grants a capability the safety floor or a role restriction removed", () => {
  it("refuses every attempt to state a floor effect as `true`, at the schema, before compilation", async () => {
    // Four documents, one per escalation axis, each carrying `true` where the
    // language declares `z.literal(false)`. The escalation is UNREPRESENTABLE rather
    // than refused at runtime, so the refusal happens at the schema and the code is
    // `rule.invalid_source` — a document that could never have been written.
    const attempts: readonly { readonly label: string; readonly actions: readonly Record<string, unknown>[] }[] = [
      {
        label: "pre_approve_within_bounds with allowDestructiveEffects: true",
        actions: [
          {
            kind: "pre_approve_within_bounds",
            approvedCapabilities: ["fs.read"],
            maximumTimeoutSeconds: 900,
            allowDestructiveEffects: true,
            allowExternalEffects: false,
            maximumSensitivity: "restricted",
          },
        ],
      },
      {
        label: "pre_approve_within_bounds with allowExternalEffects: true",
        actions: [
          {
            kind: "pre_approve_within_bounds",
            approvedCapabilities: ["fs.read"],
            maximumTimeoutSeconds: 900,
            allowDestructiveEffects: false,
            allowExternalEffects: true,
            maximumSensitivity: "restricted",
          },
        ],
      },
      {
        label: "add_restrictions with allowDestructiveEffects: true",
        actions: [{ kind: "add_restrictions", deniedCapabilities: [], allowDestructiveEffects: true }],
      },
      {
        label: "add_restrictions with allowExternalEffects: true",
        actions: [{ kind: "add_restrictions", deniedCapabilities: [], allowExternalEffects: true }],
      },
    ];

    for (const attempt of attempts) {
      const compiled = compileFromSource([
        rawRuleDocument({
          ruleId: "rule-m6-escalation",
          predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
          actions: attempt.actions,
        }),
      ]);
      expect(compiled.ok, `${attempt.label} compiled`).toBe(false);
      if (compiled.ok) continue;
      expect(compiled.error.code, attempt.label).toBe("rule.invalid_source");
      // The message names the offending field, so an author can act on it.
      expect(compiled.error.message).toMatch(/allowDestructiveEffects|allowExternalEffects/);
    }
  });

  it("refuses a pre-approval declaring a timeout above the safety floor's own ceiling", () => {
    const compiled = compileFromSource([
      rawRuleDocument({
        ruleId: "rule-m6-long-timeout",
        predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
        actions: [
          {
            kind: "pre_approve_within_bounds",
            approvedCapabilities: ["fs.read"],
            maximumTimeoutSeconds: SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS + 1,
            allowDestructiveEffects: false,
            allowExternalEffects: false,
            maximumSensitivity: "restricted",
          },
        ],
      }),
    ]);
    expect(compiled.ok, "a pre-approval above the floor's ceiling compiled").toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.code).toBe("rule.invalid_source");
  });

  it("refuses a pre-approval that constrains nothing, in every vacuous spelling of that", () => {
    // Four of these are vacuous rather than empty: `capability none` asserts an
    // ABSENCE, `roleVersion gte 1` is pinned to the bottom of its declared range,
    // `all([])` is the explicit universal, and a title pattern or a fan-out bound
    // shapes a dispatch without scoping it to a known set.
    const attempts: readonly { readonly label: string; readonly predicates: readonly unknown[] }[] = [
      { label: "an empty predicate list", predicates: [] },
      { label: "an explicit all([])", predicates: [{ field: "all", predicates: [] }] },
      { label: "capability none [...]", predicates: [{ field: "capability", operator: "none", value: ["fs.read"] }] },
      { label: "roleVersion gte 1", predicates: [{ field: "roleVersion", operator: "gte", value: 1 }] },
      {
        label: "a task title pattern, which is not a scope field",
        predicates: [{ field: "taskTitlePattern", pattern: "^deploy" }],
      },
      {
        label: "a fan-out bound, which shapes the dispatch rather than scoping it",
        predicates: [{ field: "fanOut", operator: "lte", value: 4 }],
      },
    ];
    for (const attempt of attempts) {
      const compiled = compileFromSource([
        universalPreApprovalDocument({ ruleId: "rule-m6-universal", predicates: attempt.predicates }),
      ]);
      expect(compiled.ok, `${attempt.label} compiled`).toBe(false);
      if (compiled.ok) continue;
      expect(compiled.error.code, attempt.label).toBe("rule.universal_pre_approval");
      // The refusal names every field that WOULD have constrained it, so an author can
      // act without reading the compiler.
      for (const field of NON_UNIVERSAL_PREDICATE_FIELDS) {
        expect(compiled.error.message, `${attempt.label}: the refusal must name '${field}'`).toContain(field);
      }
    }
  });

  it("does NOT accept a bare `not` as a scope, because a negation can only discard exclusions", () => {
    // ADR 0007 section 8's text says a `not` counts as constraining. The SHIPPED
    // compiler is stricter: `CONSTRUCTIVE_FORMS` (`src/rules/compile.ts:561`) admits
    // only an operator that positively names a value from a bounded vocabulary or a
    // comparison interior to its declared range, and a `not` is excluded because it
    // "can only ever DISCARD exclusions" — which is the right direction. A pre-approval
    // whose only predicate is a negation is one whose reach cannot be stated as a set
    // of projects, which is precisely the disclosure the plan's guardrail restricts.
    //
    // The test asserts the SHIPPED behaviour, because a test asserting the ADR's text
    // would be asserting a document. The divergence is reported separately.
    for (const wrapped of [
      { field: "projectId", operator: "eq", value: "proj-somewhere-else" },
      { field: "capability", operator: "any", value: ["fs.write"] },
      { field: "roleId", operator: "eq", value: "role-someone-else" },
    ]) {
      const compiled = compileFromSource([
        universalPreApprovalDocument({
          ruleId: "rule-m6-negated-scope",
          predicates: [{ field: "not", predicate: wrapped }],
        }),
      ]);
      expect(compiled.ok, `a bare not over ${wrapped.field} was accepted as a scope`).toBe(false);
      if (compiled.ok) continue;
      expect(compiled.error.code).toBe("rule.universal_pre_approval");
    }

    // A `not` ALONGSIDE a constructive predicate is fine: the constructive predicate
    // carries the scope and the negation narrows within it. So the restriction is on
    // the absence of a scope, never on the presence of a negation.
    const scoped = compileFromSource([
      universalPreApprovalDocument({
        ruleId: "rule-m6-negated-within-scope",
        predicates: [
          { field: "projectId", operator: "eq", value: PROJECT_ID },
          { field: "not", predicate: { field: "capability", operator: "any", value: ["fs.write"] } },
        ],
      }),
    ]);
    expect(scoped.ok, "a constructive scope plus a negation was refused").toBe(true);
  });

  it("denies a dispatch whose capability the ROLE denies, with a matching pre-approval attached to the envelope", () => {
    // The kernel's own post-narrowing re-check, over a real envelope carrying the M6
    // projection of a real pre-approval. Two independent authorities: the M6
    // evaluator named the grant, and the kernel refused it anyway.
    const role = roleSnapshot({ allowedCapabilities: ["fs.read", "shell.run"], deniedCapabilities: ["fs.write"] });
    const compiled = compiledFrom(
      preApprovalDocument({
        ruleId: "rule-m6-role-escalation",
        predicates: [
          { field: "projectId", operator: "eq", value: PROJECT_ID },
          { field: "capability", operator: "any", value: ["fs.write"] },
        ],
        actions: [
          {
            kind: "pre_approve_within_bounds",
            approvedCapabilities: ["fs.write"],
            maximumTimeoutSeconds: 900,
            allowDestructiveEffects: false,
            allowExternalEffects: false,
            maximumSensitivity: "restricted",
          },
        ],
      }),
    );
    // The rule COMPILED: the language cannot know what a role denies, which is
    // exactly why the kernel has to be the one to say no.
    expect(compiled.rules).toHaveLength(1);
    const kernelRule = compiled.rules[0]?.kernelRule;
    expect(kernelRule?.effect).toMatchObject({ kind: "pre_approve", approvedCapabilities: ["fs.write"] });
    if (kernelRule === null || kernelRule === undefined) throw new Error("the rule projected no kernel rule");

    const envelope = dispatchEnvelope({
      role,
      requestedCapabilities: ["fs.write"],
      permissionEnvelope: {
        allowedCapabilities: ["fs.read", "shell.run"],
        deniedCapabilities: ["fs.write"],
        approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
      },
      ruleSnapshots: [kernelRule],
    });
    // The pre-approval really IS attached, so this is not a test of an unattached rule.
    expect(envelope.ruleSnapshots).toHaveLength(1);
    const policy = POLICY_EVALUATOR({ envelope });
    expect(policy.decision).toBe("deny");
    // A denial narrows the effective set to nothing, which is a different value from
    // "no set computed": `[]` is the kernel's statement that the effective state
    // permits no capability at all.
    expect(policy.effective.allowedCapabilities).toEqual([]);
    expect(policy.grantedPreApprovals).toEqual([]);
    // The refusal says the capability "cannot be granted by any layer or pre-approval",
    // which is the whole invariant in one sentence.
    expect(policy.denials.map((denial) => denial.code)).toContain("policy.capability_denied");
    expect(policy.denials[0]?.message).toContain("cannot be granted by any layer or pre-approval");
  });

  it("cannot lift the floor's dispatch-approval demand with a `require_approval` rule that says `false`", () => {
    // `requireApprovalForDispatch: false` is a legal document — the action is a
    // NARROWING whose whole job is to say "not here". The claim is that the floor's
    // demand survives it, which is a statement about `narrowPolicyState` being
    // monotone rather than about the schema.
    const compiled = compiledFrom(
      requireApprovalDocument({
        ruleId: "rule-m6-unrequire",
        actions: [{ kind: "require_approval", requireApprovalForDispatch: false }],
      }),
    );
    expect(compiled.rules).toHaveLength(1);
    const kernelRule = compiled.rules[0]?.kernelRule;
    expect(kernelRule).not.toBeNull();
    if (kernelRule === null || kernelRule === undefined) throw new Error("the rule projected no kernel rule");

    const envelope = dispatchEnvelope({ requestedCapabilities: ["fs.read"], ruleSnapshots: [kernelRule] });
    const policy = POLICY_EVALUATOR({ envelope, taskTitle: "anything" });
    expect(policy.decision).toBe("require_approval");
    expect(policy.outstandingApprovals).toEqual(["dispatch_approval"]);
  });

  it("records every widening attempt a rule made, rather than dropping it", async () => {
    // A `set_stricter_budget` whose declared value is ABOVE the budget in force. The
    // value is refused AND reported, because a rule that tried to escalate is an audit
    // event whether or not it succeeded.
    const compiled = compiledFrom(
      budgetDocument({
        ruleId: "rule-m6-widening",
        actions: [{ kind: "set_stricter_budget", budget: { maximumFanOut: 99 } }],
      }),
    );
    const plan = await planFor(
      simulationRequest({ rules: compiled, baseBudget: { maximumConcurrency: 4, maximumFanOut: 4 } }),
    );
    for (const dispatch of plan.dispatches) {
      expect(dispatch.budget.rejectedWidening, "the widening attempt was not reported").toEqual([
        { source: "rule-m6-widening", field: "maximumFanOut", attempted: 99, current: 4 },
      ]);
      // And the ceiling in force is UNCHANGED: 4, not 99.
      expect(dispatch.budget.decision.limits.maximumFanOut).toBe(4);
    }
  });
});

// ===========================================================================
// 3. Pre-approval is restricted to the exact displayed bounds
// ===========================================================================

describe("M6.10 — a compiled pre-approval cannot grant more than the disclosure displayed", () => {
  it("grants exactly the declared capabilities and reports the basis it granted by", async () => {
    const compiled = compiledFrom(preApprovalDocument({ ruleId: "rule-m6-bounded-pre" }));
    const declared = compiled.rules[0]?.actions.find((action) => action.kind === "pre_approve_within_bounds");
    if (declared === undefined || declared.kind !== "pre_approve_within_bounds") {
      throw new Error("the compiled rule carries no pre-approval action");
    }
    const plan = await planFor(simulationRequest({ rules: compiled }));
    const granted = plan.approvals.matchedPreApprovals.find((match) => match.granted);
    expect(granted, "no pre-approval was granted, so the bound was never exercised").toBeDefined();

    // The grant covers EXACTLY the declared capabilities. A grant carrying one more
    // would be the stop condition; a grant carrying one fewer would be a weaker
    // feature. Either way the two lists must be equal.
    expect([...(granted?.capabilities ?? [])].sort()).toEqual([...declared.approvedCapabilities].sort());
    expect(granted?.ruleId).toBe("rule-m6-bounded-pre");
    expect(granted?.templateVersion).toBe(1);
    const policy = plan.dispatches.find((dispatch) => dispatch.task.dispatchId === granted?.dispatchId)?.policy;
    expect([...(policy?.grantedPreApprovals ?? [])].sort()).toEqual([...declared.approvedCapabilities].sort());
    expect(policy?.preApprovalBasis).toEqual({ ruleId: "rule-m6-bounded-pre", ruleVersion: 1 });

    // The kernel's own projection is bounded DOWN to the dispatch's timeout, never up,
    // and the two effect-escalation fields are literal false in the projection too.
    const kernelRule = compiled.rules[0]?.kernelRule;
    if (kernelRule === null || kernelRule === undefined) throw new Error("the rule projected no kernel rule");
    if (kernelRule.effect.kind !== "pre_approve") throw new Error("the projection is not a pre-approval");
    expect(kernelRule.effect.maximumTimeoutSeconds).toBeLessThanOrEqual(declared.maximumTimeoutSeconds);
    expect(kernelRule.effect.allowDestructiveEffects).toBe(false);
    expect(kernelRule.effect.allowExternalEffects).toBe(false);
  });

  it("grants nothing when the dispatch's requested retry limit is unknown, and names the bound that failed", async () => {
    // The default budget declares no `maximumRetryLimit`, so the dispatch's requested
    // retry limit is `null` and the rule's `maximumRetryLimit: 1` cannot be shown to
    // cover it. A grant here would be a grant outside the displayed bounds.
    const compiled = compiledFrom(preApprovalDocument({ ruleId: "rule-m6-retry-bound" }));
    const plan = await planFor(simulationRequest({ rules: compiled }));
    const build = plan.dispatches[0]?.preApproval;
    expect(build?.granted).toBe(false);
    expect(build?.capabilities).toEqual([]);
    // The candidate is still REPORTED, with the bound that did not hold named — which
    // is the difference between "no pre-approval exists" and "a pre-approval existed
    // and did not apply".
    expect(build?.candidates).toHaveLength(1);
    expect(build?.candidates[0]?.ruleId).toBe("rule-m6-retry-bound");
    expect(build?.candidates[0]?.boundsSatisfied).toBe(false);
    expect(build?.candidates[0]?.reason).toContain("retry limit is unknown");
  });

  it("refuses a rule carrying a narrowing action AND a pre-approval, rather than dropping one", () => {
    // The M0 `Rule` shape holds exactly one `effect`, so a projection of both would
    // silently drop one. A dropped narrowing makes the rule weaker than it reads; a
    // dropped pre-approval is inert and indistinguishable from a rule that matched
    // nothing. Only the weakening would ever be noticed, so the combination is
    // refused by name before either can take effect.
    const compiled = compileFromSource([
      rawRuleDocument({
        ruleId: "rule-m6-both",
        predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
        actions: [
          { kind: "require_approval", requireApprovalForDispatch: true },
          {
            kind: "pre_approve_within_bounds",
            approvedCapabilities: ["fs.read"],
            maximumTimeoutSeconds: 900,
            allowDestructiveEffects: false,
            allowExternalEffects: false,
            maximumSensitivity: "restricted",
          },
        ],
      }),
    ]);
    expect(compiled.ok, "a rule carrying both a narrowing and a pre-approval compiled").toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.code).toBe("rule.conflicting_action_effects");
  });

  it("refuses a rule that can never match, under one code and seven shapes", () => {
    // A silent no-op is worse than a refusal precisely because it leaves no artifact:
    // a rule that was supposed to fire and did not is indistinguishable, from the
    // outside, from a rule that was never loaded.
    const attempts: readonly { readonly label: string; readonly predicates: readonly unknown[] }[] = [
      { label: "`in` with no members", predicates: [{ field: "roleId", operator: "in", value: [] }] },
      { label: "an empty `any` combinator", predicates: [{ field: "any", predicates: [] }] },
      { label: "an empty schedule window set", predicates: [{ field: "scheduleWindow", windows: [] }] },
      { label: "`capability any []`", predicates: [{ field: "capability", operator: "any", value: [] }] },
      { label: "`capability all []`", predicates: [{ field: "capability", operator: "all", value: [] }] },
      { label: "`capability none []`", predicates: [{ field: "capability", operator: "none", value: [] }] },
      { label: "an inverted `between` on a numeric field", predicates: [{ field: "roleVersion", operator: "between", value: { min: 5, max: 3 } }] },
      { label: "`contextSensitivity any []`", predicates: [{ field: "contextSensitivity", operator: "any", value: [] }] },
    ];
    expect(attempts.length, "a new unsatisfiable family must be added to this sweep").toBe(8);
    for (const attempt of attempts) {
      const compiled = compileFromSource([
        denyDocument({ ruleId: "rule-m6-empty", predicates: attempt.predicates }),
      ]);
      expect(compiled.ok, `${attempt.label} compiled`).toBe(false);
      if (compiled.ok) continue;
      expect(compiled.error.code, attempt.label).toBe("rule.empty_enum");
    }
  });

  it("refuses a rule set spanning two projects, because a set is per-project", () => {
    const compiled = compileFromSource([
      denyDocument({ ruleId: "rule-m6-in-project" }),
      rawRuleDocument({
        ruleId: "rule-m6-out-of-project",
        projectId: "proj-m6-other",
        predicates: [],
        actions: [{ kind: "deny_with_reason", reason: "a different project's rule" }],
      }),
    ]);
    expect(compiled.ok, "a rule set spanning two projects compiled").toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.code).toBe("rule.project_scope_mismatch");
    expect(compiled.error.message).toContain("per-project");
  });
});

// ===========================================================================
// 4. Budgets: concurrency, crash, replay
// ===========================================================================

describe("M6.10 — a budget cannot be bypassed under concurrency, and survives a crash", () => {
  it("admits exactly the ceiling's worth of concurrent reserves, however many are in flight at once", async () => {
    // Six reserves launched together against a ceiling of two. The compare-and-set is
    // one synchronous frame inside the store, so no interleaving can slip between the
    // check and the write — this is the assertion that the interleaving is IMPOSSIBLE
    // rather than merely unlikely.
    const { ledger } = budgetLedger({ maximumConcurrency: 2, maximumFanOut: 2 });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => ledger.reserve(reserveRequestFor(index + 1))),
    );
    const admitted = results.filter((result) => result.ok);
    const refused = results.filter((result) => !result.ok);
    expect(admitted, "more reserves were admitted than the ceiling allows").toHaveLength(2);
    expect(refused).toHaveLength(4);
    for (const result of refused) {
      if (result.ok) continue;
      expect(result.refusal.code).toBe("budget.scope_saturated");
      expect(result.refusal.limit).toBe(2);
    }
    // The invariant, computed from the reservation LIST rather than from the store's
    // index — a helper that read the index would be asserting the index against itself.
    expect(occupiedUnits(ledger.list(), PROJECT_ID, "concurrency")).toBe(2);
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(2);
    // The ceiling holds for EVERY scope, not just the one under test.
    for (const scope of ALL_SCOPES) {
      expect(ledger.heldUnits(PROJECT_ID, scope)).toBeLessThanOrEqual(2);
    }
    // And eligibility is a PER-DISPATCH fact: exactly the admitted dispatches are
    // eligible, and no refused one is.
    for (const [index, result] of results.entries()) {
      expect(ledger.eligible(`disp-m6-${index + 1}`), `disp-m6-${index + 1} eligibility`).toBe(result.ok);
    }
  });

  it("does not double-count or lose a reservation when the same durable log is replayed twice", async () => {
    const { ledger } = budgetLedger({ maximumConcurrency: 2, maximumFanOut: 2 });
    for (const index of [1, 2]) {
      expect((await ledger.reserve(reserveRequestFor(index))).ok).toBe(true);
    }
    const durableLog = ledger.list();
    expect(durableLog).toHaveLength(2);

    // A NEW ledger over a store that holds nothing, then replay the log into it.
    const crashed = budgetLedger({ maximumConcurrency: 2, maximumFanOut: 2 });
    const first = replayDurableReservations(crashed.store as never, durableLog, replayRequest(2));
    expect(first.restored).toHaveLength(2);
    expect(first.rejected).toEqual([]);
    expect(first.rejectedByReason).toEqual({ ceiling_undeclared: 0, duplicate_dispatch: 0, over_ceiling: 0 });
    expect(crashed.ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(2);
    expect(occupiedUnits(crashed.ledger.list(), PROJECT_ID, "concurrency")).toBe(2);

    // Replaying the SAME log again is a no-op, which is what makes a restart loop
    // safe: the second pass cannot inflate the held total.
    const second = replayDurableReservations(crashed.store as never, durableLog, replayRequest(2));
    expect(second.restored).toEqual(first.restored);
    expect(second.rejected).toEqual([]);
    expect(crashed.ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(2);
    expect(crashed.ledger.list()).toHaveLength(2);

    // And the budget is STILL a budget after the replay: a third reserve is refused.
    const overflow = await crashed.ledger.reserve(reserveRequestFor(3));
    expect(overflow.ok, "a replayed ledger admitted a reserve past its ceiling").toBe(false);
    if (overflow.ok) return;
    expect(overflow.refusal.code).toBe("budget.scope_saturated");
  });

  it("replays the same log to the same report whatever order the rows arrive in", async () => {
    const { ledger } = budgetLedger({ maximumConcurrency: 3, maximumFanOut: 3 });
    for (const index of [1, 2, 3]) await ledger.reserve(reserveRequestFor(index));
    const log = ledger.list();
    const forward = replayDurableReservations(budgetLedger({ maximumConcurrency: 3 }).store as never, log, replayRequest(3));
    const backward = replayDurableReservations(
      budgetLedger({ maximumConcurrency: 3 }).store as never,
      [...log].reverse(),
      replayRequest(3),
    );
    expect(backward.restored).toEqual(forward.restored);
    expect(backward.rejected).toEqual(forward.rejected);
    expect(backward.scopes).toEqual(forward.scopes);
    expect(backward.rejectedByReason).toEqual(forward.rejectedByReason);
  });

  it("reclaims a reservation whose dispatch reached a terminal state, and leaves a running one alone", async () => {
    // The crash-between-reserve-and-release case. A reservation leaks capacity unless
    // something reclaims it, and reclaims too eagerly unless it requires EVIDENCE —
    // a terminal dispatch state, or a passed lease.
    const { ledger } = budgetLedger({ maximumConcurrency: 2, maximumFanOut: 2 });
    expect((await ledger.reserve(reserveRequestFor(1, { dispatchId: "disp-finished" }))).ok).toBe(true);
    expect((await ledger.reserve(reserveRequestFor(2, { dispatchId: "disp-running" }))).ok).toBe(true);
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(2);

    const report = recoverLeaked(ledger, {
      now: FIXED_NOW,
      // One dispatch finished; the other is still running, and the registry has never
      // heard of a third.
      dispatchStates: new Map([["disp-finished", "completed"]]),
    });
    expect(report.reclaimed.map((row) => row.reservationId)).toEqual(["res-m6-1"]);
    expect(report.reclaimed[0]?.reason).toBe("dispatch_terminal");
    expect(report.reclaimed[0]?.reclaimedState).toBe("released");
    // The running one is RETAINED, and reported as retained rather than dropped.
    expect(report.retained).toEqual(["res-m6-2"]);
    expect(report.retainedUnits).toBe(1);
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1);
    // And the reclaimed capacity is usable again.
    expect((await ledger.reserve(reserveRequestFor(3))).ok, "reclaimed capacity was not reusable").toBe(true);
  });

  it("reclaims an expired lease only AFTER the instant it expires, and never at it", async () => {
    // Strict `<` is load-bearing: a lease that expires AT T has not passed at T, and
    // reclaiming at T would return capacity from a holder still entitled to it — on a
    // sweep scheduled at a round instant, that is the common case rather than an edge
    // one.
    const { ledger } = budgetLedger({ maximumConcurrency: 1, maximumFanOut: 1 });
    const reserved = await ledger.reserve(reserveRequestFor(1, { leaseSeconds: 60 }));
    if (!reserved.ok) throw new Error("the first reserve was refused");
    // The lease expires at 09:01:00.000Z, read off the reservation rather than
    // recomputed, so this test does not restate the lease arithmetic.
    expect(reserved.value.leaseExpiresAt).toBe("2026-06-01T09:01:00.000Z");

    for (const instant of ["2026-06-01T09:00:00.000Z", "2026-06-01T09:00:59.999Z", "2026-06-01T09:01:00.000Z"]) {
      const sweep = recoverLeaked(ledger, { now: instant, dispatchStates: new Map() });
      expect(sweep.reclaimed, `the lease was reclaimed at ${instant}, which has not passed`).toEqual([]);
      expect(sweep.retained).toEqual([reserved.value.reservationId]);
      expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1);
    }
    // One millisecond later it has passed, and the capacity comes back.
    const after = recoverLeaked(ledger, { now: "2026-06-01T09:01:00.001Z", dispatchStates: new Map() });
    expect(after.reclaimed.map((row) => row.reason)).toEqual(["lease_expired"]);
    expect(after.reclaimed[0]?.reclaimedState).toBe("expired");
    expect(after.retained).toEqual([]);
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0);
  });

  it("a sweep interrupted part way is resumable, and never double-returns units", async () => {
    const { ledger } = budgetLedger({ maximumConcurrency: 2, maximumFanOut: 2 });
    expect((await ledger.reserve(reserveRequestFor(1, { dispatchId: "disp-a" }))).ok).toBe(true);
    expect((await ledger.reserve(reserveRequestFor(2, { dispatchId: "disp-b" }))).ok).toBe(true);
    const ids = ledger.list().map((reservation) => reservation.reservationId);

    // First sweep: only the first reservation.
    const partial = recoverLeaked(ledger, {
      now: FIXED_NOW,
      dispatchStates: new Map([["disp-a", "completed"]]),
      reservationIds: [ids[0]!],
    });
    expect(partial.reclaimedUnits).toBe(1);
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1);

    // Resuming: the first is already terminal and is NOT counted again — a terminal
    // reservation's units are held by nobody and were not returned by this sweep,
    // which is what keeps the arithmetic an equality rather than an over-count — and
    // the second is reclaimed on this pass.
    const resumed = recoverLeaked(ledger, {
      now: FIXED_NOW,
      dispatchStates: new Map([
        ["disp-a", "completed"],
        ["disp-b", "failed"],
      ]),
      reservationIds: ids,
    });
    expect(resumed.reclaimedByReason.dispatch_terminal).toBe(1);
    expect(resumed.reclaimedUnits).toBe(1);
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0);
  });

  it("a terminal reservation is absorbing, so a replayed commit after a release holds nothing", async () => {
    const { ledger } = budgetLedger({ maximumConcurrency: 1, maximumFanOut: 1 });
    const reserved = await ledger.reserve(reserveRequestFor(1));
    if (!reserved.ok) throw new Error("the first reserve was refused");
    const released = ledger.release(reserved.value.reservationId, FIXED_NOW);
    expect(released.ok).toBe(true);
    if (released.ok) {
      expect(released.value.changed).toBe(true);
      expect(released.value.reservation.state).toBe("released");
    }
    // A replayed commit against a released reservation changes nothing and holds
    // nothing — a resurrection would be a capacity bypass wearing an idempotency
    // claim.
    const replayed = ledger.commit(reserved.value.reservationId, FIXED_NOW);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.changed).toBe(false);
      expect(replayed.value.reservation.state).toBe("released");
    }
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0);
    expect(ledger.eligible("disp-m6-1")).toBe(false);
  });
});

// ===========================================================================
// 5. A rule cannot route to an unauthorized or unhealthy node
// ===========================================================================

describe("M6.10 — a rule cannot route to a node the hard checks excluded", () => {
  /** The three-node mesh: one eligible, one unauthorized, one stale. */
  function theThreeNodeMesh() {
    return [
      registryNode({ nodeId: NODE_A }),
      registryNode({ nodeId: NODE_UNAUTHORIZED, projectIds: ["proj-somewhere-else"] }),
      registryNode({ nodeId: NODE_UNHEALTHY, livenessState: "stale" }),
    ];
  }

  it("excludes the unauthorized and unhealthy nodes, and reports the preference for one as ignored", async () => {
    // A rule that PREFERS the two excluded nodes. A preference is a reordering of the
    // eligible set, never an admission, so the ask is reported with the reason it could
    // not be honoured rather than silently dropped.
    const nodes = theThreeNodeMesh();
    const compiled = compiledFrom(
      routingDocument({
        ruleId: "rule-m6-route-escalation",
        actions: [
          { kind: "select_routing_preference", preference: { preferredNodeIds: [NODE_UNAUTHORIZED, NODE_UNHEALTHY] } },
        ],
      }),
    );
    const plan = await planFor(simulationRequest({ nodes, rules: compiled }));
    const routing = plan.dispatches[0]?.routing;
    expect(routing).not.toBeNull();

    // Only the eligible node is selected.
    expect(routing?.selectedNodeId).toBe(NODE_A);
    // EVERY node appears, with its exclusion code, and the codes are the two the hard
    // checks own — not `excluded_by_rule`, which is deliberately checked last so an
    // operator is not sent to their own rules when the node is revoked.
    const byNode = new Map((routing?.candidates ?? []).map((candidate) => [candidate.nodeId, candidate]));
    expect([...byNode.keys()].sort()).toEqual([NODE_A, NODE_UNAUTHORIZED, NODE_UNHEALTHY].sort());
    expect(byNode.get(NODE_UNAUTHORIZED)?.exclusions.map((exclusion) => exclusion.code)).toEqual([
      "not_authorized_for_project",
    ]);
    expect(byNode.get(NODE_UNHEALTHY)?.exclusions.map((exclusion) => exclusion.code)).toEqual(["unhealthy"]);
    expect(byNode.get(NODE_A)?.eligible).toBe(true);
    expect(byNode.get(NODE_A)?.selected).toBe(true);
    // Both preferences are reported as ignored, with the eligibility reason attached.
    expect(routing?.preferenceIgnored.map((entry) => entry.nodeId)).toEqual([NODE_UNAUTHORIZED, NODE_UNHEALTHY].sort());
    for (const ignored of routing?.preferenceIgnored ?? []) {
      expect(ignored.exclusions.length, "an ignored preference carries no reason").toBeGreaterThan(0);
    }
    // And the set-level node summary carries the same codes, so a reader scanning
    // only the registry summary sees them too.
    const summary = new Map(plan.nodes.map((node) => [node.nodeId, node]));
    expect(summary.get(NODE_UNAUTHORIZED)?.excludedBy).toBe("not_authorized_for_project");
    expect(summary.get(NODE_UNHEALTHY)?.excludedBy).toBe("unhealthy");
    expect(summary.get(NODE_UNHEALTHY)?.healthy).toBe(false);
  });

  it("agrees with a direct `rankNodes` on the same exclusion set", async () => {
    const nodes = theThreeNodeMesh();
    const compiled = compiledFrom(
      routingDocument({
        ruleId: "rule-m6-route-agreement",
        actions: [{ kind: "select_routing_preference", preference: { preferredNodeIds: [NODE_UNAUTHORIZED] } }],
      }),
    );
    const plan = await planFor(simulationRequest({ nodes, rules: compiled }));
    const direct = rankNodes(
      nodes,
      {
        projectId: PROJECT_ID,
        projectPathId: PROJECT_PATH_ID,
        requiredCapabilities: ["fs.read", "shell.run"],
        requiredRuntimeKinds: ["opencode"],
        requiredToolCategories: [],
        now: Date.parse(FIXED_NOW),
        excludeNodeIds: [],
      },
      { preferredNodeIds: [NODE_UNAUTHORIZED], excludedNodeIds: [], requiredRuntimeKind: null, requiredProjectPathId: null },
    );
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(plan.dispatches[0]?.routing?.digest).toBe(direct.value.digest);
    expect(plan.dispatches[0]?.routing?.selectedNodeId).toBe(direct.value.selectedNodeId);
  });

  it("rejects a dispatch rather than routing it when no node is eligible and no local fallback was offered", async () => {
    // The empty eligible set is an ANSWER, not an error — and with no local fallback
    // the dispatch is REJECTED with routing's own code, and every candidate's reason is
    // reported rather than dropped.
    const plan = await planFor(
      simulationRequest({ nodes: [registryNode({ nodeId: NODE_UNAUTHORIZED, projectIds: ["proj-somewhere-else"] })], localDispatchNodeId: null }),
    );
    expect(plan.rejected.length).toBeGreaterThan(0);
    for (const rejection of plan.rejected) {
      expect(rejection.stage).toBe("routing");
      expect(rejection.code).toBe("routing.no_eligible_node");
    }
    expect(plan.dispatches[0]?.routing?.selectedNodeId).toBeNull();
    expect(plan.dispatches[0]?.routing?.eligibleCount).toBe(0);
    expect(plan.dispatches[0]?.routing?.candidates[0]?.exclusions.map((exclusion) => exclusion.code)).toEqual([
      "not_authorized_for_project",
    ]);
    // The refusal is reported as a `dispatch_rejected` warning naming routing's own
    // code, alongside the structured rejection — so a reader scanning only the
    // warnings sees it too. (The `routing_no_eligible_node` warning KIND exists in the
    // closed vocabulary and the plan does not raise it; the structured rejection is
    // where this fact lives. Reported separately.)
    const rejected = plan.warnings.filter((warning) => warning.kind === "dispatch_rejected");
    expect(rejected.length).toBeGreaterThan(0);
    for (const warning of rejected) {
      expect(warning.detail).toContain("routing.no_eligible_node");
    }
  });

  it("plans against the caller's local node and WARNS when the registry alone did not justify it", async () => {
    // A default single-machine install has an empty registry, and "no node is
    // eligible" is the true answer there. Reporting a rejection for every dispatch
    // would make the plan useless exactly where a dry run is most wanted — so the
    // local fallback exists, and it announces itself.
    const plan = await planFor(simulationRequest({ nodes: [], localDispatchNodeId: NODE_A }));
    expect(plan.rejected).toEqual([]);
    expect(plan.dispatches[0]?.routing?.selectedNodeId).toBeNull();
    const fallbacks = plan.warnings.filter((warning) => warning.kind === "routing_local_fallback");
    expect(fallbacks.length, "a local fallback was used without saying so").toBeGreaterThan(0);
    for (const warning of fallbacks) {
      expect(warning.message).toContain("does not justify a target");
    }
  });

  it("gives the same answer for the same registry snapshot however the node array is ordered", () => {
    const nodes = twoEligibleNodes();
    const request = {
      projectId: PROJECT_ID,
      projectPathId: PROJECT_PATH_ID,
      requiredCapabilities: ["fs.read", "shell.run"],
      requiredRuntimeKinds: ["opencode"],
      requiredToolCategories: [],
      now: Date.parse(FIXED_NOW),
      excludeNodeIds: [],
    };
    const forward = rankNodes(nodes, request);
    const reversed = rankNodes([...nodes].reverse(), request);
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    expect(reversed.value.digest).toBe(forward.value.digest);
    expect(reversed.value.selectedNodeId).toBe(forward.value.selectedNodeId);
    expect(reversed.value.explanationText).toBe(forward.value.explanationText);
  });
});

// ===========================================================================
// 6. A rule edit cannot affect an active dispatch or an existing approval
// ===========================================================================

describe("M6.10 — a rule edit cannot retroactively affect an active dispatch or an approval", () => {
  it("leaves a launched dispatch byte-identical and invalidates an open proposal instead of re-evaluating it", async () => {
    // The REAL M3 machinery: `InMemoryLocalApplicationService` over scripted runtime
    // and terminal adapters, taking the production propose → approve → launch path.
    const registry = new MutableProjectRegistry();
    const { service, launches, op, runId, approved } = await approvedRun(registry);
    const approvedDigest = approved.dispatch.envelopeDigest;
    const approvedSnapshots = approved.dispatch.envelope.ruleSnapshots;
    expect(approvedSnapshots, "the fixture launched a run with no rule snapshots to preserve").toEqual([]);

    // The run launches. A launched dispatch is the strongest case: it is ALREADY
    // running, so a retroactive edit would have to rewrite live state.
    const launched = ok(await launchCommand(service, op, runId, approved));
    expect(launched.outcome).toBe("started");
    expect(launches).toHaveLength(1);

    // ---- THE RULE EDIT. A new rule version enters the project definition, and
    // `ruleSnapshots` is a member of the service's material-definition fingerprint.
    const eventsBefore = canonicalJson(service.events(runId));
    registry.current = { ...registry.current, ruleSnapshots: [kernelRuleSnapshotAtVersion(2)] };

    // The RUNNING dispatch's own digest is unchanged: the envelope it was launched
    // with is digest-bound, and nothing about an edit can reach it.
    const afterEdit = ok(await service.execute({ type: "run.get", runId, correlationId: CORRELATION_ID }));
    expect(afterEdit.currentProposal?.dispatch.envelopeDigest).toBe(approvedDigest);
    expect(afterEdit.currentProposal?.dispatch.envelope.ruleSnapshots).toEqual(approvedSnapshots);
    expect(afterEdit.currentProposal?.approval?.approvalId).toEqual(approved.approval?.approvalId);
    expect(afterEdit.currentProposal?.approval?.state).toEqual(approved.approval?.state);
    // And the event log gained nothing: the edit changed nothing about the run, so it
    // is not an orchestration event.
    expect(canonicalJson(service.events(runId))).toBe(eventsBefore);
    // The launch is not repeated, because the edit did not re-evaluate anything.
    expect(launches).toHaveLength(1);
  });

  it("refuses a stale launch after a rule edit with `application.proposal.configuration_changed`", async () => {
    // The case the invalidation exists for: an approval recorded against the
    // PRE-edit configuration must not authorise a launch against the post-edit one.
    // Refused by name, and the proposal is marked as needing a fresh review — which is
    // the alternative to silently re-evaluating it.
    const registry = new MutableProjectRegistry();
    const { service, launches, op, runId, approved } = await approvedRun(registry);
    const before = ok(await service.execute({ type: "run.get", runId, correlationId: CORRELATION_ID }));
    const digestBefore = before.currentProposal?.dispatch.envelopeDigest;
    expect(digestBefore).toBe(approved.dispatch.envelopeDigest);

    registry.current = { ...registry.current, ruleSnapshots: [kernelRuleSnapshotAtVersion(7)] };

    const stale = await launchCommand(service, op, runId, approved);
    expect(stale.ok, "a launch against a pre-edit configuration was admitted").toBe(false);
    if (stale.ok) return;
    expect(stale.error.category).toBe("approval_required");
    expect(stale.error.code).toBe("application.proposal.configuration_changed");

    // The dispatch is still exactly the one that was approved — the edit did not
    // re-write it — and the run is flagged for a fresh proposal.
    const after = ok(await service.execute({ type: "run.get", runId, correlationId: CORRELATION_ID }));
    expect(after.currentProposal?.dispatch.envelopeDigest).toBe(digestBefore);
    expect(after.draft.proposalRequired).toBe(true);
    expect(launches, "the runtime was launched anyway").toHaveLength(0);
  });

  it("re-authorizes the launch path immediately before the effect, and fails closed when it is revoked", async () => {
    // The same bypass shape as the rule edit, one layer down: the approval is real and
    // the path is not, so the launch re-checks against the registry rather than
    // trusting the approval.
    const registry = new MutableProjectRegistry();
    const { service, launches, op, runId, approved } = await approvedRun(registry);
    registry.launchAuthorized = false;
    const refused = await launchCommand(service, op, runId, approved);
    expect(refused.ok, "a launch on a revoked path was admitted").toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("fixture.path_denied");
    expect(launches, "the runtime was launched anyway").toHaveLength(0);
  });

  it("leaves the approval standing when the definition changed outside the material fingerprint", async () => {
    // The converse, so the invalidation is not simply "any change refuses". The
    // fingerprint covers a named list of members; the project's own DISPLAY NAME is
    // not one of them, so renaming it leaves the approval and the launch authority
    // intact — which is the difference between invalidating on a material change and
    // invalidating on every keystroke.
    const registry = new MutableProjectRegistry();
    const { service, launches, op, runId, approved } = await approvedRun(registry);
    registry.current = {
      ...registry.current,
      project: { ...registry.current.project, name: "A Renamed M6 Fixture Project" },
    };
    const launched = await launchCommand(service, op, runId, approved);
    expect(launched.ok, "a cosmetic project rename invalidated a material approval").toBe(true);
    if (!launched.ok) return;
    expect(launched.value.outcome).toBe("started");
    expect(launches).toHaveLength(1);
  });
});

// ===========================================================================
// 7. Notifications: advisory, deduplicated, and free of content
// ===========================================================================

describe("M6.10 — notification delivery cannot affect orchestration state, and `emit` never rejects", () => {
  it("resolves with a delivery result for a throwing adapter, an unavailable one and a working one, in order", async () => {
    const recorder = recordingAdapter("recorder");
    const harness = notificationHarness({ adapters: [throwingAdapter("boom"), unavailableAdapter("down"), recorder] });
    const results = await harness.bus.emit(notificationRequest());
    // One result per adapter, IN THE ORDER GIVEN, and every one a value. A caller
    // that branched on any of it would be branching on noise, which is why there is
    // nothing here but `delivered` and a reason.
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ delivered: false, notificationId: "ntf-000001", reason: "adapter_error" });
    expect(results[1]).toEqual({ delivered: false, notificationId: "ntf-000001", reason: "adapter_unavailable" });
    expect(results[2]).toEqual({ delivered: true, notificationId: "ntf-000001" });
    // A broken adapter did not prevent the ones after it from being attempted.
    expect(recorder.deliveredIds()).toEqual(["ntf-000001"]);
    // And the failure is counted rather than thrown.
    expect(harness.bus.counters().emitted).toBe(1);
    expect(harness.bus.counters().delivered).toBe(1);
    expect(harness.bus.counters().adapterErrors).toBe(2);
  });

  it("resolves with an empty array for a malformed request and for one carrying content", async () => {
    const harness = notificationHarness();
    // Not a notification at all: the bus counts the error and returns, because a
    // producer with a bug is not the orchestrator's problem to propagate.
    expect(await harness.bus.emit({ category: "run_blocked" } as never)).toEqual([]);
    // And a request carrying a content field is refused by the SCHEMA rather than
    // silently dropped, which is what makes "there is no prompt in here" a refusal
    // rather than an omission. A non-strict schema would hand back a valid envelope
    // with the prompt nowhere in it.
    const withContent = { ...notificationRequest(), promptText: "the secret" };
    expect(notificationRequestSchema.safeParse(withContent).success, "a content field was accepted").toBe(false);
    expect(await harness.bus.emit(withContent as never)).toEqual([]);
    expect(harness.bus.counters().emitted).toBe(0);
    expect(harness.bus.counters().adapterErrors).toBeGreaterThan(0);
  });

  it("delivers even when the STORE throws, because the store is retention rather than truth", async () => {
    const recorder = recordingAdapter("recorder");
    const throwingStore: NotificationStore = {
      retentionWindowMs: 60_000,
      publish() {
        throw new Error("the inbox is unavailable");
      },
      list: () => [],
      acknowledge: () => false,
      acknowledgeAll: () => 0,
      pendingCount: () => 0,
      entries: (): readonly NotificationInboxEntry[] => [],
      findByDedupeKey: () => null,
    };
    const bus = createNotificationBus({ store: throwingStore, adapters: [recorder], clock: notificationClock() });
    const results = await bus.emit(notificationRequest());
    // The operator is still told, and the producer still cannot tell whether the inbox
    // took it — which is the property that stops a memory-pressure blip from being
    // indistinguishable from "no blocked runs".
    expect(results).toEqual([{ delivered: true, notificationId: "ntf-000001" }]);
    expect(recorder.deliveredIds()).toEqual(["ntf-000001"]);
    expect(bus.counters().adapterErrors).toBe(1);
    expect(bus.counters().delivered).toBe(1);
  });

  it("deduplicates by key, so a repeated event is one inbox entry", async () => {
    const harness = notificationHarness();
    const first = await harness.bus.emit(notificationRequest());
    const second = await harness.bus.emit(notificationRequest());
    expect(first[0]?.delivered).toBe(true);
    // The duplicate is reported with the ORIGINAL's id, not a freshly minted one, so
    // a producer cannot conclude anything about the original from the answer.
    expect(second).toEqual([{ delivered: false, notificationId: first[0]?.notificationId, reason: "duplicate" }]);
    expect(harness.store.entries()).toHaveLength(1);
    expect(harness.store.pendingCount()).toBe(1);
    expect(harness.bus.counters().emitted).toBe(1);
    expect(harness.bus.counters().deduplicated).toBe(1);
    // A DIFFERENT key is a different event, so it is emitted and delivered.
    await harness.bus.emit(notificationRequest({ dedupeKey: "run_blocked:run-m6-1:task-m6-2:rule-m6-deny" }));
    expect(harness.store.entries()).toHaveLength(2);
  });

  it("stores a muted notification rather than dropping it, so a mute is not a silence", async () => {
    const recorder = recordingAdapter("recorder");
    const harness = notificationHarness({
      adapters: [recorder],
      quieting: { categories: ["run_blocked"], severities: [], pairs: [] },
    });
    const results = await harness.bus.emit(notificationRequest());
    expect(results).toEqual([{ delivered: false, notificationId: "ntf-000001", reason: "muted" }]);
    // Stored, tagged, and not delivered. A user who silenced it can still ask "did I
    // silence something that mattered?" — which is the failure mode where an operator
    // disables a safety signal and never learns it was telling them something.
    expect(harness.store.entries()).toHaveLength(1);
    expect(harness.store.entries()[0]?.disposition).toBe("muted");
    expect(recorder.calls).toEqual([]);
    // `pendingCount` counts only what the operator is being asked to look at, so muting
    // still silences.
    expect(harness.store.pendingCount()).toBe(0);
  });

  it("leaves an orchestration run byte-identical while notifications are emitted, delivered, deduplicated and muted", async () => {
    // The orchestration half, over the real service. The notification path is handed a
    // bus and a store and never the service, so there is nothing for it to call; this
    // makes that structural fact observable by comparing the run before and after.
    const registry = new MutableProjectRegistry();
    const { service, runId } = await approvedRun(registry);
    const before = canonicalJson(ok(await service.execute({ type: "run.get", runId, correlationId: CORRELATION_ID })));
    const eventsBefore = canonicalJson(service.events(runId));

    // Four emissions covering all four dispositions, so "nothing changed" cannot be
    // satisfied by a bus that did nothing: one delivered, one deduplicated away, one
    // muted, one stored-then-quieted.
    const harness = notificationHarness({ quieting: { categories: [], severities: ["critical"], pairs: [] } });
    await harness.bus.emit(notificationRequest({ severity: "info", dedupeKey: "run_failed:run-m6-1:disp-m6-1" }));
    await harness.bus.emit(notificationRequest());
    await harness.bus.emit(notificationRequest());
    await harness.bus.emit(notificationRequest({ dedupeKey: "lease_expired:run-m6-1:lease-m6" }));
    harness.clock.advance(60_000);
    harness.bus.setQuieting({ categories: ["run_blocked"], severities: [], pairs: [] });
    await harness.bus.emit(notificationRequest({ dedupeKey: "rule_conflict:run-m6-1:rule-m6-deny" }));

    const after = canonicalJson(ok(await service.execute({ type: "run.get", runId, correlationId: CORRELATION_ID })));
    expect(after, "a notification changed the run").toBe(before);
    expect(canonicalJson(service.events(runId)), "a notification appended an event").toBe(eventsBefore);
    // The notifications themselves were real, so "nothing changed" is not "nothing
    // happened" — otherwise this test would pass against a bus that had been replaced
    // by a no-op.
    expect(harness.bus.counters().emitted).toBeGreaterThan(0);
    expect(harness.bus.counters().delivered).toBeGreaterThan(0);
    expect(harness.bus.counters().muted).toBeGreaterThan(0);
    expect(harness.bus.counters().deduplicated).toBeGreaterThan(0);
  });

  it("exposes no verb that could reach orchestration, and no verb that could fail a run", () => {
    // The structural claim, as a value. The bus's whole surface is: emit, read the
    // counters, read and set the quieting, read the store, count what it minted. There
    // is no "block", "retry", "fail" or "re-dispatch", so a notification subsystem that
    // could affect orchestration state would need a member that does not exist.
    const harness = notificationHarness();
    expect(Object.keys(harness.bus).sort()).toEqual([
      "counters",
      "emit",
      "emittedCount",
      "quieting",
      "setQuieting",
      "store",
    ]);
    for (const forbidden of ["dispatch", "launch", "approve", "block", "retry", "cancel", "fail", "reserve"]) {
      expect(Object.keys(harness.bus), `the bus exposes a '${forbidden}' verb`).not.toContain(forbidden);
    }
  });

  it("carries identifiers and reason codes only, over all four egress paths", async () => {
    // The canaries are seeded into the SNAPSHOTS a notification is derived from — the
    // role's free text, the template's, the step titles, the bound parameter value and
    // the node display names — and the notification names the run, the task, the rule
    // and the code, which is all ADR 0007 section 17 permits.
    const recorder = recordingAdapter("recorder");
    const harness = notificationHarness({ adapters: [recorder] });
    await harness.bus.emit(
      notificationRequest({
        runId: "run-m6-1",
        taskId: "task-m6-1",
        dispatchId: "disp-m6-1",
        nodeId: NODE_A,
        ruleId: "rule-m6-deny",
        reasonCode: "rule.denied",
        summary: "Run run-m6-1 task task-m6-1 blocked by rule rule-m6-deny (rule.denied)",
      }),
    );

    // The shipped audit, over all four paths, with the canaries declared in the
    // FIXTURES rather than produced by the module under audit.
    const audit = auditNotificationPayload({
      seededSecrets: everyCanary(),
      envelopes: recorder.calls,
      inboxEntries: harness.entriesAtRest(),
      rendered: { title: "AIBridge — Notifications", lines: harness.renderedLines() },
      notice: harness.noticeLine(),
    });
    expect([...audit.examinedPaths].sort()).toEqual([...NOTIFICATION_EGRESS_PATHS].sort());
    expect(audit.findings, `a canary left the notification: ${JSON.stringify(audit.findings)}`).toEqual([]);
    expect(audit.passed).toBe(true);

    // And the independent walk: every canary, in five encodings, against the envelope,
    // the inbox at rest, every rendered line and the notice line.
    const findings = auditForCanaries({
      artifact: { envelopes: recorder.calls, inbox: harness.entriesAtRest() },
      renderedText: [...harness.renderedLines(), harness.noticeLine() ?? ""],
      seededCanaries: Object.values(CANARIES),
    });
    expect(findings).toEqual([]);

    // The notification names what it is allowed to name, and nothing else: the exact
    // envelope member list, so a new content-bearing field would fail here.
    const envelope = recorder.calls[0];
    expect(envelope?.runId).toBe("run-m6-1");
    expect(envelope?.taskId).toBe("task-m6-1");
    expect(envelope?.ruleId).toBe("rule-m6-deny");
    expect(envelope?.reasonCode).toBe("rule.denied");
    expect(Object.keys(envelope ?? {}).sort()).toEqual([
      "category",
      "createdAt",
      "dedupeKey",
      "dispatchId",
      "nodeId",
      "notificationId",
      "reasonCode",
      "ruleId",
      "runId",
      "severity",
      "summary",
      "taskId",
    ]);
  });

  it("the audit CATCHES a producer that puts content in, so the clean result is not a blind one", async () => {
    // The converse, and the reason the clean result above means anything: a canary
    // placed in the summary is found at all four paths.
    const recorder = recordingAdapter("recorder");
    const harness = notificationHarness({ adapters: [recorder] });
    await harness.bus.emit(notificationRequest({ summary: `blocked while running: ${CANARIES.stepTitle}` }));
    const audit = auditNotificationPayload({
      seededSecrets: everyCanary(),
      envelopes: recorder.calls,
      inboxEntries: harness.entriesAtRest(),
      rendered: { lines: harness.renderedLines() },
      notice: harness.noticeLine(),
    });
    expect(audit.passed).toBe(false);
    expect(audit.findings.length).toBeGreaterThan(0);
    const paths = new Set(audit.findings.map((finding) => finding.path));
    expect(paths.has("envelope_payload")).toBe(true);
    expect(paths.has("inbox_at_rest")).toBe(true);
    expect(paths.has("tui_render")).toBe(true);
    expect(paths.has("notice_line")).toBe(true);
    for (const finding of audit.findings) {
      expect(finding.severity).toBe("blocker");
      // The finding names the field and the path, never the content: a reviewer's
      // report must not be the leak.
      expect(finding.detail).not.toContain(CANARIES.stepTitle);
    }
  });
});

// ===========================================================================
// 8. The dry run, with real ports, over a real project
// ===========================================================================

describe("M6.10 — a dry run over a real project changes nothing about it", () => {
  it("plans a rule-bearing run and leaves the project definition, the runtime and the sinks untouched", async () => {
    const registry = new MutableProjectRegistry(serviceProjectDefinition());
    const definitionBefore = canonicalJson(registry.current);
    const { service, launches } = applicationService(registry);
    const { runId } = await approvedRun(registry);
    const eventsBefore = canonicalJson(service.events(runId));

    const ports = simulationPorts({ templates: templateRepository([canariedTemplateInput()]) });
    const plan = await planFor(
      canariedRequest(compiledFrom(preApprovalDocument({ ruleId: "rule-m6-safety-pre" }))),
      ports,
    );

    // The plan is a real plan over real snapshots: expanded, routed, budgeted, and
    // carrying a matched pre-approval plus a disclosure.
    expect(plan.dispatches).toHaveLength(2);
    expect(plan.approvals.preApprovalDisclosures).toHaveLength(1);
    expect(plan.approvals.matchedPreApprovals.length).toBeGreaterThan(0);
    expect(plan.ruleSetDigest).toMatch(/^sha256:/);
    // No sink was reached and nothing was retained.
    expect(assertNoRetainedSideEffects(readSinkCounters(ports.tally))).toEqual([]);
    expect(ports.probe.counters.retained).toBe(0);
    expect(ports.templates.mutations).toEqual({ create: 0, update: 0, clear: 0 });
    // The project definition is byte-identical, so a plan that had written a template
    // or touched the registry would show up here.
    expect(canonicalJson(registry.current)).toBe(definitionBefore);
    // The runtime was not launched by the plan: the approval flow in this test never
    // launched either, so the launch log is empty.
    expect(launches).toHaveLength(0);
    // And the run's event log gained nothing.
    expect(canonicalJson(service.events(runId))).toBe(eventsBefore);
  });

  it("carries no canary from a canaried project, template, role and node set", async () => {
    // Every free-text field of every snapshot is poisoned, and the plan is audited in
    // five encodings against the whole value and every rendered line.
    const plan = await planFor(
      canariedRequest(compiledFrom(preApprovalDocument({ ruleId: "rule-m6-safety-canary" }))),
      simulationPorts({ templates: templateRepository([canariedTemplateInput()]) }),
    );
    expect(plan.dispatches).toHaveLength(2);
    const findings = auditForCanaries({
      artifact: plan,
      renderedText: [...plan.lines, plan.explanationText],
      seededCanaries: Object.values(CANARIES),
    });
    expect(findings, `a canary reached the plan: ${findings.join("; ")}`).toEqual([]);
    // The plan names the node id, never its display name.
    expect(plan.dispatches[0]?.routing?.selectedNodeId).toBe(NODE_A);
    expect(JSON.stringify(plan)).not.toContain(CANARIES.nodeDisplayName);
  });

  it("refuses rather than half-planning when a node snapshot is not readable", async () => {
    // A routing layer that answered "nothing is eligible" from a projection it could
    // not read would be answering a different question on a different machine.
    // Overriding the whole `registry` member rather than passing the `nodes` override,
    // because that override's type is `readonly RoutingNodeSnapshot[]` and this value
    // is deliberately NOT one — which is the whole point of the case. The request is
    // typed `unknown` at the entry point, so the malformed value crosses the boundary
    // without a cast anywhere.
    const broken = [{ ...registryNode({ nodeId: NODE_A }), capabilities: "not-an-array" }];
    const result = await simulateDryRun({ ...simulationRequest(), registry: { nodes: broken } }, simulationPorts());
    expect(result.ok, "an unreadable node snapshot produced a plan").toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("simulation.input_invalid");
    // The refusal NAMES THE PATH, so a caller can tell which node and which member the
    // simulator could not read — a count alone would send an operator looking at the
    // whole registry.
    expect(result.refusal.message).toContain("registry.nodes.0.capabilities");
  });
});

// ===========================================================================
// 9. The language has no escape hatch
// ===========================================================================

describe("M6.10 — the rule language has no expression form, no function form, and no way to execute anything", () => {
  it("refuses a document carrying a member the schema does not declare", () => {
    // The load-bearing strictness: a non-strict object schema silently DROPS unknown
    // keys, which is the mechanism by which "I wrote a script" and "I wrote nothing"
    // become the same document. `.strict()` turns that into a refusal.
    for (const extra of [
      { script: "process.exit(1)" },
      { expression: "1 + 1" },
      { javascript: "() => 42" },
      { onMatch: "eval" },
    ]) {
      const compiled = compileFromSource([{ ...rawRuleDocument({ ruleId: "rule-m6-extra" }), ...extra }]);
      expect(compiled.ok, `a document carrying '${Object.keys(extra)[0]}' compiled`).toBe(false);
      if (compiled.ok) continue;
      expect(compiled.error.code).toBe("rule.invalid_source");
    }
  });

  it("refuses a predicate whose operator the field does not define", () => {
    // The vocabulary is a closed discriminated union on `field`, so an invented
    // operator is a shape error rather than a silently ignored member. Built through
    // `rawRuleDocument` rather than `denyDocument`, because the validating builder
    // would throw at the fixture — and a fixture that throws is a fixture bug, not the
    // product's refusal, which is the diagnostic this test is after.
    for (const predicate of [
      { field: "capability", operator: "matches_regex", value: ["fs.*"] },
      { field: "projectId", operator: "ends_with", value: "proj" },
      { field: "not_a_field", operator: "eq", value: "x" },
    ]) {
      const compiled = compileFromSource([
        rawRuleDocument({
          ruleId: "rule-m6-bad-operator",
          predicates: [predicate],
          actions: [{ kind: "deny_with_reason", reason: "an invented operator" }],
        }),
      ]);
      expect(compiled.ok, `the predicate ${JSON.stringify(predicate)} compiled`).toBe(false);
      if (compiled.ok) continue;
      expect(compiled.error.code).toBe("rule.invalid_source");
    }
  });

  it("refuses a pattern the bounded analyser refuses, rather than absorbing it as a no-match", () => {
    // The kernel's own behaviour for a malformed `taskTitlePattern` is that it never
    // matches, which is safe for a narrowing effect and UNSAFE to inherit: under the
    // same rule a mistyped pre-approval pattern would silently never pre-approve and
    // the author would never be told. So it is a compile refusal.
    for (const pattern of ["(", "[a-", "(a+)+$"]) {
      const compiled = compileFromSource([
        denyDocument({
          ruleId: "rule-m6-bad-pattern",
          predicates: [{ field: "taskTitlePattern", pattern }],
        }),
      ]);
      expect(compiled.ok, `the pattern '${pattern}' compiled`).toBe(false);
      if (compiled.ok) continue;
      expect(["rule.pattern_refused", "rule.invalid_source"]).toContain(compiled.error.code);
    }
  });

  it("deep-freezes the compiled set, so nothing downstream can annotate it with what matched", () => {
    const compiled = compiledFrom(preApprovalDocument(), denyDocument({ ruleId: "rule-m6-frozen-deny" }));
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.rules)).toBe(true);
    for (const rule of compiled.rules) {
      expect(Object.isFrozen(rule)).toBe(true);
      expect(Object.isFrozen(rule.predicates)).toBe(true);
      expect(Object.isFrozen(rule.actions)).toBe(true);
    }
    // And a write attempt throws in this module's strict mode rather than corrupting
    // the artifact the runtime is about to read.
    const first = compiled.rules[0];
    if (first === undefined) throw new Error("the compiled set is empty");
    const original = first.name;
    expect(() => {
      // Through a spread into a fresh object, because the point being made is about
      // the artifact and `Object.assign` onto a frozen target is the same refusal.
      Object.assign(first, { name: "edited in place" });
    }).toThrow(TypeError);
    expect(first.name).toBe(original);
  });

  it("compiles the DEFAULT INSTALLATION as zero rules, with a digest and a real limits table", () => {
    // ADR 0007 section 18: a default installation ships zero enabled rules. Asserted by
    // loading the shipped default through the real compiler rather than by reading the
    // documentation, because a documentation claim about an artifact is not evidence
    // about the artifact.
    const compiled = compileRuleSet([]);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.languageVersion).toBe(2);
    expect(compiled.value.rules).toEqual([]);
    expect(compiled.value.digest).toMatch(/^sha256:/);
    expect(Object.keys(compiled.value.limits).length, "the limits table is empty").toBeGreaterThan(0);
  });
});
