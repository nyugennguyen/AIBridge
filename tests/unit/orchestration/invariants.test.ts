import { readFileSync as readFile } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { digestDispatchEnvelope } from "../../../src/orchestration/digest.js"
import {
  InvalidStateTransitionError,
  InvariantViolationError,
} from "../../../src/orchestration/errors.js"
import {
  approvalSchema,
  controllerLeaseSchema,
  dispatchSchema,
  orchestrationCommandSchema,
  runSchema,
  sessionSchema,
  taskSchema,
} from "../../../src/orchestration/schemas.js"
import {
  APPROVAL_STATES,
  APPROVAL_TERMINAL_STATES,
  DISPATCH_STATES,
  DISPATCH_TERMINAL_STATES,
  RUN_STATES,
  RUN_TERMINAL_STATES,
  SESSION_STATES,
  SESSION_TERMINAL_STATES,
  TASK_STATES,
  TASK_TERMINAL_STATES,
} from "../../../src/orchestration/transitions.js"
import {
  assertApprovalDigestBound,
  assertCommandLease,
  assertCommandState,
  assertEpochMonotonicity,
  assertNonTerminal,
  COMMAND_MATRIX,
  deriveApprovalState,
  isApprovalDigestValid,
  isCommandAllowedForStates,
  validateApprovalDigest,
  validateApprovalInvariants,
  validateCommandLease,
  validateCommandState,
  validateCommandStateByType,
  validateDispatchInvariants,
  validateEpochMonotonicity,
  validateNonTerminal,
  validateRunInvariants,
  validateSessionInvariants,
  validateTaskInvariants,
  type CommandType,
} from "../../../src/orchestration/invariants.js"

function loadFixture<T>(filename: string): T {
  const filepath = resolve(process.cwd(), "tests/contracts/examples", filename)
  return JSON.parse(readFile(filepath, "utf8")) as T
}

const exampleApproval = approvalSchema.parse(loadFixture("approval.v1.json"))
const exampleCommand = orchestrationCommandSchema.parse(loadFixture("command.v1.json"))
const exampleLease = controllerLeaseSchema.parse(loadFixture("controller-lease.v1.json"))
const exampleDispatch = dispatchSchema.parse(loadFixture("dispatch.v1.json"))
const exampleRun = runSchema.parse(loadFixture("run.v1.json"))
const exampleTask = taskSchema.parse(loadFixture("task.v1.json"))
const exampleSession = sessionSchema.parse(loadFixture("session.v1.json"))

describe("Command matrix invariants", () => {
  const commandTypes: CommandType[] = [
    "run.cancel",
    "dispatch.execute",
    "session.prompt",
    "session.respond",
    "session.interrupt",
    "session.terminate",
  ]

  it("defines exact allowed states in COMMAND_MATRIX for all 6 command variants", () => {
    for (const type of commandTypes) {
      const rule = COMMAND_MATRIX[type]
      expect(rule).toBeDefined()
      expect(rule.allowedRunStates.length).toBeGreaterThan(0)
    }
  })

  describe("run.cancel command", () => {
    it("permits execution when run is draft or active", () => {
      expect(isCommandAllowedForStates("run.cancel", { runState: "draft" })).toBe(true)
      expect(isCommandAllowedForStates("run.cancel", { runState: "active" })).toBe(true)
      expect(validateCommandStateByType("run.cancel", { runState: "draft" }).ok).toBe(true)
      expect(validateCommandStateByType("run.cancel", { runState: "active" }).ok).toBe(true)
    })

    it("rejects execution when run is in terminal states", () => {
      for (const terminal of RUN_TERMINAL_STATES) {
        expect(isCommandAllowedForStates("run.cancel", { runState: terminal })).toBe(false)
        const result = validateCommandStateByType("run.cancel", { runState: terminal })
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error.category).toBe("conflict")
          expect(result.error.code).toBe("command.terminal_state_immutable")
          expect(result.error.message).toContain("terminal state")
        }
      }
    })
  })

  describe("dispatch.execute command", () => {
    it("permits execution when run is draft or active, dispatch is approved, approval is approved, task is ready", () => {
      const validContexts = [
        { runState: "draft" as const, dispatchState: "approved" as const, approvalState: "approved" as const, taskState: "ready" as const },
        { runState: "active" as const, dispatchState: "approved" as const, approvalState: "approved" as const, taskState: "ready" as const },
        { runState: "draft" as const, dispatchState: "approved" as const, approvalState: "approved" as const },
      ]

      for (const ctx of validContexts) {
        expect(isCommandAllowedForStates("dispatch.execute", ctx)).toBe(true)
        expect(validateCommandStateByType("dispatch.execute", ctx).ok).toBe(true)
      }
    })

    it("rejects execution when dispatch is not approved", () => {
      for (const state of DISPATCH_STATES) {
        if (state === "approved") continue
        const result = validateCommandStateByType("dispatch.execute", {
          runState: "active",
          dispatchState: state,
          approvalState: "approved",
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error.category).toBe("conflict")
          if (DISPATCH_TERMINAL_STATES.includes(state as any)) {
            expect(result.error.code).toBe("command.terminal_state_immutable")
          } else {
            expect(result.error.code).toBe("command.invalid_dispatch_state")
          }
        }
      }
    })

    it("rejects execution when approval is not approved", () => {
      for (const state of APPROVAL_STATES) {
        if (state === "approved") continue
        const result = validateCommandStateByType("dispatch.execute", {
          runState: "active",
          dispatchState: "approved",
          approvalState: state,
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error.category).toBe("conflict")
          if (APPROVAL_TERMINAL_STATES.includes(state as any)) {
            expect(result.error.code).toBe("command.terminal_state_immutable")
          } else {
            expect(result.error.code).toBe("command.invalid_approval_state")
          }
        }
      }
    })

    it("rejects execution when task is not ready", () => {
      for (const state of TASK_STATES) {
        if (state === "ready") continue
        const result = validateCommandStateByType("dispatch.execute", {
          runState: "active",
          dispatchState: "approved",
          approvalState: "approved",
          taskState: state,
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error.category).toBe("conflict")
          if (TASK_TERMINAL_STATES.includes(state as any)) {
            expect(result.error.code).toBe("command.terminal_state_immutable")
          } else {
            expect(result.error.code).toBe("command.invalid_task_state")
          }
        }
      }
    })
  })

  describe("session.prompt command", () => {
    it("permits execution when session is idle and run is active", () => {
      expect(isCommandAllowedForStates("session.prompt", { runState: "active", sessionState: "idle" })).toBe(true)
      expect(validateCommandStateByType("session.prompt", { runState: "active", sessionState: "idle" }).ok).toBe(true)
    })

    it("rejects execution when session is non-idle or run is not active", () => {
      expect(isCommandAllowedForStates("session.prompt", { runState: "draft", sessionState: "idle" })).toBe(false)
      expect(isCommandAllowedForStates("session.prompt", { runState: "active", sessionState: "launching" })).toBe(false)
      expect(isCommandAllowedForStates("session.prompt", { runState: "active", sessionState: "running" })).toBe(false)

      for (const terminal of SESSION_TERMINAL_STATES) {
        const res = validateCommandStateByType("session.prompt", { runState: "active", sessionState: terminal })
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.error.code).toBe("command.terminal_state_immutable")
        }
      }
    })
  })

  describe("session.respond command", () => {
    it("permits execution when session is running or idle and run is active", () => {
      expect(isCommandAllowedForStates("session.respond", { runState: "active", sessionState: "running" })).toBe(true)
      expect(isCommandAllowedForStates("session.respond", { runState: "active", sessionState: "idle" })).toBe(true)
    })

    it("rejects execution when session is launching or terminal", () => {
      expect(isCommandAllowedForStates("session.respond", { runState: "active", sessionState: "launching" })).toBe(false)
      for (const terminal of SESSION_TERMINAL_STATES) {
        expect(isCommandAllowedForStates("session.respond", { runState: "active", sessionState: terminal })).toBe(false)
      }
    })
  })

  describe("session.interrupt command", () => {
    it("permits execution only when session is running and run is active", () => {
      expect(isCommandAllowedForStates("session.interrupt", { runState: "active", sessionState: "running" })).toBe(true)
      expect(isCommandAllowedForStates("session.interrupt", { runState: "active", sessionState: "idle" })).toBe(false)
      expect(isCommandAllowedForStates("session.interrupt", { runState: "active", sessionState: "launching" })).toBe(false)
    })

    it("rejects execution on terminal session states", () => {
      for (const terminal of SESSION_TERMINAL_STATES) {
        expect(isCommandAllowedForStates("session.interrupt", { runState: "active", sessionState: terminal })).toBe(false)
      }
    })
  })

  describe("session.terminate command", () => {
    it("permits execution when session is launching, running, or idle", () => {
      expect(isCommandAllowedForStates("session.terminate", { runState: "active", sessionState: "launching" })).toBe(true)
      expect(isCommandAllowedForStates("session.terminate", { runState: "active", sessionState: "running" })).toBe(true)
      expect(isCommandAllowedForStates("session.terminate", { runState: "active", sessionState: "idle" })).toBe(true)
      expect(isCommandAllowedForStates("session.terminate", { runState: "draft", sessionState: "launching" })).toBe(true)
    })

    it("rejects execution when session is in terminal states", () => {
      for (const terminal of SESSION_TERMINAL_STATES) {
        const res = validateCommandStateByType("session.terminate", { runState: "active", sessionState: terminal })
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.error.code).toBe("command.terminal_state_immutable")
        }
      }
    })
  })

  describe("validateCommandState and assertCommandState", () => {
    it("validates command object against context", () => {
      const validCtx = { runState: "active" as const, dispatchState: "approved" as const, approvalState: "approved" as const }
      expect(validateCommandState(exampleCommand, validCtx).ok).toBe(true)
      expect(() => assertCommandState(exampleCommand, validCtx)).not.toThrow()
    })

    it("assertCommandState throws InvariantViolationError on invalid states", () => {
      const invalidCtx = { runState: "completed" as const }
      expect(() => assertCommandState(exampleCommand, invalidCtx)).toThrow(InvariantViolationError)
    })
  })
})

describe("Digest-bound approval invariant", () => {
  it("passes validation for matching approval and dispatch fixture", () => {
    expect(isApprovalDigestValid(exampleApproval, exampleDispatch)).toBe(true)
    const result = validateApprovalDigest(exampleApproval, exampleDispatch)
    expect(result.ok).toBe(true)
    expect(() => assertApprovalDigestBound(exampleApproval, exampleDispatch)).not.toThrow()
    expect(deriveApprovalState(exampleApproval, exampleDispatch)).toBe("approved")
  })

  it("invalidates approval when dispatch envelope prompt is mutated", () => {
    const mutated = JSON.parse(JSON.stringify(exampleDispatch))
    mutated.envelope.prompt = "A tampered or modified prompt that changes the hash!"

    expect(isApprovalDigestValid(exampleApproval, mutated)).toBe(false)
    const result = validateApprovalDigest(exampleApproval, mutated)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.category).toBe("conflict")
      expect(result.error.code).toBe("approval.digest_mismatch")
      expect(result.error.message).toContain("does not match canonical dispatch digest")
    }

    expect(deriveApprovalState(exampleApproval, mutated)).toBe("invalidated")
    expect(() => assertApprovalDigestBound(exampleApproval, mutated)).toThrow(InvariantViolationError)
  })

  it("invalidates approval when any material envelope field changes", () => {
    const envelopeMutations: Array<(env: any) => void> = [
      (env) => { env.attempt = 2 },
      (env) => { env.targetNodeId = "other-node" },
      (env) => { env.installationId = "other-installation" },
      (env) => { env.runtimeKind = "other-runtime" },
      (env) => { env.projectPathId = "other-path" },
      (env) => { env.timeoutSeconds = 999 },
      (env) => { env.controllerEpoch = 2 },
      (env) => { env.requestedCapabilities = ["read", "write"] },
      (env) => { env.dependencies = [{ taskId: "upstream-task-contract", failurePolicy: "block" }] },
      (env) => { env.roleSnapshot.name = "Tampered Role" },
      (env) => { env.ruleSnapshots[0].enabled = false },
      (env) => { env.model = "anthropic/claude-3-5-sonnet" },
    ]

    for (const mutate of envelopeMutations) {
      const cloned = JSON.parse(JSON.stringify(exampleDispatch))
      mutate(cloned.envelope)
      // update recorded digest so that recorded matches mutated, but approval still mismatches
      cloned.envelopeDigest = digestDispatchEnvelope(cloned.envelope)

      expect(isApprovalDigestValid(exampleApproval, cloned)).toBe(false)
      expect(deriveApprovalState(exampleApproval, cloned)).toBe("invalidated")
    }
  })

  it("rejects approval with mismatched dispatchId, projectId, or runId", () => {
    const dispatchMismatch = { ...exampleApproval, dispatchId: "different-dispatch" }
    expect(validateApprovalDigest(dispatchMismatch as any, exampleDispatch).ok).toBe(false)
    const res1 = validateApprovalDigest(dispatchMismatch as any, exampleDispatch)
    if (!res1.ok) expect(res1.error.code).toBe("approval.dispatch_mismatch")

    const projectMismatch = { ...exampleApproval, projectId: "different-project" }
    expect(validateApprovalDigest(projectMismatch as any, exampleDispatch).ok).toBe(false)
    const res2 = validateApprovalDigest(projectMismatch as any, exampleDispatch)
    if (!res2.ok) expect(res2.error.code).toBe("approval.project_mismatch")

    const runMismatch = { ...exampleApproval, runId: "different-run" }
    expect(validateApprovalDigest(runMismatch as any, exampleDispatch).ok).toBe(false)
    const res3 = validateApprovalDigest(runMismatch as any, exampleDispatch)
    if (!res3.ok) expect(res3.error.code).toBe("approval.run_mismatch")
  })

  it("rejects approval when dispatch recorded digest does not match its own computed envelope digest", () => {
    const corruptDispatch = {
      ...exampleDispatch,
      envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }
    const computed = digestDispatchEnvelope(corruptDispatch.envelope)
    const matchingApproval = { ...exampleApproval, envelopeDigest: computed }

    const res = validateApprovalDigest(matchingApproval, corruptDispatch as any)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe("dispatch.digest_mismatch")
  })

  it("rejects approval when decision is rejected", () => {
    const rejectedApproval = { ...exampleApproval, decision: "rejected" as const }
    const res = validateApprovalDigest(rejectedApproval, exampleDispatch)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.category).toBe("approval_required")
      expect(res.error.code).toBe("approval.not_approved")
    }
    expect(deriveApprovalState(rejectedApproval, exampleDispatch)).toBe("rejected")
  })
})

describe("Controller epoch and lease invariants", () => {
  describe("Epoch monotonicity", () => {
    it("accepts strictly increasing epochs in default mode", () => {
      expect(validateEpochMonotonicity(1, 2).ok).toBe(true)
      expect(validateEpochMonotonicity(5, 6).ok).toBe(true)
      expect(validateEpochMonotonicity(10, 100).ok).toBe(true)
      expect(() => assertEpochMonotonicity(1, 2)).not.toThrow()
    })

    it("rejects non-increasing epochs in default strict mode", () => {
      const resEqual = validateEpochMonotonicity(2, 2)
      expect(resEqual.ok).toBe(false)
      if (!resEqual.ok) {
        expect(resEqual.error.category).toBe("stale_epoch")
        expect(resEqual.error.code).toBe("epoch.not_monotonic")
      }

      const resLower = validateEpochMonotonicity(2, 1)
      expect(resLower.ok).toBe(false)
      if (!resLower.ok) {
        expect(resLower.error.category).toBe("stale_epoch")
        expect(resLower.error.code).toBe("epoch.not_monotonic")
      }

      expect(() => assertEpochMonotonicity(2, 1)).toThrow(InvariantViolationError)
    })

    it("accepts equal epochs when allowSameEpoch is true (lease renewal)", () => {
      expect(validateEpochMonotonicity(2, 2, { allowSameEpoch: true }).ok).toBe(true)
      expect(validateEpochMonotonicity(2, 3, { allowSameEpoch: true }).ok).toBe(true)

      const resLower = validateEpochMonotonicity(3, 2, { allowSameEpoch: true })
      expect(resLower.ok).toBe(false)
      if (!resLower.ok) {
        expect(resLower.error.category).toBe("stale_epoch")
        expect(resLower.error.code).toBe("epoch.stale")
      }
    })

    it("rejects non-positive and unsafe integer epochs", () => {
      expect(validateEpochMonotonicity(0, 1).ok).toBe(false)
      expect(validateEpochMonotonicity(1, -1).ok).toBe(false)
      expect(validateEpochMonotonicity(1.5, 2).ok).toBe(false)
      expect(validateEpochMonotonicity(1, 2.5).ok).toBe(false)
    })
  })

  describe("Command lease authority checks", () => {
    it("accepts command matching active lease within valid time window", () => {
      const res = validateCommandLease(exampleCommand, exampleLease, { now: "2026-09-17T00:01:00.000Z" })
      expect(res.ok).toBe(true)
      expect(() => assertCommandLease(exampleCommand, exampleLease, { now: "2026-09-17T00:01:00.000Z" })).not.toThrow()
    })

    it("rejects command with stale epoch (< active lease epoch)", () => {
      const leaseEpoch2 = { ...exampleLease, epoch: 2 }
      const res = validateCommandLease(exampleCommand, leaseEpoch2)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.category).toBe("stale_epoch")
        expect(res.error.code).toBe("epoch.stale")
        expect(res.error.message).toContain("stale")
      }
    })

    it("rejects command with future unregistered epoch (> active lease epoch)", () => {
      const commandEpoch2 = { ...exampleCommand, controllerEpoch: 2 }
      const res = validateCommandLease(commandEpoch2 as any, exampleLease)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.category).toBe("conflict")
        expect(res.error.code).toBe("epoch.unregistered")
      }
    })

    it("rejects command with mismatched leaseId", () => {
      const leaseMismatched = { ...exampleLease, leaseId: "other-lease" }
      const res = validateCommandLease(exampleCommand, leaseMismatched as any)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.category).toBe("conflict")
        expect(res.error.code).toBe("lease.mismatched")
      }
    })

    it("rejects command with mismatched controllerNodeId", () => {
      const controllerMismatched = { ...exampleLease, controllerNodeId: "other-node" }
      const res = validateCommandLease(exampleCommand, controllerMismatched as any)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.category).toBe("policy_denied")
        expect(res.error.code).toBe("lease.controller_mismatch")
      }
    })

    it("rejects command when active lease has expired", () => {
      const res = validateCommandLease(exampleCommand, exampleLease, { now: "2026-09-17T00:06:00.000Z" })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.category).toBe("stale_epoch")
        expect(res.error.code).toBe("lease.expired")
      }
    })

    it("rejects command whose expiry exceeds active lease expiry", () => {
      const commandLongExpiry = { ...exampleCommand, expiresAt: "2026-09-17T00:10:00.000Z" }
      const res = validateCommandLease(commandLongExpiry as any, exampleLease)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.category).toBe("validation")
        expect(res.error.code).toBe("command.expiry_exceeds_lease")
      }
    })

    it("rejects command issued before lease issued time", () => {
      const commandEarlyIssue = { ...exampleCommand, issuedAt: "2026-09-16T23:59:00.000Z" }
      const res = validateCommandLease(commandEarlyIssue as any, exampleLease)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.category).toBe("validation")
        expect(res.error.code).toBe("command.issued_before_lease")
      }
    })

    it("rejects command when current verification time exceeds command expiry", () => {
      const res = validateCommandLease(exampleCommand, exampleLease, { now: "2026-09-17T00:04:30.000Z" })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.category).toBe("timeout")
        expect(res.error.code).toBe("command.expired")
      }
    })

    it("assertCommandLease throws InvariantViolationError on lease check failures", () => {
      const leaseEpoch2 = { ...exampleLease, epoch: 2 }
      expect(() => assertCommandLease(exampleCommand, leaseEpoch2)).toThrow(InvariantViolationError)
    })
  })
})

describe("Terminal state immutability and aggregate invariants", () => {
  it("enforces non-terminal state validation across all entities", () => {
    expect(validateNonTerminal("run", "draft").ok).toBe(true)
    expect(validateNonTerminal("run", "active").ok).toBe(true)
    expect(validateNonTerminal("task", "ready").ok).toBe(true)
    expect(validateNonTerminal("dispatch", "approved").ok).toBe(true)
    expect(validateNonTerminal("approval", "pending").ok).toBe(true)
    expect(validateNonTerminal("session", "running").ok).toBe(true)

    for (const term of RUN_TERMINAL_STATES) {
      expect(validateNonTerminal("run", term).ok).toBe(false)
      expect(() => assertNonTerminal("run", term)).toThrow(InvalidStateTransitionError)
    }

    for (const term of TASK_TERMINAL_STATES) {
      expect(validateNonTerminal("task", term).ok).toBe(false)
      expect(() => assertNonTerminal("task", term)).toThrow(InvalidStateTransitionError)
    }

    for (const term of DISPATCH_TERMINAL_STATES) {
      expect(validateNonTerminal("dispatch", term).ok).toBe(false)
      expect(() => assertNonTerminal("dispatch", term)).toThrow(InvalidStateTransitionError)
    }

    for (const term of APPROVAL_TERMINAL_STATES) {
      expect(validateNonTerminal("approval", term).ok).toBe(false)
      expect(() => assertNonTerminal("approval", term)).toThrow(InvalidStateTransitionError)
    }

    for (const term of SESSION_TERMINAL_STATES) {
      expect(validateNonTerminal("session", term).ok).toBe(false)
      expect(() => assertNonTerminal("session", term)).toThrow(InvalidStateTransitionError)
    }
  })

  it("validates run timestamp ordering", () => {
    expect(validateRunInvariants(exampleRun).ok).toBe(true)

    const invalidTimestamps = { ...exampleRun, createdAt: "2026-09-17T00:05:00.000Z", updatedAt: "2026-09-17T00:01:00.000Z" }
    const res = validateRunInvariants(invalidTimestamps as any)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe("run.invalid_timestamps")
    }
  })

  it("validates task invariants with run context", () => {
    expect(validateTaskInvariants(exampleTask, { runState: "active" }).ok).toBe(true)

    const nonTerminalTaskInTerminalRun = validateTaskInvariants(exampleTask, { runState: "completed" })
    expect(nonTerminalTaskInTerminalRun.ok).toBe(false)
    if (!nonTerminalTaskInTerminalRun.ok) {
      expect(nonTerminalTaskInTerminalRun.error.code).toBe("task.run_terminal")
    }

    const completedTask = { ...exampleTask, state: "completed" }
    expect(validateTaskInvariants(completedTask as any, { runState: "completed" }).ok).toBe(true)
  })

  it("validates dispatch invariants with digest and run context", () => {
    expect(validateDispatchInvariants(exampleDispatch, { runState: "active" }).ok).toBe(true)

    const nonTerminalDispatchInTerminalRun = validateDispatchInvariants(exampleDispatch, { runState: "completed" })
    expect(nonTerminalDispatchInTerminalRun.ok).toBe(false)
    if (!nonTerminalDispatchInTerminalRun.ok) {
      expect(nonTerminalDispatchInTerminalRun.error.code).toBe("dispatch.run_terminal")
    }

    const corruptedDigestDispatch = { ...exampleDispatch, envelopeDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111" }
    const resCorrupt = validateDispatchInvariants(corruptedDigestDispatch as any)
    expect(resCorrupt.ok).toBe(false)
    if (!resCorrupt.ok) {
      expect(resCorrupt.error.code).toBe("dispatch.digest_mismatch")
    }
  })

  it("validates session invariants with run context", () => {
    const nonTerminalSessionInTerminalRun = validateSessionInvariants(exampleSession, { runState: "completed" })
    expect(nonTerminalSessionInTerminalRun.ok).toBe(false)
    if (!nonTerminalSessionInTerminalRun.ok) {
      expect(nonTerminalSessionInTerminalRun.error.code).toBe("session.run_terminal")
    }

    const completedSession = { ...exampleSession, state: "completed" }
    expect(validateSessionInvariants(completedSession as any, { runState: "completed" }).ok).toBe(true)
  })

  it("validates approval invariants with dispatch", () => {
    expect(validateApprovalInvariants(exampleApproval, exampleDispatch).ok).toBe(true)
  })
})
