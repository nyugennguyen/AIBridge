import { describe, expect, it } from "vitest"
import {
  assertCharterDoesNotRelaxCore,
  computeImmutableCoreDigest,
  IMMUTABLE_CORE_ITEMS,
  type ImmutableCoreItemId,
} from "../../../src/orchestration/policy/immutable-core.js"
import { SAFETY_FLOOR } from "../../../src/orchestration/policy/floor.js"
import type { SafetyFloor } from "../../../src/orchestration/policy/types.js"
import {
  charterProposalSchema,
  charterSchema,
  computeCharterSnapshotDigest,
  type Charter,
  type CharterChangeOp,
  type CharterProposal,
} from "../../../src/orchestration/schemas.js"

function createValidCharter(immutableCoreDigest: string): Charter {
  const template = {
    charterId: "charter-001",
    version: 1,
    purpose: "Ensure safe and coordinated AI agent orchestration across mesh nodes.",
    globalRules: [
      "Never bypass safety floors or credential boundaries",
      "Require operator confirmation before destructive filesystem actions",
    ],
    communicationPolicy: {
      turnTaking: "chair_ordered" as const,
      objectionRequiredBefore: ["deploy", "schema_migration"],
      verbosity: "normal" as const,
      mustStopAndAsk: ["ambiguous prompt", "missing authorization"],
      objectionMustContain: ["rationale", "risk_assessment"],
    },
    escalationPolicy: {
      maxRounds: 5,
      onDeadlock: "human_decides" as const,
      budgetScope: "shared" as const,
    },
    roleCatalog: [
      {
        roleId: "lead",
        version: 1,
        snapshotDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    ],
    immutableCoreDigest,
    snapshotDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    capturedAt: "2026-10-13T12:00:00.000Z",
    author: "human" as const,
  }

  const snapshotDigest = computeCharterSnapshotDigest(template)
  return charterSchema.parse({
    ...template,
    snapshotDigest,
  })
}

function createProposal(charter: Charter, changes: readonly CharterChangeOp[]): CharterProposal {
  return charterProposalSchema.parse({
    charter,
    rationale: "Refining operational roles and communication protocols based on team deliberation.",
    evidenceRefs: ["rt-deliberation-042", "mem-retro-09"],
    changes,
  })
}

describe("Immutable Core Policy Validation", () => {
  const correctCoreDigest = computeImmutableCoreDigest(SAFETY_FLOOR)

  describe("Six core items refusal (Plan §7.3 / §11)", () => {
    const testCases: readonly {
      item: ImmutableCoreItemId
      token: (typeof IMMUTABLE_CORE_ITEMS)[number]["areas"][number]
    }[] = [
      { item: "safety_floor", token: "policy.safety_floor" },
      { item: "input_ownership_fencing", token: "fencing.input_ownership" },
      { item: "security_perimeter", token: "security.allowed_sources" },
      { item: "security_perimeter", token: "security.project_allowlist" },
      { item: "roundtable_advisory_only", token: "roundtable.advisory_only" },
      { item: "budget_ceilings", token: "budgets.ceilings" },
      { item: "terminal_state_authority", token: "kernel.event_store_authority" },
    ]

    for (const { item, token } of testCases) {
      it(`refuses proposal touching core item '${item}' via area '${token}'`, () => {
        const charter = createValidCharter(correctCoreDigest)
        const proposal = createProposal(charter, [
          { area: token, note: `attempting to adjust ${item}` },
        ])

        const result = assertCharterDoesNotRelaxCore(proposal, SAFETY_FLOOR)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error.category).toBe("policy_denied")
          expect(result.error.code).toBe("charter_core_violation")
          expect(result.error.retryable).toBe(false)
          expect(result.error.message).toContain(item)
          expect(result.error.message).toContain(token)
        }
      })
    }
  })

  describe("Position independence of core change ops", () => {
    it("refuses proposal when core op is at the beginning of changes list", () => {
      const charter = createValidCharter(correctCoreDigest)
      const proposal = createProposal(charter, [
        { area: "security.allowed_sources", note: "remove allowed source" },
        { area: "charter.purpose", note: "clarify purpose" },
        { area: "charter.role_catalog", note: "add role" },
      ])

      const result = assertCharterDoesNotRelaxCore(proposal, SAFETY_FLOOR)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe("charter_core_violation")
        expect(result.error.message).toContain("security_perimeter")
      }
    })

    it("refuses proposal when core op is in the middle of changes list", () => {
      const charter = createValidCharter(correctCoreDigest)
      const proposal = createProposal(charter, [
        { area: "charter.global_rules", note: "update rules" },
        { area: "fencing.input_ownership", note: "bypass fencing" },
        { area: "charter.role_catalog", note: "update roles" },
      ])

      const result = assertCharterDoesNotRelaxCore(proposal, SAFETY_FLOOR)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe("charter_core_violation")
        expect(result.error.message).toContain("input_ownership_fencing")
      }
    })

    it("refuses proposal when core op is at the end of changes list", () => {
      const charter = createValidCharter(correctCoreDigest)
      const proposal = createProposal(charter, [
        { area: "charter.purpose", note: "clarify purpose" },
        { area: "charter.communication_policy", note: "tune verbosity" },
        { area: "budgets.ceilings", note: "raise ceiling" },
      ])

      const result = assertCharterDoesNotRelaxCore(proposal, SAFETY_FLOOR)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe("charter_core_violation")
        expect(result.error.message).toContain("budget_ceilings")
      }
    })
  })

  describe("Non-core ops and core stamp validation", () => {
    it("accepts a proposal with only non-core ops and a correct immutableCoreDigest", () => {
      const charter = createValidCharter(correctCoreDigest)
      const proposal = createProposal(charter, [
        { area: "charter.purpose", note: "expand mission statement" },
        { area: "charter.global_rules", note: "add style guideline" },
        { area: "charter.communication_policy", note: "adjust turn-taking" },
        { area: "charter.escalation_policy", note: "increase max rounds" },
        { area: "charter.role_catalog", note: "register qa-auditor role" },
      ])

      const result = assertCharterDoesNotRelaxCore(proposal, SAFETY_FLOOR)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toBeUndefined()
      }
    })

    it("refuses a proposal with non-core ops but a wrong immutableCoreDigest (stamp mismatch)", () => {
      const wrongCoreDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      const charter = createValidCharter(wrongCoreDigest)
      const proposal = createProposal(charter, [
        { area: "charter.purpose", note: "harmless purpose update" },
      ])

      const result = assertCharterDoesNotRelaxCore(proposal, SAFETY_FLOOR)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.category).toBe("policy_denied")
        expect(result.error.code).toBe("charter_core_violation")
        expect(result.error.retryable).toBe(false)
        expect(result.error.message).toContain("stamped against a different core")
      }
    })
  })

  describe("Purity and determinism", () => {
    it("evaluates identical inputs to deeply equal results across multiple runs", () => {
      const charter = createValidCharter(correctCoreDigest)
      const proposal = createProposal(charter, [
        { area: "charter.purpose", note: "refine description" },
      ])

      const firstRun = assertCharterDoesNotRelaxCore(proposal, SAFETY_FLOOR)
      const secondRun = assertCharterDoesNotRelaxCore(proposal, SAFETY_FLOOR)
      expect(firstRun).toEqual(secondRun)

      const badProposal = createProposal(charter, [
        { area: "policy.safety_floor", note: "tamper" },
      ])
      const firstBad = assertCharterDoesNotRelaxCore(badProposal, SAFETY_FLOOR)
      const secondBad = assertCharterDoesNotRelaxCore(badProposal, SAFETY_FLOOR)
      expect(firstBad).toEqual(secondBad)
    })

    it("computes identical digests regardless of input property key ordering", () => {
      const floorA: SafetyFloor = {
        requireApprovalForDispatch: true,
        requireApprovalForDestructiveEffects: true,
        requireApprovalForExternalEffects: true,
        allowDestructiveEffects: false,
        allowExternalEffects: false,
        maximumTimeoutSeconds: 3600,
      }

      // Re-ordered keys in object literal
      const floorB: SafetyFloor = {
        maximumTimeoutSeconds: 3600,
        allowExternalEffects: false,
        allowDestructiveEffects: false,
        requireApprovalForExternalEffects: true,
        requireApprovalForDestructiveEffects: true,
        requireApprovalForDispatch: true,
      }

      const digestA = computeImmutableCoreDigest(floorA)
      const digestB = computeImmutableCoreDigest(floorB)
      expect(digestA).toBe(digestB)
      expect(digestA).toBe(correctCoreDigest)
    })
  })
})
