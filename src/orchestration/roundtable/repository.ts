/**
 * In-memory and replayable repository for Roundtable deliberation aggregates.
 *
 * Provides lifecycle storage for advisory deliberation sessions, enforcing
 * uniqueness of discussion IDs, immutable open membership, and monotonic
 * per-discussion sequence numbers.
 */

import type { Result } from "../errors.js"
import type { OrchestrationEvent } from "../types.js"
import { appendPost, closeRoundtable, openRoundtable } from "./aggregate.js"
import {
  RoundtableAlreadyExistsError,
  RoundtableNotFoundError,
  type Post,
  type Roundtable,
  type RoundtableAggregateState,
  type RoundtableOutcome,
} from "./types.js"

export class RoundtableRepository {
  readonly #discussions = new Map<string, RoundtableAggregateState>()

  /**
   * Retrieves a roundtable aggregate by discussion identifier.
   */
  get(discussionId: string): RoundtableAggregateState | undefined {
    return this.#discussions.get(discussionId)
  }

  /**
   * Checks whether a roundtable exists.
   */
  has(discussionId: string): boolean {
    return this.#discussions.has(discussionId)
  }

  /**
   * Lists all roundtables associated with a specific run.
   */
  listByRun(runId: string): readonly RoundtableAggregateState[] {
    const matched: RoundtableAggregateState[] = []
    for (const discussion of this.#discussions.values()) {
      if (discussion.roundtable.runId === runId) {
        matched.push(discussion)
      }
    }
    return matched
  }

  /**
   * Lists all roundtables associated with a specific task.
   */
  listByTask(taskId: string): readonly RoundtableAggregateState[] {
    const matched: RoundtableAggregateState[] = []
    for (const discussion of this.#discussions.values()) {
      if (discussion.roundtable.taskId === taskId) {
        matched.push(discussion)
      }
    }
    return matched
  }

  /**
   * Checks whether a closed roundtable deliberation session with a recorded outcome exists for a task.
   */
  hasClosedDeliberationForTask(taskId: string): boolean {
    for (const discussion of this.#discussions.values()) {
      if (
        discussion.roundtable.taskId === taskId &&
        discussion.roundtable.state === "closed" &&
        discussion.outcome !== undefined
      ) {
        return true
      }
    }
    return false
  }

  /**
   * Opens a new roundtable deliberation session.
   * Duplicate discussion IDs are refused with `roundtable.already_exists`.
   */
  open(roundtable: Roundtable): Result<RoundtableAggregateState> {
    if (this.#discussions.has(roundtable.id)) {
      return {
        ok: false,
        error: new RoundtableAlreadyExistsError(roundtable.id).toContractError(),
      }
    }

    const result = openRoundtable(roundtable)
    if (!result.ok) {
      return result
    }

    this.#discussions.set(roundtable.id, result.value)
    return result
  }

  /**
   * Posts to an existing roundtable deliberation session.
   * Refuses if discussion is unknown, closed, or poster is not a member.
   */
  post(
    postInput: Omit<Post, "seq"> & { readonly seq?: number },
    isHumanInjection = false,
  ): Result<{ readonly nextState: RoundtableAggregateState; readonly post: Post }> {
    const existing = this.#discussions.get(postInput.discussionId)
    if (!existing) {
      return {
        ok: false,
        error: new RoundtableNotFoundError(postInput.discussionId).toContractError(),
      }
    }

    const result = appendPost(existing, postInput, isHumanInjection)
    if (!result.ok) {
      return result
    }

    this.#discussions.set(postInput.discussionId, result.value.nextState)
    return result
  }

  /**
   * Closes an existing roundtable deliberation session with an advisory outcome.
   * Refuses if discussion is unknown or already closed.
   */
  close(
    discussionId: string,
    outcome: RoundtableOutcome,
  ): Result<{ readonly nextState: RoundtableAggregateState; readonly outcome: RoundtableOutcome }> {
    const existing = this.#discussions.get(discussionId)
    if (!existing) {
      return {
        ok: false,
        error: new RoundtableNotFoundError(discussionId).toContractError(),
      }
    }

    const result = closeRoundtable(existing, outcome)
    if (!result.ok) {
      return result
    }

    this.#discussions.set(discussionId, result.value.nextState)
    return result
  }

  /**
   * Replays roundtable events to reconstruct aggregate states from log history.
   */
  replayFromEvents(events: readonly OrchestrationEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "roundtable.opened": {
          this.open(event.payload.roundtable)
          break
        }
        case "roundtable.posted": {
          const isHuman = event.payload.post.authorRoleId === "human"
          this.post(event.payload.post, isHuman)
          break
        }
        case "roundtable.outcome_recorded": {
          this.close(event.payload.discussionId, event.payload.outcome)
          break
        }
        default:
          break
      }
    }
  }

  /**
   * Clears all stored discussions (testing harness utility).
   */
  clear(): void {
    this.#discussions.clear()
  }
}
