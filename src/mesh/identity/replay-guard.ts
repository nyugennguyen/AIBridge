import { createContractError, type Result } from "../../orchestration/errors.js"
import {
  MAX_FUTURE_SKEW_MS,
  MAX_REQUEST_AGE_MS,
  type ReplayGuard,
} from "./request-signature.js"

/**
 * One-time nonces.
 *
 * A freshness window alone does not stop replay. A signature that is valid for
 * five minutes is replayable five hundred times in those five minutes, and the
 * thing it authorises — a command, a terminal attach, an enrollment — is not
 * idempotent. The nonce is what makes "valid for five minutes" mean "valid once".
 *
 * The bound that matters is not the size of the store, it is HOW LONG an entry
 * lives. An entry may be forgotten only once no request bearing it can still be
 * accepted, which is `MAX_REQUEST_AGE_MS` after the timestamp that produced it —
 * hence {@link DEFAULT_NONCE_RETENTION_MS} being the age bound plus the future
 * skew, not the age bound alone. Evicting a nonce that is still inside its
 * acceptance window converts a bounded replay exposure into an unbounded one, and
 * it is the kind of "memory optimisation" that gets made without anyone reading
 * the arithmetic.
 */

/**
 * How long a nonce is remembered.
 *
 * `MAX_REQUEST_AGE_MS + MAX_FUTURE_SKEW_MS`, computed rather than restated: a
 * request timestamped up to the skew into the future is still acceptable until
 * it is `MAX_REQUEST_AGE_MS` old, so a shorter retention would forget it while it
 * still verifies.
 */
export const DEFAULT_NONCE_RETENTION_MS = MAX_REQUEST_AGE_MS + MAX_FUTURE_SKEW_MS

/**
 * How many nonces are remembered before the guard refuses.
 *
 * Bounded because an unbounded map keyed by an unauthenticated value is a memory
 * exhaustion vector, and the milestone's own stop conditions include resource
 * exhaustion. The bound is reached by FLOODING, and the answer to a flood is to
 * refuse — not to evict a live nonce, and not to grow.
 *
 * The refusal is `internal_failure` and not retryable by the client: a client
 * that retries through a full guard is the flood. An operator's next action is to
 * look at request volume.
 */
export const DEFAULT_MAX_TRACKED_NONCES = 100_000

export interface NonceGuardOptions {
  readonly retentionMs?: number
  readonly maxTracked?: number
}

/**
 * The in-memory replay guard.
 *
 * Process-local, and the seam exists precisely because that is a real limit: a
 * controller running N processes needs the guard to be SHARED, or each process
 * accepts the nonces the other has already seen. This milestone has no multi-
 * process controller — a run is governed by one controller under one lease — so
 * the limit does not bind yet. The interface is the seam, and a durable
 * implementation is a `ReplayGuard` over the same store the pins live in.
 *
 * `consume` is SYNCHRONOUS. The check and the write are the same turn, which is
 * the property that stops two concurrent replays of one request from both being
 * recorded as first use. A durable implementation makes that pair one transaction
 * and keeps the signature.
 */
export class InMemoryNonceGuard implements ReplayGuard {
  readonly #seen = new Map<string, number>()
  readonly #retentionMs: number
  readonly #maxTracked: number

  constructor(options: NonceGuardOptions = {}) {
    this.#retentionMs = options.retentionMs ?? DEFAULT_NONCE_RETENTION_MS
    this.#maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED_NONCES
  }

  consume(key: string, now: number): Result<"recorded" | "replay"> {
    if (!Number.isSafeInteger(now) || now < 0) {
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "identity.invalid_time",
          "The replay guard was given a clock value that is not a non-negative integer epoch millisecond count. It refuses rather than recording the nonce against a deadline it cannot compute.",
        ),
      }
    }
    this.#prune(now)
    const previous = this.#seen.get(key)
    if (previous !== undefined && previous > now) {
      return { ok: true, value: "replay" }
    }
    if (this.#seen.size >= this.#maxTracked) {
      // Refuse rather than evict. Evicting here would let an unauthenticated
      // flood invalidate a legitimate node's nonces — a denial of service that
      // needs no credentials at all — and refusing turns the same flood into a
      // visible, bounded outage instead.
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "identity.replay_store_full",
          `The replay guard is holding ${this.#seen.size} unexpired nonces, at its ${this.#maxTracked} bound. Requests are refused until the window advances. Evicting a live nonce to make room would turn an unauthenticated flood into a denial of service against legitimate nodes, so the guard refuses instead.`,
        ),
      }
    }
    this.#seen.set(key, now + this.#retentionMs)
    return { ok: true, value: "recorded" }
  }

  /** Drops entries whose retention has elapsed. O(n), once per request. */
  #prune(now: number): void {
    for (const [key, expiresAt] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(key)
    }
  }

  get size(): number {
    return this.#seen.size
  }
}

/**
 * A replay guard that refuses every request.
 *
 * For a deployment that has not wired a real one. The alternative — an
 * implementation that accepts everything, which is what a stub that returns
 * `true` does — disables replay defence while looking enabled, and the test
 * suite stays green. This one is visibly broken instead.
 */
export class RefusingNonceGuard implements ReplayGuard {
  consume(): Result<"recorded" | "replay"> {
    return {
      ok: false,
      error: createContractError(
        "internal_failure",
        "identity.replay_guard_absent",
        "No replay guard is configured, so no request can be authenticated. A guard that accepted everything would leave replay defence switched off while appearing enabled.",
      ),
    }
  }
}
