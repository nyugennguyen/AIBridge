import { describe, expect, it } from "vitest"
import {
  AGGREGATE_ENTITIES,
  APPROVAL_STATES,
  APPROVAL_TERMINAL_STATES,
  APPROVAL_TRANSITIONS,
  canTransition,
  canTransitionApproval,
  canTransitionDispatch,
  canTransitionRun,
  canTransitionSession,
  canTransitionTask,
  DISPATCH_STATES,
  DISPATCH_TERMINAL_STATES,
  DISPATCH_TRANSITIONS,
  InvalidStateTransitionError,
  isApprovalTerminal,
  isDispatchTerminal,
  isRunTerminal,
  isSessionTerminal,
  isTaskTerminal,
  isTerminalState,
  RUN_STATES,
  RUN_TERMINAL_STATES,
  RUN_TRANSITIONS,
  SESSION_STATES,
  SESSION_TERMINAL_STATES,
  SESSION_TRANSITIONS,
  TASK_STATES,
  TASK_TERMINAL_STATES,
  TASK_TRANSITIONS,
  transitionAggregate,
  transitionApproval,
  transitionDispatch,
  transitionRun,
  transitionSession,
  transitionTask,
  tryTransitionAggregate,
  tryTransitionApproval,
  tryTransitionDispatch,
  tryTransitionRun,
  tryTransitionSession,
  tryTransitionTask,
  type AggregateEntity,
  type ApprovalState,
  type DispatchState,
  type RunState,
  type SessionState,
  type TaskState,
} from "../../../src/orchestration/transitions.js"

describe("Run state machine and transitions", () => {
  it("exhaustively tests all pairs in Cartesian product of RUN_STATES (5x5 = 25 pairs)", () => {
    let checkedTransitions = 0

    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        checkedTransitions += 1
        const allowedTargets = RUN_TRANSITIONS[from]
        const isAllowed = allowedTargets.includes(to)
        const isTerminal = isRunTerminal(from)

        expect(canTransitionRun(from, to)).toBe(isAllowed)
        expect(canTransition("run", from, to)).toBe(isAllowed)

        if (isAllowed) {
          expect(transitionRun(from, to)).toBe(to)
          const tryRes = tryTransitionRun(from, to)
          expect(tryRes.ok).toBe(true)
          if (tryRes.ok) {
            expect(tryRes.value).toBe(to)
          }
        } else {
          expect(() => transitionRun(from, to)).toThrow(InvalidStateTransitionError)
          try {
            transitionRun(from, to)
          } catch (err) {
            expect(err).toBeInstanceOf(InvalidStateTransitionError)
            const transitionErr = err as InvalidStateTransitionError
            expect(transitionErr.entity).toBe("run")
            expect(transitionErr.fromState).toBe(from)
            expect(transitionErr.toState).toBe(to)
            expect(transitionErr.isTerminal).toBe(isTerminal)
            if (isTerminal) {
              expect(transitionErr.message).toContain("terminal states are strictly immutable")
            }
          }

          const tryRes = tryTransitionRun(from, to)
          expect(tryRes.ok).toBe(false)
          if (!tryRes.ok) {
            expect(tryRes.error.category).toBe("conflict")
            expect(tryRes.error.code).toBe(isTerminal ? "state.terminal_immutable" : "state.invalid_transition")
            expect(tryRes.error.retryable).toBe(false)
          }
        }
      }
    }

    expect(checkedTransitions).toBe(25)
  })

  it("walks positive lifecycle paths for Run", () => {
    // Path 1: draft -> active -> completed
    let state: RunState = "draft"
    state = transitionRun(state, "active")
    expect(state).toBe("active")
    state = transitionRun(state, "completed")
    expect(state).toBe("completed")
    expect(isRunTerminal(state)).toBe(true)

    // Path 2: draft -> active -> failed
    state = "draft"
    state = transitionRun(state, "active")
    state = transitionRun(state, "failed")
    expect(state).toBe("failed")
    expect(isRunTerminal(state)).toBe(true)

    // Path 3: draft -> active -> cancelled
    state = "draft"
    state = transitionRun(state, "active")
    state = transitionRun(state, "cancelled")
    expect(state).toBe("cancelled")
    expect(isRunTerminal(state)).toBe(true)

    // Path 4: draft -> cancelled
    state = "draft"
    state = transitionRun(state, "cancelled")
    expect(state).toBe("cancelled")
    expect(isRunTerminal(state)).toBe(true)
  })

  it("strictly enforces terminal immutability for Run", () => {
    for (const terminal of RUN_TERMINAL_STATES) {
      expect(isRunTerminal(terminal)).toBe(true)
      expect(isTerminalState("run", terminal)).toBe(true)
      for (const target of RUN_STATES) {
        expect(canTransitionRun(terminal, target)).toBe(false)
        expect(() => transitionRun(terminal, target)).toThrow(InvalidStateTransitionError)
      }
    }
  })
})

describe("Task state machine and transitions", () => {
  it("exhaustively tests all pairs in Cartesian product of TASK_STATES (8x8 = 64 pairs)", () => {
    let checkedTransitions = 0

    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        checkedTransitions += 1
        const allowedTargets = TASK_TRANSITIONS[from]
        const isAllowed = allowedTargets.includes(to)
        const isTerminal = isTaskTerminal(from)

        expect(canTransitionTask(from, to)).toBe(isAllowed)
        expect(canTransition("task", from, to)).toBe(isAllowed)

        if (isAllowed) {
          expect(transitionTask(from, to)).toBe(to)
          const tryRes = tryTransitionTask(from, to)
          expect(tryRes.ok).toBe(true)
          if (tryRes.ok) {
            expect(tryRes.value).toBe(to)
          }
        } else {
          expect(() => transitionTask(from, to)).toThrow(InvalidStateTransitionError)
          try {
            transitionTask(from, to)
          } catch (err) {
            expect(err).toBeInstanceOf(InvalidStateTransitionError)
            const transitionErr = err as InvalidStateTransitionError
            expect(transitionErr.entity).toBe("task")
            expect(transitionErr.fromState).toBe(from)
            expect(transitionErr.toState).toBe(to)
            expect(transitionErr.isTerminal).toBe(isTerminal)
          }

          const tryRes = tryTransitionTask(from, to)
          expect(tryRes.ok).toBe(false)
          if (!tryRes.ok) {
            expect(tryRes.error.category).toBe("conflict")
            expect(tryRes.error.code).toBe(isTerminal ? "state.terminal_immutable" : "state.invalid_transition")
          }
        }
      }
    }

    expect(checkedTransitions).toBe(64)
  })

  it("walks positive lifecycle paths for Task", () => {
    // Normal success: draft -> pending -> ready -> running -> completed
    let state: TaskState = "draft"
    state = transitionTask(state, "pending")
    state = transitionTask(state, "ready")
    state = transitionTask(state, "running")
    state = transitionTask(state, "completed")
    expect(state).toBe("completed")
    expect(isTaskTerminal(state)).toBe(true)

    // Retry path: draft -> pending -> ready -> running -> ready (retry) -> running -> completed
    state = "draft"
    state = transitionTask(state, "pending")
    state = transitionTask(state, "ready")
    state = transitionTask(state, "running")
    state = transitionTask(state, "ready")
    expect(state).toBe("ready")
    state = transitionTask(state, "running")
    state = transitionTask(state, "completed")
    expect(state).toBe("completed")

    // Failed path: draft -> pending -> ready -> running -> failed
    state = "draft"
    state = transitionTask(state, "pending")
    state = transitionTask(state, "ready")
    state = transitionTask(state, "running")
    state = transitionTask(state, "failed")
    expect(state).toBe("failed")
    expect(isTaskTerminal(state)).toBe(true)

    // Skipped path: draft -> pending -> skipped
    state = "draft"
    state = transitionTask(state, "pending")
    state = transitionTask(state, "skipped")
    expect(state).toBe("skipped")
    expect(isTaskTerminal(state)).toBe(true)

    // Dependency fail path: draft -> pending -> failed
    state = "draft"
    state = transitionTask(state, "pending")
    state = transitionTask(state, "failed")
    expect(state).toBe("failed")

    // Cancel paths
    state = "draft"
    state = transitionTask(state, "cancelled")
    expect(state).toBe("cancelled")

    state = "draft"
    state = transitionTask(state, "pending")
    state = transitionTask(state, "cancelled")
    expect(state).toBe("cancelled")

    state = "draft"
    state = transitionTask(state, "pending")
    state = transitionTask(state, "ready")
    state = transitionTask(state, "cancelled")
    expect(state).toBe("cancelled")

    state = "draft"
    state = transitionTask(state, "pending")
    state = transitionTask(state, "ready")
    state = transitionTask(state, "running")
    state = transitionTask(state, "cancelled")
    expect(state).toBe("cancelled")
  })

  it("strictly enforces terminal immutability for Task", () => {
    for (const terminal of TASK_TERMINAL_STATES) {
      expect(isTaskTerminal(terminal)).toBe(true)
      expect(isTerminalState("task", terminal)).toBe(true)
      for (const target of TASK_STATES) {
        expect(canTransitionTask(terminal, target)).toBe(false)
        expect(() => transitionTask(terminal, target)).toThrow(InvalidStateTransitionError)
      }
    }
  })
})

describe("Dispatch state machine and transitions", () => {
  it("exhaustively tests all pairs in Cartesian product of DISPATCH_STATES (8x8 = 64 pairs)", () => {
    let checkedTransitions = 0

    for (const from of DISPATCH_STATES) {
      for (const to of DISPATCH_STATES) {
        checkedTransitions += 1
        const allowedTargets = DISPATCH_TRANSITIONS[from]
        const isAllowed = allowedTargets.includes(to)
        const isTerminal = isDispatchTerminal(from)

        expect(canTransitionDispatch(from, to)).toBe(isAllowed)
        expect(canTransition("dispatch", from, to)).toBe(isAllowed)

        if (isAllowed) {
          expect(transitionDispatch(from, to)).toBe(to)
          const tryRes = tryTransitionDispatch(from, to)
          expect(tryRes.ok).toBe(true)
          if (tryRes.ok) {
            expect(tryRes.value).toBe(to)
          }
        } else {
          expect(() => transitionDispatch(from, to)).toThrow(InvalidStateTransitionError)
          try {
            transitionDispatch(from, to)
          } catch (err) {
            expect(err).toBeInstanceOf(InvalidStateTransitionError)
            const transitionErr = err as InvalidStateTransitionError
            expect(transitionErr.entity).toBe("dispatch")
            expect(transitionErr.fromState).toBe(from)
            expect(transitionErr.toState).toBe(to)
            expect(transitionErr.isTerminal).toBe(isTerminal)
          }

          const tryRes = tryTransitionDispatch(from, to)
          expect(tryRes.ok).toBe(false)
          if (!tryRes.ok) {
            expect(tryRes.error.category).toBe("conflict")
            expect(tryRes.error.code).toBe(isTerminal ? "state.terminal_immutable" : "state.invalid_transition")
          }
        }
      }
    }

    expect(checkedTransitions).toBe(64)
  })

  it("walks positive lifecycle paths for Dispatch", () => {
    // Success: proposed -> approved -> running -> completed
    let state: DispatchState = "proposed"
    state = transitionDispatch(state, "approved")
    state = transitionDispatch(state, "running")
    state = transitionDispatch(state, "completed")
    expect(state).toBe("completed")
    expect(isDispatchTerminal(state)).toBe(true)

    // Rejection: proposed -> rejected
    state = "proposed"
    state = transitionDispatch(state, "rejected")
    expect(state).toBe("rejected")
    expect(isDispatchTerminal(state)).toBe(true)

    // Failed: proposed -> approved -> running -> failed
    state = "proposed"
    state = transitionDispatch(state, "approved")
    state = transitionDispatch(state, "running")
    state = transitionDispatch(state, "failed")
    expect(state).toBe("failed")
    expect(isDispatchTerminal(state)).toBe(true)

    // Timeout: proposed -> approved -> running -> timed_out
    state = "proposed"
    state = transitionDispatch(state, "approved")
    state = transitionDispatch(state, "running")
    state = transitionDispatch(state, "timed_out")
    expect(state).toBe("timed_out")
    expect(isDispatchTerminal(state)).toBe(true)

    // Cancelled paths
    state = "proposed"
    state = transitionDispatch(state, "cancelled")
    expect(state).toBe("cancelled")

    state = "proposed"
    state = transitionDispatch(state, "approved")
    state = transitionDispatch(state, "cancelled")
    expect(state).toBe("cancelled")

    state = "proposed"
    state = transitionDispatch(state, "approved")
    state = transitionDispatch(state, "running")
    state = transitionDispatch(state, "cancelled")
    expect(state).toBe("cancelled")
  })

  it("strictly enforces terminal immutability for Dispatch", () => {
    for (const terminal of DISPATCH_TERMINAL_STATES) {
      expect(isDispatchTerminal(terminal)).toBe(true)
      expect(isTerminalState("dispatch", terminal)).toBe(true)
      for (const target of DISPATCH_STATES) {
        expect(canTransitionDispatch(terminal, target)).toBe(false)
        expect(() => transitionDispatch(terminal, target)).toThrow(InvalidStateTransitionError)
      }
    }
  })
})

describe("Approval state machine and transitions", () => {
  it("exhaustively tests all pairs in Cartesian product of APPROVAL_STATES (4x4 = 16 pairs)", () => {
    let checkedTransitions = 0

    for (const from of APPROVAL_STATES) {
      for (const to of APPROVAL_STATES) {
        checkedTransitions += 1
        const allowedTargets = APPROVAL_TRANSITIONS[from]
        const isAllowed = allowedTargets.includes(to)
        const isTerminal = isApprovalTerminal(from)

        expect(canTransitionApproval(from, to)).toBe(isAllowed)
        expect(canTransition("approval", from, to)).toBe(isAllowed)

        if (isAllowed) {
          expect(transitionApproval(from, to)).toBe(to)
          const tryRes = tryTransitionApproval(from, to)
          expect(tryRes.ok).toBe(true)
          if (tryRes.ok) {
            expect(tryRes.value).toBe(to)
          }
        } else {
          expect(() => transitionApproval(from, to)).toThrow(InvalidStateTransitionError)
          try {
            transitionApproval(from, to)
          } catch (err) {
            expect(err).toBeInstanceOf(InvalidStateTransitionError)
            const transitionErr = err as InvalidStateTransitionError
            expect(transitionErr.entity).toBe("approval")
            expect(transitionErr.fromState).toBe(from)
            expect(transitionErr.toState).toBe(to)
            expect(transitionErr.isTerminal).toBe(isTerminal)
          }

          const tryRes = tryTransitionApproval(from, to)
          expect(tryRes.ok).toBe(false)
          if (!tryRes.ok) {
            expect(tryRes.error.category).toBe("conflict")
            expect(tryRes.error.code).toBe(isTerminal ? "state.terminal_immutable" : "state.invalid_transition")
          }
        }
      }
    }

    expect(checkedTransitions).toBe(16)
  })

  it("walks positive lifecycle paths for Approval", () => {
    // Approved: pending -> approved
    let state: ApprovalState = "pending"
    state = transitionApproval(state, "approved")
    expect(state).toBe("approved")

    // Invalidation after approval (e.g. envelope digest changed): approved -> invalidated
    state = transitionApproval(state, "invalidated")
    expect(state).toBe("invalidated")
    expect(isApprovalTerminal(state)).toBe(true)

    // Rejected: pending -> rejected
    state = "pending"
    state = transitionApproval(state, "rejected")
    expect(state).toBe("rejected")
    expect(isApprovalTerminal(state)).toBe(true)

    // Invalidation before decision: pending -> invalidated
    state = "pending"
    state = transitionApproval(state, "invalidated")
    expect(state).toBe("invalidated")
  })

  it("strictly enforces terminal immutability for Approval", () => {
    for (const terminal of APPROVAL_TERMINAL_STATES) {
      expect(isApprovalTerminal(terminal)).toBe(true)
      expect(isTerminalState("approval", terminal)).toBe(true)
      for (const target of APPROVAL_STATES) {
        expect(canTransitionApproval(terminal, target)).toBe(false)
        expect(() => transitionApproval(terminal, target)).toThrow(InvalidStateTransitionError)
      }
    }
  })
})

describe("Session state machine and transitions", () => {
  it("exhaustively tests all pairs in Cartesian product of SESSION_STATES (7x7 = 49 pairs)", () => {
    let checkedTransitions = 0

    for (const from of SESSION_STATES) {
      for (const to of SESSION_STATES) {
        checkedTransitions += 1
        const allowedTargets = SESSION_TRANSITIONS[from]
        const isAllowed = allowedTargets.includes(to)
        const isTerminal = isSessionTerminal(from)

        expect(canTransitionSession(from, to)).toBe(isAllowed)
        expect(canTransition("session", from, to)).toBe(isAllowed)

        if (isAllowed) {
          expect(transitionSession(from, to)).toBe(to)
          const tryRes = tryTransitionSession(from, to)
          expect(tryRes.ok).toBe(true)
          if (tryRes.ok) {
            expect(tryRes.value).toBe(to)
          }
        } else {
          expect(() => transitionSession(from, to)).toThrow(InvalidStateTransitionError)
          try {
            transitionSession(from, to)
          } catch (err) {
            expect(err).toBeInstanceOf(InvalidStateTransitionError)
            const transitionErr = err as InvalidStateTransitionError
            expect(transitionErr.entity).toBe("session")
            expect(transitionErr.fromState).toBe(from)
            expect(transitionErr.toState).toBe(to)
            expect(transitionErr.isTerminal).toBe(isTerminal)
          }

          const tryRes = tryTransitionSession(from, to)
          expect(tryRes.ok).toBe(false)
          if (!tryRes.ok) {
            expect(tryRes.error.category).toBe("conflict")
            expect(tryRes.error.code).toBe(isTerminal ? "state.terminal_immutable" : "state.invalid_transition")
          }
        }
      }
    }

    expect(checkedTransitions).toBe(49)
  })

  it("walks positive lifecycle paths for Session", () => {
    // Multi-turn conversation: launching -> running -> idle -> running -> idle -> completed
    let state: SessionState = "launching"
    state = transitionSession(state, "running")
    state = transitionSession(state, "idle")
    state = transitionSession(state, "running")
    state = transitionSession(state, "idle")
    state = transitionSession(state, "completed")
    expect(state).toBe("completed")
    expect(isSessionTerminal(state)).toBe(true)

    // Direct launch failures
    expect(transitionSession("launching", "failed")).toBe("failed")
    expect(transitionSession("launching", "cancelled")).toBe("cancelled")
    expect(transitionSession("launching", "timed_out")).toBe("timed_out")

    // Running failures
    expect(transitionSession("running", "failed")).toBe("failed")
    expect(transitionSession("running", "cancelled")).toBe("cancelled")
    expect(transitionSession("running", "timed_out")).toBe("timed_out")

    // Idle failures / cancellation
    expect(transitionSession("idle", "failed")).toBe("failed")
    expect(transitionSession("idle", "cancelled")).toBe("cancelled")
    expect(transitionSession("idle", "timed_out")).toBe("timed_out")
  })

  it("strictly enforces terminal immutability for Session", () => {
    for (const terminal of SESSION_TERMINAL_STATES) {
      expect(isSessionTerminal(terminal)).toBe(true)
      expect(isTerminalState("session", terminal)).toBe(true)
      for (const target of SESSION_STATES) {
        expect(canTransitionSession(terminal, target)).toBe(false)
        expect(() => transitionSession(terminal, target)).toThrow(InvalidStateTransitionError)
      }
    }
  })
})

describe("Aggregate generic dispatch and unknown state rejection", () => {
  it("routes transitions through transitionAggregate and tryTransitionAggregate", () => {
    for (const entity of AGGREGATE_ENTITIES) {
      const validFrom = entity === "run" ? "draft" : entity === "task" ? "draft" : entity === "dispatch" ? "proposed" : entity === "approval" ? "pending" : "launching"
      const validTo = entity === "run" ? "active" : entity === "task" ? "pending" : entity === "dispatch" ? "approved" : entity === "approval" ? "approved" : "running"

      expect(transitionAggregate(entity, validFrom, validTo)).toBe(validTo)
      const res = tryTransitionAggregate(entity, validFrom, validTo)
      expect(res.ok).toBe(true)
    }
  })

  it("rejects unknown source and target states", () => {
    expect(() => transitionRun("unknown" as any, "active")).toThrow(InvalidStateTransitionError)
    expect(() => transitionRun("draft", "unknown" as any)).toThrow(InvalidStateTransitionError)
    expect(() => transitionTask("unknown" as any, "pending")).toThrow(InvalidStateTransitionError)
    expect(() => transitionDispatch("unknown" as any, "approved")).toThrow(InvalidStateTransitionError)
    expect(() => transitionApproval("unknown" as any, "approved")).toThrow(InvalidStateTransitionError)
    expect(() => transitionSession("unknown" as any, "running")).toThrow(InvalidStateTransitionError)
  })
})
