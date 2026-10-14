/**
 * Unit tests for RoleBinder (plan §7.1, §10, §11).
 *
 * Acceptance criteria asserted:
 * 1. Deterministic compilation: Same inputs twice → byte-identical system prompt;
 *    digest matches the input digests (test asserts both).
 *    Composition: `system = Charter(v).globalRules + primaryRole.instructions + Σ secondaryRole.addendum + Charter(v).communicationPolicy + taskPrompt`.
 * 2. Order independence: Shuffled secondary role assignments produce identical output
 *    via canonicalizeRoleAssignments.
 * 3. Bounded budget, hard cap on Σ secondary addenda:
 *    At boundary (MAX_SECONDARY_ADDENDA_BYTES): accepted.
 *    Over boundary (MAX_SECONDARY_ADDENDA_BYTES + 1): refused deterministically with
 *    RoleAddendaBudgetExceededError (never silently truncated).
 * 4. Per runtime kind tool policy and prompt compilation:
 *    RoleTemplate → runtime kind + tool policy for opencode, claude, codex.
 *    Resolves preferredRuntimeKinds; throws UnresolvableRuntimeKindError when none match live kinds.
 * 5. Adapter cutover helpers:
 *    Byte-identical single-role output for opencode, claude, codex;
 *    canonical multi-role addenda assembly without duplication.
 */

import { describe, expect, it } from "vitest"
import {
  MAX_SECONDARY_ADDENDA_BYTES,
  RoleAddendaBudgetExceededError,
  RoleBinder,
  UnresolvableRuntimeKindError,
  compilePrompt,
  compileSystemPrompt,
  extractCanonicalSecondaryAddenda,
  formatCharterGlobalRules,
  formatCommunicationPolicy,
  resolveRuntimeKind,
  type BinderCompileOptions,
} from "../../../src/runtime/binder.js"
import type { RoleAssignment } from "../../../src/orchestration/schemas.js"
import type { Digest } from "../../../src/orchestration/identifiers.js"
import type { Charter, CommunicationPolicy } from "../../../src/orchestration/charter/types.js"
import type { RoleSnapshot, RoleTemplate } from "../../../src/orchestration/roles/types.js"
import {
  launchAgentRequestSchema,
  runtimeOperationContextSchema,
  type LaunchAgentRequest,
} from "../../../src/runtime/schemas.js"

// ============================================================================
// Test Fixtures
// ============================================================================

const sampleCommunicationPolicy: CommunicationPolicy = {
  turnTaking: "chair_ordered",
  objectionRequiredBefore: ["deploy", "schema_migration"],
  verbosity: "normal",
  mustStopAndAsk: ["data_loss", "security_escalation"],
  objectionMustContain: ["rationale", "evidence"],
}

const sampleCharterDigest = "sha256:1111111111111111111111111111111111111111111111111111111111111111" as Digest
const samplePrimaryRoleDigest = "sha256:2222222222222222222222222222222222222222222222222222222222222222" as Digest
const sampleSecondaryRoleDigest = "sha256:3333333333333333333333333333333333333333333333333333333333333333" as Digest
const sampleRuleDigest = "sha256:4444444444444444444444444444444444444444444444444444444444444444" as Digest

const sampleCharter: Charter = {
  charterId: "profile-main",
  version: 1,
  purpose: "Governs autonomous task dispatches",
  globalRules: [
    "Rule 1: Always verify assumptions before destructive operations.",
    "Rule 2: Keep logs and evidence for every state modification.",
  ],
  communicationPolicy: sampleCommunicationPolicy,
  escalationPolicy: {
    maxRounds: 5,
    onDeadlock: "chair_decides",
    budgetScope: "shared",
  },
  roleCatalog: [
    { roleId: "implementer", version: 1 },
    { roleId: "reviewer", version: 1 },
  ],
  immutableCoreDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as Digest,
  snapshotDigest: sampleCharterDigest,
  capturedAt: "2026-10-13T00:00:00.000Z",
  author: "human",
}

const samplePrimaryRole: RoleTemplate = {
  schemaVersion: 1,
  roleId: "implementer",
  version: 1,
  templateVersion: 1,
  name: "Implementer",
  description: "Writes tested application code",
  purpose: "Writes tested application code",
  instructions: "Implement code following test-driven development. Verify each step before moving forward.",
  capabilities: ["filesystem.read", "filesystem.write"],
  requiredCapabilities: ["filesystem.read", "filesystem.write"],
  preferredRuntimeKinds: ["opencode"],
  rules: [],
  metadata: {},
  createdAt: "2026-10-13T00:00:00.000Z",
  projectId: "project-1",
  contextSelectionPolicyReference: { namespace: "test", id: "default" },
  author: { kind: "system" as const, name: "test" },
  permissionRestrictions: {
    allowedCapabilities: ["filesystem.read", "filesystem.write"],
    deniedCapabilities: [],
    approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
  },
}

const sampleSecondaryRole: RoleTemplate = {
  schemaVersion: 1,
  roleId: "security-auditor",
  version: 1,
  templateVersion: 1,
  name: "Security Auditor",
  description: "Audits security perimeter and input hygiene",
  purpose: "Audits security perimeter and input hygiene",
  instructions: "Full auditor instructions that should NOT appear in compiled prompt.",
  capabilities: ["filesystem.read"],
  requiredCapabilities: ["filesystem.read"],
  preferredRuntimeKinds: ["opencode"],
  rules: [],
  metadata: {},
  createdAt: "2026-10-13T00:00:00.000Z",
  projectId: "project-1",
  contextSelectionPolicyReference: { namespace: "test", id: "default" },
  author: { kind: "system" as const, name: "test" },
  permissionRestrictions: {
    allowedCapabilities: ["filesystem.read"],
    deniedCapabilities: [],
    approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
  },
}

function makeRoleSnapshotWithDigest(template: RoleTemplate, digest: Digest): RoleSnapshot {
  return {
    roleId: template.roleId,
    version: template.version,
    templateVersion: template.templateVersion,
    name: template.name,
    description: template.description,
    capabilities: template.capabilities,
    requiredCapabilities: template.requiredCapabilities,
    rules: template.rules,
    capturedAt: template.createdAt,
    snapshotDigest: digest,
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe("RoleBinder deterministic compilation (plan §7.1 + §11)", () => {
  it("compiles exact §7.1 composition: globalRules + instructions + Σ addenda + communicationPolicy + taskPrompt", () => {
    const roleAssignments: RoleAssignment[] = [
      { roleId: "implementer", primary: true },
      { roleId: "security-auditor", primary: false, addendum: "Audit all buffer allocations and secret accesses." },
    ]

    const compiled = RoleBinder.compile({
      charter: sampleCharter,
      primaryRole: samplePrimaryRole,
      secondaryRoles: [sampleSecondaryRole],
      roleAssignments,
      taskPrompt: "Fix memory leak in network connection handler.",
    })

    const expectedGlobalRules = sampleCharter.globalRules.join("\n")
    const expectedInstructions = samplePrimaryRole.instructions
    const expectedAddenda = "Audit all buffer allocations and secret accesses."
    const expectedCommPolicy = formatCommunicationPolicy(sampleCommunicationPolicy)
    const expectedTaskPrompt = "Fix memory leak in network connection handler."

    const expectedSystemPrompt = [
      expectedGlobalRules,
      expectedInstructions,
      expectedAddenda,
      expectedCommPolicy,
      expectedTaskPrompt,
    ].join("\n\n")

    expect(compiled.systemPrompt).toBe(expectedSystemPrompt)
    expect(compiled.taskPrompt).toBe(expectedTaskPrompt)
  })

  it("same inputs twice produce byte-identical system prompt and matching digests (acceptance §11)", () => {
    const primarySnapshot = makeRoleSnapshotWithDigest(samplePrimaryRole, samplePrimaryRoleDigest)
    const secondarySnapshot = makeRoleSnapshotWithDigest(sampleSecondaryRole, sampleSecondaryRoleDigest)

    const options: BinderCompileOptions = {
      charter: sampleCharter,
      primaryRole: primarySnapshot,
      secondaryRoles: [secondarySnapshot],
      roleAssignments: [
        { roleId: "implementer", primary: true },
        { roleId: "security-auditor", primary: false, addendum: "Ensure no credentials leak into log sinks." },
      ],
      ruleSnapshots: [
        {
          ruleId: "rule-sandbox",
          templateVersion: 1,
          enabled: true,
          effect: { kind: "restrict", deniedCapabilities: ["process.exec"] },
          snapshotDigest: sampleRuleDigest,
        },
      ],
      taskPrompt: "Perform repository hygiene review.",
    }

    const run1 = RoleBinder.compile(options)
    const run2 = RoleBinder.compile(options)

    // Byte-identical system prompt
    expect(run1.systemPrompt).toBe(run2.systemPrompt)

    // Digests match input digests stamped deterministically
    expect(run1.charterDigest).toBe(sampleCharterDigest)
    expect(run2.charterDigest).toBe(sampleCharterDigest)

    expect(run1.roleDigests).toEqual([samplePrimaryRoleDigest, sampleSecondaryRoleDigest])
    expect(run2.roleDigests).toEqual([samplePrimaryRoleDigest, sampleSecondaryRoleDigest])

    expect(run1.ruleDigests).toEqual([sampleRuleDigest])
    expect(run2.ruleDigests).toEqual([sampleRuleDigest])

    expect(run1.promptDigest).toBe(run2.promptDigest)
    expect(run1.compositeDigest).toBe(run2.compositeDigest)
  })

  it("secondaries contribute addenda ONLY; full secondary instructions are excluded", () => {
    const roleAssignments: RoleAssignment[] = [
      { roleId: "implementer", primary: true },
      { roleId: "security-auditor", primary: false, addendum: "Secondary addendum text" },
    ]

    const compiled = RoleBinder.compile({
      primaryRole: samplePrimaryRole,
      secondaryRoles: [sampleSecondaryRole],
      roleAssignments,
    })

    expect(compiled.systemPrompt).toContain("Secondary addendum text")
    expect(compiled.systemPrompt).not.toContain(sampleSecondaryRole.instructions!)
  })

  it("shuffled secondary assignment order produces byte-identical output via canonicalizeRoleAssignments", () => {
    const setA: RoleAssignment[] = [
      { roleId: "zeta-checker", primary: false, addendum: "Zeta check addendum." },
      { roleId: "implementer", primary: true },
      { roleId: "alpha-linter", primary: false, addendum: "Alpha lint addendum." },
    ]

    const setB: RoleAssignment[] = [
      { roleId: "alpha-linter", primary: false, addendum: "Alpha lint addendum." },
      { roleId: "zeta-checker", primary: false, addendum: "Zeta check addendum." },
      { roleId: "implementer", primary: true },
    ]

    const compiledA = RoleBinder.compile({
      charter: sampleCharter,
      primaryRole: samplePrimaryRole,
      roleAssignments: setA,
      taskPrompt: "Refactor core loop.",
    })

    const compiledB = RoleBinder.compile({
      charter: sampleCharter,
      primaryRole: samplePrimaryRole,
      roleAssignments: setB,
      taskPrompt: "Refactor core loop.",
    })

    expect(compiledA.systemPrompt).toBe(compiledB.systemPrompt)
    expect(compiledA.promptDigest).toBe(compiledB.promptDigest)
    expect(compiledA.compositeDigest).toBe(compiledB.compositeDigest)

    // Lexicographical order: alpha-linter before zeta-checker
    const alphaIndex = compiledA.systemPrompt.indexOf("Alpha lint addendum.")
    const zetaIndex = compiledA.systemPrompt.indexOf("Zeta check addendum.")
    expect(alphaIndex).toBeLessThan(zetaIndex)
  })
})

describe("Bounded budget and hard cap on Σ secondary addenda (plan §7.1)", () => {
  it("compiles successfully when Σ secondary addenda is exactly at MAX_SECONDARY_ADDENDA_BYTES", () => {
    // Construct addenda exactly filling MAX_SECONDARY_ADDENDA_BYTES (16,384 bytes)
    // 4 addenda of 4,096 bytes each
    const chunkSize = 4_096
    const chunkA = "A".repeat(chunkSize)
    const chunkB = "B".repeat(chunkSize)
    const chunkC = "C".repeat(chunkSize)
    const chunkD = "D".repeat(chunkSize)

    const totalBytes = Buffer.byteLength(chunkA + chunkB + chunkC + chunkD, "utf8")
    expect(totalBytes).toBe(MAX_SECONDARY_ADDENDA_BYTES)

    const assignments: RoleAssignment[] = [
      { roleId: "lead", primary: true },
      { roleId: "sec-a", primary: false, addendum: chunkA },
      { roleId: "sec-b", primary: false, addendum: chunkB },
      { roleId: "sec-c", primary: false, addendum: chunkC },
      { roleId: "sec-d", primary: false, addendum: chunkD },
    ]

    const compiled = RoleBinder.compile({
      primaryRole: samplePrimaryRole,
      roleAssignments: assignments,
    })

    expect(compiled.systemPrompt).toContain(chunkA)
    expect(compiled.systemPrompt).toContain(chunkD)
  })

  it("refuses compilation when Σ secondary addenda exceeds MAX_SECONDARY_ADDENDA_BYTES by 1 byte", () => {
    const chunkA = "A".repeat(4_096)
    const chunkB = "B".repeat(4_096)
    const chunkC = "C".repeat(4_096)
    const chunkD = "D".repeat(4_097) // 1 byte over boundary

    const totalBytes = Buffer.byteLength(chunkA + chunkB + chunkC + chunkD, "utf8")
    expect(totalBytes).toBe(MAX_SECONDARY_ADDENDA_BYTES + 1)

    const assignments: RoleAssignment[] = [
      { roleId: "lead", primary: true },
      { roleId: "sec-a", primary: false, addendum: chunkA },
      { roleId: "sec-b", primary: false, addendum: chunkB },
      { roleId: "sec-c", primary: false, addendum: chunkC },
      { roleId: "sec-d", primary: false, addendum: chunkD },
    ]

    expect(() =>
      RoleBinder.compile({
        primaryRole: samplePrimaryRole,
        roleAssignments: assignments,
      }),
    ).toThrow(RoleAddendaBudgetExceededError)

    try {
      RoleBinder.compile({
        primaryRole: samplePrimaryRole,
        roleAssignments: assignments,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(RoleAddendaBudgetExceededError)
      const budgetErr = err as RoleAddendaBudgetExceededError
      expect(budgetErr.code).toBe("binder.addenda_budget_exceeded")
      expect(budgetErr.category).toBe("validation")
      expect(budgetErr.totalBytes).toBe(MAX_SECONDARY_ADDENDA_BYTES + 1)
      expect(budgetErr.maxBytes).toBe(MAX_SECONDARY_ADDENDA_BYTES)
      expect(budgetErr.toContractError().code).toBe("binder.addenda_budget_exceeded")
    }
  })

  it("extractCanonicalSecondaryAddenda enforces MAX_SECONDARY_ADDENDA_BYTES unconditionally", () => {
    const chunkA = "A".repeat(4_096)
    const chunkB = "B".repeat(4_096)
    const chunkC = "C".repeat(4_096)
    const chunkD = "D".repeat(4_096)

    const exactAssignments: RoleAssignment[] = [
      { roleId: "lead", primary: true },
      { roleId: "sec-a", primary: false, addendum: chunkA },
      { roleId: "sec-b", primary: false, addendum: chunkB },
      { roleId: "sec-c", primary: false, addendum: chunkC },
      { roleId: "sec-d", primary: false, addendum: chunkD },
    ]

    const exact = extractCanonicalSecondaryAddenda(exactAssignments)
    expect(exact).toHaveLength(4)

    const overflowAssignments: RoleAssignment[] = [
      { roleId: "lead", primary: true },
      { roleId: "sec-a", primary: false, addendum: chunkA },
      { roleId: "sec-b", primary: false, addendum: chunkB },
      { roleId: "sec-c", primary: false, addendum: chunkC },
      { roleId: "sec-d", primary: false, addendum: chunkD + "!" },
    ]

    expect(() => extractCanonicalSecondaryAddenda(overflowAssignments)).toThrow(
      RoleAddendaBudgetExceededError,
    )
  })
})

describe("RoleTemplate → runtime kind + tool policy per live runtime (plan §10)", () => {
  it("resolves preferredRuntimeKinds and emits opencode tool policy", () => {
    const role: RoleTemplate = {
      ...samplePrimaryRole,
      preferredRuntimeKinds: ["opencode"],
    }

    const compiled = RoleBinder.compile({
      primaryRole: role,
      requestedCapabilities: ["filesystem.read"],
      permissionEnvelope: {
        allowedCapabilities: ["filesystem.read"],
        deniedCapabilities: ["filesystem.write"],
      },
    })

    expect(compiled.runtimeKind).toBe("opencode")
    expect(compiled.toolPolicy.runtimeKind).toBe("opencode")
    if (compiled.toolPolicy.runtimeKind === "opencode") {
      expect(compiled.toolPolicy.tools["read"]).toBeUndefined() // allowed
      expect(compiled.toolPolicy.tools["write"]).toBe(false) // denied
      expect(compiled.toolPolicy.tools["bash"]).toBe(false) // unrequested
    }
  })

  it("resolves preferredRuntimeKinds and emits claude tool policy", () => {
    const role: RoleTemplate = {
      ...samplePrimaryRole,
      preferredRuntimeKinds: ["claude"],
    }

    const compiled = RoleBinder.compile({
      primaryRole: role,
      requestedCapabilities: ["filesystem.read", "filesystem.write"],
      permissionEnvelope: {
        allowedCapabilities: ["filesystem.read"],
        deniedCapabilities: ["filesystem.write"],
      },
    })

    expect(compiled.runtimeKind).toBe("claude")
    expect(compiled.toolPolicy.runtimeKind).toBe("claude")
    expect(compiled.toolPolicy.allowedCapabilities).toEqual(["filesystem.read"])
    expect(compiled.toolPolicy.deniedCapabilities).toContain("filesystem.write")
  })

  it("resolves preferredRuntimeKinds and emits codex tool policy with sandbox mode", () => {
    const readOnlyRole: RoleTemplate = {
      ...samplePrimaryRole,
      preferredRuntimeKinds: ["codex"],
    }

    const readOnlyCompiled = RoleBinder.compile({
      primaryRole: readOnlyRole,
      requestedCapabilities: ["filesystem.read"],
      permissionEnvelope: {
        allowedCapabilities: ["filesystem.read"],
        deniedCapabilities: [],
      },
    })

    expect(readOnlyCompiled.runtimeKind).toBe("codex")
    expect(readOnlyCompiled.toolPolicy.runtimeKind).toBe("codex")
    if (readOnlyCompiled.toolPolicy.runtimeKind === "codex") {
      expect(readOnlyCompiled.toolPolicy.sandbox).toBe("read-only")
    }

    const writeRole: RoleTemplate = {
      ...samplePrimaryRole,
      preferredRuntimeKinds: ["codex"],
    }

    const writeCompiled = RoleBinder.compile({
      primaryRole: writeRole,
      requestedCapabilities: ["filesystem.read", "filesystem.write"],
      permissionEnvelope: {
        allowedCapabilities: ["filesystem.read", "filesystem.write"],
        deniedCapabilities: [],
      },
    })

    if (writeCompiled.toolPolicy.runtimeKind === "codex") {
      expect(writeCompiled.toolPolicy.sandbox).toBe("workspace-write")
    }
  })

  it("emits runtime kind and tool policy from the same role template for all three runtimes", () => {
    const multiKindRole: RoleTemplate = {
      ...samplePrimaryRole,
      preferredRuntimeKinds: ["opencode", "claude", "codex"],
    }

    for (const runtimeKind of ["opencode", "claude", "codex"] as const) {
      const compiled = RoleBinder.compile({
        primaryRole: multiKindRole,
        runtimeKind,
        taskPrompt: "Execute build",
      })

      expect(compiled.runtimeKind).toBe(runtimeKind)
      expect(compiled.toolPolicy.runtimeKind).toBe(runtimeKind)
      expect(compiled.systemPrompt).toContain(multiKindRole.instructions!)
      expect(compiled.taskPrompt).toBe("Execute build")
    }
  })

  it("throws UnresolvableRuntimeKindError when preferences match no live runtime", () => {
    const unsupportedRole: RoleTemplate = {
      ...samplePrimaryRole,
      roleId: "exotic-agent",
      preferredRuntimeKinds: ["unsupported-runtime-x", "future-engine-y"],
    }

    expect(() =>
      resolveRuntimeKind(unsupportedRole),
    ).toThrow(UnresolvableRuntimeKindError)
  })
})

describe("Adapter prompt assembly cutover & regression safety (acceptance §11)", () => {
  function makeSampleLaunchRequest(assignments?: RoleAssignment[]): LaunchAgentRequest {
    const envelope = {
      schemaVersion: 1 as const,
      dispatchId: "dispatch-1",
      attempt: 1,
      projectId: "project-1",
      runId: "run-1",
      taskId: "task-1",
      targetNodeId: "node-1",
      installationId: "install-1",
      runtimeKind: "opencode",
      projectPathId: "path-1",
      prompt: "Inspect the codebase.",
      roleSnapshot: {
        schemaVersion: 1 as const,
        roleId: "implementer",
        templateVersion: 1,
        projectId: "project-1",
        name: "Implementer",
        purpose: "Writes tested application code",
        instructions: samplePrimaryRole.instructions!,
        requiredCapabilities: ["filesystem.read", "filesystem.write"],
        preferredRuntimeKinds: ["opencode"],
        contextSelectionPolicyReference: { namespace: "test", id: "default" },
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "filesystem.write"],
          deniedCapabilities: [],
          approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
        },
        author: { kind: "system" as const, name: "test" },
        createdAt: "2026-10-13T00:00:00.000Z",
      },
      roleSnapshots: [{
        schemaVersion: 1 as const,
        roleId: "implementer",
        templateVersion: 1,
        projectId: "project-1",
        name: "Implementer",
        purpose: "Writes tested application code",
        instructions: samplePrimaryRole.instructions!,
        requiredCapabilities: ["filesystem.read", "filesystem.write"],
        preferredRuntimeKinds: ["opencode"],
        contextSelectionPolicyReference: { namespace: "test", id: "default" },
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "filesystem.write"],
          deniedCapabilities: [],
          approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
        },
        author: { kind: "system" as const, name: "test" },
        createdAt: "2026-10-13T00:00:00.000Z",
      }],
      roleAssignments: assignments ?? [{ roleId: "implementer", primary: true }],
      ruleSnapshots: [],
      contextManifest: {
        references: [],
        manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
      requestedCapabilities: ["filesystem.read"],
      permissionEnvelope: {
        allowedCapabilities: ["filesystem.read"],
        deniedCapabilities: ["network.external"],
        approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
      },
      dependencies: [],
      timeoutSeconds: 30,
      controllerEpoch: 1,
    }
    const operation = runtimeOperationContextSchema.parse({
      schemaVersion: 1,
      commandId: "cmd-1",
      correlationId: "corr-1",
      projectId: "project-1",
      runId: "run-1",
      dispatchId: "dispatch-1",
      nodeId: "node-1",
      controllerNodeId: "node-1",
      controllerEpoch: 1,
      leaseId: "lease-1",
    })
    return launchAgentRequestSchema.parse({
      schemaVersion: 1,
      operation,
      dispatchEnvelope: envelope,
      dispatchEnvelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      approvalId: "appr-1",
    })
  }

  it("OpenCode single-role output is byte-identical to previous adapter inline assembly", () => {
    const request = makeSampleLaunchRequest()
    const compiled = RoleBinder.compileForOpenCode(request)

    // Expected string matching exact legacy opencode-adapter assembly
    const expected = [
      "Role: Implementer",
      samplePrimaryRole.instructions,
      "Approved capability envelope: filesystem.read. Denied: network.external.",
      "This dispatch requests a timeout of 30 seconds.",
    ].join("\n\n")

    expect(compiled.system).toBe(expected)
    expect(compiled.tools).toBeDefined()
    expect(compiled.tools!["bash"]).toBe(false)
  })

  it("Claude single-role output is byte-identical to previous adapter inline assembly", () => {
    const request = makeSampleLaunchRequest()
    const compiled = RoleBinder.compileForClaude(request)

    expect(compiled.systemPrompt).toBe(samplePrimaryRole.instructions!)
  })

  it("Codex single-role output is byte-identical to previous adapter inline assembly", () => {
    const request = makeSampleLaunchRequest()
    const compiled = RoleBinder.compileForCodex(request)

    expect(compiled.prompt).toBe("Inspect the codebase.")
    expect(compiled.toolPolicy.sandbox).toBe("read-only")
  })

  it("multi-role dispatch includes canonical secondary addenda in OpenCode and Claude", () => {
    const multiAssignments: RoleAssignment[] = [
      { roleId: "implementer", primary: true },
      { roleId: "sec-b", primary: false, addendum: "Second addendum B" },
      { roleId: "sec-a", primary: false, addendum: "First addendum A" },
    ]

    const request = makeSampleLaunchRequest(multiAssignments)

    const opencodeCompiled = RoleBinder.compileForOpenCode(request)
    expect(opencodeCompiled.system).toBeDefined()
    expect(opencodeCompiled.system!).toContain("First addendum A")
    expect(opencodeCompiled.system!).toContain("Second addendum B")
    expect(opencodeCompiled.system!.indexOf("First addendum A")).toBeLessThan(
      opencodeCompiled.system!.indexOf("Second addendum B"),
    )

    const claudeCompiled = RoleBinder.compileForClaude(request)
    expect(claudeCompiled.systemPrompt).toContain("First addendum A")
    expect(claudeCompiled.systemPrompt).toContain("Second addendum B")
    expect(claudeCompiled.systemPrompt.indexOf("First addendum A")).toBeLessThan(
      claudeCompiled.systemPrompt.indexOf("Second addendum B"),
    )
  })

  it("RoleBinder instance methods delegate to static compile methods", () => {
    const binder = new RoleBinder()
    const request = makeSampleLaunchRequest()

    expect(binder.compileForOpenCode(request)).toEqual(RoleBinder.compileForOpenCode(request))
    expect(binder.compileForClaude(request)).toEqual(RoleBinder.compileForClaude(request))
    expect(binder.compileForCodex(request)).toEqual(RoleBinder.compileForCodex(request))
  })
})
