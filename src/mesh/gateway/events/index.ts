/**
 * M4.6 — the SSE event gateway, the M4-S snapshot policy, and the M4-B projection
 * hook.
 *
 * The seam M4.8 (TUI mesh and takeover UX) and M4.9 (the two-node fault harness)
 * consume. Six things a consumer must know before importing anything from here:
 *
 *   1. **`MeshEventGateway` assigns the ONLY total order over the events one SSE
 *      client reads.** The kernel's `sequence` is per-RUN and the mesh's
 *      `localSequence` is per-SOURCE-NODE, so neither orders a stream that mixes
 *      runs and workers. `position` is assigned at accept time, it is gapless, and
 *      it is the only thing `Last-Event-ID` ever carries.
 *   2. **A cursor that cannot be honoured is NEVER answered with the head.**
 *      `resume` returns `snapshot_required` (an explicit re-base) or `refused`. The
 *      third answer — "here is the newest thing I have" — is the one a client
 *      cannot detect, and a client applying later events over a state it never
 *      received the intervening ones for produces a projection derived from a
 *      stream it never saw. The client's next action differs for the two real
 *      answers too: one re-bases, the other stops and tells an operator.
 *   3. **Retention is FINITE and named**, and that is the whole point: a gateway
 *      that retained everything could always answer a cursor and would then never
 *      have to admit it could not. The bound is both a count and an age, and the age
 *      is measured with THIS node's clock rather than the sender's `observedAt`, so
 *      a fast-clocked peer cannot age its own events out of a peer's window.
 *   4. **`versionError` separates "upgrade the peer" from "your sender is
 *      broken".** `publish` surfaces `safeParseMeshEnvelope`'s flag rather than
 *      collapsing the two into one code, because a version-skewed node answered with
 *      a sender-bug code retries forever and a sender bug answered with a version
 *      code sends an operator to reinstall a node that needs a fix.
 *   5. **M4-S is one rule with two halves.** `./projection-updater.ts` WRITES
 *      (`saveSnapshot`, driven by the projection engine, and it is where M4-B hook 7
 *      fires); `./snapshot-source.ts` READS (`getSnapshot`, and it RECOMPUTES the
 *      digest from the state rather than echoing the stored column, so a client can
 *      check what it was handed). `readGlobal` is reachable through the rebuild path
 *      `./projection-updater.ts#applyAll` serves. A re-base therefore never promises
 *      per-attempt envelope history — R3 says a same-`dispatchId` revision REPLACES
 *      the envelope, so the superseded one is not rebuildable from a projection, and
 *      no member of the re-base may imply otherwise.
 *   6. **The route authenticates through M4.2's `createMeshIdentityHook` and writes
 *      nothing before it passes.** The shared bridge bearer token is not an
 *      alternative; `./middleware.ts` in that directory says why at length, and the
 *      reason is not only that a bearer is not per-node — it is that a bearer is not
 *      a SIGNATURE, so any hop that can see the header can replay it forever.
 *
 * Purity: only `./route.ts` touches the framework, and it composes no
 * authentication of its own. Everything else is pure and clock-injected, so
 * "ten minutes after the retention window closed" is a number rather than a wait,
 * and the SSE tests never sleep.
 */

export {
  MESH_EVENT_RESUME_LIMIT,
  MESH_EVENT_RETENTION_MAX_AGE_MS,
  MESH_EVENT_RETENTION_MAX_EVENTS,
  type EventGatewayDependencies,
  type EventStreamCursor,
  type EventStreamGateway,
  type GatewayPublishOutcome,
  type GatewayPublishResult,
  type GatewayRefusalKind,
  type GatewayResume,
  type GatewayResumeOptions,
  type ProjectionBoundary,
  type ProjectionSnapshotStore,
  type ProjectionUpdateResult,
  type ProjectionUpdaterDependencies,
  type ReconcileScope,
  type ReplayScope,
  type SnapshotFallbackSource,
  type SnapshotRebase,
  type StreamedEvent,
  type UnacknowledgedSource,
} from "./types.js"

export { MeshEventGateway } from "./gateway.js"

export {
  RUN_AGGREGATE_TYPE,
  MeshProjectionUpdater,
  digestOfSnapshotState,
  snapshotDigestMismatch,
} from "./projection-updater.js"

export { ProjectionSnapshotFallback } from "./snapshot-source.js"

export {
  SSE_EVENT_NAME,
  SSE_FRAME_NAMES,
  SSE_RETRY_MS,
  SSE_SNAPSHOT_EVENT_NAME,
  cursorFromRequest,
  decodeFrames,
  encodeEventFrame,
  encodePreamble,
  encodeSnapshotFrame,
  type SseFrame,
} from "./sse.js"

export {
  MESH_EVENT_STREAM_PATH,
  registerEventStreamRoute,
  scopeFromQuery,
  type EventStreamRouteDependencies,
} from "./route.js"
