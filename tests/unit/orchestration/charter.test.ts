import { describe, expect, it } from "vitest"
import {
  CHARTER_CHANGE_AREAS,
  CHARTER_CORE_CHANGE_AREAS,
  charterAuthorSchema,
  charterChangeAreaSchema,
  charterChangeOpSchema,
  charterProposalSchema,
  charterRoleRefSchema,
  charterSchema,
  communicationPolicySchema,
  computeCharterSnapshotDigest,
  discussionModeSchema,
  escalationPolicySchema,
  postKindSchema,
  postSchema,
  roundtableMemberSchema,
  roundtableOutcomeSchema,
  roundtableSchema,
  verifyCharterSnapshotDigest,
} from "../../../src/orchestration/schemas.js"
import type {
  Charter,
  CharterProposal,
  Post,
  Roundtable,
  RoundtableOutcome,
} from "../../../src/orchestration/charter/types.js"

function createValidCharterTemplate() {
  return {
    charterId: "charter-v1",
    version: 1 as const,
    purpose: "Coordinate autonomous software engineering workflows safely",
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
        snapshotDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const,
      },
      {
        roleId: "reviewer",
        version: 1,
      },
    ],
    immutableCoreDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const,
    snapshotDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const,
    capturedAt: "2026-10-13T12:00:00.000Z",
    author: "human" as const,
  }
}

function createGenuineCharter(): Charter {
  const template = createValidCharterTemplate()
  const genuineDigest = computeCharterSnapshotDigest(template)
  return charterSchema.parse({
    ...template,
    snapshotDigest: genuineDigest,
  })
}

function createValidRoundtable(): Roundtable {
  return roundtableSchema.parse({
    id: "rt-001",
    runId: "run-001",
    taskId: "task-001",
    subject: "Architecture review for session prompting",
    mode: "sequential",
    chairNodeId: "node-chair-1",
    members: [
      { nodeId: "node-chair-1", roleId: "chair" },
      { nodeId: "node-worker-2", roleId: "implementer" },
    ],
    state: "open",
  })
}

function createValidPost(): Post {
  return postSchema.parse({
    postId: "post-001",
    discussionId: "rt-001",
    seq: 1,
    authorNodeId: "node-worker-2",
    authorRoleId: "implementer",
    kind: "proposal",
    replyTo: "post-000",
    body: "## Proposal\nWe should stream events through the SSE gateway.",
    createdAt: "2026-10-13T12:01:00.000Z",
  })
}

function createValidRoundtableOutcome(): RoundtableOutcome {
  return roundtableOutcomeSchema.parse({
    summary: "Roundtable concluded with consensus on event relay.",
    recommendation: "Proceed with dispatch using sequential mode.",
    addressedObjections: ["post-002"],
    unresolvedObjections: [],
  })
}

describe("Charter and Roundtable Schemas (Phase 0)", () => {
  describe("Charter Schema", () => {
    it("parses a valid charter document", () => {
      const genuine = createGenuineCharter()
      expect(genuine.charterId).toBe("charter-v1")
      expect(genuine.version).toBe(1)
      expect(genuine.author).toBe("human")
      expect(genuine.globalRules).toHaveLength(2)
      expect(genuine.roleCatalog).toHaveLength(2)
    })

    it("supports agent author", () => {
      const template = createValidCharterTemplate()
      const agentCharter = charterSchema.parse({ ...template, author: "agent" })
      expect(agentCharter.author).toBe("agent")
    })

    it("refuses unknown keys on Charter (strict parse)", () => {
      const template = createValidCharterTemplate()
      expect(() =>
        charterSchema.parse({
          ...template,
          unexpectedExtraKey: "not_allowed",
        }),
      ).toThrow()
    })

    it("treats charter version as a revision counter and refuses structurally invalid versions at parse", () => {
      const template = createValidCharterTemplate()
      // Revisions 2, 3, 99 are first-class: `charter.revise` bumps the counter (plan §7.4).
      for (const version of [1, 2, 3, 99]) {
        expect(() => charterSchema.parse({ ...template, version })).not.toThrow()
      }
      expect(() => charterSchema.parse({ ...template, version: 0 })).toThrow()
      expect(() => charterSchema.parse({ ...template, version: -1 })).toThrow()
      expect(() => charterSchema.parse({ ...template, version: 1.5 })).toThrow()
      expect(() => charterSchema.parse({ ...template, version: Number.MAX_SAFE_INTEGER + 2 })).toThrow()
    })

    it("refuses unknown author discriminator", () => {
      const template = createValidCharterTemplate()
      expect(() => charterSchema.parse({ ...template, author: "robot" })).toThrow()
    })

    it("refuses bounded limits violations on globalRules", () => {
      const template = createValidCharterTemplate()
      const tooManyRules = Array.from({ length: 129 }, (_, i) => `Rule number ${i}`)
      expect(() => charterSchema.parse({ ...template, globalRules: tooManyRules })).toThrow()
    })
  })

  describe("CommunicationPolicy and EscalationPolicy Schemas", () => {
    it("parses valid communication policy", () => {
      const policy = communicationPolicySchema.parse({
        turnTaking: "free_for_all",
        objectionRequiredBefore: ["schema_migration"],
        verbosity: "terse",
        mustStopAndAsk: ["ambiguous prompt"],
        objectionMustContain: ["rationale"],
      })
      expect(policy.turnTaking).toBe("free_for_all")
      expect(policy.verbosity).toBe("terse")
    })

    it("refuses unknown keys on CommunicationPolicy (strict parse)", () => {
      expect(() =>
        communicationPolicySchema.parse({
          turnTaking: "chair_ordered",
          objectionRequiredBefore: [],
          verbosity: "normal",
          mustStopAndAsk: [],
          objectionMustContain: [],
          extraField: true,
        }),
      ).toThrow()
    })

    it("refuses invalid turnTaking or verbosity enums", () => {
      const invalidTurnTaking: Record<string, unknown> = {
        turnTaking: "anarchy",
        objectionRequiredBefore: [],
        verbosity: "normal",
        mustStopAndAsk: [],
        objectionMustContain: [],
      }
      expect(() => communicationPolicySchema.parse(invalidTurnTaking)).toThrow()

      const invalidVerbosity: Record<string, unknown> = {
        turnTaking: "chair_ordered",
        objectionRequiredBefore: [],
        verbosity: "verbose",
        mustStopAndAsk: [],
        objectionMustContain: [],
      }
      expect(() => communicationPolicySchema.parse(invalidVerbosity)).toThrow()
    })

    it("parses valid escalation policy", () => {
      const policy = escalationPolicySchema.parse({
        maxRounds: 10,
        onDeadlock: "fail_run",
        budgetScope: "per_member",
      })
      expect(policy.maxRounds).toBe(10)
      expect(policy.onDeadlock).toBe("fail_run")
      expect(policy.budgetScope).toBe("per_member")
    })

    it("refuses unknown keys on EscalationPolicy (strict parse)", () => {
      expect(() =>
        escalationPolicySchema.parse({
          maxRounds: 3,
          onDeadlock: "chair_decides",
          budgetScope: "shared",
          unsupportedKey: 42,
        }),
      ).toThrow()
    })

    it("refuses invalid onDeadlock or budgetScope enums", () => {
      const invalidDeadlock: Record<string, unknown> = {
        maxRounds: 3,
        onDeadlock: "random_choice",
        budgetScope: "shared",
      }
      expect(() => escalationPolicySchema.parse(invalidDeadlock)).toThrow()

      const invalidScope: Record<string, unknown> = {
        maxRounds: 3,
        onDeadlock: "chair_decides",
        budgetScope: "infinite",
      }
      expect(() => escalationPolicySchema.parse(invalidScope)).toThrow()
    })
  })

  describe("Roundtable, Post, RoundtableMember, and RoundtableOutcome Schemas", () => {
    it("parses valid roundtable session aggregate", () => {
      const rt = createValidRoundtable()
      expect(rt.id).toBe("rt-001")
      expect(rt.mode).toBe("sequential")
      expect(rt.members).toHaveLength(2)
      expect(rt.state).toBe("open")
    })

    it("refuses unknown keys on Roundtable (strict parse)", () => {
      const valid = createValidRoundtable()
      expect(() =>
        roundtableSchema.parse({
          ...valid,
          extraneousState: "running",
        }),
      ).toThrow()
    })

    it("parses valid roundtable member shape and refuses speculative fields", () => {
      const member = roundtableMemberSchema.parse({
        nodeId: "node-1",
        roleId: "reviewer",
      })
      expect(member.nodeId).toBe("node-1")
      expect(member.roleId).toBe("reviewer")

      // Minimal shape: extra speculative fields (status, joinedAt, permissions) must be refused
      expect(() =>
        roundtableMemberSchema.parse({
          nodeId: "node-1",
          roleId: "reviewer",
          status: "ready",
        }),
      ).toThrow()

      expect(() =>
        roundtableMemberSchema.parse({
          nodeId: "node-1",
          roleId: "reviewer",
          joinedAt: "2026-10-13T12:00:00.000Z",
        }),
      ).toThrow()
    })

    it("allows 'human' as authorRoleId on Post and member roleId", () => {
      const post = postSchema.parse({
        postId: "post-human-1",
        discussionId: "rt-001",
        seq: 0,
        authorNodeId: "node-chair-1",
        authorRoleId: "human",
        kind: "note",
        body: "Operator joined the discussion.",
        createdAt: "2026-10-13T12:00:00.000Z",
      })
      expect(post.authorRoleId).toBe("human")

      const member = roundtableMemberSchema.parse({
        nodeId: "node-chair-1",
        roleId: "human",
      })
      expect(member.roleId).toBe("human")
    })

    it("parses all valid PostKind enum values", () => {
      const kinds = ["proposal", "objection", "question", "answer", "note"] as const
      for (const kind of kinds) {
        expect(postKindSchema.parse(kind)).toBe(kind)
      }
    })

    it("refuses invalid PostKind enum values", () => {
      const invalidKinds = ["rant", "comment", "argument", "reply", "vote"]
      for (const kind of invalidKinds) {
        expect(() => postKindSchema.parse(kind)).toThrow()
        expect(() =>
          postSchema.parse({
            postId: "post-1",
            discussionId: "rt-1",
            seq: 1,
            authorNodeId: "node-1",
            authorRoleId: "reviewer",
            kind,
            body: "invalid kind",
            createdAt: "2026-10-13T12:00:00.000Z",
          }),
        ).toThrow()
      }
    })

    it("parses all valid DiscussionMode enum values", () => {
      const modes = ["sequential", "parallel", "until_objections_resolved"] as const
      for (const mode of modes) {
        expect(discussionModeSchema.parse(mode)).toBe(mode)
      }
    })

    it("refuses invalid DiscussionMode enum values", () => {
      const invalidModes = ["chaos", "free_form", "unlimited", "random"]
      for (const mode of invalidModes) {
        expect(() => discussionModeSchema.parse(mode)).toThrow()
        expect(() =>
          roundtableSchema.parse({
            id: "rt-1",
            runId: "run-1",
            subject: "test",
            mode,
            chairNodeId: "node-1",
            members: [],
            state: "open",
          }),
        ).toThrow()
      }
    })

    it("refuses unknown keys on Post (strict parse)", () => {
      const valid = createValidPost()
      expect(() =>
        postSchema.parse({
          ...valid,
          reactions: ["thumbs_up"],
        }),
      ).toThrow()
    })

    it("parses RoundtableOutcome and refuses unknown keys (strict parse, advisory only)", () => {
      const outcome = createValidRoundtableOutcome()
      expect(outcome.summary).toContain("Roundtable concluded")
      expect(outcome.addressedObjections).toEqual(["post-002"])

      // Strict parse: unknown keys (e.g. attempting to encode a trigger command) are rejected
      expect(() =>
        roundtableOutcomeSchema.parse({
          ...outcome,
          triggerCommand: "dispatch.execute",
        }),
      ).toThrow()
    })
  })

  describe("CharterProposal Schema", () => {
    it("parses a valid charter proposal referencing charter, rationale, evidenceRefs, and changes", () => {
      const genuine = createGenuineCharter()
      const proposal: CharterProposal = charterProposalSchema.parse({
        charter: genuine,
        rationale: "Update communication policy to require objection before db migrations",
        evidenceRefs: ["rt-001", "mem-audit-42"],
        changes: [
          { area: "charter.communication_policy", note: "Add objectionRequiredBefore entry" },
        ],
      })

      expect(proposal.charter.charterId).toBe("charter-v1")
      expect(proposal.rationale).toContain("Update communication policy")
      expect(proposal.evidenceRefs).toEqual(["rt-001", "mem-audit-42"])
      expect(proposal.changes).toHaveLength(1)
      expect(proposal.changes[0].area).toBe("charter.communication_policy")
    })

    it("parses a proposal with mixed core and non-core change operations", () => {
      const genuine = createGenuineCharter()
      const proposal = charterProposalSchema.parse({
        charter: genuine,
        rationale: "Broad proposal touching both governance rules and security boundaries",
        evidenceRefs: ["rt-001"],
        changes: [
          { area: "charter.global_rules", note: "Add rule against force pushes" },
          { area: "security.allowed_sources", note: "Propose new source node" },
          { area: "policy.safety_floor", note: "Tighten floor requirement" },
        ],
      })

      expect(proposal.changes).toHaveLength(3)
      expect(proposal.changes.map((c) => c.area)).toEqual([
        "charter.global_rules",
        "security.allowed_sources",
        "policy.safety_floor",
      ])
    })

    it("refuses an unknown change area token (strict enum)", () => {
      expect(() => charterChangeAreaSchema.parse("unsupported.area")).toThrow()
      expect(() => charterChangeAreaSchema.parse("charter.unknown_section")).toThrow()

      const genuine = createGenuineCharter()
      const invalidOpProposal: Record<string, unknown> = {
        charter: genuine,
        rationale: "Attempting to touch unknown area",
        evidenceRefs: [],
        changes: [{ area: "unknown.area_token" }],
      }
      expect(() => charterProposalSchema.parse(invalidOpProposal)).toThrow()
    })

    it("refuses a proposal without changes", () => {
      const genuine = createGenuineCharter()
      const missingChanges: Record<string, unknown> = {
        charter: genuine,
        rationale: "Proposal missing changes array",
        evidenceRefs: [],
      }
      expect(() => charterProposalSchema.parse(missingChanges)).toThrow()
    })

    it("refuses unknown keys on CharterProposal (strict parse)", () => {
      const genuine = createGenuineCharter()
      expect(() =>
        charterProposalSchema.parse({
          charter: genuine,
          rationale: "some rationale",
          evidenceRefs: [],
          changes: [{ area: "charter.purpose" }],
          autoApprove: true,
        }),
      ).toThrow()
    })

    it("refuses proposal if inner charter has a structurally invalid version", () => {
      const template = createValidCharterTemplate()
      expect(() =>
        charterProposalSchema.parse({
          charter: { ...template, version: 0 },
          rationale: "invalid version proposal",
          evidenceRefs: [],
          changes: [{ area: "charter.purpose" }],
        }),
      ).toThrow()
    })

    it("exports frozen core and total change areas tables", () => {
      expect(CHARTER_CORE_CHANGE_AREAS).toContain("policy.safety_floor")
      expect(CHARTER_CORE_CHANGE_AREAS).toContain("security.allowed_sources")
      expect(CHARTER_CORE_CHANGE_AREAS).toHaveLength(7)
      expect(CHARTER_CHANGE_AREAS).toHaveLength(12)
    })
  })

  describe("Canonical JSON Snapshot Digest Computation and Verification", () => {
    it("computes byte-identical digests across multiple runs", () => {
      const template = createValidCharterTemplate()
      const digest1 = computeCharterSnapshotDigest(template)
      const digest2 = computeCharterSnapshotDigest(template)
      const digest3 = computeCharterSnapshotDigest(template)

      expect(digest1).toBe(digest2)
      expect(digest2).toBe(digest3)
      expect(digest1).toMatch(/^sha256:[0-9a-f]{64}$/)
    })

    it("computes byte-identical digests across arbitrary object key ordering", () => {
      const template = createValidCharterTemplate()
      const digestOriginal = computeCharterSnapshotDigest(template)

      // Construct identical data with reversed and scrambled key orders at all levels
      const scrambledCharter = {
        author: template.author,
        capturedAt: template.capturedAt,
        version: template.version,
        roleCatalog: [
          {
            snapshotDigest: template.roleCatalog[0].snapshotDigest,
            version: template.roleCatalog[0].version,
            roleId: template.roleCatalog[0].roleId,
          },
          {
            version: template.roleCatalog[1].version,
            roleId: template.roleCatalog[1].roleId,
          },
        ],
        immutableCoreDigest: template.immutableCoreDigest,
        purpose: template.purpose,
        globalRules: [...template.globalRules],
        escalationPolicy: {
          budgetScope: template.escalationPolicy.budgetScope,
          onDeadlock: template.escalationPolicy.onDeadlock,
          maxRounds: template.escalationPolicy.maxRounds,
        },
        communicationPolicy: {
          objectionMustContain: [...template.communicationPolicy.objectionMustContain],
          mustStopAndAsk: [...template.communicationPolicy.mustStopAndAsk],
          verbosity: template.communicationPolicy.verbosity,
          objectionRequiredBefore: [...template.communicationPolicy.objectionRequiredBefore],
          turnTaking: template.communicationPolicy.turnTaking,
        },
        charterId: template.charterId,
      }

      const digestScrambled = computeCharterSnapshotDigest(scrambledCharter)
      expect(digestScrambled).toBe(digestOriginal)
    })

    it("excludes only its own snapshotDigest from canonical payload", () => {
      const template = createValidCharterTemplate()
      const baseDigest = computeCharterSnapshotDigest(template)

      const withAlteredSnapshotDigest = {
        ...template,
        snapshotDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as const,
      }
      expect(computeCharterSnapshotDigest(withAlteredSnapshotDigest)).toBe(baseDigest)

      const withoutSnapshotDigest = {
        author: template.author,
        capturedAt: template.capturedAt,
        charterId: template.charterId,
        communicationPolicy: template.communicationPolicy,
        escalationPolicy: template.escalationPolicy,
        globalRules: template.globalRules,
        immutableCoreDigest: template.immutableCoreDigest,
        purpose: template.purpose,
        roleCatalog: template.roleCatalog,
        version: template.version,
      }
      expect(computeCharterSnapshotDigest(withoutSnapshotDigest)).toBe(baseDigest)
    })

    it("changing immutableCoreDigest yields a different snapshotDigest than original document", () => {
      const genuine = createGenuineCharter()
      const originalSnapshotDigest = genuine.snapshotDigest

      const tamperedCore = {
        ...genuine,
        immutableCoreDigest: "sha256:9999999999999999999999999999999999999999999999999999999999999999" as const,
      }
      const newSnapshotDigest = computeCharterSnapshotDigest(tamperedCore)

      expect(newSnapshotDigest).not.toBe(originalSnapshotDigest)
      expect(verifyCharterSnapshotDigest(tamperedCore)).toBe(false)
      expect(verifyCharterSnapshotDigest({ ...tamperedCore, snapshotDigest: newSnapshotDigest })).toBe(true)
    })

    it("changing any governed field changes the computed digest", () => {
      const template = createValidCharterTemplate()
      const baseDigest = computeCharterSnapshotDigest(template)

      // 1. charterId
      expect(computeCharterSnapshotDigest({ ...template, charterId: "charter-v2" })).not.toBe(baseDigest)

      // 2. purpose
      expect(computeCharterSnapshotDigest({ ...template, purpose: "Different purpose statement" })).not.toBe(baseDigest)

      // 3. globalRules (add rule)
      expect(
        computeCharterSnapshotDigest({ ...template, globalRules: [...template.globalRules, "New extra rule"] }),
      ).not.toBe(baseDigest)

      // 4. globalRules (modify rule content)
      expect(
        computeCharterSnapshotDigest({
          ...template,
          globalRules: ["Modified rule", template.globalRules[1]],
        }),
      ).not.toBe(baseDigest)

      // 5. communicationPolicy.turnTaking
      expect(
        computeCharterSnapshotDigest({
          ...template,
          communicationPolicy: { ...template.communicationPolicy, turnTaking: "free_for_all" },
        }),
      ).not.toBe(baseDigest)

      // 6. communicationPolicy.verbosity
      expect(
        computeCharterSnapshotDigest({
          ...template,
          communicationPolicy: { ...template.communicationPolicy, verbosity: "terse" },
        }),
      ).not.toBe(baseDigest)

      // 7. communicationPolicy.mustStopAndAsk
      expect(
        computeCharterSnapshotDigest({
          ...template,
          communicationPolicy: { ...template.communicationPolicy, mustStopAndAsk: ["completely new requirement"] },
        }),
      ).not.toBe(baseDigest)

      // 8. escalationPolicy.maxRounds
      expect(
        computeCharterSnapshotDigest({
          ...template,
          escalationPolicy: { ...template.escalationPolicy, maxRounds: 99 },
        }),
      ).not.toBe(baseDigest)

      // 9. escalationPolicy.onDeadlock
      expect(
        computeCharterSnapshotDigest({
          ...template,
          escalationPolicy: { ...template.escalationPolicy, onDeadlock: "fail_run" },
        }),
      ).not.toBe(baseDigest)

      // 10. roleCatalog
      expect(
        computeCharterSnapshotDigest({
          ...template,
          roleCatalog: [{ roleId: "lead", version: 2 }],
        }),
      ).not.toBe(baseDigest)

      // 11. capturedAt
      expect(
        computeCharterSnapshotDigest({ ...template, capturedAt: "2026-10-13T12:00:01.000Z" }),
      ).not.toBe(baseDigest)

      // 12. author
      expect(
        computeCharterSnapshotDigest({ ...template, author: "agent" }),
      ).not.toBe(baseDigest)

      // 13. immutableCoreDigest
      expect(
        computeCharterSnapshotDigest({
          ...template,
          immutableCoreDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        }),
      ).not.toBe(baseDigest)
    })

    it("verifies genuine snapshot digest successfully", () => {
      const genuine = createGenuineCharter()
      expect(verifyCharterSnapshotDigest(genuine)).toBe(true)
    })

    it("fails verification if snapshot digest does not match content", () => {
      const genuine = createGenuineCharter()
      const tamperedDigest = {
        ...genuine,
        snapshotDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const,
      }
      expect(verifyCharterSnapshotDigest(tamperedDigest)).toBe(false)
    })

    it("fails verification if governed content is tampered with after signing", () => {
      const genuine = createGenuineCharter()
      const tamperedRules = {
        ...genuine,
        globalRules: ["Bypass all security checks"],
      }
      expect(verifyCharterSnapshotDigest(tamperedRules)).toBe(false)
    })

    it("computes and verifies digests for revision versions 2 and above", () => {
      const template = createValidCharterTemplate()
      for (const version of [2, 3, 99]) {
        const revision = { ...template, version }
        const digest = computeCharterSnapshotDigest(revision)
        expect(verifyCharterSnapshotDigest({ ...revision, snapshotDigest: digest })).toBe(true)
      }
      // Distinct revisions are distinct governed content: the counter is in the digest.
      expect(computeCharterSnapshotDigest({ ...template, version: 2 })).not.toBe(
        computeCharterSnapshotDigest({ ...template, version: 1 }),
      )
    })
  })
})
