import { timestampSchema, type Timestamp } from "../../orchestration/identifiers.js"

/**
 * The only place a number becomes a wire timestamp in this module.
 *
 * Every pure function here takes `now` as a parameter and nothing in
 * `src/mesh/identity/` calls `Date.now()`. That is not a style preference: the
 * mesh scenarios this milestone has to be testable for are "ten minutes after
 * this code expired" and "thirty seconds after a lease stopped being renewed",
 * and a module that reads the clock itself can only be tested by sleeping. The
 * two exceptions are the filesystem key store and the Fastify adapter, and each
 * states that it is one of the two.
 *
 * The branding matters for a second reason. `Timestamp` is a branded string, so
 * handing a `NodeId` where a timestamp is wanted is a compile error; converting
 * through one function means no call site has to reach into Zod to do it, and no
 * call site can quietly substitute a `Date` for a `Timestamp`.
 */

/** Milliseconds since the epoch, from a wire timestamp. */
export function msOf(timestamp: Timestamp): number {
  return Date.parse(timestamp)
}

/** A wire timestamp from milliseconds since the epoch. */
export function toTimestamp(ms: number): Timestamp {
  // `new Date(ms)` is a CONVERSION of a number the caller supplied, not a read of the
  // clock: the argument-less `new Date()` is the ambient one and appears nowhere in
  // this directory. That distinction is the whole reason this module can convert a
  // timestamp at all while remaining testable — a test asserting "an hour after this
  // code expired" is a number, not a sleep.
  return timestampSchema.parse(new Date(ms).toISOString())
}
