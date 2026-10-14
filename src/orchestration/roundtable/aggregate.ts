/**
 * Roundtable Deliberation Aggregate State Transitions.
 *
 * Implements pure state-transition functions governing roundtable deliberation:
 * opening a discussion with fixed membership, appending posts with deterministic
 * sequence ordering, and closing a discussion with an advisory outcome.
 *
 * Invariants:
 * 1. Monotonic Per-Discussion Sequence (§6.3):
 *    Sequence numbers `seq` are assigned deterministically at append time as
 *    strictly increasing integers: `posts.length + 1`.
 *
 * 2. Immutable Membership at Open (§10):
 *    Membership is fixed at opening time. Only declared members may post, with the
 *    exception of human injection (`roundtable.inject_human`), where `authorRoleId`
 *    must be `"human"`.
 *
 * 3. Advisory Outcome (§7.5):
 *    Closing records a `RoundtableOutcome` advisory document; this aggregate state
 *    transition never mutates external task or run lifecycle states.
 */

import type { Result } from "../errors.js"
import {
  RoundtableClosedError,
  RoundtableInvalidAuthorError,
  RoundtableMembershipError,
  RoundtableNonMemberError,
  type Post,
  type Roundtable,
  type RoundtableAggregateState,
  type RoundtableOutcome,
} from "./types.js"

/**
 * Initializes a new roundtable aggregate state from an open roundtable document.
 */
export function openRoundtable(roundtable: Roundtable): Result<RoundtableAggregateState> {
  if (roundtable.state !== "open") {
    return {
      ok: false,
      error: new RoundtableMembershipError(`Roundtable '${roundtable.id}' must be opened in state 'open', got '${roundtable.state}'`).toContractError(),
    }
  }

  if (roundtable.members.length === 0) {
    return {
      ok: false,
      error: new RoundtableMembershipError(`Roundtable '${roundtable.id}' must specify at least one participant member`).toContractError(),
    }
  }

  const chairIsMember = roundtable.members.some((member) => member.nodeId === roundtable.chairNodeId)
  if (!chairIsMember) {
    return {
      ok: false,
      error: new RoundtableMembershipError(
        `Roundtable '${roundtable.id}' chair node '${roundtable.chairNodeId}' must be included in participant members`,
      ).toContractError(),
    }
  }

  return {
    ok: true,
    value: {
      roundtable,
      posts: [],
    },
  }
}

/**
 * Appends a post to an open roundtable discussion, assigning the sequence number deterministically.
 */
export function appendPost(
  state: RoundtableAggregateState,
  postInput: Omit<Post, "seq"> & { readonly seq?: number },
  isHumanInjection = false,
): Result<{ readonly nextState: RoundtableAggregateState; readonly post: Post }> {
  if (state.roundtable.state !== "open") {
    return {
      ok: false,
      error: new RoundtableClosedError(state.roundtable.id).toContractError(),
    }
  }

  if (isHumanInjection) {
    if (postInput.authorRoleId !== "human") {
      return {
        ok: false,
        error: new RoundtableInvalidAuthorError(postInput.authorRoleId).toContractError(),
      }
    }
  } else {
    const isMember = state.roundtable.members.some(
      (member) => member.nodeId === postInput.authorNodeId && member.roleId === postInput.authorRoleId,
    )
    if (!isMember) {
      return {
        ok: false,
        error: new RoundtableNonMemberError(
          state.roundtable.id,
          postInput.authorNodeId,
          postInput.authorRoleId,
        ).toContractError(),
      }
    }
  }

  const seq = state.posts.length + 1
  const post: Post = {
    ...postInput,
    seq,
  }

  const nextState: RoundtableAggregateState = {
    ...state,
    posts: [...state.posts, post],
  }

  return {
    ok: true,
    value: {
      nextState,
      post,
    },
  }
}

/**
 * Closes an open roundtable deliberation, recording the advisory outcome document.
 * Closing an already closed discussion is refused.
 */
export function closeRoundtable(
  state: RoundtableAggregateState,
  outcome: RoundtableOutcome,
): Result<{ readonly nextState: RoundtableAggregateState; readonly outcome: RoundtableOutcome }> {
  if (state.roundtable.state !== "open") {
    return {
      ok: false,
      error: new RoundtableClosedError(
        state.roundtable.id,
        `roundtable.closed: Discussion '${state.roundtable.id}' is already closed; closing twice is refused`,
      ).toContractError(),
    }
  }

  const nextState: RoundtableAggregateState = {
    ...state,
    roundtable: {
      ...state.roundtable,
      state: "closed",
    },
    outcome,
  }

  return {
    ok: true,
    value: {
      nextState,
      outcome,
    },
  }
}
