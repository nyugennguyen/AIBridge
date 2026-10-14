/**
 * Parity tests for Charter and Roundtable contract schemas
 * (Phase 0 / Milestone 6 of docs/implementation-plans/aibridge-herdr-orchestration.md §10-§11).
 *
 * Asserts that:
 * 1. The committed `contracts/v1/*.schema.json` artefacts match what the live Zod schemas
 *    in `src/orchestration/schemas.ts` compile to under `buildContractDocument`.
 * 2. Every generated schema compiles cleanly under Draft 2020-12 AJV with strict mode enabled.
 * 3. Canonical valid fixtures pass both the live Zod schemas and the compiled JSON schemas.
 * 4. Structural rejections (unknown keys, invalid enums, invalid bounds) agree across both validators.
 */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import Ajv2020Module from "ajv/dist/2020.js"
import type { ErrorObject, ValidateFunction } from "ajv"
import {
  CHARTER_ROUNDTABLE_CLOSURE,
  buildContractDocument,
  resolveSourceLine,
  type ContractSpec,
} from "../../scripts/generate-contracts.js"
import {
  CHARTER_CHANGE_AREAS,
  charterProposalSchema,
  charterRoleRefSchema,
  charterSchema,
  communicationPolicySchema,
  escalationPolicySchema,
  postSchema,
  roundtableOutcomeSchema,
  roundtableSchema,
  orchestrationCommandSchema,
  orchestrationEventSchema,
} from "../../src/orchestration/schemas.js"
const Ajv2020 = Ajv2020Module.default
const CONTRACTS_DIRECTORY = fileURLToPath(new URL("../../contracts/v1/", import.meta.url))

function createAjv(): InstanceType<typeof Ajv2020> {
  return new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
  })
}

async function loadCommittedContract(file: string): Promise<Record<string, unknown>> {
  const content = await readFile(`${CONTRACTS_DIRECTORY}${file}.schema.json`, "utf8")
  return JSON.parse(content) as Record<string, unknown>
}

function firstError(validate: ValidateFunction): string {
  const errors = validate.errors as ErrorObject[] | null
  if (!errors || errors.length === 0) return "(no error)"
  return errors.map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`).join("; ")
}

// ---------------------------------------------------------------------------
// Canonical test fixtures
// ---------------------------------------------------------------------------

const validRoleRef = {
  roleId: "role-architect",
  version: 1,
  snapshotDigest: `sha256:${"a".repeat(64)}`,
}

const validCommunicationPolicy = {
  turnTaking: "chair_ordered" as const,
  objectionRequiredBefore: ["dispatch.execute"],
  verbosity: "normal" as const,
  mustStopAndAsk: ["destructive_action"],
  objectionMustContain: ["rationale", "risk_mitigation"],
}

const validEscalationPolicy = {
  maxRounds: 5,
  onDeadlock: "human_decides" as const,
  budgetScope: "shared" as const,
}

const validCharter = {
  charterId: "charter-default",
  version: 1,
  purpose: "Coordinate autonomous engineering agents with human oversight",
  globalRules: [
    "Never bypass safety floors or credential boundaries",
    "Always require confirmation before production mutation",
  ],
  communicationPolicy: validCommunicationPolicy,
  escalationPolicy: validEscalationPolicy,
  roleCatalog: [
    validRoleRef,
    {
      roleId: "reviewer",
      version: 1,
    },
  ],
  immutableCoreDigest: `sha256:${"b".repeat(64)}`,
  snapshotDigest: `sha256:${"c".repeat(64)}`,
  capturedAt: "2026-10-13T12:00:00.000Z",
  author: "human" as const,
}

const validRoundtable = {
  id: "discussion-1",
  runId: "run-001",
  taskId: "task-001",
  subject: "Evaluate architecture approach",
  mode: "sequential" as const,
  chairNodeId: "node-chair-1",
  members: [
    { nodeId: "node-chair-1", roleId: "role-architect" },
    { nodeId: "node-worker-2", roleId: "reviewer" },
  ],
  state: "open" as const,
}

const validPost = {
  postId: "post-1",
  discussionId: "discussion-1",
  seq: 1,
  authorNodeId: "node-worker-2",
  authorRoleId: "reviewer",
  kind: "proposal" as const,
  body: "I propose we adopt contract-parity assertions across all new surfaces.",
  createdAt: "2026-10-13T12:05:00.000Z",
}

const validOutcome = {
  summary: "Deliberation concluded successfully with full consensus.",
  recommendation: "Proceed with proposed contract generation slice.",
  addressedObjections: ["objection-1"],
  unresolvedObjections: [],
}

const validProposal = {
  charter: validCharter,
  rationale: "Align communication policy with high-concurrency deliberation.",
  evidenceRefs: ["discussion-1"],
  changes: [
    { area: "charter.communication_policy" as const, note: "Switch to free_for_all turn-taking" },
    { area: "charter.global_rules" as const },
  ],
}

describe("charter and roundtable contract parity", () => {
  it("covers all eight required charter and roundtable schemas in the generator closure", () => {
    const files = CHARTER_ROUNDTABLE_CLOSURE.map((spec) => spec.file)
    expect(files).toEqual([
      "charter-role-ref",
      "communication-policy",
      "escalation-policy",
      "charter",
      "roundtable",
      "post",
      "roundtable-outcome",
      "charter-proposal",
    ])
  })

  it("proves generated JSON matches live Zod schema compilation for every charter and roundtable contract", async () => {
    for (const spec of CHARTER_ROUNDTABLE_CLOSURE) {
      const line = await resolveSourceLine(spec)
      const expectedDocument = buildContractDocument(spec, line)
      const committedDocument = await loadCommittedContract(spec.file)

      expect(
        committedDocument,
        `contracts/v1/${spec.file}.schema.json has drifted from live Zod compilation of ${spec.exportName}`,
      ).toEqual(expectedDocument)
    }
  })

  it("compiles every generated schema cleanly with Ajv Draft 2020-12 in strict mode", async () => {
    const ajv = createAjv()
    for (const spec of CHARTER_ROUNDTABLE_CLOSURE) {
      const schemaJson = await loadCommittedContract(spec.file)
      expect(() => ajv.compile(schemaJson), `Ajv failed to compile ${spec.file}.schema.json`).not.toThrow()
    }
  })

  describe("cross-validator fixture acceptance parity", () => {
    const suites: Array<{
      name: string
      file: string
      zodSchema: { parse(val: unknown): unknown }
      document: Record<string, unknown>
    }> = [
      { name: "CharterRoleRef", file: "charter-role-ref", zodSchema: charterRoleRefSchema, document: validRoleRef },
      { name: "CommunicationPolicy", file: "communication-policy", zodSchema: communicationPolicySchema, document: validCommunicationPolicy },
      { name: "EscalationPolicy", file: "escalation-policy", zodSchema: escalationPolicySchema, document: validEscalationPolicy },
      { name: "Charter", file: "charter", zodSchema: charterSchema, document: validCharter },
      { name: "Roundtable", file: "roundtable", zodSchema: roundtableSchema, document: validRoundtable },
      { name: "Post", file: "post", zodSchema: postSchema, document: validPost },
      { name: "RoundtableOutcome", file: "roundtable-outcome", zodSchema: roundtableOutcomeSchema, document: validOutcome },
      { name: "CharterProposal", file: "charter-proposal", zodSchema: charterProposalSchema, document: validProposal },
    ]

    for (const suite of suites) {
      it(`accepts valid ${suite.name} in both Zod and JSON Schema`, async () => {
        // Zod validation
        expect(() => suite.zodSchema.parse(suite.document)).not.toThrow()

        // AJV validation
        const ajv = createAjv()
        const schemaJson = await loadCommittedContract(suite.file)
        const validate = ajv.compile(schemaJson)
        const ok = validate(suite.document)
        expect(ok, `AJV rejected valid ${suite.name}: ${firstError(validate)}`).toBe(true)
      })
    }
  })

  describe("cross-validator rejection parity", () => {
    it("rejects unknown keys in both Zod and JSON Schema for all eight documents (closed objects)", async () => {
      const ajv = createAjv()
      const pairs: Array<{
        name: string
        file: string
        zodSchema: { safeParse(val: unknown): { success: boolean } }
        validDoc: Record<string, unknown>
      }> = [
        { name: "CharterRoleRef", file: "charter-role-ref", zodSchema: charterRoleRefSchema, validDoc: validRoleRef },
        { name: "CommunicationPolicy", file: "communication-policy", zodSchema: communicationPolicySchema, validDoc: validCommunicationPolicy },
        { name: "EscalationPolicy", file: "escalation-policy", zodSchema: escalationPolicySchema, validDoc: validEscalationPolicy },
        { name: "Charter", file: "charter", zodSchema: charterSchema, validDoc: validCharter },
        { name: "Roundtable", file: "roundtable", zodSchema: roundtableSchema, validDoc: validRoundtable },
        { name: "Post", file: "post", zodSchema: postSchema, validDoc: validPost },
        { name: "RoundtableOutcome", file: "roundtable-outcome", zodSchema: roundtableOutcomeSchema, validDoc: validOutcome },
        { name: "CharterProposal", file: "charter-proposal", zodSchema: charterProposalSchema, validDoc: validProposal },
      ]

      for (const { name, file, zodSchema, validDoc } of pairs) {
        const injected = { ...validDoc, __forbidden_unknown_field__: "poison" }
        expect(zodSchema.safeParse(injected).success, `Zod should reject unknown key in ${name}`).toBe(false)

        const schemaJson = await loadCommittedContract(file)
        const validate = ajv.compile(schemaJson)
        expect(validate(injected), `AJV should reject unknown key in ${name}`).toBe(false)
      }
    })

    it("rejects invalid enum values across both Zod and JSON Schema", async () => {
      const ajv = createAjv()

      // 1. Charter author enum
      const invalidCharter = { ...validCharter, author: "alien" }
      expect(charterSchema.safeParse(invalidCharter).success).toBe(false)
      const validateCharter = ajv.compile(await loadCommittedContract("charter"))
      expect(validateCharter(invalidCharter)).toBe(false)

      // 2. CommunicationPolicy turnTaking enum
      const invalidComm = { ...validCommunicationPolicy, turnTaking: "round_robin" }
      expect(communicationPolicySchema.safeParse(invalidComm).success).toBe(false)
      const validateComm = ajv.compile(await loadCommittedContract("communication-policy"))
      expect(validateComm(invalidComm)).toBe(false)

      // 3. EscalationPolicy onDeadlock enum
      const invalidEsc = { ...validEscalationPolicy, onDeadlock: "ignore" }
      expect(escalationPolicySchema.safeParse(invalidEsc).success).toBe(false)
      const validateEsc = ajv.compile(await loadCommittedContract("escalation-policy"))
      expect(validateEsc(invalidEsc)).toBe(false)

      // 4. Roundtable discussionMode enum
      const invalidRt = { ...validRoundtable, mode: "unbounded" }
      expect(roundtableSchema.safeParse(invalidRt).success).toBe(false)
      const validateRt = ajv.compile(await loadCommittedContract("roundtable"))
      expect(validateRt(invalidRt)).toBe(false)

      // 5. Post kind enum
      const invalidPost = { ...validPost, kind: "rant" }
      expect(postSchema.safeParse(invalidPost).success).toBe(false)
      const validatePost = ajv.compile(await loadCommittedContract("post"))
      expect(validatePost(invalidPost)).toBe(false)
    })

    it("accepts all recognized change areas and rejects unknown change areas in CharterProposal", async () => {
      const ajv = createAjv()
      const validateProposal = ajv.compile(await loadCommittedContract("charter-proposal"))

      // Every recognized change area is accepted by both
      for (const area of CHARTER_CHANGE_AREAS) {
        const prop = {
          ...validProposal,
          changes: [{ area, note: `Testing area ${area}` }],
        }
        expect(charterProposalSchema.safeParse(prop).success, `Zod should accept area ${area}`).toBe(true)
        expect(validateProposal(prop), `AJV should accept area ${area}`).toBe(true)
      }

      // An unknown change area is rejected by both
      const badProp = {
        ...validProposal,
        changes: [{ area: "security.unauthorized_area", note: "Should fail" }],
      }
      expect(charterProposalSchema.safeParse(badProp).success).toBe(false)
      expect(validateProposal(badProp)).toBe(false)
    })

    it("enforces charter version constraints identically on both validators", async () => {
      const ajv = createAjv()
      const validateCharter = ajv.compile(await loadCommittedContract("charter"))

      // Version is a revision counter (plan §7.4): both validators accept any
      // positive integer, so a revised charter at version 2+ is wire-representable.
      for (const version of [1, 2, 99]) {
        const revision = { ...validCharter, version }
        expect(charterSchema.safeParse(revision).success).toBe(true)
        expect(validateCharter(revision)).toBe(true)
      }

      // The bound is structural, so the wire contract refuses exactly what the
      // runtime refuses — a `.refine`-only guard would be dropped by
      // zod-to-json-schema and leave the wire wider than the runtime.
      for (const version of [0, -1, 1.5]) {
        const invalid = { ...validCharter, version }
        expect(charterSchema.safeParse(invalid).success).toBe(false)
        expect(validateCharter(invalid)).toBe(false)
      }
    })
    it("accepts all four roundtable command variants on both Zod and JSON schema contracts", async () => {
      const ajv = createAjv()
      const validateCommand = ajv.compile(await loadCommittedContract("command"))

      const baseCommandInput = {
        schemaVersion: 1,
        commandId: "cmd-contract-test",
        projectId: "proj-1",
        runId: "run-001",
        actor: { kind: "node" as const, nodeId: "node-chair-1" },
        controllerNodeId: "node-chair-1",
        controllerEpoch: 1,
        leaseId: "lease-1",
        issuedAt: "2026-10-13T12:00:00.000Z",
        expiresAt: "2026-10-13T13:00:00.000Z",
        correlationId: "corr-1",
        causation: null,
      }

      const commands = [
        { ...baseCommandInput, type: "roundtable.open", payload: { roundtable: validRoundtable } },
        { ...baseCommandInput, type: "roundtable.post", payload: { post: validPost } },
        {
          ...baseCommandInput,
          type: "roundtable.inject_human",
          payload: { post: { ...validPost, authorRoleId: "human" } },
        },
        {
          ...baseCommandInput,
          type: "roundtable.close",
          payload: { discussionId: validRoundtable.id, outcome: validOutcome },
        },
      ]

      for (const cmd of commands) {
        expect(orchestrationCommandSchema.safeParse(cmd).success).toBe(true)
        expect(validateCommand(cmd)).toBe(true)
      }
    })

    it("accepts all four roundtable event variants on both Zod and JSON schema contracts", async () => {
      const ajv = createAjv()
      const validateEvent = ajv.compile(await loadCommittedContract("event"))

      const baseEventInput = {
        schemaVersion: 1,
        eventId: "evt-contract-test",
        sequence: 1,
        projectId: "proj-1",
        runId: "run-001",
        actor: { kind: "node" as const, nodeId: "node-chair-1" },
        controllerEpoch: 1,
        occurredAt: "2026-10-13T12:00:00.000Z",
        correlationId: "corr-1",
        causation: null,
      }

      const events = [
        { ...baseEventInput, type: "roundtable.opened", payload: { roundtable: validRoundtable } },
        { ...baseEventInput, type: "roundtable.posted", payload: { post: validPost } },
        { ...baseEventInput, type: "roundtable.closed", payload: { discussionId: validRoundtable.id } },
        {
          ...baseEventInput,
          type: "roundtable.outcome_recorded",
          payload: { discussionId: validRoundtable.id, outcome: validOutcome },
        },
      ]

      for (const evt of events) {
        expect(orchestrationEventSchema.safeParse(evt).success).toBe(true)
        expect(validateEvent(evt)).toBe(true)
      }
    })

    it("accepts all four charter command variants on both Zod and JSON schema contracts", async () => {
      const ajv = createAjv()
      const validateCommand = ajv.compile(await loadCommittedContract("command"))

      const baseCommandInput = {
        schemaVersion: 1,
        commandId: "cmd-contract-test",
        projectId: "proj-1",
        runId: "run-001",
        actor: { kind: "user" as const, userId: "user-operator" },
        controllerNodeId: "node-chair-1",
        controllerEpoch: 1,
        leaseId: "lease-1",
        issuedAt: "2026-10-13T12:00:00.000Z",
        expiresAt: "2026-10-13T13:00:00.000Z",
        correlationId: "corr-1",
        causation: null,
      }

      const commands = [
        { ...baseCommandInput, type: "charter.propose", payload: { proposal: validProposal } },
        { ...baseCommandInput, type: "charter.approve", payload: { charterId: validCharter.charterId, version: 1 } },
        { ...baseCommandInput, type: "charter.revise", payload: { charter: validCharter } },
        { ...baseCommandInput, type: "charter.reject", payload: { charterId: validCharter.charterId, version: 1, rationale: "Rejection rationale" } },
      ]

      for (const cmd of commands) {
        expect(orchestrationCommandSchema.safeParse(cmd).success).toBe(true)
        expect(validateCommand(cmd)).toBe(true)
      }
    })

    it("accepts all three charter event variants on both Zod and JSON schema contracts", async () => {
      const ajv = createAjv()
      const validateEvent = ajv.compile(await loadCommittedContract("event"))

      const baseEventInput = {
        schemaVersion: 1,
        eventId: "evt-contract-test",
        sequence: 1,
        projectId: "proj-1",
        runId: "run-001",
        actor: { kind: "node" as const, nodeId: "node-chair-1" },
        controllerEpoch: 1,
        occurredAt: "2026-10-13T12:00:00.000Z",
        correlationId: "corr-1",
        causation: null,
      }

      const events = [
        { ...baseEventInput, type: "charter.proposed", payload: { proposal: validProposal } },
        { ...baseEventInput, type: "charter.revised", payload: { charter: validCharter } },
        { ...baseEventInput, type: "charter.rejected", payload: { charterId: validCharter.charterId, version: 1, rationale: "Rejected" } },
      ]

      for (const evt of events) {
        expect(orchestrationEventSchema.safeParse(evt).success).toBe(true)
        expect(validateEvent(evt)).toBe(true)
      }
    })
  })
})
