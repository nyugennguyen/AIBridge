import { describe, expect, it } from "vitest"
import { digestDispatchEnvelope } from "../../../src/orchestration/digest.js"
import { approvalIdSchema, projectIdSchema, taskIdSchema, userIdSchema } from "../../../src/orchestration/identifiers.js"
import type { Approval, DispatchEnvelope, Rule } from "../../../src/orchestration/types.js"
import {
  SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
  createApproval,
  evaluatePolicy,
  invalidateApproval,
  verifyApproval,
  type ProjectPolicy,
} from "../../../src/orchestration/policy/index.js"

const PROJECT_ID = "proj-1"
const CAPS = ["fs.read", "net.fetch"] as const

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

function envelope(overrides: Partial<DispatchEnvelope> = {}, rules: readonly Rule[] = []): DispatchEnvelope {
  return {
    schemaVersion: 1,
    dispatchId: "disp-1",
    attempt: 1,
    projectId: PROJECT_ID,
    runId: "run-1",
    taskId: "task-1",
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
    ruleSnapshots: [...rules],
    contextManifest: { references: [], manifestDigest: "sha256:0".padEnd(71, "0") },
    requestedCapabilities: [...CAPS],
    permissionEnvelope: {
      allowedCapabilities: [...CAPS],
      deniedCapabilities: [],
      approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
    },
    dependencies: [],
    timeoutSeconds: 600,
    controllerEpoch: 1,
    ...overrides,
  } as unknown as DispatchEnvelope
}

function preApprove(overrides: Record<string, unknown> = {}): Rule {
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

describe("Safety floor cannot be widened by any layer", () => {
  it("hostile project policy cannot enable destructive/external effects, raise the ceiling, or clear the demand", () => {
    const hostile: ProjectPolicy = {
      projectId: projectIdSchema.parse(PROJECT_ID),
      label: "hostile",
      narrowing: {
        allowedCapabilities: [...CAPS, "root.escalate"],
        deniedCapabilities: [],
        requireApprovalForCapabilities: [],
        requireApprovalForDispatch: false,
        requireApprovalForDestructiveEffects: false,
        requireApprovalForExternalEffects: false,
        allowDestructiveEffects: true,
        allowExternalEffects: true,
        maximumTimeoutSeconds: 999_999,
      },
    }

    const result = evaluatePolicy({ envelope: envelope(), taskTitle: "t", projectPolicy: hostile })

    expect(result.effective.allowDestructiveEffects).toBe(false)
    expect(result.effective.allowExternalEffects).toBe(false)
    // The hostile policy asked for 999999; the floor caps at 3600 and the
    // dispatch layer narrows further to the declared 600. What matters is that
    // the hostile value never won.
    expect(result.effective.maximumTimeoutSeconds).toBeLessThanOrEqual(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS)
    expect(result.effective.maximumTimeoutSeconds).not.toBe(999_999)
    // "root.escalate" was never requested, so it can never enter the effective set.
    expect(result.effective.allowedCapabilities).not.toContain("root.escalate")
    // The floor's blanket approval demand must survive the hostile policy.
    expect(result.effective.dispatchApprovalDemands).toEqual(["safety_floor"])
    expect(result.outstandingApprovals).toContain("dispatch_approval")
    expect(result.decision).not.toBe("allow")
    expect(result.explanation.wideningAttempts.length).toBeGreaterThan(0)
  })

  it("the floor approval demand is present even with no policy, no rules and a permissive envelope", () => {
    const result = evaluatePolicy({ envelope: envelope(), taskTitle: "t" })
    expect(result.effective.allowDestructiveEffects).toBe(false)
    expect(result.effective.allowExternalEffects).toBe(false)
    expect(result.decision).toBe("require_approval")
    expect(result.outstandingApprovals).toContain("dispatch_approval")
  })
})

describe("Pre-approval cannot bypass policy denial", () => {
  it("a dispatch denied by a matching restrict rule stays denied despite a full pre-approval", () => {
    const denyRule = makeRule({
      ruleId: "rule-deny",
      effect: {
        kind: "restrict",
        deniedCapabilities: ["net.fetch"],
        requireApprovalForDestructiveEffects: false,
        requireApprovalForExternalEffects: false,
      },
    })
    const result = evaluatePolicy({
      envelope: envelope({}, [denyRule, preApprove()]),
      taskTitle: "t",
    })

    expect(result.decision).toBe("deny")
    expect(result.denials.map((d) => d.code)).toContain("policy.capability_denied")
    expect(result.outstandingApprovals.length).toBeGreaterThan(0)
  })

  it("a pre-approval cannot clear a project policy's own dispatch-approval demand", () => {
    const strict: ProjectPolicy = {
      projectId: projectIdSchema.parse(PROJECT_ID),
      label: "strict",
      narrowing: { deniedCapabilities: [], requireApprovalForCapabilities: [], requireApprovalForDispatch: true },
    }

    const result = evaluatePolicy({
      envelope: envelope({}, [preApprove()]),
      taskTitle: "t",
      projectPolicy: strict,
    })

    expect(result.effective.dispatchApprovalDemands).toEqual(["safety_floor", "project"])
    expect(result.decision).toBe("require_approval")
    expect(result.outstandingApprovals).toContain("dispatch_approval")
  })

  it("a pre-approval that requests destructive effects the floor denies is rejected", () => {
    const escalating = preApprove({
      effect: {
        kind: "pre_approve",
        approvedCapabilities: [...CAPS],
        maximumTimeoutSeconds: 600,
        allowDestructiveEffects: true,
        allowExternalEffects: false,
      },
    })
    const result = evaluatePolicy({ envelope: envelope({}, [escalating]), taskTitle: "t" })

    expect(result.decision).toBe("require_approval")
    expect(result.effective.allowDestructiveEffects).toBe(false)
    expect(result.outstandingApprovals).toContain("dispatch_approval")
  })

  it("a pre-approval whose maximum timeout is below the declared timeout is rejected", () => {
    const short = preApprove({
      effect: {
        kind: "pre_approve",
        approvedCapabilities: [...CAPS],
        maximumTimeoutSeconds: 60,
        allowDestructiveEffects: false,
        allowExternalEffects: false,
      },
    })
    const result = evaluatePolicy({ envelope: envelope({ timeoutSeconds: 600 }, [short]), taskTitle: "t" })

    expect(result.decision).toBe("require_approval")
    expect(result.outstandingApprovals).toContain("dispatch_approval")
  })
})

describe("Any envelope mutation invalidates its approval", () => {
  const mutators: ReadonlyArray<[string, (e: DispatchEnvelope) => DispatchEnvelope]> = [
    ["prompt", (e) => ({ ...e, prompt: `${e.prompt}!!` })],
    ["timeoutSeconds", (e) => ({ ...e, timeoutSeconds: e.timeoutSeconds + 1 })],
    ["controllerEpoch", (e) => ({ ...e, controllerEpoch: e.controllerEpoch + 1 })],
    ["attempt", (e) => ({ ...e, attempt: e.attempt + 1 })],
    ["targetNodeId", (e) => ({ ...e, targetNodeId: "node-evil" as never })],
    ["runtimeKind", (e) => ({ ...e, runtimeKind: "codex" })],
    ["requestedCapabilities", (e) => ({ ...e, requestedCapabilities: ["fs.read"] })],
    ["ruleSnapshots", (e) => ({ ...e, ruleSnapshots: [preApprove()] })],
    ["roleSnapshot.templateVersion", (e) => ({
      ...e,
      roleSnapshot: { ...e.roleSnapshot, templateVersion: e.roleSnapshot.templateVersion + 1 },
    })],
    ["permissionEnvelope.approvalRequirements", (e) => ({
      ...e,
      permissionEnvelope: {
        ...e.permissionEnvelope,
        approvalRequirements: { destructiveEffects: true, externalEffects: true, capabilities: ["fs.read"] },
      },
    })],
    ["dependencies", (e) => ({ ...e, dependencies: [{ taskId: taskIdSchema.parse("task-0"), failurePolicy: "block" }] })],
    ["model", (e) => ({ ...e, model: "gpt-9" })],
  ]

  for (const [label, mutate] of mutators) {
    it(`${label} changes the digest and invalidates the approval`, () => {
      const original = envelope()
      const created = createApproval({
        approvalId: approvalIdSchema.parse("appr-1"),
        envelope: original,
        decision: "approved",
        basis: { kind: "user" },
        actor: { kind: "user", userId: userIdSchema.parse("user-1") },
        decidedAt: "2026-02-02T00:00:00Z",
      })
      expect(created.ok).toBe(true)
      const approval = (created as { ok: true; value: Approval }).value

      expect(verifyApproval(approval, original).valid).toBe(true)
      expect(verifyApproval(approval, original).state).toBe("approved")

      const mutated = mutate(original)
      expect(digestDispatchEnvelope(mutated)).not.toBe(digestDispatchEnvelope(original))

      const verification = verifyApproval(approval, mutated)
      expect(verification.valid).toBe(false)
      expect(verification.state).toBe("invalidated")

      const invalidation = invalidateApproval(approval, mutated, "approved")
      expect(invalidation.ok).toBe(true)
      expect((invalidation as { ok: true; value: string }).value).toBe("invalidated")
    })
  }

  it("a reordering-only change does not invalidate the approval's decision", () => {
    const original = envelope()
    const created = createApproval({
      approvalId: approvalIdSchema.parse("appr-1"),
      envelope: original,
      decision: "approved",
      basis: { kind: "user" },
      actor: { kind: "user", userId: userIdSchema.parse("user-1") },
      decidedAt: "2026-02-02T00:00:00Z",
    })
    const approval = (created as { ok: true; value: Approval }).value
    const reordered = { ...original, requestedCapabilities: ["net.fetch", "fs.read"] }

    // NOTE: array order is significant to `canonicalJson`, so the digest changes.
    // That is pre-existing M3.1 behaviour and is fail-closed (spurious
    // invalidation, never a spurious approval). What must hold is that the
    // policy *conclusion* is order-insensitive.
    expect(verifyApproval(approval, reordered).valid).toBe(false)

    const base = evaluatePolicy({ envelope: original, taskTitle: "deploy" })
    const shuffled = evaluatePolicy({ envelope: reordered, taskTitle: "deploy" })
    expect(shuffled.decision).toBe(base.decision)
    expect(shuffled.effective).toEqual(base.effective)
    expect(shuffled.explanationText).toBe(base.explanationText)
  })
})

describe("Policy evaluation is deterministic", () => {
  it("byte-identical decision, explanation and digest across repeated and reordered evaluations", () => {
    const rules = [preApprove(), makeRule({ ruleId: "rule-z" }), makeRule({ ruleId: "rule-b" })]
    const first = evaluatePolicy({ envelope: envelope({}, rules), taskTitle: "deploy" })
    const second = evaluatePolicy({ envelope: envelope({}, rules), taskTitle: "deploy" })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.decisionDigest).toBe(second.decisionDigest)

    const shuffled = [rules[2], rules[0], rules[1]]
    const third = evaluatePolicy({ envelope: envelope({}, shuffled), taskTitle: "deploy" })
    // The envelopes differ (array order is significant to canonicalJson), so the
    // envelope digest and therefore decisionDigest differ. Every policy
    // conclusion must be identical.
    expect(third.envelopeDigest).not.toBe(first.envelopeDigest)
    expect(third.decision).toBe(first.decision)
    expect(third.effective).toEqual(first.effective)
    expect(third.explanation).toEqual(first.explanation)
    expect(third.explanationText).toBe(first.explanationText)
    expect(third.outstandingApprovals).toEqual(first.outstandingApprovals)
  })
})
