import { describe, expect, it } from "vitest"
import {
  evaluateRoundtableGate,
  evaluateWithKernel,
  compileRuleSet,
} from "../../../src/rules/index.js"
import {
  RoundtableRepository,
  type Roundtable,
  type RoundtableOutcome,
} from "../../../src/orchestration/roundtable/index.js"
import { SAFETY_FLOOR } from "../../../src/orchestration/policy/floor.js"
import { computeImmutableCoreDigest } from "../../../src/orchestration/policy/immutable-core.js"
import { computeCharterSnapshotDigest } from "../../../src/orchestration/schemas.js"
import type { Charter } from "../../../src/orchestration/charter/types.js"
import { dispatchEnvelope } from "./fixtures.js"

const NOW = "2026-10-14T00:00:00.000Z"

function makeTestCharter(objectionRequiredBefore: readonly string[] = []): Charter {
  const coreDigest = computeImmutableCoreDigest(SAFETY_FLOOR)
  const template = {
    charterId: "charter-test",
    version: 1,
    purpose: "Testing roundtable gate",
    globalRules: ["rule 1"],
    communicationPolicy: {
      turnTaking: "chair_ordered" as const,
      objectionRequiredBefore: [...objectionRequiredBefore],
      verbosity: "normal" as const,
      mustStopAndAsk: [],
      objectionMustContain: ["rationale"],
    },
    escalationPolicy: {
      maxRounds: 5,
      onDeadlock: "chair_decides" as const,
      budgetScope: "shared" as const,
    },
    roleCatalog: [{ roleId: "role-1", version: 1 }],
    immutableCoreDigest: coreDigest,
    snapshotDigest: `sha256:${"0".repeat(64)}` as const,
    author: "human" as const,
    capturedAt: NOW,
  }
  const snapshotDigest = computeCharterSnapshotDigest(template)
  return { ...template, snapshotDigest }
}

function makeSampleOutcome(): RoundtableOutcome {
  return {
    summary: "Consensus reached after reviewing objections.",
    recommendation: "Proceed with execution dispatch.",
    addressedObjections: ["post-1"],
    unresolvedObjections: [],
  }
}

describe("Phase 5 — Rule gate requiring closed roundtable before execution dispatch", () => {
  it("refuses with roundtable_required when objectionRequiredBefore covers action and NO closed roundtable exists", () => {
    const charter = makeTestCharter(["deploy"])
    const envelope = dispatchEnvelope({}, ["deploy"])

    const result = evaluateRoundtableGate({
      envelope,
      charter,
      task: { taskId: envelope.taskId, title: "deploy task" },
      roundtables: new RoundtableRepository(),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("roundtable_required")
      expect(result.error.category).toBe("policy_denied")
      expect(result.error.message).toContain("roundtable_required")
      expect(result.error.message).toContain("deploy")
    }
  })

  it("refuses with roundtable_required when a roundtable exists for the task but is still open", () => {
    const charter = makeTestCharter(["deploy"])
    const envelope = dispatchEnvelope({}, ["deploy"])
    const repo = new RoundtableRepository()

    const rt: Roundtable = {
      id: "disc-open-1",
      runId: envelope.runId,
      taskId: envelope.taskId,
      subject: "Deployment deliberation",
      mode: "parallel",
      chairNodeId: "node-1" as never,
      members: [{ nodeId: "node-1" as never, roleId: "chair-role" }],
      state: "open",
    }
    repo.open(rt)

    const result = evaluateRoundtableGate({
      envelope,
      charter,
      task: { taskId: envelope.taskId, title: "deploy task" },
      roundtables: repo,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("roundtable_required")
    }
  })

  it("refuses with roundtable_required when a roundtable has posts but outcome is not yet recorded", () => {
    const charter = makeTestCharter(["deploy"])
    const envelope = dispatchEnvelope({}, ["deploy"])
    const repo = new RoundtableRepository()

    const rt: Roundtable = {
      id: "disc-posted-1",
      runId: envelope.runId,
      taskId: envelope.taskId,
      subject: "Deployment deliberation",
      mode: "parallel",
      chairNodeId: "node-1" as never,
      members: [{ nodeId: "node-1" as never, roleId: "chair-role" }],
      state: "open",
    }
    repo.open(rt)
    repo.post({
      postId: "post-1",
      discussionId: "disc-posted-1",
      authorNodeId: "node-1" as never,
      authorRoleId: "chair-role",
      kind: "proposal",
      body: "Proposal to deploy",
      createdAt: NOW,
    })

    const result = evaluateRoundtableGate({
      envelope,
      charter,
      task: { taskId: envelope.taskId, title: "deploy task" },
      roundtables: repo,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("roundtable_required")
    }
  })

  it("admits execution dispatch when a closed roundtable with recorded outcome exists for the task", () => {
    const charter = makeTestCharter(["deploy"])
    const envelope = dispatchEnvelope({}, ["deploy"])
    const repo = new RoundtableRepository()

    const rt: Roundtable = {
      id: "disc-closed-1",
      runId: envelope.runId,
      taskId: envelope.taskId,
      subject: "Deployment deliberation",
      mode: "parallel",
      chairNodeId: "node-1" as never,
      members: [{ nodeId: "node-1" as never, roleId: "chair-role" }],
      state: "open",
    }
    repo.open(rt)
    repo.post({
      postId: "post-1",
      discussionId: "disc-closed-1",
      authorNodeId: "node-1" as never,
      authorRoleId: "chair-role",
      kind: "proposal",
      body: "Proposal to deploy",
      createdAt: NOW,
    })
    repo.close("disc-closed-1", makeSampleOutcome())

    const result = evaluateRoundtableGate({
      envelope,
      charter,
      task: { taskId: envelope.taskId, title: "deploy task" },
      roundtables: repo,
    })

    expect(result.ok).toBe(true)
  })

  it("gates any execution dispatch when objectionRequiredBefore covers dispatch.execute", () => {
    const charter = makeTestCharter(["dispatch.execute"])
    const envelope = dispatchEnvelope({}, ["fs.read"])
    const repo = new RoundtableRepository()

    const result = evaluateRoundtableGate({
      envelope,
      charter,
      task: { taskId: envelope.taskId, title: "read file" },
      roundtables: repo,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("roundtable_required")
    }
  })

  it("does NOT gate non-covered action classes (no false refusals)", () => {
    const charter = makeTestCharter(["database_migration", "security.elevate"])
    const envelope = dispatchEnvelope({}, ["fs.read"])
    const repo = new RoundtableRepository()

    const result = evaluateRoundtableGate({
      envelope,
      charter,
      task: { taskId: envelope.taskId, title: "read and parse file" },
      roundtables: repo,
    })

    expect(result.ok).toBe(true)
  })

  it("evaluates cleanly through evaluateWithKernel composition", () => {
    const charter = makeTestCharter(["deploy"])
    const envelope = dispatchEnvelope({}, ["deploy"])
    const compiled = compileRuleSet([])
    if (!compiled.ok) throw new Error("compile failed")

    // Without closed roundtable -> evaluateWithKernel returns roundtable_required
    const gated = evaluateWithKernel(
      {
        envelope,
        taskTitle: "deploy",
        charter,
        roundtables: new RoundtableRepository(),
      },
      compiled.value,
      [],
    )
    expect(gated.ok).toBe(false)
    if (!gated.ok) {
      expect(gated.error.code).toBe("roundtable_required")
    }

    // With closed roundtable -> passes roundtable gate
    const repo = new RoundtableRepository()
    repo.open({
      id: "disc-kernel-1",
      runId: envelope.runId,
      taskId: envelope.taskId,
      subject: "Kernel deliberation",
      mode: "parallel",
      chairNodeId: "node-1" as never,
      members: [{ nodeId: "node-1" as never, roleId: "chair-role" }],
      state: "open",
    })
    repo.close("disc-kernel-1", makeSampleOutcome())

    const admitted = evaluateWithKernel(
      {
        envelope,
        taskTitle: "deploy",
        charter,
        roundtables: repo,
      },
      compiled.value,
      [],
    )
    // Passes the gate and reaches kernel evaluatePolicy
    expect(admitted.ok).toBe(true)
  })
})
