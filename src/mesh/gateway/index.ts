/**
 * `src/mesh/gateway/` — the three mesh gateways, in one place.
 *
 * It exists because the alternative is three import paths that a consumer has to
 * know the shape of, and the three are the same shape: a pure seam plus one
 * framework adapter. Naming them together is what lets a reader see that
 * M4.6's events, M4.6's reconciler and M4.7's terminal all obey the same two
 * rules — the decision lives in a pure function, and the route composes no
 * authentication of its own — without opening three directories to find out.
 *
 * What the three share, and it is not a coincidence:
 *
 *   - Each route authenticates through M4.2's `createMeshIdentityHook`,
 *     unmodified. There is no second credential anywhere under this directory,
 *     and `./terminal/route.ts` repeats M4.2's reason at length because a
 *     terminal socket is the route where adding "just a bearer token as well" is
 *     most tempting and most wrong.
 *   - Each is clock-injected, so every bound in §6 of the protocol spec is a
 *     number in a test rather than a sleep.
 *   - Each refuses a record it cannot fully understand rather than reading it
 *     partially, because the M0 contract re-approval established that partial
 *     reads are how an unversionable break becomes permanent.
 */

export * from "./events/index.js"
export * from "./reconcile/index.js"
export * from "./terminal/index.js"
