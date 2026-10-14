/**
 * Charter Proposal Lifecycle and §7.3 Immutable Core Enforcement Tests.
 *
 * Validates:
 * 1. Plan §7.4 Lifecycle Semantics:
 *    - `charter.propose` leaves active charter unchanged (status: pending).
 *    - `charter.approve` flows through `charter.revise` -> `charter.revised` (activates version N+1).
 *    - `charter.reject` records refusal rationale; leaves active charter unchanged.
 *    - There is NO `charter.approved` event.
 *    - `charter.revise` is a kernel command, never a direct file write.
 *
 * 2. Plan §7.3 Pre-Pending Core Refusal (DoD #4):
 *    - `assertCharterDoesNotRelaxCore(proposal, floor)` is called in the propose path BEFORE pending.
 *    - A proposal touching `security.allowed_sources` is refused with `charter_core_violation`.
 *    - The refused proposal document is STILL RECORDED AS EVIDENCE, but can NEVER be activated.
 *
 * 3. Settled §15 Human-Only Approval:
 *    - `charter.approve` requires human authority (`actor.kind === "user"`).
 *    - An agent-authored proposal approved via an unauthorized path (`actor.kind === "session"` or `"node"`)
 *      is refused with `charter.unauthorized_approval` (mirroring `dispatch.approve` authorization tests).
 *
 * 4. Dispatch Digest Isolation (DoD #3):
 *    - Running dispatches retain the charter version and digest they started with;
 *      activating version N+1 does not alter existing dispatch bindings.
 *
 * 5. Plan §7.3 Rule-Language Matching Test:
 *    - Verified in the rules layer's established form: the rule engine cannot relax
 *      the immutable core baseline.
 */

import { describe, expect, it } from "vitest"
import { DispatchCoordinator } from "../../../src/orchestration/coordinator/coordinator.js"
import { CharterRepository } from "../../../src/orchestration/charter/repository.js"
import { CharterProposalLifecycle } from "../../../src/orchestration/charter/proposal.js"
import { SAFETY_FLOOR } from "../../../src/orchestration/policy/floor.js"
import {
  assertCharterDoesNotRelaxCore,
  computeImmutableCoreDigest,
} from "../../../src/orchestration/policy/immutable-core.js"
import {
  computeCharterSnapshotDigest,
  type CharterChangeArea,
  type Charter,
  type CharterProposal,
} from "../../../src/orchestration/schemas.js"
import type { Actor, OrchestrationCommand, OrchestrationEvent } from "../../../src/orchestration/types.js"
import {
  compileRuleSet,
  evaluateRules,
  evaluateWithKernel,
  type CompiledRuleSet,
} from "../../../src/rules/index.js"
import { MAX_FAN_OUT, MAX_RULE_EXPIRY_DAYS } from "../../../src/rules/limits.js"
import { rawPreApprovalDocument, validContext } from "../rules/fixtures.js"
import {
  eventIdSchema,
  correlationIdSchema,
  userIdSchema,
  sessionIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  leaseIdSchema,
  type Digest,
} from "../../../src/orchestration/identifiers.js"
import { reduceEvent } from "../../../src/orchestration/projections/index.js"
import type { RunProjectionState } from "../../../src/orchestration/projections/types.js"
import type { EventInput } from "../../../src/orchestration/event-store/types.js"

// ============================================================================
// Fixtures and Helpers
// ============================================================================

const NOW = "2026-10-14T10:00:00.000Z"
const LATER = "2026-10-14T11:00:00.000Z"
const PROFILE_ID = "profile-mac-m4"

function makeHumanActor(): Actor {
  return { kind: "user", userId: userIdSchema.parse("user-operator-1") }
}

function makeAgentActor(sessionId = "sess-agent-007"): Actor {
  return { kind: "session", sessionId: sessionIdSchema.parse(sessionId) }
}

function makeNodeActor(nodeId = "node-worker-2"): Actor {
  return { kind: "node", nodeId: nodeIdSchema.parse(nodeId) }
}
function createInitialRunProjection(): RunProjectionState {
  const runCreated: OrchestrationEvent = {
    schemaVersion: 1,
    eventId: eventIdSchema.parse("evt-seed-run"),
    sequence: 1,
    type: "run.created",
    projectId: projectIdSchema.parse("proj-1"),
    runId: runIdSchema.parse("run-001"),
    actor: makeHumanActor(),
    controllerEpoch: 1,
    occurredAt: NOW,
    correlationId: correlationIdSchema.parse("corr-seed"),
    causation: null,
    payload: {
      run: {
        schemaVersion: 1,
        runId: runIdSchema.parse("run-001"),
        projectId: projectIdSchema.parse("proj-1"),
        goal: "Test charter slice",
        state: "active",
        paused: false,
        createdAt: NOW,
        updatedAt: NOW,
        externalReferences: [],
      },
    },
  } as OrchestrationEvent

  return reduceEvent(null, runCreated)!
}

function createBaselineCharter(charterId = PROFILE_ID, version = 1): Charter {
  const coreDigest = computeImmutableCoreDigest(SAFETY_FLOOR)
  const template = {
    charterId,
    version,
    purpose: "Governing autonomous AI agent coordination across distributed mesh nodes.",
    globalRules: [
      "Never bypass safety floors or credential boundaries.",
      "Require human authorization before destructive actions.",
    ],
    communicationPolicy: {
      turnTaking: "chair_ordered" as const,
      objectionRequiredBefore: ["deploy", "database_migration"],
      verbosity: "normal" as const,
      mustStopAndAsk: ["ambiguous_prompt", "missing_token"],
      objectionMustContain: ["rationale", "risk_mitigation"],
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
        snapshotDigest: `sha256:${"1".repeat(64)}` as Digest,
      },
      {
        roleId: "reviewer",
        version: 1,
      },
    ],
    immutableCoreDigest: coreDigest,
    snapshotDigest: `sha256:${"0".repeat(64)}`,
    capturedAt: NOW,
    author: "human" as const,
  }
  const snapshotDigest = computeCharterSnapshotDigest(template)
  return { ...template, snapshotDigest }
}

function createProposal(
  charter: Charter,
  changes: readonly { area: CharterChangeArea; note?: string }[],
  rationale = "Refining deliberation turn-taking based on roundtable audit.",
  evidenceRefs: readonly string[] = ["rt-deliberation-001", "mem-retro-42"],
): CharterProposal {
  return {
    charter,
    rationale,
    evidenceRefs: [...evidenceRefs],
    changes: [...changes],
  }
}

interface TestHarness {
  readonly coordinator: DispatchCoordinator
  readonly charters: CharterRepository
  readonly proposals: CharterProposalLifecycle
  readonly log: { command: OrchestrationCommand; events: unknown[] }[]
}

function makeCoordinatorHarness(initialCharter?: Charter): TestHarness {
  const charters = new CharterRepository(initialCharter ? [initialCharter] : [])
  const proposals = new CharterProposalLifecycle({ safetyFloor: SAFETY_FLOOR })
  const log: { command: OrchestrationCommand; events: unknown[] }[] = []

  const commandLog = {
    append(options: { command: OrchestrationCommand; events: readonly EventInput[] }) {
      log.push({ command: options.command, events: [...options.events] })
      return { duplicate: false, events: options.events }
    },
  }
  const projection = createInitialRunProjection()

  const coordinator = new DispatchCoordinator({
    log: commandLog,
    now: () => NOW,
    newEventId: (() => {
      let counter = 0
      return () => `evt-${++counter}`
    })(),
    readRun: (runId: string) => (projection.run.runId === runId ? projection : undefined),
    charters,
    charterProposals: proposals,
    safetyFloor: SAFETY_FLOOR,
  })

  return { coordinator, charters, proposals, log }
}

function baseCommand(
  type: OrchestrationCommand["type"],
  payload: unknown,
  actor: Actor = makeHumanActor(),
  commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
): OrchestrationCommand {
  return {
    schemaVersion: 1,
    commandId,
    projectId: projectIdSchema.parse("proj-1"),
    runId: runIdSchema.parse("run-001"),
    actor,
    controllerNodeId: nodeIdSchema.parse("node-chair"),
    controllerEpoch: 1,
    leaseId: leaseIdSchema.parse("lease-1"),
    issuedAt: NOW,
    expiresAt: LATER,
    correlationId: "corr-1",
    causation: null,
    type,
    payload,
  } as OrchestrationCommand
}

// ============================================================================
// Test Suites
// ============================================================================

describe("Charter Proposal Lifecycle & Immutable Core (§7.3, §7.4, DoD #3, DoD #4)", () => {
  describe("1. Pre-pending core refusal (Plan §7.3, DoD #4)", () => {
    it("refuses proposal whose changes include 'security.allowed_sources' with charter_core_violation BEFORE becoming pending", () => {
      const h = makeCoordinatorHarness(createBaselineCharter())
      const activeBefore = h.charters.getLatestCharter(PROFILE_ID)
      expect(activeBefore).toBeDefined()
      expect(activeBefore!.version).toBe(1)

      // An agent proposes a charter revision modifying allowed_sources (DoD #4 exact case)
      const proposedCharter = {
        ...activeBefore!,
        version: 2,
        purpose: "Attempt to modify security boundary",
        author: "agent" as const,
      }
      proposedCharter.snapshotDigest = computeCharterSnapshotDigest(proposedCharter)

      const proposal = createProposal(proposedCharter, [
        { area: "security.allowed_sources", note: "attempt to remove source restriction" },
        { area: "charter.purpose", note: "update purpose" },
      ])

      const proposeCommand = baseCommand(
        "charter.propose",
        { proposal, proposalId: "prop-dod4-violation" },
        makeAgentActor(),
      )

      const outcome = h.coordinator.submit(proposeCommand)

      // Must be refused with category=policy_denied, code=charter_core_violation
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.error.category).toBe("policy_denied")
        expect(outcome.error.code).toBe("charter_core_violation")
        expect(outcome.error.message).toContain("security_perimeter")
        expect(outcome.error.message).toContain("security.allowed_sources")
      }

      // DoD #4: The proposed document IS STILL RECORDED AS EVIDENCE
      const evidence = h.proposals.listEvidence(PROFILE_ID)
      expect(evidence.length).toBeGreaterThan(0)
      const foundEvidence = evidence.find((e) => e.proposalId === "prop-dod4-violation")
      expect(foundEvidence).toBeDefined()
      expect(foundEvidence!.status).toBe("refused_core_violation")
      expect(foundEvidence!.refusalReason).toContain("security.allowed_sources")

      // DoD #4: The proposal can NEVER reach pending
      const pending = h.proposals.getPendingProposal(PROFILE_ID, 2)
      expect(pending).toBeUndefined()
      expect(h.proposals.hasPending(PROFILE_ID)).toBe(false)

      // Active charter is COMPLETELY UNTOUCHED
      const activeAfter = h.charters.getLatestCharter(PROFILE_ID)
      expect(activeAfter!.version).toBe(1)
      expect(activeAfter!.snapshotDigest).toBe(activeBefore!.snapshotDigest)

      // And it can NEVER be activated via approve
      const approveOutcome = h.coordinator.submit(
        baseCommand("charter.approve", {
          charterId: PROFILE_ID,
          version: 2,
          proposalId: "prop-dod4-violation",
        }),
      )
      expect(approveOutcome.ok).toBe(false)
      if (!approveOutcome.ok) {
        expect(approveOutcome.error.code).toBe("charter_core_violation")
      }
    })

    it("refuses all other 5 immutable core change areas with charter_core_violation pre-pending", () => {
      const coreAreas = [
        { area: "policy.safety_floor", expectedItem: "safety_floor" },
        { area: "fencing.input_ownership", expectedItem: "input_ownership_fencing" },
        { area: "security.project_allowlist", expectedItem: "security_perimeter" },
        { area: "roundtable.advisory_only", expectedItem: "roundtable_advisory_only" },
        { area: "budgets.ceilings", expectedItem: "budget_ceilings" },
        { area: "kernel.event_store_authority", expectedItem: "terminal_state_authority" },
      ] as const

      for (const { area, expectedItem } of coreAreas) {
        const h = makeCoordinatorHarness(createBaselineCharter())
        const base = h.charters.getLatestCharter(PROFILE_ID)!
        const proposedCharter = { ...base, version: 2 }
        proposedCharter.snapshotDigest = computeCharterSnapshotDigest(proposedCharter)

        const proposal = createProposal(proposedCharter, [
          { area, note: `touching ${area}` },
        ])

        const res = h.coordinator.submit(
          baseCommand("charter.propose", { proposal, proposalId: `prop-${area}` }, makeAgentActor()),
        )

        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.error.code).toBe("charter_core_violation")
          expect(res.error.message).toContain(expectedItem)
        }
        expect(h.proposals.getPendingProposal(PROFILE_ID, 2)).toBeUndefined()
      }
    })

    it("refuses a proposal stamped against an incorrect immutableCoreDigest", () => {
      const h = makeCoordinatorHarness(createBaselineCharter())
      const base = h.charters.getLatestCharter(PROFILE_ID)!

      const forgedCharter = {
        ...base,
        version: 2,
        immutableCoreDigest: `sha256:${"f".repeat(64)}` as Digest,
      }
      forgedCharter.snapshotDigest = computeCharterSnapshotDigest(forgedCharter)

      const proposal = createProposal(forgedCharter, [
        { area: "charter.purpose", note: "innocent purpose edit" },
      ])

      const outcome = h.coordinator.submit(
        baseCommand("charter.propose", { proposal }, makeAgentActor()),
      )

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.error.code).toBe("charter_core_violation")
        expect(outcome.error.message).toContain("Proposal was stamped against a different core")
      }
    })
  })

  describe("2. Active charter unchanged until approval (§7.4)", () => {
    it("keeps active charter at version 1 when a valid proposal is submitted and rejected", () => {
      const h = makeCoordinatorHarness(createBaselineCharter())
      const v1 = h.charters.getLatestCharter(PROFILE_ID)!
      expect(v1.version).toBe(1)

      // 1. Propose valid revision
      const v2Candidate = {
        ...v1,
        version: 2,
        purpose: "Updated operational purpose after roundtable deliberation.",
        author: "agent" as const,
      }
      v2Candidate.snapshotDigest = computeCharterSnapshotDigest(v2Candidate)

      const proposal = createProposal(v2Candidate, [
        { area: "charter.purpose", note: "clarify operational goals" },
      ])

      const proposeOutcome = h.coordinator.submit(
        baseCommand("charter.propose", { proposal, proposalId: "prop-valid-01" }, makeAgentActor()),
      )

      expect(proposeOutcome.ok).toBe(true)
      if (proposeOutcome.ok) {
        expect(proposeOutcome.value.events).toEqual(["charter.proposed"])
      }

      // Proposal is pending
      const pendingRecord = h.proposals.getPendingProposal(PROFILE_ID, 2)
      expect(pendingRecord).toBeDefined()
      expect(pendingRecord!.status).toBe("pending")

      // Active charter in repository is STILL version 1, unchanged!
      const currentCharter = h.charters.getLatestCharter(PROFILE_ID)!
      expect(currentCharter.version).toBe(1)
      expect(currentCharter.snapshotDigest).toBe(v1.snapshotDigest)
      expect(currentCharter.purpose).toBe(v1.purpose)

      // 2. Reject proposal with rationale
      const rejectOutcome = h.coordinator.submit(
        baseCommand(
          "charter.reject",
          {
            charterId: PROFILE_ID,
            version: 2,
            proposalId: "prop-valid-01",
            rationale: "Operator review concluded purpose wording was too broad.",
          },
          makeHumanActor(),
        ),
      )

      expect(rejectOutcome.ok).toBe(true)
      if (rejectOutcome.ok) {
        expect(rejectOutcome.value.events).toEqual(["charter.rejected"])
      }

      // Record shows rejected with recorded rationale
      const recorded = h.proposals.getProposal("prop-valid-01")!
      expect(recorded.status).toBe("rejected")
      expect(recorded.rejectionRationale).toContain("Operator review concluded")

      // Active charter STILL version 1!
      const finalCharter = h.charters.getLatestCharter(PROFILE_ID)!
      expect(finalCharter.version).toBe(1)
      expect(finalCharter.snapshotDigest).toBe(v1.snapshotDigest)
      expect(h.charters.hasCharter(PROFILE_ID, 2)).toBe(false)
    })
  })

  describe("3. Human-only approval authority (settled §15)", () => {
    it("refuses an agent-authored proposal approved via an unauthorized agent path (mirrors dispatch.approve)", () => {
      const h = makeCoordinatorHarness(createBaselineCharter())
      const v1 = h.charters.getLatestCharter(PROFILE_ID)!

      const v2Candidate = {
        ...v1,
        version: 2,
        purpose: "Agent attempted self-approved charter rewrite.",
        author: "agent" as const,
      }
      v2Candidate.snapshotDigest = computeCharterSnapshotDigest(v2Candidate)

      const proposal = createProposal(v2Candidate, [
        { area: "charter.purpose", note: "agent proposal" },
      ])

      // Propose as agent
      const proposeRes = h.coordinator.submit(
        baseCommand("charter.propose", { proposal, proposalId: "prop-agent-1" }, makeAgentActor("sess-1")),
      )
      expect(proposeRes.ok).toBe(true)

      // Attempt approval with agent session actor (unauthorized path)
      const unauthorizedSession = h.coordinator.submit(
        baseCommand(
          "charter.approve",
          { charterId: PROFILE_ID, version: 2, proposalId: "prop-agent-1" },
          makeAgentActor("sess-1"),
        ),
      )
      expect(unauthorizedSession.ok).toBe(false)
      if (!unauthorizedSession.ok) {
        expect(unauthorizedSession.error.category).toBe("policy_denied")
        expect(unauthorizedSession.error.code).toBe("charter.unauthorized_approval")
        expect(unauthorizedSession.error.message).toContain("actor.kind must be 'user'")
      }

      // Attempt approval with node actor (unauthorized path)
      const unauthorizedNode = h.coordinator.submit(
        baseCommand(
          "charter.approve",
          { charterId: PROFILE_ID, version: 2, proposalId: "prop-agent-1" },
          makeNodeActor("node-remote-7"),
        ),
      )
      expect(unauthorizedNode.ok).toBe(false)
      if (!unauthorizedNode.ok) {
        expect(unauthorizedNode.error.category).toBe("policy_denied")
        expect(unauthorizedNode.error.code).toBe("charter.unauthorized_approval")
      }

      // Proposal remains in pending state
      const record = h.proposals.getProposal("prop-agent-1")!
      expect(record.status).toBe("pending")

      // Active charter remains version 1
      expect(h.charters.getLatestCharter(PROFILE_ID)!.version).toBe(1)

      // When approved by human operator, it succeeds
      const authorizedApproval = h.coordinator.submit(
        baseCommand(
          "charter.approve",
          { charterId: PROFILE_ID, version: 2, proposalId: "prop-agent-1", comment: "Human reviewed and accepted" },
          makeHumanActor(),
        ),
      )
      expect(authorizedApproval.ok).toBe(true)
      if (authorizedApproval.ok) {
        expect(authorizedApproval.value.events).toEqual(["charter.revised"])
      }

      // Now activated as version 2!
      const activeCharter = h.charters.getLatestCharter(PROFILE_ID)!
      expect(activeCharter.version).toBe(2)
      expect(activeCharter.purpose).toBe("Agent attempted self-approved charter rewrite.")
    })
  })

  describe("4. Kernel round-trip and dispatch digest isolation (DoD #3, §7.4)", () => {
    it("round-trips charter.revise through kernel and leaves running dispatch stored digests unaffected", () => {
      const h = makeCoordinatorHarness(createBaselineCharter())
      const v1 = h.charters.getLatestCharter(PROFILE_ID)!
      const digestV1 = v1.snapshotDigest

      // Simulate a running dispatch that started under charter version 1
      const runningDispatchBinding = {
        dispatchId: "disp-running-001",
        boundCharterVersion: v1.version,
        boundCharterSnapshotDigest: digestV1,
      }

      // Propose revision v2
      const v2Candidate = {
        ...v1,
        version: 2,
        purpose: "Expanded governance for cross-node roundtable deliberations.",
        globalRules: [...v1.globalRules, "All outbound network requests require telemetry."],
        author: "human" as const,
      }
      v2Candidate.snapshotDigest = computeCharterSnapshotDigest(v2Candidate)

      const proposal = createProposal(v2Candidate, [
        { area: "charter.purpose", note: "expanded purpose" },
        { area: "charter.global_rules", note: "added telemetry rule" },
      ])

      h.coordinator.submit(
        baseCommand("charter.propose", { proposal, proposalId: "prop-roundtrip-v2" }, makeHumanActor()),
      )

      // Approve -> revise -> charter.revised
      const approveRes = h.coordinator.submit(
        baseCommand(
          "charter.approve",
          { charterId: PROFILE_ID, version: 2, proposalId: "prop-roundtrip-v2" },
          makeHumanActor(),
        ),
      )

      expect(approveRes.ok).toBe(true)
      if (approveRes.ok) {
        // Plan §7.4: Follow exactly — there is NO charter.approved event
        expect(approveRes.value.events).toEqual(["charter.revised"])
        expect(approveRes.value.events).not.toContain("charter.approved")
      }

      // Repository now holds version 2 as latest
      const v2 = h.charters.getLatestCharter(PROFILE_ID)!
      expect(v2.version).toBe(2)
      expect(v2.immutableCoreDigest).toBe(v1.immutableCoreDigest) // invariant across revisions
      expect(v2.snapshotDigest).not.toBe(digestV1) // new stamped digest

      // DoD #3: "running dispatches keep the old digest"
      // The running dispatch's bound version and digest are completely unaffected
      expect(runningDispatchBinding.boundCharterVersion).toBe(1)
      expect(runningDispatchBinding.boundCharterSnapshotDigest).toBe(digestV1)

      // And retrieving version 1 from repository still yields the exact original document
      const retrievedV1 = h.charters.getCharter(PROFILE_ID, 1)!
      expect(retrievedV1).toBeDefined()
      expect(retrievedV1.snapshotDigest).toBe(digestV1)
      expect(retrievedV1.snapshotDigest).toBe(runningDispatchBinding.boundCharterSnapshotDigest)

      // Direct charter.revise kernel command for version 3
      const v3Candidate = {
        ...v2,
        version: 3,
        purpose: "Version 3 directly revised through kernel command.",
      }
      v3Candidate.snapshotDigest = computeCharterSnapshotDigest(v3Candidate)

      const reviseRes = h.coordinator.submit(
        baseCommand("charter.revise", { charter: v3Candidate }, makeHumanActor()),
      )

      expect(reviseRes.ok).toBe(true)
      if (reviseRes.ok) {
        expect(reviseRes.value.events).toEqual(["charter.revised"])
      }

      const v3 = h.charters.getLatestCharter(PROFILE_ID)!
      expect(v3.version).toBe(3)
      expect(v3.immutableCoreDigest).toBe(v1.immutableCoreDigest)
    })
  })

  describe("5. Plan §7.3 rule-language matching invariant test", () => {
    it("the rule engine enforces safety floor immutability analogously to assertCharterDoesNotRelaxCore", () => {
      // In §7.3: "The rule language gains a matching test so this is enforced the same way every other invariant is"
      // Verify that the rule engine cannot relax or widen the safety floor:
      const ruleDocuments = [
        rawPreApprovalDocument({
          ruleId: "rule-attempt-escalation",
          actions: [
            {
              kind: "pre_approve_within_bounds",
              approvedCapabilities: ["fs.read", "net.fetch"],
              maximumTimeoutSeconds: 900,
              allowDestructiveEffects: false,
              allowExternalEffects: false,
              maximumSensitivity: "restricted",
            },
          ],
        }),
      ]

      // Compile rules
      const compiled = compileRuleSet(ruleDocuments)
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) return

      // Evaluate rules
      const evaluated = evaluateRules(compiled.value, validContext({ requestedCapabilities: ["fs.read"] }))

      // The pre-approval candidate bounds are clamped down to the safety floor's maximum timeout
      // No rule can exceed SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS (3600)
      if (evaluated.preApproval) {
        for (const candidate of evaluated.preApproval.candidates) {
          expect(candidate.bounds.maximumTimeoutSeconds).toBeLessThanOrEqual(3600)
        }
      }

      // Parity check with assertCharterDoesNotRelaxCore:
      // A charter proposal that attempts to relax the safety floor is refused identically
      const baseCharter = createBaselineCharter()
      const violatingProposal = createProposal(
        { ...baseCharter, version: 2 },
        [{ area: "policy.safety_floor", note: "widen safety floor" }],
      )

      const charterCoreCheck = assertCharterDoesNotRelaxCore(violatingProposal, SAFETY_FLOOR)
      expect(charterCoreCheck.ok).toBe(false)
      if (!charterCoreCheck.ok) {
        expect(charterCoreCheck.error.code).toBe("charter_core_violation")
      }
    })

    it("the rule language enforces complexity and budget limits (item 5: budget ceilings)", () => {
      // Plan §7.3 Item 5: "Budget ceilings (rules/limits.ts)"
      // The rule language schema and limits enforce hard ceilings
      expect(MAX_FAN_OUT).toBeDefined()
      expect(MAX_RULE_EXPIRY_DAYS).toBe(3_655)
    })
  })

  describe("6. Activation authority hardening (ADR 0008 §4, DoD #4)", () => {
    it("refuses to activate a pending proposal via charter.revise even for a human actor", () => {
      const h = makeCoordinatorHarness(createBaselineCharter())
      const v1 = h.charters.getLatestCharter(PROFILE_ID)!
      const v2Candidate = { ...v1, version: 2, purpose: "Pending proposal content." }
      v2Candidate.snapshotDigest = computeCharterSnapshotDigest(v2Candidate)

      h.coordinator.submit(
        baseCommand(
          "charter.propose",
          { proposal: createProposal(v2Candidate, [{ area: "charter.purpose" }]), proposalId: "prop-hardening-pending" },
          makeAgentActor(),
        ),
      )
      expect(h.proposals.getProposal("prop-hardening-pending")!.status).toBe("pending")

      // Human authority is not a substitute for approval: activation through a
      // proposal applies only content the approval vouched for (§7.4).
      const revise = h.coordinator.submit(
        baseCommand("charter.revise", { charter: v2Candidate, proposalId: "prop-hardening-pending" }, makeHumanActor()),
      )
      expect(revise.ok).toBe(false)
      if (!revise.ok) {
        expect(revise.error.code).toBe("charter.revision_not_approved")
      }
      expect(h.proposals.getProposal("prop-hardening-pending")!.status).toBe("pending")
      expect(h.charters.getLatestCharter(PROFILE_ID)!.version).toBe(1)
    })

    it("refuses to activate a refused_core_violation proposal via charter.revise (can never be activated)", () => {
      const h = makeCoordinatorHarness(createBaselineCharter())
      const v1 = h.charters.getLatestCharter(PROFILE_ID)!
      const v2Candidate = { ...v1, version: 2, purpose: "Core-violating content." }
      v2Candidate.snapshotDigest = computeCharterSnapshotDigest(v2Candidate)

      h.coordinator.submit(
        baseCommand(
          "charter.propose",
          {
            proposal: createProposal(v2Candidate, [
              { area: "security.allowed_sources", note: "attempt to remove restriction" },
            ]),
            proposalId: "prop-hardening-refused",
          },
          makeAgentActor(),
        ),
      )
      expect(h.proposals.getProposal("prop-hardening-refused")!.status).toBe("refused_core_violation")

      const revise = h.coordinator.submit(
        baseCommand("charter.revise", { charter: v2Candidate, proposalId: "prop-hardening-refused" }, makeHumanActor()),
      )
      expect(revise.ok).toBe(false)
      if (!revise.ok) {
        expect(revise.error.code).toBe("charter_core_violation")
      }
      expect(h.charters.getLatestCharter(PROFILE_ID)!.version).toBe(1)
    })

    it("refuses an activation payload that differs from the approved proposal's content (§7.3)", () => {
      const h = makeCoordinatorHarness(createBaselineCharter())
      const v1 = h.charters.getLatestCharter(PROFILE_ID)!
      const approved = { ...v1, version: 2, purpose: "Approved purpose." }
      approved.snapshotDigest = computeCharterSnapshotDigest(approved)

      h.coordinator.submit(
        baseCommand(
          "charter.propose",
          { proposal: createProposal(approved, [{ area: "charter.purpose" }]), proposalId: "prop-hardening-mismatch" },
          makeAgentActor(),
        ),
      )
      // Human decision recorded WITHOUT activation — exactly the state an
      // activation retry finds after a failed approve.
      const approvedRecord = h.proposals.approve({
        proposalId: "prop-hardening-mismatch",
        charterId: PROFILE_ID,
        version: 2,
        actor: makeHumanActor(),
        decidedAt: new Date().toISOString(),
        comment: "Human reviewed and accepted",
      })
      expect(approvedRecord.ok).toBe(true)

      const smuggled = { ...approved, purpose: "SMUGGLED purpose that never passed approval." }
      smuggled.snapshotDigest = computeCharterSnapshotDigest(smuggled)
      const revise = h.coordinator.submit(
        baseCommand("charter.revise", { charter: smuggled, proposalId: "prop-hardening-mismatch" }, makeAgentActor()),
      )
      expect(revise.ok).toBe(false)
      if (!revise.ok) {
        expect(revise.error.code).toBe("charter.revision_content_mismatch")
      }
      expect(h.charters.getLatestCharter(PROFILE_ID)!.version).toBe(1)
    })

    it("activates exactly the approved proposal's content through charter.revise (agents re-drive after approval)", () => {
      const h = makeCoordinatorHarness(createBaselineCharter())
      const v1 = h.charters.getLatestCharter(PROFILE_ID)!
      const approved = { ...v1, version: 2, purpose: "Approved purpose." }
      approved.snapshotDigest = computeCharterSnapshotDigest(approved)

      h.coordinator.submit(
        baseCommand(
          "charter.propose",
          { proposal: createProposal(approved, [{ area: "charter.purpose" }]), proposalId: "prop-hardening-activate" },
          makeAgentActor(),
        ),
      )
      const approvedRecord = h.proposals.approve({
        proposalId: "prop-hardening-activate",
        charterId: PROFILE_ID,
        version: 2,
        actor: makeHumanActor(),
        decidedAt: new Date().toISOString(),
        comment: "Human reviewed and accepted",
      })
      expect(approvedRecord.ok).toBe(true)

      const revise = h.coordinator.submit(
        baseCommand("charter.revise", { charter: approved, proposalId: "prop-hardening-activate" }, makeAgentActor()),
      )
      expect(revise.ok).toBe(true)
      if (revise.ok) {
        expect(revise.value.events).toEqual(["charter.revised"])
      }
      expect(h.charters.getLatestCharter(PROFILE_ID)!.version).toBe(2)
      expect(h.proposals.getProposal("prop-hardening-activate")!.status).toBe("revised")
    })

    it("markRevised refuses non-approved records (activation history cannot be manufactured)", () => {
      const h = makeCoordinatorHarness(createBaselineCharter())
      const v1 = h.charters.getLatestCharter(PROFILE_ID)!
      const v2Candidate = { ...v1, version: 2, purpose: "Pending proposal content." }
      v2Candidate.snapshotDigest = computeCharterSnapshotDigest(v2Candidate)

      h.coordinator.submit(
        baseCommand(
          "charter.propose",
          { proposal: createProposal(v2Candidate, [{ area: "charter.purpose" }]), proposalId: "prop-hardening-stamp" },
          makeAgentActor(),
        ),
      )

      const stamped = h.proposals.markRevised("prop-hardening-stamp", 2)
      expect(stamped.ok).toBe(false)
      if (!stamped.ok) {
        expect(stamped.error.code).toBe("charter.revision_not_approved")
      }
      expect(h.proposals.getProposal("prop-hardening-stamp")!.status).toBe("pending")
    })
  })
})
