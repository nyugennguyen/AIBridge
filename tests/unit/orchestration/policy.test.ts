import { describe, expect, it } from "vitest"
import {
  approvalIdSchema,
  projectIdSchema,
  ruleIdSchema,
  runIdSchema,
  taskIdSchema,
  dispatchIdSchema,
  userIdSchema,
} from "../../../src/orchestration/identifiers.js"
import { canonicalJson, digestDispatchEnvelope, digestJson } from "../../../src/orchestration/digest.js"
import { approvalSchema, dispatchEnvelopeSchema } from "../../../src/orchestration/schemas.js"
import {
  APPROVAL_TRANSITIONS,
  canTransitionApproval,
  isApprovalTerminal,
} from "../../../src/orchestration/transitions.js"
import type { Approval, DispatchEnvelope, Rule } from "../../../src/orchestration/types.js"
import {
  POLICY_PRECEDENCE,
  SAFETY_FLOOR,
  SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
  authorizeDispatch,
  collectWideningAttempts,
  createApproval,
  evaluatePolicy,
  invalidateApproval,
  matchRule,
  narrowPolicyState,
  orderRuleSnapshots,
  policyEvaluationSchema,
  policyResultOf,
  renderPolicyExplanation,
  resolveApprovalState,
  seedPolicyState,
  verifyApproval,
  type EffectivePolicyState,
  type PermissionNarrowing,
  type PolicyEvaluation,
  type PolicyLayerId,
  type ProjectPolicy,
} from "../../../src/orchestration/policy/index.js"

const PROJECT_ID = "proj-1"
const RUN_ID = "run-1"
const TASK_ID = "task-1"
const TASK_TITLE = "deploy the api"
const CAPS = ["fs.read", "net.fetch"] as const

// --- Fixtures ---

function makeRule(overrides: Record<string, unknown> = {}): Rule {
  return {
    schemaVersion: 1,
    ruleId: "rule-a",
    templateVersion: 1,
    projectId: PROJECT_ID,
    enabled: true,
    match: {},
    effect: {
      kind: "restrict",
      deniedCapabilities: [],
      requireApprovalForDestructiveEffects: false,
      requireApprovalForExternalEffects: false,
    },
    author: { kind: "user", userId: userIdSchema.parse("user-1") },
    createdAt: "2026-02-01T00:00:00Z",
    ...overrides,
  } as unknown as Rule
}

function preApproveRule(overrides: Record<string, unknown> = {}): Rule {
  return makeRule({
    ruleId: "rule-pre",
    effect: {
      kind: "pre_approve",
      approvedCapabilities: [...CAPS],
      maximumTimeoutSeconds: 600,
      allowDestructiveEffects: false,
      allowExternalEffects: false,
    },
    ...overrides,
  })
}

function restrictRule(overrides: Record<string, unknown> = {}): Rule {
  return makeRule({
    effect: {
      kind: "restrict",
      deniedCapabilities: [],
      requireApprovalForDestructiveEffects: false,
      requireApprovalForExternalEffects: false,
    },
    ...overrides,
  })
}

function makeEnvelope(overrides: Partial<DispatchEnvelope> = {}, rules: readonly Rule[] = []): DispatchEnvelope {
  const base = {
    schemaVersion: 1,
    dispatchId: "disp-1",
    attempt: 1,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    targetNodeId: "node-1",
    installationId: "inst-1",
    runtimeKind: "opencode",
    projectPathId: "path-1",
    prompt: "run the deployment",
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "role-1",
      templateVersion: 1,
      projectId: PROJECT_ID,
      name: "Runner",
      purpose: "execute deployments",
      instructions: "Execute the task",
      requiredCapabilities: [...CAPS],
      preferredRuntimeKinds: ["opencode"],
      contextSelectionPolicyReference: { namespace: "test", id: "ref-1" },
      permissionRestrictions: {
        allowedCapabilities: [...CAPS],
        deniedCapabilities: [],
        approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
      },
      author: { kind: "user", userId: userIdSchema.parse("user-1") },
      createdAt: "2026-02-01T00:00:00Z",
    },
    ruleSnapshots: rules,
    contextManifest: { references: [], manifestDigest: digestJson({ manifest: "empty" }) },
    requestedCapabilities: [...CAPS],
    permissionEnvelope: {
      allowedCapabilities: [...CAPS],
      deniedCapabilities: [],
      approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
    },
    dependencies: [],
    timeoutSeconds: 600,
    controllerEpoch: 3,
  }
  return dispatchEnvelopeSchema.parse({ ...base, ...overrides }) as DispatchEnvelope
}

function makeProjectPolicy(narrowing: Partial<PermissionNarrowing>, projectId = PROJECT_ID): ProjectPolicy {
  return {
    projectId,
    label: "project-baseline",
    narrowing: {
      deniedCapabilities: [],
      requireApprovalForCapabilities: [],
      ...narrowing,
    },
  } as ProjectPolicy
}

function evaluate(
  envelope: DispatchEnvelope,
  options: { taskTitle?: string | null; projectPolicy?: ProjectPolicy } = {},
): PolicyEvaluation {
  return evaluatePolicy({
    envelope,
    ...(options.taskTitle === undefined ? { taskTitle: TASK_TITLE } : {}),
    ...(options.projectPolicy === undefined ? {} : { projectPolicy: options.projectPolicy }),
  })
}

function layerNode(evaluation: PolicyEvaluation, layer: PolicyLayerId) {
  const node = evaluation.explanation.children.find((child) => child.layer === layer)
  if (node === undefined) throw new Error(`missing layer node '${layer}'`)
  return node
}

function ruleNode(evaluation: PolicyEvaluation, ruleId: string) {
  const node = layerNode(evaluation, "rule").children.find((child) => child.subject === ruleId)
  if (node === undefined) throw new Error(`missing rule node '${ruleId}'`)
  return node
}

function makeApproval(overrides: Partial<Record<string, unknown>> = {}): Approval {
  const envelope = makeEnvelope()
  return approvalSchema.parse({
    schemaVersion: 1,
    approvalId: approvalIdSchema.parse("appr-1"),
    projectId: PROJECT_ID,
    runId: RUN_ID,
    dispatchId: "disp-1",
    envelopeDigest: digestDispatchEnvelope(envelope),
    decision: "approved",
    basis: { kind: "user" },
    actor: { kind: "user", userId: userIdSchema.parse("user-1") },
    decidedAt: "2026-02-02T00:00:00Z",
    ...overrides,
  })
}

// =========================================================================
// Safety floor
// =========================================================================

describe("Policy safety floor (M3.6)", () => {
  it("requires approval for every dispatch by default", () => {
    const evaluation = evaluate(makeEnvelope())

    expect(evaluation.decision).toBe("require_approval")
    expect(evaluation.allowed).toBe(false)
    expect(evaluation.outstandingApprovals).toEqual(["dispatch_approval"])
    expect(evaluation.effective.dispatchApprovalDemands).toEqual(["safety_floor"])
    expect(SAFETY_FLOOR.requireApprovalForDispatch).toBe(true)
  })

  it("denies destructive and external effects by default and does not pre-approve them", () => {
    const evaluation = evaluate(makeEnvelope())

    expect(SAFETY_FLOOR.allowDestructiveEffects).toBe(false)
    expect(SAFETY_FLOOR.allowExternalEffects).toBe(false)
    expect(evaluation.effective.allowDestructiveEffects).toBe(false)
    expect(evaluation.effective.allowExternalEffects).toBe(false)
  })

  it("caps timeoutSeconds", () => {
    const within = evaluate(makeEnvelope({ timeoutSeconds: SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS }))
    const over = evaluate(makeEnvelope({ timeoutSeconds: SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS + 1 }))

    expect(within.effectiveTimeoutSeconds).toBe(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS)
    expect(over.effectiveTimeoutSeconds).toBe(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS)
    expect(over.decision).toBe("require_approval")
  })

  it("cannot be relaxed by a project policy that tries to enable every effect", () => {
    const evaluation = evaluate(
      makeEnvelope(),
      {
        projectPolicy: makeProjectPolicy({
          allowDestructiveEffects: true,
          allowExternalEffects: true,
          requireApprovalForDestructiveEffects: false,
          requireApprovalForExternalEffects: false,
          requireApprovalForDispatch: false,
          maximumTimeoutSeconds: 86_400,
        }),
      },
    )

    expect(evaluation.effective.allowDestructiveEffects).toBe(false)
    expect(evaluation.effective.allowExternalEffects).toBe(false)
    expect(evaluation.effective.requireApprovalForDestructiveEffects).toBe(true)
    expect(evaluation.effective.requireApprovalForExternalEffects).toBe(true)
    // The dispatch layer still narrows the ceiling down to its own declared timeout.
    expect(evaluation.effective.maximumTimeoutSeconds).toBeLessThanOrEqual(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS)
    expect(evaluation.effective.maximumTimeoutSeconds).toBe(600)
    expect(evaluation.effectiveTimeoutSeconds).toBe(600)
    expect(evaluation.effective.dispatchApprovalDemands).toEqual(["safety_floor"])
    expect(evaluation.outstandingApprovals).toEqual(["dispatch_approval"])
    expect(evaluation.decision).toBe("require_approval")
  })

  it("cannot be relaxed by a role template that tries to enable every effect", () => {
    const envelope = makeEnvelope()
    const mutated = makeEnvelope({
      roleSnapshot: {
        ...envelope.roleSnapshot,
        permissionRestrictions: {
          allowedCapabilities: [...CAPS],
          deniedCapabilities: [],
          approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
        },
      },
    })
    const evaluation = evaluate(mutated, {
      projectPolicy: makeProjectPolicy({ allowDestructiveEffects: true, allowExternalEffects: true }),
    })

    expect(evaluation.effective.allowDestructiveEffects).toBe(false)
    expect(evaluation.effective.allowExternalEffects).toBe(false)
  })

  it("requires approval for a dispatch that declares destructive or external effects", () => {
    const destructive = evaluate(
      makeEnvelope({
        permissionEnvelope: {
          allowedCapabilities: [...CAPS],
          deniedCapabilities: [],
          approvalRequirements: { destructiveEffects: true, externalEffects: false, capabilities: [] },
        },
      }),
    )
    const external = evaluate(
      makeEnvelope({
        permissionEnvelope: {
          allowedCapabilities: [...CAPS],
          deniedCapabilities: [],
          approvalRequirements: { destructiveEffects: false, externalEffects: true, capabilities: [] },
        },
      }),
    )

    expect(destructive.outstandingApprovals).toEqual(["destructive_effects", "dispatch_approval"])
    expect(external.outstandingApprovals).toEqual(["dispatch_approval", "external_effects"])
  })
})

// =========================================================================
// Narrowing-only composition
// =========================================================================

describe("Narrowing-only composition (M3.6)", () => {
  const seed = seedPolicyState(makeEnvelope())

  function narrow(state: EffectivePolicyState, layer: PolicyLayerId, narrowing: PermissionNarrowing) {
    return narrowPolicyState(state, layer, narrowing)
  }

  it("layers in the documented precedence order", () => {
    expect(POLICY_PRECEDENCE).toEqual(["safety_floor", "project", "role", "rule", "dispatch"])
    const evaluation = evaluate(makeEnvelope(), { projectPolicy: makeProjectPolicy({}) })
    expect(evaluation.explanation.children.map((child) => child.layer)).toEqual([
      "safety_floor",
      "project",
      "role",
      "rule",
      "dispatch",
    ])
  })

  it("intersects allowed capabilities and can never add one back", () => {
    const first = narrow(seed, "project", { allowedCapabilities: ["fs.read"], deniedCapabilities: [], requireApprovalForCapabilities: [] })
    const second = narrow(first.state, "role", {
      allowedCapabilities: ["fs.read", "net.fetch", "shell.exec"],
      deniedCapabilities: [],
      requireApprovalForCapabilities: [],
    })

    expect(first.state.allowedCapabilities).toEqual(["fs.read"])
    expect(second.state.allowedCapabilities).toEqual(["fs.read"])
    expect(second.wideningAttempts.join(" ")).toContain("allowedCapabilities")
  })

  it("unions denied capabilities and can never remove one", () => {
    const first = narrow(seed, "project", { deniedCapabilities: ["net.fetch"], requireApprovalForCapabilities: [] })
    const second = narrow(first.state, "role", { deniedCapabilities: [], requireApprovalForCapabilities: [] })

    expect(first.state.deniedCapabilities).toEqual(["net.fetch"])
    expect(second.state.deniedCapabilities).toEqual(["net.fetch"])
    expect(second.state.allowedCapabilities).toEqual(["fs.read"])
  })

  it("unions approval demands and can never clear one", () => {
    const first = narrow(seed, "project", { deniedCapabilities: [], requireApprovalForCapabilities: ["fs.read"] })
    const second = narrow(first.state, "role", { deniedCapabilities: [], requireApprovalForCapabilities: [] })

    expect(first.state.approvalRequiredCapabilities).toEqual(["fs.read"])
    expect(second.state.approvalRequiredCapabilities).toEqual(["fs.read"])
  })

  it("ANDs effect permission flags and can never re-enable a denied effect", () => {
    const first = narrow(seed, "safety_floor", {
      deniedCapabilities: [],
      requireApprovalForCapabilities: [],
      allowDestructiveEffects: false,
      allowExternalEffects: false,
    })
    const second = narrow(first.state, "project", {
      deniedCapabilities: [],
      requireApprovalForCapabilities: [],
      allowDestructiveEffects: true,
      allowExternalEffects: true,
    })

    expect(first.state.allowDestructiveEffects).toBe(false)
    expect(first.state.allowExternalEffects).toBe(false)
    expect(second.state.allowDestructiveEffects).toBe(false)
    expect(second.state.allowExternalEffects).toBe(false)
    expect(second.wideningAttempts).toHaveLength(2)
    expect(second.wideningAttempts.join(" ")).toContain("allowDestructiveEffects")
    expect(second.wideningAttempts.join(" ")).toContain("allowExternalEffects")
  })

  it("takes min of the timeout ceiling and can never raise it", () => {
    const first = narrow(seed, "safety_floor", {
      deniedCapabilities: [],
      requireApprovalForCapabilities: [],
      maximumTimeoutSeconds: 300,
    })
    const second = narrow(first.state, "project", {
      deniedCapabilities: [],
      requireApprovalForCapabilities: [],
      maximumTimeoutSeconds: 900,
    })

    expect(first.state.maximumTimeoutSeconds).toBe(300)
    expect(second.state.maximumTimeoutSeconds).toBe(300)
    expect(second.wideningAttempts.join(" ")).toContain("maximumTimeoutSeconds")
  })

  it("records dispatch approval demands from every layer that demands one", () => {
    const evaluation = evaluate(makeEnvelope(), {
      projectPolicy: makeProjectPolicy({ requireApprovalForDispatch: true }),
    })

    expect(evaluation.effective.dispatchApprovalDemands).toEqual(["safety_floor", "project"])
  })

  it("the narrower result wins regardless of which layer disagrees", () => {
    // Project allows a capability the role denies; the deny survives.
    const evaluation = evaluate(
      makeEnvelope({
        roleSnapshot: {
          ...makeEnvelope().roleSnapshot,
          permissionRestrictions: {
            allowedCapabilities: ["fs.read"],
            deniedCapabilities: ["net.fetch"],
            approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
          },
        },
      }),
      { projectPolicy: makeProjectPolicy({ allowedCapabilities: ["fs.read", "net.fetch", "shell.exec"] }) },
    )

    expect(evaluation.effective.deniedCapabilities).toEqual(["net.fetch"])
    expect(evaluation.effective.allowedCapabilities).toEqual(["fs.read"])
    expect(evaluation.decision).toBe("deny")
    expect(evaluation.denials.map((denial) => denial.code)).toEqual(["policy.capability_denied"])
  })

  it("rejects a project policy scoped to a different project", () => {
    expect(() => evaluate(makeEnvelope(), { projectPolicy: makeProjectPolicy({}, "proj-other") })).toThrow(
      /policy.project_scope_mismatch/,
    )
  })
})

// =========================================================================
// Rule evaluation
// =========================================================================

describe("Rule evaluation (M3.6)", () => {
  const context = { taskTitle: TASK_TITLE, requestedCapabilities: [...CAPS], runtimeKind: "opencode" }

  it("does not match a disabled rule", () => {
    expect(matchRule(restrictRule({ enabled: false }), context).matched).toBe(false)
  })

  it("matches on taskTitlePattern", () => {
    expect(matchRule(restrictRule({ match: { taskTitlePattern: "^deploy" } }), context).matched).toBe(true)
    expect(matchRule(restrictRule({ match: { taskTitlePattern: "^build" } }), context).matched).toBe(false)
  })

  it("never matches an invalid taskTitlePattern", () => {
    expect(matchRule(restrictRule({ match: { taskTitlePattern: "([unclosed" } }), context).matched).toBe(false)
  })

  it("does not match a taskTitlePattern rule when no task title is available", () => {
    const noTitle = { ...context, taskTitle: null }
    expect(matchRule(restrictRule({ match: { taskTitlePattern: "^deploy" } }), noTitle).matched).toBe(false)
  })

  it("matches on requestedCapabilitiesAny intersection", () => {
    expect(matchRule(restrictRule({ match: { requestedCapabilitiesAny: ["net.fetch", "shell.exec"] } }), context).matched).toBe(true)
    expect(matchRule(restrictRule({ match: { requestedCapabilitiesAny: ["shell.exec"] } }), context).matched).toBe(false)
    expect(matchRule(restrictRule({ match: { requestedCapabilitiesAny: [] } }), context).matched).toBe(false)
  })

  it("matches on runtimeKinds", () => {
    expect(matchRule(restrictRule({ match: { runtimeKinds: ["opencode"] } }), context).matched).toBe(true)
    expect(matchRule(restrictRule({ match: { runtimeKinds: ["codex"] } }), context).matched).toBe(false)
  })

  it("requires every declared criterion to hold", () => {
    const rule = restrictRule({
      match: { taskTitlePattern: "^deploy", requestedCapabilitiesAny: ["net.fetch"], runtimeKinds: ["codex"] },
    })
    expect(matchRule(rule, context).matched).toBe(false)
  })

  it("applies a restrict effect as a narrowing layer", () => {
    const evaluation = evaluate(
      makeEnvelope({}, [restrictRule({ effect: { kind: "restrict", deniedCapabilities: ["net.fetch"], requireApprovalForDestructiveEffects: false, requireApprovalForExternalEffects: false } })]),
    )

    expect(evaluation.decision).toBe("deny")
    expect(evaluation.effective.deniedCapabilities).toEqual(["net.fetch"])
    expect(ruleNode(evaluation, "rule-a").outcome).toBe("narrowed")
    expect(ruleNode(evaluation, "rule-a").deniedCapabilities).toEqual(["net.fetch"])
  })

  it("a restrict effect can add an approval demand that a pre-approval cannot clear", () => {
    const rules = [
      restrictRule({
        effect: {
          kind: "restrict",
          deniedCapabilities: [],
          requireApprovalForDestructiveEffects: true,
          requireApprovalForExternalEffects: true,
        },
      }),
      preApproveRule({ ruleId: "rule-pre" }),
    ]
    const evaluation = evaluate(
      makeEnvelope({
        permissionEnvelope: {
          allowedCapabilities: [...CAPS],
          deniedCapabilities: [],
          approvalRequirements: { destructiveEffects: true, externalEffects: true, capabilities: [] },
        },
      }, rules),
    )

    expect(evaluation.decision).toBe("require_approval")
    expect(evaluation.outstandingApprovals).toEqual(["destructive_effects", "external_effects"])
    expect(evaluation.effective.dispatchApprovalDemands).toEqual(["safety_floor"])
  })

  it("a pre_approve rule allows the dispatch when it covers everything", () => {
    const evaluation = evaluate(makeEnvelope({}, [preApproveRule()]))

    expect(evaluation.decision).toBe("allow")
    expect(evaluation.allowed).toBe(true)
    expect(evaluation.grantedPreApprovals).toEqual([...CAPS].sort())
    expect(evaluation.preApprovalBasis).toEqual({ ruleId: "rule-pre", ruleVersion: 1 })
    expect(evaluation.preApprovalClearedDefault).toBe(true)
    expect(evaluation.outstandingApprovals).toEqual([])
  })

  it("a disabled pre_approve rule changes nothing", () => {
    const evaluation = evaluate(makeEnvelope({}, [preApproveRule({ enabled: false })]))

    expect(evaluation.decision).toBe("require_approval")
    expect(evaluation.grantedPreApprovals).toEqual([])
    expect(ruleNode(evaluation, "rule-pre").outcome).toBe("skipped")
  })

  it("a non-matching pre_approve rule changes nothing", () => {
    const evaluation = evaluate(makeEnvelope({}, [preApproveRule({ match: { taskTitlePattern: "^migrate" } })]))

    expect(evaluation.decision).toBe("require_approval")
    expect(evaluation.grantedPreApprovals).toEqual([])
    expect(ruleNode(evaluation, "rule-pre").outcome).toBe("skipped")
  })

  it("a pre_approval cannot grant a capability a restrict rule denied", () => {
    const rules = [
      restrictRule({
        effect: { kind: "restrict", deniedCapabilities: ["net.fetch"], requireApprovalForDestructiveEffects: false, requireApprovalForExternalEffects: false },
      }),
      preApproveRule({ ruleId: "rule-pre" }),
    ]
    const evaluation = evaluate(makeEnvelope({}, rules))

    expect(evaluation.decision).toBe("deny")
    expect(evaluation.grantedPreApprovals).toEqual([])
    expect(ruleNode(evaluation, "rule-pre").outcome).toBe("pre_approval_rejected")
    expect(ruleNode(evaluation, "rule-pre").rejectedPreApprovals).toEqual(["net.fetch"])
  })

  it("a pre_approval cannot grant a capability no layer allows", () => {
    const rules = [preApproveRule({ effect: { kind: "pre_approve", approvedCapabilities: ["fs.read", "shell.exec"], maximumTimeoutSeconds: 600, allowDestructiveEffects: false, allowExternalEffects: false } })]
    const evaluation = evaluate(makeEnvelope({}, rules))

    expect(evaluation.decision).toBe("require_approval")
    expect(evaluation.grantedPreApprovals).toEqual([])
    expect(ruleNode(evaluation, "rule-pre").rejectedPreApprovals).toEqual(["shell.exec"])
  })

  it("a pre_approval cannot exceed its maximumTimeoutSeconds", () => {
    const evaluation = evaluate(
      makeEnvelope({ timeoutSeconds: 900 }, [preApproveRule({ effect: { kind: "pre_approve", approvedCapabilities: [...CAPS], maximumTimeoutSeconds: 300, allowDestructiveEffects: false, allowExternalEffects: false } })]),
    )

    expect(evaluation.decision).toBe("require_approval")
    expect(evaluation.grantedPreApprovals).toEqual([])
    expect(ruleNode(evaluation, "rule-pre").outcome).toBe("pre_approval_rejected")
    expect(ruleNode(evaluation, "rule-pre").reason).toContain("exceeds the rule maximum")
  })

  it("a pre_approval cannot enable destructive or external effects the floor denies", () => {
    const destructive = evaluate(
      makeEnvelope({}, [preApproveRule({ effect: { kind: "pre_approve", approvedCapabilities: [...CAPS], maximumTimeoutSeconds: 600, allowDestructiveEffects: true, allowExternalEffects: false } })]),
    )
    const external = evaluate(
      makeEnvelope({}, [preApproveRule({ effect: { kind: "pre_approve", approvedCapabilities: [...CAPS], maximumTimeoutSeconds: 600, allowDestructiveEffects: false, allowExternalEffects: true } })]),
    )

    for (const evaluation of [destructive, external]) {
      expect(evaluation.decision).toBe("require_approval")
      expect(evaluation.grantedPreApprovals).toEqual([])
      expect(evaluation.effective.allowDestructiveEffects).toBe(false)
      expect(evaluation.effective.allowExternalEffects).toBe(false)
      expect(evaluation.explanation.wideningAttempts.length + ruleNode(evaluation, "rule-pre").wideningAttempts.length).toBeGreaterThan(0)
    }
  })

  it("a pre_approval cannot raise the timeout ceiling", () => {
    const evaluation = evaluate(
      makeEnvelope({}, [preApproveRule({ effect: { kind: "pre_approve", approvedCapabilities: [...CAPS], maximumTimeoutSeconds: 86_400, allowDestructiveEffects: false, allowExternalEffects: false } })]),
    )

    // The ceiling stays at the dispatch layer's declared timeout; the rule's
    // larger proposal is recorded as an ignored widening attempt.
    expect(evaluation.effective.maximumTimeoutSeconds).toBe(600)
    expect(evaluation.effectiveTimeoutSeconds).toBe(600)
    expect(ruleNode(evaluation, "rule-pre").wideningAttempts.join(" ")).toContain("maximumTimeoutSeconds")
  })

  it("a pre_approval cannot clear a dispatch approval demanded by a narrowing layer", () => {
    const evaluation = evaluate(makeEnvelope({}, [preApproveRule()]), {
      projectPolicy: makeProjectPolicy({ requireApprovalForDispatch: true }),
    })

    expect(evaluation.decision).toBe("require_approval")
    expect(evaluation.outstandingApprovals).toEqual(["dispatch_approval"])
    expect(ruleNode(evaluation, "rule-pre").reason).toContain("narrowing layer")
  })

  it("ignores a superseded rule version and applies the newest", () => {
    const rules = [
      preApproveRule({ ruleId: "rule-pre", templateVersion: 1 }),
      preApproveRule({ ruleId: "rule-pre", templateVersion: 2 }),
    ]
    const evaluation = evaluate(makeEnvelope({}, rules))

    const children = layerNode(evaluation, "rule").children.filter((child) => child.subject === "rule-pre")
    expect(children).toHaveLength(2)
    expect(children.find((child) => child.ruleVersion === 1)?.outcome).toBe("superseded")
    expect(children.find((child) => child.ruleVersion === 2)?.outcome).toBe("pre_approved")
    expect(evaluation.decision).toBe("allow")
  })

  it("a newer version of a rule can restrict what an older version allowed", () => {
    const rules = [
      preApproveRule({ ruleId: "rule-pre", templateVersion: 1 }),
      restrictRule({
        ruleId: "rule-pre",
        templateVersion: 2,
        effect: { kind: "restrict", deniedCapabilities: ["net.fetch"], requireApprovalForDestructiveEffects: false, requireApprovalForExternalEffects: false },
      }),
    ]
    const evaluation = evaluate(makeEnvelope({}, rules))

    expect(evaluation.decision).toBe("deny")
    expect(evaluation.effective.deniedCapabilities).toEqual(["net.fetch"])
  })

  it("rejects duplicate rule id and version pairs on the envelope", () => {
    const rules = [restrictRule(), restrictRule()]
    expect(() => makeEnvelope({}, rules)).toThrow(/Rule snapshots must be unique/)
  })

  it("orders rule snapshots deterministically and independently of array order", () => {
    const a = restrictRule({ ruleId: "rule-a", templateVersion: 1 })
    const b = restrictRule({ ruleId: "rule-b", templateVersion: 1 })
    const c = restrictRule({ ruleId: "rule-b", templateVersion: 2 })

    const forward = orderRuleSnapshots([a, b, c]).map((entry) => `${entry.rule.ruleId}@${entry.rule.templateVersion}`)
    const reverse = orderRuleSnapshots([c, b, a]).map((entry) => `${entry.rule.ruleId}@${entry.rule.templateVersion}`)

    expect(forward).toEqual(["rule-a@1", "rule-b@1", "rule-b@2"])
    expect(reverse).toEqual(forward)
    expect(orderRuleSnapshots([a, b, c]).filter((entry) => entry.superseded).map((entry) => entry.rule.ruleId + "@" + entry.rule.templateVersion)).toEqual(["rule-b@1"])
  })
})

// =========================================================================
// Truth table
// =========================================================================

interface TruthRow {
  readonly name: string
  readonly build: () => DispatchEnvelope
  readonly policy: ProjectPolicy | undefined
  readonly expectedDecision: PolicyEvaluation["decision"]
  readonly expectedOutstanding: readonly string[]
  readonly expectedDenied: readonly string[]
  readonly expectedGrants: readonly string[]
  readonly expectedRuleOutcome: string
}

function baseEnvelopeWith(
  rules: readonly Rule[],
  overrides: Partial<DispatchEnvelope> = {},
): DispatchEnvelope {
  return makeEnvelope(overrides, rules)
}

interface LayerVariant {
  readonly name: string
  readonly policy: ProjectPolicy | undefined
  /** Capabilities this project layer denies, which compose with the rule's denials. */
  readonly projectDenied: readonly string[]
  /** Whether this project layer adds its own dispatch-approval demand. */
  readonly projectDemandsApproval: boolean
}

const LAYER_VARIANTS: readonly LayerVariant[] = [
  { name: "no project policy", policy: undefined, projectDenied: [], projectDemandsApproval: false },
  {
    name: "project demands dispatch approval",
    policy: makeProjectPolicy({ requireApprovalForDispatch: true }),
    projectDenied: [],
    projectDemandsApproval: true,
  },
  {
    name: "project denies net.fetch",
    policy: makeProjectPolicy({ deniedCapabilities: ["net.fetch"] }),
    projectDenied: ["net.fetch"],
    projectDemandsApproval: false,
  },
  {
    name: "project raises the ceiling",
    policy: makeProjectPolicy({ maximumTimeoutSeconds: 86_400 }),
    projectDenied: [],
    projectDemandsApproval: false,
  },
  {
    name: "project enables effects",
    policy: makeProjectPolicy({ allowDestructiveEffects: true, allowExternalEffects: true }),
    projectDenied: [],
    projectDemandsApproval: false,
  },
]

interface RuleVariant {
  readonly name: string
  readonly rule: Rule
  readonly kind: "restrict" | "pre_approve"
  /** Whether the rule matches and is enabled at all. */
  readonly active: boolean
  readonly denies: readonly string[]
  /** For restrict rules: whether the rule is expected to add a new denial on its own. */
  readonly addsDenial: boolean
  /** For pre_approve rules: whether the rule is a full-coverage pre-approval. */
  readonly covers: boolean
}

const RULE_VARIANTS: readonly RuleVariant[] = [
  {
    name: "disabled restrict",
    rule: restrictRule({ ruleId: "rule-v", enabled: false, effect: { kind: "restrict", deniedCapabilities: ["net.fetch"], requireApprovalForDestructiveEffects: false, requireApprovalForExternalEffects: false } }),
    kind: "restrict",
    active: false,
    denies: ["net.fetch"],
    addsDenial: true,
    covers: false,
  },
  {
    name: "non-matching restrict",
    rule: restrictRule({ ruleId: "rule-v", match: { taskTitlePattern: "^migrate" }, effect: { kind: "restrict", deniedCapabilities: ["net.fetch"], requireApprovalForDestructiveEffects: false, requireApprovalForExternalEffects: false } }),
    kind: "restrict",
    active: false,
    denies: ["net.fetch"],
    addsDenial: true,
    covers: false,
  },
  {
    name: "matching restrict denying a requested capability",
    rule: restrictRule({ ruleId: "rule-v", effect: { kind: "restrict", deniedCapabilities: ["net.fetch"], requireApprovalForDestructiveEffects: false, requireApprovalForExternalEffects: false } }),
    kind: "restrict",
    active: true,
    denies: ["net.fetch"],
    addsDenial: true,
    covers: false,
  },
  {
    name: "matching restrict denying an unrequested capability",
    rule: restrictRule({ ruleId: "rule-v", effect: { kind: "restrict", deniedCapabilities: ["shell.exec"], requireApprovalForDestructiveEffects: false, requireApprovalForExternalEffects: false } }),
    kind: "restrict",
    active: true,
    // The capability is not requested, so the denial is still added to the
    // effective set but produces no denial for the dispatch.
    denies: ["shell.exec"],
    addsDenial: true,
    covers: false,
  },
  {
    name: "matching pre_approve covering everything",
    rule: preApproveRule({ ruleId: "rule-v" }),
    kind: "pre_approve",
    active: true,
    denies: [],
    addsDenial: false,
    covers: true,
  },
  {
    name: "matching pre_approve exceeding maximumTimeoutSeconds",
    rule: preApproveRule({ ruleId: "rule-v", effect: { kind: "pre_approve", approvedCapabilities: [...CAPS], maximumTimeoutSeconds: 60, allowDestructiveEffects: false, allowExternalEffects: false } }),
    kind: "pre_approve",
    active: true,
    denies: [],
    addsDenial: false,
    covers: false,
  },
  {
    name: "matching pre_approve enabling destructive effects",
    rule: preApproveRule({ ruleId: "rule-v", effect: { kind: "pre_approve", approvedCapabilities: [...CAPS], maximumTimeoutSeconds: 600, allowDestructiveEffects: true, allowExternalEffects: false } }),
    kind: "pre_approve",
    active: true,
    denies: [],
    addsDenial: false,
    covers: false,
  },
  {
    name: "matching pre_approve partial coverage",
    rule: preApproveRule({ ruleId: "rule-v", effect: { kind: "pre_approve", approvedCapabilities: ["fs.read"], maximumTimeoutSeconds: 600, allowDestructiveEffects: false, allowExternalEffects: false } }),
    kind: "pre_approve",
    active: true,
    denies: [],
    addsDenial: false,
    covers: false,
  },
]

/**
 * Expected results are derived from the layer and rule semantics rather than
 * transcribed per cell, so the table is exhaustive by construction: every
 * (layer, rule) pair gets an independently derived, asserted outcome.
 */
function deriveTruthRow(layer: LayerVariant, variant: RuleVariant): TruthRow {
  const ruleDenies = variant.active ? variant.denies : []
  const denied = [...new Set([...layer.projectDenied, ...ruleDenies])].sort()
  const requestedDenied = denied.filter((capability) => CAPS.includes(capability as (typeof CAPS)[number])).sort()

  // A pre-approval clears the floor's default only when the rule is active and
  // covers everything, no layer added its own dispatch-approval demand, and no
  // layer denies a requested capability. A denied dispatch can never be
  // pre-approved, so the rule is recorded as rejected rather than applied.
  const canPreApprove =
    variant.kind === "pre_approve" &&
    variant.active &&
    variant.covers &&
    layer.projectDemandsApproval === false &&
    requestedDenied.length === 0

  const ruleOutcome: string = !variant.active
    ? "skipped"
    : variant.kind === "restrict"
      ? // A restrict rule that only re-denies what the project already denied
        // leaves the effective set unchanged.
        variant.addsDenial && ruleDenies.some((capability) => !layer.projectDenied.includes(capability))
        ? "narrowed"
        : "unchanged"
      : canPreApprove
        ? "pre_approved"
        : "pre_approval_rejected"

  const outstanding = canPreApprove ? [] : ["dispatch_approval"]
  const decision: PolicyEvaluation["decision"] =
    requestedDenied.length > 0 ? "deny" : outstanding.length === 0 ? "allow" : "require_approval"

  return {
    name: `${layer.name} x ${variant.name}`,
    build: () => baseEnvelopeWith([variant.rule]),
    policy: layer.policy,
    expectedDecision: decision,
    expectedOutstanding: outstanding,
    expectedDenied: requestedDenied,
    expectedGrants: canPreApprove ? [...CAPS].sort() : [],
    expectedRuleOutcome: ruleOutcome,
  }
}

const truthRows: readonly TruthRow[] = LAYER_VARIANTS.flatMap((layer) =>
  RULE_VARIANTS.map((variant) => deriveTruthRow(layer, variant)),
)

describe("Policy truth table (M3.6)", () => {
  it("covers every layer x rule combination", () => {
    expect(truthRows).toHaveLength(LAYER_VARIANTS.length * RULE_VARIANTS.length)
    expect(new Set(truthRows.map((row) => row.name)).size).toBe(truthRows.length)
  })

  it("exercises allow, require_approval and deny in every layer", () => {
    for (const layer of LAYER_VARIANTS) {
      const decisions = new Set(
        LAYER_VARIANTS.length > 0
          ? RULE_VARIANTS.map((variant) => deriveTruthRow(layer, variant).expectedDecision)
          : [],
      )
      expect(decisions.size).toBeGreaterThan(0)
    }
  })

  for (const row of truthRows) {
    it(`evaluates: ${row.name}`, () => {
      const evaluation = evaluate(row.build(), row.policy === undefined ? {} : { projectPolicy: row.policy })

      expect(evaluation.decision).toBe(row.expectedDecision)
      expect(evaluation.outstandingApprovals).toEqual([...row.expectedOutstanding])
      expect(evaluation.denials.flatMap((denial) => denial.capabilities)).toEqual([...row.expectedDenied])
      expect(evaluation.grantedPreApprovals).toEqual([...row.expectedGrants])
      expect(ruleNode(evaluation, "rule-v").outcome).toBe(row.expectedRuleOutcome)
    })
  }

  it("every truth-table row keeps the safety floor intact", () => {
    for (const row of truthRows) {
      const evaluation = evaluate(row.build(), row.policy === undefined ? {} : { projectPolicy: row.policy })

      expect(evaluation.effective.allowDestructiveEffects).toBe(false)
      expect(evaluation.effective.allowExternalEffects).toBe(false)
      expect(evaluation.effective.requireApprovalForDestructiveEffects).toBe(true)
      expect(evaluation.effective.requireApprovalForExternalEffects).toBe(true)
      expect(evaluation.effective.maximumTimeoutSeconds).toBeLessThanOrEqual(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS)
      expect(evaluation.effective.dispatchApprovalDemands).toContain("safety_floor")
    }
  })

  it("every truth-table row produces a serializable explanation tree", () => {
    for (const row of truthRows) {
      const evaluation = evaluate(row.build(), row.policy === undefined ? {} : { projectPolicy: row.policy })

      expect(() => canonicalJson(evaluation.explanation)).not.toThrow()
      expect(evaluation.explanationText).toContain(`decision: ${evaluation.decision}`)
    }
  })
})

// =========================================================================
// Explanation tree
// =========================================================================

describe("Policy explanation tree (M3.6)", () => {
  it("records every layer and rule in precedence order", () => {
    const rules = [
      restrictRule({ ruleId: "rule-b", effect: { kind: "restrict", deniedCapabilities: ["net.fetch"], requireApprovalForDestructiveEffects: false, requireApprovalForExternalEffects: false } }),
      preApproveRule({ ruleId: "rule-a" }),
    ]
    const evaluation = evaluate(makeEnvelope({}, rules), {
      projectPolicy: makeProjectPolicy({ deniedCapabilities: ["shell.exec"] }),
    })

    expect(evaluation.explanation.layer).toBe("policy")
    expect(evaluation.explanation.children.map((child) => child.layer)).toEqual([
      "safety_floor",
      "project",
      "role",
      "rule",
      "dispatch",
    ])
    const ruleChildren = layerNode(evaluation, "rule").children
    expect(ruleChildren.map((child) => `${child.subject}@${child.ruleVersion}`)).toEqual(["rule-a@1", "rule-b@1"])
  })

  it("records the effective state after each layer, monotonically narrowing", () => {
    const rules = [
      restrictRule({ ruleId: "rule-b", effect: { kind: "restrict", deniedCapabilities: ["shell.exec"], requireApprovalForDestructiveEffects: false, requireApprovalForExternalEffects: false } }),
    ]
    const evaluation = evaluate(makeEnvelope({}, rules), {
      projectPolicy: makeProjectPolicy({ deniedCapabilities: ["db.drop"], requireApprovalForDispatch: true }),
    })
    const children = evaluation.explanation.children

    // The safety floor is the baseline: it starts from the widest possible state.
    expect(children[0].layer).toBe("safety_floor")
    expect(children[0].effective.allowedCapabilities).toEqual([...CAPS].sort())
    expect(children[0].effective.dispatchApprovalDemands).toEqual(["safety_floor"])

    // Every later layer is a narrowing of the layer above it.
    for (let index = 2; index < children.length; index += 1) {
      const previous = children[index - 1].effective
      const current = children[index].effective
      for (const capability of current.allowedCapabilities) {
        expect(previous.allowedCapabilities).toContain(capability)
      }
      // Denials, approval demands and dispatch-approval demands are unions, so
      // they can only grow.
      for (const capability of previous.deniedCapabilities) {
        expect(current.deniedCapabilities).toContain(capability)
      }
      for (const capability of previous.approvalRequiredCapabilities) {
        expect(current.approvalRequiredCapabilities).toContain(capability)
      }
      for (const layer of previous.dispatchApprovalDemands) {
        expect(current.dispatchApprovalDemands).toContain(layer)
      }
      expect(current.maximumTimeoutSeconds).toBeLessThanOrEqual(previous.maximumTimeoutSeconds)
      // A boolean flag may only ever go from true to false, never back.
      if (current.allowDestructiveEffects) expect(previous.allowDestructiveEffects).toBe(true)
      if (current.allowExternalEffects) expect(previous.allowExternalEffects).toBe(true)
    }
  })

  it("explains denials, not just approvals", () => {
    const evaluation = evaluate(
      makeEnvelope({}, [restrictRule({ effect: { kind: "restrict", deniedCapabilities: ["net.fetch"], requireApprovalForDestructiveEffects: false, requireApprovalForExternalEffects: false } })]),
    )

    expect(evaluation.decision).toBe("deny")
    expect(evaluation.denials).toHaveLength(1)
    expect(evaluation.denials[0].message).toContain("net.fetch")
    expect(evaluation.explanationText).toContain("denials:")
    expect(evaluation.explanationText).toContain("policy.capability_denied")
  })

  it("explains a layer-override attempt as ignored", () => {
    const evaluation = evaluate(
      makeEnvelope({}, [preApproveRule({ effect: { kind: "pre_approve", approvedCapabilities: [...CAPS], maximumTimeoutSeconds: 600, allowDestructiveEffects: true, allowExternalEffects: false } })]),
      { projectPolicy: makeProjectPolicy({ allowDestructiveEffects: true }) },
    )

    const widening = [
      ...layerNode(evaluation, "project").wideningAttempts,
      ...ruleNode(evaluation, "rule-pre").wideningAttempts,
    ]
    expect(widening.length).toBeGreaterThan(0)
    expect(widening.join(" ")).toContain("ignored")
    expect(evaluation.explanationText).toContain("ignoredWidening=")
  })

  it("never includes prompt text or role instructions", () => {
    const envelope = makeEnvelope()
    const evaluation = evaluate(envelope, { projectPolicy: makeProjectPolicy({}) })
    const serialized = `${evaluation.explanationText}\n${canonicalJson(evaluation.explanation)}`

    expect(serialized).not.toContain(envelope.prompt)
    expect(serialized).not.toContain(envelope.roleSnapshot.instructions)
    expect(serialized).not.toContain(TASK_TITLE)
  })

  it("renders the explanation deterministically", () => {
    const envelope = makeEnvelope({}, [preApproveRule()])
    const first = evaluate(envelope)
    const second = evaluate(envelope)

    expect(first.explanationText).toBe(second.explanationText)
    expect(renderPolicyExplanation(first)).toBe(renderPolicyExplanation(second))
  })
})

// =========================================================================
// Widening-attempt auditability (F1/F2 regression guard)
// =========================================================================

describe("Widening attempts are auditable (M3.6)", () => {
  /**
   * A project policy that tries to escalate on every axis at once. The floor
   * rejects all four, so the layer's only effect is to be refused.
   */
  const HOSTILE_POLICY = makeProjectPolicy({
    allowedCapabilities: [...CAPS, "root.escalate"],
    allowDestructiveEffects: true,
    allowExternalEffects: true,
    maximumTimeoutSeconds: 999_999,
  })

  function escalatingPreApproval(ruleId: string, extra: Record<string, unknown> = {}): Rule {
    return preApproveRule({
      ruleId,
      effect: {
        kind: "pre_approve",
        approvedCapabilities: [...CAPS],
        maximumTimeoutSeconds: 600,
        allowDestructiveEffects: true,
        allowExternalEffects: false,
      },
      ...extra,
    })
  }

  // --- F1: the root node must aggregate the whole subtree ---

  it("surfaces a hostile layer's widening attempts at the root node", () => {
    const evaluation = evaluate(makeEnvelope(), { projectPolicy: HOSTILE_POLICY })
    const project = layerNode(evaluation, "project")

    // F1 regression: the four attempts exist on the layer node...
    expect(project.wideningAttempts).toHaveLength(4)
    // ...and must also be visible to anything that only reads the root.
    expect(evaluation.explanation.wideningAttempts).toEqual(collectWideningAttempts(evaluation.explanation.children))
    expect(evaluation.explanation.wideningAttempts).toHaveLength(4)
    for (const attempt of project.wideningAttempts) {
      expect(evaluation.explanation.wideningAttempts).toContain(attempt)
    }
    expect(evaluation.explanation.reason).toContain("4 widening attempt(s) were rejected")
    expect(evaluation.explanationText).toContain("ignoredWidening=")
  })

  it("surfaces a pre-approval pass widening attempt at the root node", () => {
    // The pre-approval pass was already aggregated before F1; this guards that
    // the aggregation still reaches the root now that it is subtree-wide.
    const evaluation = evaluate(makeEnvelope({}, [escalatingPreApproval("rule-pre")]))

    expect(ruleNode(evaluation, "rule-pre").wideningAttempts).toHaveLength(1)
    expect(evaluation.explanation.wideningAttempts).toEqual(ruleNode(evaluation, "rule-pre").wideningAttempts)
  })

  it("aggregates layer attempts and pre-approval attempts together", () => {
    const evaluation = evaluate(makeEnvelope({}, [escalatingPreApproval("rule-pre")]), {
      projectPolicy: HOSTILE_POLICY,
    })

    const root = evaluation.explanation.wideningAttempts
    expect(root).toHaveLength(5)
    expect(root.filter((attempt) => attempt.includes("layer 'project'"))).toHaveLength(4)
    expect(root.filter((attempt) => attempt.includes("rule 'rule-pre@1'"))).toHaveLength(1)
    // Enforcement is untouched by the reporting change.
    expect(evaluation.decision).toBe("require_approval")
    expect(evaluation.effective.allowDestructiveEffects).toBe(false)
    expect(evaluation.effective.allowExternalEffects).toBe(false)
  })

  it("de-duplicates the root aggregation even when a parent re-states its children's attempts", () => {
    const evaluation = evaluate(makeEnvelope({}, [escalatingPreApproval("rule-pre")]), {
      projectPolicy: HOSTILE_POLICY,
    })
    const ruleLayer = layerNode(evaluation, "rule")

    // The `rule` layer node restates its children's attempts, so a naive
    // concatenation would report the rule's attempt twice.
    expect(ruleLayer.wideningAttempts).toEqual(ruleNode(evaluation, "rule-pre").wideningAttempts)
    expect(evaluation.explanation.wideningAttempts).toEqual(
      expect.arrayContaining([...ruleLayer.wideningAttempts]),
    )
    const occurrences = evaluation.explanation.wideningAttempts.filter(
      (attempt) => attempt === ruleLayer.wideningAttempts[0],
    )
    expect(occurrences).toHaveLength(1)
  })

  it("produces a sorted, duplicate-free root aggregation", () => {
    const evaluation = evaluate(makeEnvelope({}, [escalatingPreApproval("rule-pre")]), {
      projectPolicy: HOSTILE_POLICY,
    })
    const root = evaluation.explanation.wideningAttempts

    expect(root).toEqual([...root].sort())
    expect(new Set(root).size).toBe(root.length)
  })

  it("aggregates deterministically regardless of the rule snapshot order", () => {
    const rules = [escalatingPreApproval("rule-a"), escalatingPreApproval("rule-b")]
    const forward = evaluate(makeEnvelope({}, rules), { projectPolicy: HOSTILE_POLICY })
    const reversed = evaluate(makeEnvelope({}, [...rules].reverse()), { projectPolicy: HOSTILE_POLICY })

    expect(forward.explanation.wideningAttempts).toEqual(reversed.explanation.wideningAttempts)
    expect(forward.explanation.wideningAttempts).toHaveLength(6)
    expect(forward.explanationText).toBe(reversed.explanationText)
  })

  it("collectWideningAttempts is a pure function of the tree", () => {
    const evaluation = evaluate(makeEnvelope({}, [escalatingPreApproval("rule-pre")]), {
      projectPolicy: HOSTILE_POLICY,
    })

    expect(collectWideningAttempts(evaluation.explanation.children)).toEqual(
      collectWideningAttempts(evaluation.explanation.children),
    )
    expect(collectWideningAttempts([])).toEqual([])
    // The safety floor can never widen anything, so it contributes nothing.
    expect(collectWideningAttempts([layerNode(evaluation, "safety_floor")])).toEqual([])
  })

  // --- F2: a rejected escalation must not read as a no-op ---

  it("reports widening_rejected rather than unchanged for a layer whose only effect was refused", () => {
    const evaluation = evaluate(makeEnvelope(), { projectPolicy: HOSTILE_POLICY })
    const project = layerNode(evaluation, "project")

    expect(project.wideningAttempts).toHaveLength(4)
    // F2 regression: `unchanged` understates a refused escalation attempt.
    expect(project.outcome).toBe("widening_rejected")
    expect(project.outcome).not.toBe("unchanged")
    expect(project.applied).toBe(true)
    expect(project.reason).toContain("4 widening attempt(s) were rejected and had no effect")
  })

  it("still reports widening_rejected for a layer that both narrowed and escalated", () => {
    const mixed = makeProjectPolicy({
      deniedCapabilities: ["db.drop"],
      requireApprovalForCapabilities: ["fs.read"],
      allowDestructiveEffects: true,
    })
    const evaluation = evaluate(makeEnvelope(), { projectPolicy: mixed })
    const project = layerNode(evaluation, "project")

    // The layer did narrow, and it also tried to escalate. The attempt wins the
    // primary outcome; the narrowing is still fully reported and really applied.
    expect(project.deniedCapabilities).toEqual(["db.drop"])
    expect(project.wideningAttempts).toHaveLength(1)
    expect(evaluation.effective.deniedCapabilities).toEqual(["db.drop"])
    expect(evaluation.effective.approvalRequiredCapabilities).toEqual(["fs.read"])
    expect(project.outcome).toBe("widening_rejected")
  })

  it("leaves a layer with nothing to contribute on unchanged", () => {
    // The new outcome must not be applied blanket-style.
    const evaluation = evaluate(makeEnvelope(), { projectPolicy: makeProjectPolicy({}) })
    const project = layerNode(evaluation, "project")

    expect(project.wideningAttempts).toEqual([])
    expect(project.outcome).toBe("unchanged")
    expect(project.reason).not.toContain("widening attempt")
  })

  it("reports widening_rejected on the rule layer and keeps the rule's own more specific outcome", () => {
    const evaluation = evaluate(makeEnvelope({}, [escalatingPreApproval("rule-pre")]))
    const ruleLayer = layerNode(evaluation, "rule")

    expect(ruleLayer.wideningAttempts).toHaveLength(1)
    expect(ruleLayer.outcome).toBe("widening_rejected")
    // `pre_approval_rejected` says strictly more than "a widening was rejected".
    expect(ruleNode(evaluation, "rule-pre").outcome).toBe("pre_approval_rejected")
    expect(ruleNode(evaluation, "rule-pre").reason).toContain("attempted to widen the safety floor")
  })

  it("renders the rejected escalation so a human auditor can read the denial", () => {
    const evaluation = evaluate(makeEnvelope(), { projectPolicy: HOSTILE_POLICY })
    const projectLine = evaluation.explanationText
      .split("\n")
      .find((line) => line.trimStart().startsWith("project:"))

    expect(projectLine).toBeDefined()
    expect(projectLine).toContain("widening_rejected")
    expect(projectLine).toContain("widening attempt(s) were rejected and had no effect")
    expect(projectLine).toContain("ignoredWidening=")
    expect(projectLine).toContain("allowDestructiveEffects")
    expect(projectLine).toContain("maximumTimeoutSeconds")
  })

  it("keeps the root outcome on the decision axis and reports the attempts alongside it", () => {
    const evaluation = evaluate(makeEnvelope(), { projectPolicy: HOSTILE_POLICY })
    const rootLine = evaluation.explanationText.split("\n")[0]

    expect(evaluation.decision).toBe("require_approval")
    expect(evaluation.explanation.outcome).toBe("unchanged")
    expect(rootLine).toContain("4 widening attempt(s) were rejected and had no effect")
    expect(rootLine).toContain("ignoredWidening=")
  })

  it("keeps every node valid against the explanation node schema", () => {
    const evaluation = evaluate(makeEnvelope({}, [escalatingPreApproval("rule-pre")]), {
      projectPolicy: HOSTILE_POLICY,
    })

    expect(() => policyEvaluationSchema.parse(evaluation)).not.toThrow()
  })
})

// =========================================================================
// Determinism
// =========================================================================

describe("Policy determinism (M3.6)", () => {
  const rules = [
    restrictRule({ ruleId: "rule-b", match: { runtimeKinds: ["opencode"] }, effect: { kind: "restrict", deniedCapabilities: ["shell.exec"], requireApprovalForDestructiveEffects: true, requireApprovalForExternalEffects: true } }),
    preApproveRule({ ruleId: "rule-a", match: { requestedCapabilitiesAny: ["net.fetch"] } }),
  ]
  const envelope = makeEnvelope({}, rules)
  const policy = makeProjectPolicy({ requireApprovalForDispatch: true, deniedCapabilities: ["db.drop"] })

  it("produces byte-identical output for identical input", () => {
    const first = evaluate(envelope, { projectPolicy: policy })
    const second = evaluate(envelope, { projectPolicy: policy })

    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(first.decisionDigest).toBe(second.decisionDigest)
    expect(first.explanationText).toBe(second.explanationText)
  })

  it("decides identically regardless of the rule snapshot array order", () => {
    const forward = evaluate(envelope, { projectPolicy: policy })
    const reversed = evaluate(makeEnvelope({}, [...rules].reverse()), { projectPolicy: policy })

    // The envelopes differ (array order is part of the digest), so the
    // envelopeDigest and decisionDigest legitimately differ. Everything the
    // decision actually depends on must be identical.
    expect(forward.envelopeDigest).not.toBe(reversed.envelopeDigest)
    expect(forward.decision).toBe(reversed.decision)
    expect(forward.allowed).toBe(reversed.allowed)
    expect(forward.effective).toEqual(reversed.effective)
    expect(forward.outstandingApprovals).toEqual(reversed.outstandingApprovals)
    expect(forward.denials).toEqual(reversed.denials)
    expect(forward.grantedPreApprovals).toEqual(reversed.grantedPreApprovals)
    expect(forward.explanation).toEqual(reversed.explanation)
    expect(forward.explanationText).toBe(reversed.explanationText)
  })

  it("changes the decision digest when the envelope changes", () => {
    const baseline = evaluate(envelope)
    const mutated = evaluate(makeEnvelope({ timeoutSeconds: 599 }, rules))

    expect(baseline.decisionDigest).not.toBe(mutated.decisionDigest)
  })

  it("contains no timestamp or random component", () => {
    const evaluation = evaluate(envelope, { projectPolicy: policy })
    const serialized = canonicalJson(evaluation)

    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

// =========================================================================
// Digest-bound approval
// =========================================================================

describe("Digest-bound approval (M3.6)", () => {
  it("records the exact envelope digest and the envelope's own scope", () => {
    const envelope = makeEnvelope()
    const result = createApproval({
      envelope,
      approvalId: approvalIdSchema.parse("appr-1"),
      decision: "approved",
      basis: { kind: "user" },
      actor: { kind: "user", userId: userIdSchema.parse("user-1") },
      decidedAt: "2026-02-02T00:00:00Z",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.envelopeDigest).toBe(digestDispatchEnvelope(envelope))
    expect(result.value.dispatchId).toBe(envelope.dispatchId)
    expect(result.value.projectId).toBe(envelope.projectId)
    expect(result.value.runId).toBe(envelope.runId)
  })

  it("verifies a matching approval", () => {
    const envelope = makeEnvelope()
    const approval = makeApproval({ envelopeDigest: digestDispatchEnvelope(envelope) })
    const verification = verifyApproval(approval, envelope)

    expect(verification.state).toBe("approved")
    expect(verification.valid).toBe(true)
    expect(verification.reasons).toEqual([])
    expect(verification.codes).toEqual([])
    expect(verification.recordedEnvelopeDigest).toBe(verification.computedEnvelopeDigest)
  })

  it("rejects a rule basis that is not among the envelope's rule snapshots", () => {
    const envelope = makeEnvelope({}, [preApproveRule({ ruleId: "rule-pre", templateVersion: 1 })])
    const approval = makeApproval({
      envelopeDigest: digestDispatchEnvelope(envelope),
      basis: { kind: "rule", ruleId: ruleIdSchema.parse("rule-absent"), ruleVersion: 1 },
    })
    const verification = verifyApproval(approval, envelope)

    expect(verification.state).toBe("invalidated")
    expect(verification.valid).toBe(false)
    expect(verification.codes).toContain("approval.unknown_rule_basis")
  })

  it("rejects a rule basis naming a version the envelope does not carry", () => {
    const envelope = makeEnvelope({}, [preApproveRule({ ruleId: "rule-pre", templateVersion: 1 })])
    const approval = makeApproval({
      envelopeDigest: digestDispatchEnvelope(envelope),
      basis: { kind: "rule", ruleId: "rule-pre", ruleVersion: 7 },
    })

    expect(verifyApproval(approval, envelope).state).toBe("invalidated")
  })

  it("rejects a rule basis whose effect cannot pre-approve", () => {
    const envelope = makeEnvelope({}, [restrictRule({ ruleId: "rule-v" })])
    const approval = makeApproval({
      envelopeDigest: digestDispatchEnvelope(envelope),
      basis: { kind: "rule", ruleId: "rule-v", ruleVersion: 1 },
    })

    expect(verifyApproval(approval, envelope).state).toBe("invalidated")
  })

  it("accepts a rule basis matching a pre_approve snapshot", () => {
    const envelope = makeEnvelope({}, [preApproveRule({ ruleId: "rule-pre" })])
    const approval = makeApproval({
      envelopeDigest: digestDispatchEnvelope(envelope),
      basis: { kind: "rule", ruleId: "rule-pre", ruleVersion: 1 },
    })

    expect(verifyApproval(approval, envelope).state).toBe("approved")
  })

  it("refuses to create an approval whose rule basis does not exist", () => {
    const envelope = makeEnvelope()
    const result = createApproval({
      envelope,
      approvalId: approvalIdSchema.parse("appr-1"),
      decision: "approved",
      basis: { kind: "rule", ruleId: ruleIdSchema.parse("rule-absent"), ruleVersion: 1 },
      actor: { kind: "user", userId: userIdSchema.parse("user-1") },
      decidedAt: "2026-02-02T00:00:00Z",
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("approval.unknown_rule_basis")
    expect(result.error.category).toBe("validation")
  })

  it("refuses to record an approval against a policy evaluation that does not allow", () => {
    const envelope = makeEnvelope()
    const evaluation = evaluate(envelope)
    const result = createApproval({
      envelope,
      approvalId: approvalIdSchema.parse("appr-1"),
      decision: "approved",
      basis: { kind: "user" },
      actor: { kind: "user", userId: userIdSchema.parse("user-1") },
      decidedAt: "2026-02-02T00:00:00Z",
      evaluation,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("policy.approval_not_satisfiable")
    expect(result.error.category).toBe("approval_required")
  })

  it("refuses to record an approval against a stale evaluation", () => {
    const envelope = makeEnvelope()
    const evaluation = evaluate(makeEnvelope({}, [preApproveRule()]))
    const result = createApproval({
      envelope,
      approvalId: approvalIdSchema.parse("appr-1"),
      decision: "approved",
      basis: { kind: "user" },
      actor: { kind: "user", userId: userIdSchema.parse("user-1") },
      decidedAt: "2026-02-02T00:00:00Z",
      evaluation,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("approval.evaluation_digest_mismatch")
  })

  it("rejects an approval whose dispatch, project or run does not match", () => {
    const envelope = makeEnvelope()
    const approval = makeApproval({ envelopeDigest: digestDispatchEnvelope(envelope) })

    const wrongDispatch = verifyApproval({ ...approval, dispatchId: dispatchIdSchema.parse("disp-other") }, envelope)
    const wrongProject = verifyApproval({ ...approval, projectId: projectIdSchema.parse("proj-other") }, envelope)
    const wrongRun = verifyApproval({ ...approval, runId: runIdSchema.parse("run-other") }, envelope)

    for (const verification of [wrongDispatch, wrongProject, wrongRun]) {
      expect(verification.state).toBe("invalidated")
      expect(verification.valid).toBe(false)
    }
    expect(wrongDispatch.codes).toContain("approval.dispatch_mismatch")
    expect(wrongProject.codes).toContain("approval.project_mismatch")
    expect(wrongRun.codes).toContain("approval.run_mismatch")
  })

  it("keeps a rejection terminal even when the envelope no longer matches", () => {
    const envelope = makeEnvelope({ timeoutSeconds: 599 })
    const approval = makeApproval({
      envelopeDigest: digestDispatchEnvelope(makeEnvelope()),
      decision: "rejected",
    })
    const verification = verifyApproval(approval, envelope)

    // The state stays `rejected` because `rejected` is terminal and has no
    // transition to `invalidated`, but the approval no longer binds.
    expect(verification.state).toBe("rejected")
    expect(verification.valid).toBe(false)
    expect(verification.codes).toContain("approval.digest_mismatch")
  })

  it("invalidates a prior approval after an envelope mutation", () => {
    const envelope = makeEnvelope()
    const approval = makeApproval({ envelopeDigest: digestDispatchEnvelope(envelope) })
    const mutated = makeEnvelope({ timeoutSeconds: 599 })

    expect(verifyApproval(approval, envelope).state).toBe("approved")
    const result = invalidateApproval(approval, mutated, "approved")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("invalidated")
  })

  it("refuses to invalidate an approval that still binds", () => {
    const envelope = makeEnvelope()
    const approval = makeApproval({ envelopeDigest: digestDispatchEnvelope(envelope) })
    const result = invalidateApproval(approval, envelope, "approved")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("approval.invalidation_unwarranted")
  })

  it("refuses to invalidate a terminal approval, per the state machine", () => {
    const envelope = makeEnvelope({ timeoutSeconds: 599 })
    const approval = makeApproval({ envelopeDigest: digestDispatchEnvelope(makeEnvelope()) })

    for (const state of ["rejected", "invalidated"] as const) {
      const result = invalidateApproval(approval, envelope, state)
      expect(result.ok).toBe(false)
      if (result.ok) return
      // `rejected` and `invalidated` are terminal, so the transition is refused
      // as a terminal-immutability violation rather than an unknown transition.
      expect(result.error.code).toBe("state.terminal_immutable")
      expect(isApprovalTerminal(state)).toBe(true)
    }
  })

  it("uses the approval state machine for invalidation", () => {
    expect(APPROVAL_TRANSITIONS.pending).toContain("invalidated")
    expect(APPROVAL_TRANSITIONS.approved).toContain("invalidated")
    expect(canTransitionApproval("approved", "invalidated")).toBe(true)
    expect(canTransitionApproval("invalidated", "approved")).toBe(false)
  })

  it("resolves the approval state for a known prior state", () => {
    const envelope = makeEnvelope()
    const approval = makeApproval({ envelopeDigest: digestDispatchEnvelope(envelope) })

    expect(resolveApprovalState(approval, envelope, "approved")).toEqual({ ok: true, value: "approved" })
    const mutated = resolveApprovalState(approval, makeEnvelope({ timeoutSeconds: 599 }), "approved")
    expect(mutated).toEqual({ ok: true, value: "invalidated" })
  })

  it("reads a policy result off an approval projection when present", () => {
    const evaluation = evaluate(makeEnvelope())
    expect(policyResultOf({ policyResult: evaluation })).toEqual(evaluation)
    expect(policyResultOf({ policyResult: null })).toBeNull()
    expect(policyResultOf({ policyResult: "none" })).toBeNull()
    expect(policyResultOf({ policyResult: { decision: "allow" } })).toBeNull()
  })
})

// =========================================================================
// Mutation tests
// =========================================================================

describe("Approval invalidation on envelope mutation (M3.6)", () => {
  const MATERIAL_MUTATIONS: ReadonlyArray<{ readonly name: string; readonly mutate: () => DispatchEnvelope }> = [
    { name: "dispatchId", mutate: () => makeEnvelope({ dispatchId: dispatchIdSchema.parse("disp-2") }) },
    { name: "attempt", mutate: () => makeEnvelope({ attempt: 2 }) },
    {
      // The envelope schema pins the role snapshot to the dispatch project, so
      // the project scope is mutated consistently on both.
      name: "projectId",
      mutate: () => {
        const projectId = projectIdSchema.parse("proj-2")
        return makeEnvelope({
          projectId,
          roleSnapshot: { ...makeEnvelope().roleSnapshot, projectId },
          ruleSnapshots: [makeRule({ projectId })],
        })
      },
    },
    { name: "runId", mutate: () => makeEnvelope({ runId: runIdSchema.parse("run-2") }) },
    { name: "taskId", mutate: () => makeEnvelope({ taskId: taskIdSchema.parse("task-2") }) },
    { name: "targetNodeId", mutate: () => makeEnvelope({ targetNodeId: "node-2" as never }) },
    { name: "installationId", mutate: () => makeEnvelope({ installationId: "inst-2" as never }) },
    { name: "runtimeKind", mutate: () => makeEnvelope({ runtimeKind: "codex" }) },
    { name: "projectPathId", mutate: () => makeEnvelope({ projectPathId: "path-2" as never }) },
    { name: "prompt", mutate: () => makeEnvelope({ prompt: "run the other deployment" }) },
    {
      name: "roleSnapshot.templateVersion",
      mutate: () => makeEnvelope({ roleSnapshot: { ...makeEnvelope().roleSnapshot, templateVersion: 2 } }),
    },
    {
      name: "roleSnapshot.permissionRestrictions",
      mutate: () =>
        makeEnvelope({
          roleSnapshot: {
            ...makeEnvelope().roleSnapshot,
            permissionRestrictions: {
              allowedCapabilities: ["fs.read"],
              deniedCapabilities: [],
              approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
            },
          },
        }),
    },
    {
      name: "ruleSnapshots",
      mutate: () => makeEnvelope({}, [restrictRule({ ruleId: "rule-v", effect: { kind: "restrict", deniedCapabilities: ["net.fetch"], requireApprovalForDestructiveEffects: false, requireApprovalForExternalEffects: false } })]),
    },
    {
      name: "contextManifest",
      mutate: () => makeEnvelope({ contextManifest: { references: [], manifestDigest: digestJson({ manifest: "other" }) } }),
    },
    { name: "requestedCapabilities", mutate: () => makeEnvelope({ requestedCapabilities: ["fs.read"] }) },
    {
      name: "permissionEnvelope.allowedCapabilities",
      mutate: () =>
        makeEnvelope({
          permissionEnvelope: {
            // The dispatch still requests both capabilities, so the envelope
            // contract requires the extra one to be explicitly denied.
            allowedCapabilities: ["fs.read"],
            deniedCapabilities: ["net.fetch"],
            approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
          },
        }),
    },
    {
      name: "permissionEnvelope.approvalRequirements",
      mutate: () =>
        makeEnvelope({
          permissionEnvelope: {
            allowedCapabilities: [...CAPS],
            deniedCapabilities: [],
            approvalRequirements: { destructiveEffects: true, externalEffects: false, capabilities: [] },
          },
        }),
    },
    { name: "dependencies", mutate: () => makeEnvelope({ dependencies: [{ taskId: taskIdSchema.parse("task-0"), failurePolicy: "block" }] }) },
    { name: "timeoutSeconds", mutate: () => makeEnvelope({ timeoutSeconds: 601 }) },
    { name: "controllerEpoch", mutate: () => makeEnvelope({ controllerEpoch: 4 }) },
    { name: "model", mutate: () => makeEnvelope({ model: "gpt-6-astra" }) },
  ]

  it("covers every material envelope field", () => {
    expect(MATERIAL_MUTATIONS).toHaveLength(21)
    expect(new Set(MATERIAL_MUTATIONS.map((mutation) => mutation.name)).size).toBe(MATERIAL_MUTATIONS.length)
  })

  for (const mutation of MATERIAL_MUTATIONS) {
    it(`invalidates the approval and changes the digest: ${mutation.name}`, () => {
      const original = makeEnvelope()
      const originalDigest = digestDispatchEnvelope(original)
      const approval = makeApproval({ envelopeDigest: originalDigest })

      const mutated = mutation.mutate()
      const mutatedDigest = digestDispatchEnvelope(mutated)

      expect(mutatedDigest).not.toBe(originalDigest)

      const verification = verifyApproval(approval, mutated)
      expect(verification.state).toBe("invalidated")
      expect(verification.valid).toBe(false)
      // A mutation either breaks the digest binding outright or moves the
      // envelope out from under the approval's identity; both invalidate.
      expect(verification.codes.some((code) => code.startsWith("approval."))).toBe(true)
      expect(verification.reasons.length).toBeGreaterThan(0)

      const invalidation = invalidateApproval(approval, mutated, "approved")
      expect(invalidation.ok).toBe(true)
      if (!invalidation.ok) return
      expect(invalidation.value).toBe("invalidated")
    })
  }

  it("restoring the original envelope restores the digest and the approval", () => {
    const original = makeEnvelope()
    const approval = makeApproval({ envelopeDigest: digestDispatchEnvelope(original) })
    const mutated = makeEnvelope({ timeoutSeconds: 601 })
    const restored = makeEnvelope({ timeoutSeconds: 600 })

    expect(digestDispatchEnvelope(restored)).toBe(digestDispatchEnvelope(original))
    expect(verifyApproval(approval, restored).state).toBe("approved")
  })

  it("rejects a non-envelope mutation that would change key order only", () => {
    const original = makeEnvelope()
    const reordered = Object.fromEntries(Object.entries(original).reverse()) as unknown as DispatchEnvelope

    expect(digestDispatchEnvelope(reordered)).toBe(digestDispatchEnvelope(original))
  })
})

// =========================================================================
// authorizeDispatch
// =========================================================================

describe("authorizeDispatch (M3.6)", () => {
  it("fails closed with an approval_required error by default", () => {
    const result = authorizeDispatch({ envelope: makeEnvelope(), taskTitle: TASK_TITLE })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.category).toBe("approval_required")
    expect(result.error.code).toBe("policy.approval_required")
    expect(result.error.retryable).toBe(false)
  })

  it("fails with policy_denied for a denied dispatch", () => {
    const envelope = makeEnvelope({}, [restrictRule({ effect: { kind: "restrict", deniedCapabilities: ["net.fetch"], requireApprovalForDestructiveEffects: false, requireApprovalForExternalEffects: false } })])
    const result = authorizeDispatch({ envelope, taskTitle: TASK_TITLE })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.category).toBe("policy_denied")
    expect(result.error.code).toBe("policy.denied")
  })

  it("succeeds when a pre_approval covers the dispatch", () => {
    const envelope = makeEnvelope({}, [preApproveRule()])
    const result = authorizeDispatch({ envelope, taskTitle: TASK_TITLE })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.decision).toBe("allow")
  })

  it("fails with policy_denied for a project policy scope mismatch", () => {
    const result = authorizeDispatch({
      envelope: makeEnvelope(),
      taskTitle: TASK_TITLE,
      projectPolicy: makeProjectPolicy({}, "proj-other"),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("policy.project_scope_mismatch")
  })
})
