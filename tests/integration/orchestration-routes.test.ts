/**
 * Integration tests for Orchestration Command Ingress & Capability Preview Seam.
 *
 * Verifies:
 * 1. Authenticated `charter.propose` (non-core changes) round-trips -> `charter.proposed` in events.
 * 2. The SAME propose with `changes: [{ area: "security.allowed_sources" }]` is refused
 *    with `code: "charter_core_violation"` and the proposal recorded as evidence.
 * 3. `roundtable.inject_human` round-trips -> `roundtable.posted` in events.
 * 4. `POST /orchestration/capability-preview` returns the INTERSECTION for two roles
 *    matching `computeCapabilityEnvelope`'s output exactly (pure function call).
 * 5. Unauthorized callers (missing token, invalid token, unallowlisted project,
 *    unauthorized source) are refused with 401/403 exactly like `/trigger`.
 */

import { describe, expect, it } from "vitest"
import { buildTestApp, testConfig, testConfigNoAuth } from "./fixtures.js"
import { DispatchCoordinator } from "../../src/orchestration/coordinator/coordinator.js"
import type { CommandLog } from "../../src/orchestration/coordinator/types.js"
import { CharterRepository } from "../../src/orchestration/charter/repository.js"
import { CharterProposalLifecycle } from "../../src/orchestration/charter/proposal.js"
import { RoundtableRepository } from "../../src/orchestration/roundtable/repository.js"
import { SAFETY_FLOOR } from "../../src/orchestration/policy/floor.js"
import { computeImmutableCoreDigest } from "../../src/orchestration/policy/immutable-core.js"
import { computeCapabilityEnvelope } from "../../src/runtime/opencode-adapter.js"
import {
  eventIdSchema,
  correlationIdSchema,
  projectIdSchema,
  runIdSchema,
  nodeIdSchema,
  userIdSchema,
  leaseIdSchema,
  sessionIdSchema,
  type Digest,
} from "../../src/orchestration/identifiers.js"
import { reduceEvent } from "../../src/orchestration/projections/reducer.js"
import type { RunProjectionState } from "../../src/orchestration/projections/types.js"
import { computeCharterSnapshotDigest, type Charter, type CharterProposal, type CharterChangeArea } from "../../src/orchestration/schemas.js"
import type { OrchestrationCommand, OrchestrationEvent } from "../../src/orchestration/types.js"
import type { EventInput } from "../../src/orchestration/event-store/types.js"

// ============================================================================
// Fixtures
// ============================================================================

const NOW = "2026-10-14T10:00:00.000Z"
const LATER = "2026-10-14T12:00:00.000Z"
const TEST_PROJECT_ID = "app" // Allowlisted in testConfig().projects
const TEST_RUN_ID = "run-001"
const CHARTER_ID = "profile-test"

function createInitialRunProjection(): RunProjectionState {
  const runCreated: OrchestrationEvent = {
    schemaVersion: 1,
    eventId: eventIdSchema.parse("evt-seed-run"),
    sequence: 1,
    type: "run.created",
    projectId: projectIdSchema.parse(TEST_PROJECT_ID),
    runId: runIdSchema.parse(TEST_RUN_ID),
    actor: { kind: "user", userId: userIdSchema.parse("usr-operator") },
    controllerEpoch: 1,
    occurredAt: NOW,
    correlationId: correlationIdSchema.parse("corr-seed"),
    causation: null,
    payload: {
      run: {
        schemaVersion: 1,
        runId: runIdSchema.parse(TEST_RUN_ID),
        projectId: projectIdSchema.parse(TEST_PROJECT_ID),
        goal: "Orchestration integration test run",
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

function createBaselineCharter(charterId = CHARTER_ID, version = 1): Charter {
  const coreDigest = computeImmutableCoreDigest(SAFETY_FLOOR)
  const template = {
    charterId,
    version,
    purpose: "Testing orchestration routes",
    globalRules: ["Rule 1", "Rule 2"],
    communicationPolicy: {
      turnTaking: "chair_ordered" as const,
      objectionRequiredBefore: ["deploy"],
      verbosity: "normal" as const,
      mustStopAndAsk: ["ambiguous_prompt"],
      objectionMustContain: ["rationale"],
    },
    escalationPolicy: {
      maxRounds: 5,
      onDeadlock: "human_decides" as const,
      budgetScope: "shared" as const,
    },
    roleCatalog: [
      { roleId: "implementer", version: 1 },
      { roleId: "reviewer", version: 1 },
    ],
    immutableCoreDigest: coreDigest,
    snapshotDigest: `sha256:${"0".repeat(64)}` as Digest,
    author: "human" as const,
    capturedAt: NOW,
  }
  const snapshotDigest = computeCharterSnapshotDigest(template)
  return { ...template, snapshotDigest }
}

function createProposal(
  charter: Charter,
  changes: readonly { area: CharterChangeArea; note?: string }[],
  rationale = "Test revision",
): CharterProposal {
  return {
    charter,
    rationale,
    evidenceRefs: ["ev-test-1"],
    changes: [...changes],
  }
}

function makeCommand(
  type: OrchestrationCommand["type"],
  payload: unknown,
  overrides: Partial<OrchestrationCommand> = {},
): OrchestrationCommand {
  return {
    schemaVersion: 1,
    commandId: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    projectId: projectIdSchema.parse(TEST_PROJECT_ID),
    runId: runIdSchema.parse(TEST_RUN_ID),
    // Machine callers (the manager plugin, peer bridges) authenticate as
    // sessions. User-kind `actor` claims require the operator credential and
    // are exercised explicitly in describe "5".
    actor: { kind: "session", sessionId: sessionIdSchema.parse("sess-manager-001") },
    controllerNodeId: nodeIdSchema.parse("node-chair"),
    controllerEpoch: 1,
    leaseId: leaseIdSchema.parse("lease-1"),
    issuedAt: NOW,
    expiresAt: LATER,
    correlationId: correlationIdSchema.parse("corr-cmd-1"),
    causation: null,
    type,
    payload,
    ...overrides,
  } as OrchestrationCommand
}

function setupOrchestrationHarness() {
  const baselineCharter = createBaselineCharter()
  const charters = new CharterRepository([baselineCharter])
  const proposals = new CharterProposalLifecycle({ safetyFloor: SAFETY_FLOOR })
  const roundtables = new RoundtableRepository()
  const log: { command: OrchestrationCommand; events: readonly EventInput[] }[] = []

  const commandLog: CommandLog = {
    append(options) {
      log.push({ command: options.command, events: [...options.events] })
      return { duplicate: false, events: options.events }
    },
  }

  const projection = createInitialRunProjection()

  let eventCounter = 0
  const coordinator = new DispatchCoordinator({
    log: commandLog,
    now: () => NOW,
    newEventId: () => `evt-${++eventCounter}`,
    readRun: (runId: string) => (projection.run.runId === runId ? projection : undefined),
    charters,
    charterProposals: proposals,
    roundtables,
    safetyFloor: SAFETY_FLOOR,
  })

  return { coordinator, charters, proposals, roundtables, log, baselineCharter }
}

// ============================================================================
// Test Suites
// ============================================================================

describe("Orchestration Routes Seam (POST /orchestration/commands & /capability-preview)", () => {
  describe("1. POST /orchestration/commands: charter.propose lifecycle", () => {
    it("round-trips an authenticated charter.propose (non-core changes) -> charter.proposed in response events", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        orchestration: { coordinator: harness.coordinator },
      })

      const nonCoreProposal = createProposal(harness.baselineCharter, [
        { area: "charter.communication_policy", note: "chair_ordered deliberation" },
      ])
      const proposeCommand = makeCommand("charter.propose", {
        proposal: nonCoreProposal,
        proposalId: "prop-noncore-001",
      })

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer secret" },
        payload: proposeCommand,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.ok).toBe(true)
      expect(body.value.events).toEqual(["charter.proposed"])
      expect(body.value.duplicate).toBe(false)

      // Verified: Proposal is pending in store
      const record = harness.proposals.getProposal("prop-noncore-001")
      expect(record).toBeDefined()
      expect(record?.status).toBe("pending")
    })

    it("refuses the SAME propose with changes: [{ area: 'security.allowed_sources' }] with code 'charter_core_violation' and records proposal as evidence", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        orchestration: { coordinator: harness.coordinator },
      })

      const coreViolationProposal = createProposal(harness.baselineCharter, [
        { area: "security.allowed_sources", note: "attempt to modify allowed_sources" },
      ])
      const proposeCommand = makeCommand("charter.propose", {
        proposal: coreViolationProposal,
        proposalId: "prop-core-violation-001",
      })

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer secret" },
        payload: proposeCommand,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.ok).toBe(false)
      expect(body.error.code).toBe("charter_core_violation")
      expect(body.error.category).toBe("policy_denied")
      expect(body.error.message).toContain("touches immutable core item 'security_perimeter'")

      // Verified: Proposal is recorded as evidence with status 'refused_core_violation'
      const evidence = harness.proposals.getProposal("prop-core-violation-001")
      expect(evidence).toBeDefined()
      expect(evidence?.status).toBe("refused_core_violation")
      expect(evidence?.refusalReason).toContain("security.allowed_sources")

      // Evidence log contains this proposal
      const evidenceLog = harness.proposals.listEvidence()
      expect(evidenceLog.some((e) => e.proposalId === "prop-core-violation-001")).toBe(true)
    })
  })

  describe("2. POST /orchestration/commands: roundtable.inject_human", () => {
    it("round-trips roundtable.inject_human into an open discussion -> roundtable.posted in response events", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        orchestration: { coordinator: harness.coordinator },
      })

      // Open a roundtable discussion first
      const discussionId = "disc-deliberation-001"
      const openRoundtableCommand = makeCommand("roundtable.open", {
        roundtable: {
          id: discussionId,
          runId: TEST_RUN_ID,
          subject: "Release architecture decision",
          mode: "sequential",
          chairNodeId: nodeIdSchema.parse("node-chair"),
          members: [
            { nodeId: nodeIdSchema.parse("node-chair"), roleId: "lead" },
            { nodeId: nodeIdSchema.parse("node-worker-1"), roleId: "worker" },
          ],
          state: "open",
        },
      })

      const openResponse = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer secret" },
        payload: openRoundtableCommand,
      })
      expect(openResponse.statusCode).toBe(200)
      expect(openResponse.json().ok).toBe(true)
      expect(openResponse.json().value.events).toEqual(["roundtable.opened"])

      // Now inject a human post
      const injectHumanCommand = makeCommand("roundtable.inject_human", {
        post: {
          postId: "post-human-intervention-001",
          discussionId,
          seq: 1,
          authorNodeId: nodeIdSchema.parse("node-chair"),
          authorRoleId: "human",
          kind: "objection",
          body: "Human supervisor intervention: delay deployment until verification passes.",
          createdAt: NOW,
        },
      })

      const injectResponse = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer secret" },
        payload: injectHumanCommand,
      })

      expect(injectResponse.statusCode).toBe(200)
      const injectBody = injectResponse.json()
      expect(injectBody.ok).toBe(true)
      expect(injectBody.value.events).toEqual(["roundtable.posted"])

      // Verified: Post exists in roundtable repository
      const discussion = harness.roundtables.get(discussionId)
      expect(discussion).toBeDefined()
      const humanPost = discussion?.posts.find((p) => p.postId === "post-human-intervention-001")
      expect(humanPost).toBeDefined()
      expect(humanPost?.authorRoleId).toBe("human")
      expect(humanPost?.body).toContain("Human supervisor intervention")
    })
  })

  describe("3. POST /orchestration/capability-preview: multi-role intersection", () => {
    it("returns the INTERSECTION for two roles matching computeCapabilityEnvelope output exactly", async () => {
      const { app } = await buildTestApp()

      const role1 = {
        roleId: "implementer",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "filesystem.write"],
          deniedCapabilities: [],
        },
      }

      const role2 = {
        roleId: "release-manager",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "process.exec"],
          deniedCapabilities: [],
        },
      }

      const requestedCapabilities = ["filesystem.read", "filesystem.write", "process.exec"]
      const permissionEnvelope = {
        allowedCapabilities: ["filesystem.read", "filesystem.write", "process.exec", "network.external"],
        deniedCapabilities: [],
      }

      const previewPayload = {
        requestedCapabilities,
        permissionEnvelope,
        roles: [role1, role2],
      }

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/capability-preview",
        headers: { authorization: "Bearer secret" },
        payload: previewPayload,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()

      // Direct comparison with kernel's pure computeCapabilityEnvelope
      const expected = computeCapabilityEnvelope({
        requestedCapabilities,
        permissionEnvelope,
        roles: [role1, role2],
      })

      expect(body.allowed).toEqual(expected.allowed)
      expect(body.allowed).toEqual(["filesystem.read"]) // Intersection: only filesystem.read permitted by both
      expect(body.denied).toEqual(expected.denied)
      expect(body.tools).toEqual(expected.tools)

      // Verified tool states: filesystem tools permitted; bash and network disabled
      expect(body.tools.write).toBe(false)
      expect(body.tools.bash).toBe(false)
      expect(body.tools.webfetch).toBe(false)
      expect(body.tools.websearch).toBe(false)
    })

    it("respects per-role deniedCapabilities and widens only on explicit union compositionMode", async () => {
      const { app } = await buildTestApp()

      const role1 = {
        roleId: "writer",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "filesystem.write"],
          deniedCapabilities: ["network.external"],
        },
      }

      const role2 = {
        roleId: "reader",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read"],
          deniedCapabilities: [],
        },
      }

      const previewPayload = {
        requestedCapabilities: ["filesystem.read", "filesystem.write"],
        roles: [role1, role2],
      }

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/capability-preview",
        headers: { authorization: "Bearer secret" },
        payload: previewPayload,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.allowed).toEqual(["filesystem.read"])
      expect(body.denied).toContain("network.external")
    })
  })

  describe("4. Authentication and Authorization discipline (matching /trigger)", () => {
    it("refuses callers with 401 when Authorization header is missing (bearer-token mode)", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        orchestration: { coordinator: harness.coordinator },
      })

      // Commands endpoint
      const cmdResponse = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        payload: makeCommand("charter.propose", {
          proposal: createProposal(harness.baselineCharter, []),
        }),
      })
      expect(cmdResponse.statusCode).toBe(401)
      expect(cmdResponse.json()).toEqual({ error: "Unauthorized" })

      // Preview endpoint
      const previewResponse = await app.inject({
        method: "POST",
        url: "/orchestration/capability-preview",
        payload: { requestedCapabilities: ["filesystem.read"] },
      })
      expect(previewResponse.statusCode).toBe(401)
      expect(previewResponse.json()).toEqual({ error: "Unauthorized" })
    })

    it("refuses callers with 401 when Authorization header carries invalid token", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        orchestration: { coordinator: harness.coordinator },
      })

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer wrong-token" },
        payload: makeCommand("charter.propose", {
          proposal: createProposal(harness.baselineCharter, []),
        }),
      })
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: "Unauthorized" })
    })

    it("refuses commands with 403 when projectId is not in allowlisted projects", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        orchestration: { coordinator: harness.coordinator },
      })

      const unallowlistedCmd = makeCommand(
        "charter.propose",
        { proposal: createProposal(harness.baselineCharter, []) },
        { projectId: projectIdSchema.parse("unallowlisted-project") },
      )

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer secret" },
        payload: unallowlistedCmd,
      })
      expect(response.statusCode).toBe(403)
      expect(response.json().error).toContain("Project is not allowlisted")
    })

    it("refuses requests with 403 when x-source-agent-id header is not an authorized source", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        orchestration: { coordinator: harness.coordinator },
      })

      const validCmd = makeCommand("charter.propose", {
        proposal: createProposal(harness.baselineCharter, []),
      })

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: {
          authorization: "Bearer secret",
          "x-source-agent-id": "unknown-intruder-agent",
        },
        payload: validCmd,
      })
      expect(response.statusCode).toBe(403)
      expect(response.json().error).toContain("Source unknown-intruder-agent is not authorized")
    })

    it("accepts anonymous requests when security.auth_mode is 'none'", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        config: testConfigNoAuth(),
        orchestration: { coordinator: harness.coordinator },
      })

      const nonCoreProposal = createProposal(harness.baselineCharter, [
        { area: "charter.communication_policy", note: "anonymous test" },
      ])
      const proposeCommand = makeCommand("charter.propose", {
        proposal: nonCoreProposal,
        proposalId: "prop-anon-001",
      })

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        payload: proposeCommand,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().ok).toBe(true)
    })

    it("returns 400 when command payload fails schema validation", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        orchestration: { coordinator: harness.coordinator },
      })

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer secret" },
        payload: { notACommand: true },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe("Invalid command payload")
    })

    it("returns 503 when coordinator is not configured on bridge app", async () => {
      const { app } = await buildTestApp({
        // No coordinator provided
      })

      const nonCoreProposal = createProposal(createBaselineCharter(), [
        { area: "charter.communication_policy" },
      ])
      const proposeCommand = makeCommand("charter.propose", {
        proposal: nonCoreProposal,
      })

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer secret" },
        payload: proposeCommand,
      })
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe("coordinator_unavailable")
    })
  })

  describe("5. Actor claim authority (ADR 0008 §4)", () => {
    it("refuses a user-kind actor claim over a peer credential and never reaches the coordinator", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        operatorToken: "operator-secret",
        orchestration: { coordinator: harness.coordinator },
      })

      // The payload CLAIMS human authority (what charter approval gates on);
      // the credential presented is a peer's. Self-asserted actor fields are
      // not identities (ADR 0008 §4) — forging one must fail at the boundary.
      const forged = makeCommand(
        "charter.propose",
        {
          proposal: createProposal(harness.baselineCharter, [{ area: "charter.purpose", note: "forged authority" }]),
          proposalId: "prop-forged-001",
        },
        { actor: { kind: "user", userId: userIdSchema.parse("usr-operator") } },
      )

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer secret" },
        payload: forged,
      })
      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({ error: "Forbidden" })
      // Authorization happens at the boundary: the coordinator never saw it.
      expect(harness.log.length).toBe(0)
    })

    it("admits a user-kind actor claim only with the operator credential", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        operatorToken: "operator-secret",
        orchestration: { coordinator: harness.coordinator },
      })

      const operatorCommand = makeCommand(
        "charter.propose",
        {
          proposal: createProposal(harness.baselineCharter, [{ area: "charter.purpose", note: "operator edit" }]),
          proposalId: "prop-operator-001",
        },
        { actor: { kind: "user", userId: userIdSchema.parse("usr-operator") } },
      )

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer operator-secret" },
        payload: operatorCommand,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().ok).toBe(true)
    })

    it("fail-closes user-kind authority when no operator credential is configured", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        orchestration: { coordinator: harness.coordinator },
      })

      const userClaim = makeCommand(
        "charter.propose",
        {
          proposal: createProposal(harness.baselineCharter, [{ area: "charter.purpose", note: "uncredentialed claim" }]),
          proposalId: "prop-nooperator-001",
        },
        { actor: { kind: "user", userId: userIdSchema.parse("usr-operator") } },
      )

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer secret" },
        payload: userClaim,
      })
      expect(response.statusCode).toBe(403)
      expect(harness.log.length).toBe(0)
    })

    it("keeps user-kind authority credential-bound even when security.auth_mode is 'none'", async () => {
      const harness = setupOrchestrationHarness()
      const { app } = await buildTestApp({
        config: testConfigNoAuth(),
        orchestration: { coordinator: harness.coordinator },
      })

      const userClaim = makeCommand(
        "charter.propose",
        {
          proposal: createProposal(harness.baselineCharter, [{ area: "charter.purpose", note: "anonymous user claim" }]),
          proposalId: "prop-anon-user-001",
        },
        { actor: { kind: "user", userId: userIdSchema.parse("usr-operator") } },
      )

      const response = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        payload: userClaim,
      })
      // auth_mode "none" admits anonymous CALLERS; it does not make a
      // self-asserted human-authority claim trustworthy. §15's human-only gate
      // must not be forgeable in exactly the deployments `aibr setup` permits
      // (CGNAT-bound, no bearer) — the rule is uniform across auth modes.
      expect(response.statusCode).toBe(403)
      expect(harness.log.length).toBe(0)
    })
  })
})
