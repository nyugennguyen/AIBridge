import type { FastifyInstance } from "fastify"
import { createContractError, type ContractError, type Result } from "../../../orchestration/errors.js"
import { projectIdSchema, runIdSchema } from "../../../orchestration/identifiers.js"
import { createMeshIdentityHook, type MeshIdentityHookOptions } from "../../identity/middleware.js"
import { cursorFromRequest, encodeEventFrame, encodePreamble, encodeSnapshotFrame, SSE_RETRY_MS } from "./sse.js"
import type { EventStreamGateway, ReplayScope } from "./types.js"

/**
 * The SSE transport, and the ONLY module in `events/` allowed to touch the
 * framework — for the same reason `src/mesh/identity/middleware.ts` is the only
 * module there allowed to: everything that is a DECISION lives in a pure function
 * elsewhere, and what is left here is the part that can only be proven with a
 * request.
 *
 * Four things are load-bearing about the order below, and each of them is a
 * property a reader can only check against a real route:
 *
 *   1. **Authentication is a `preHandler`, and it runs before any byte.** The plan
 *      requires the stream to be authenticated, and "the handler does not run" is
 *      the half that is only observable here — a gateway that checked the signature
 *      and then streamed anyway would pass every test of the pure functions. The
 *      hook is M4.2's own, unmodified, so the shared bridge bearer token is not an
 *      alternative here for the reasons that file gives at length.
 *   2. **A refusal is a status code and a JSON body, never a stream.** A cursor
 *      that cannot be honoured, or a cursor from another stream, is answered before
 *      the headers are switched to `text/event-stream`. A client that received an
 *      SSE stream containing an error object would have to parse a refusal out of
 *      an event frame, and a conforming client branches on `event:` — so an error
 *      that arrived as a frame is a client that silently believes it is
 *      subscribed.
 *   3. **The re-base frame is written BEFORE any `mesh.event` frame, and carries
 *      no `id:`.** The absence of the id is the second half of detectability: a
 *      snapshot that carried one would tell the client it had consumed up to there,
 *      which is the false "everything after this point is accounted for" claim the
 *      fallback exists to avoid. See `./sse.ts`.
 *   4. **The scope is read from the query, never from the retained window.** Both
 *      ids are parsed through the kernel's own schemas, so an unparseable scope is
 *      a 400 rather than a read keyed on whatever the caller typed.
 */

export const MESH_EVENT_STREAM_PATH = "/v1/mesh/events"

export interface EventStreamRouteDependencies {
  readonly gateway: EventStreamGateway
  /** M4.2's hook options. Passed straight through; this route composes no auth. */
  readonly identity: MeshIdentityHookOptions
  /** The `retry:` hint. A hint, not a contract. */
  readonly retryMs?: number
  /**
   * Resolves the `(projectId, runId)` a request is for, from its QUERY.
   *
   * It takes the query and NOT the request, and that is a deliberate narrowing: a
   * signature-covering `signedPath` already binds the query string, and a resolver
   * handed the whole request would have the headers available to it too — at which
   * point "which run is this stream for" has a second possible answer, and the
   * caller picks.
   *
   * REQUIRED whenever a request could carry a cursor, because the snapshot fallback
   * is filed under a scope and a caller that omitted it would get
   * `snapshot_unavailable` for a run this node does hold a snapshot for.
   */
  readonly scopeOf: (query: unknown) => Result<ReplayScope>
}

export function registerEventStreamRoute(app: FastifyInstance, dependencies: EventStreamRouteDependencies): void {
  app.get(MESH_EVENT_STREAM_PATH, { preHandler: createMeshIdentityHook(dependencies.identity) }, async (request, reply) => {
    const scope = dependencies.scopeOf(request.query)
    if (!scope.ok) {
      // Before the headers. A scope that cannot be parsed must not become an SSE
      // response, because the only way a client learns it was refused is the
      // status code.
      return reply.code(400).send({ error: scope.error })
    }

    const cursor = cursorFromRequest({ headers: request.headers as Record<string, unknown>, query: request.query })
    if (!cursor.ok) {
      return reply.code(400).send({ error: cursor.error })
    }

    const resumed = await dependencies.gateway.resume(cursor.value, { scope: scope.value })
    if (resumed.kind === "refused") {
      return reply.code(statusForRefusal(resumed.error)).send({ error: resumed.error })
    }

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and every other buffering proxy in front of a Tailscale link will
      // otherwise hold the stream until its buffer fills, which for a
      // low-traffic orchestration stream is forever. The client asked to be
      // notified as events happen; a proxy that batches them has changed the
      // contract without anybody deciding to.
      "x-accel-buffering": "no",
    })
    raw.write(encodePreamble(dependencies.retryMs ?? SSE_RETRY_MS))

    if (resumed.kind === "snapshot_required") {
      // FIRST, and the only frame with no `id:`. A client that re-bases then asks
      // for the head again; it does not receive a page here, because the page and
      // the snapshot are on two different orderings and a client cannot reconcile
      // the two from the wire.
      raw.write(encodeSnapshotFrame(resumed.rebase))
      raw.end()
      return
    }

    for (const entry of resumed.entries) raw.write(encodeEventFrame(entry))
    raw.end()
  })
}

/**
 * Which HTTP status a refusal becomes.
 *
 * `validation` is 400 and everything else is 409, and the split is the same one
 * the identity middleware makes: "we do not accept this request" versus "we
 * accept it and it conflicts with what we hold". A cursor below the retention floor
 * and a cursor from another stream are BOTH conflicts with this gateway's state,
 * and answering either with 400 would tell an operator the request was malformed
 * when the request was fine and the answer was no.
 */
function statusForRefusal(error: ContractError): 400 | 409 {
  return error.category === "validation" ? 400 : 409
}

/**
 * The scope of a stream request, from `?projectId=` and `?runId=`.
 *
 * A helper rather than an inline parse because the integration tests and the
 * route need the same rule, and a second copy of "which query parameter names the
 * run" is a second answer to it.
 */
export function scopeFromQuery(query: unknown): Result<ReplayScope> {
  const read = (key: string): unknown => {
    if (typeof query !== "object" || query === null) return undefined
    return (query as Record<string, unknown>)[key]
  }
  const projectId = projectIdSchema.safeParse(read("projectId"))
  if (!projectId.success) return missingScope("projectId")
  const runId = runIdSchema.safeParse(read("runId"))
  if (!runId.success) return missingScope("runId")
  return { ok: true, value: { projectId: projectId.data, runId: runId.data } }
}

function missingScope(parameter: string): { ok: false; error: ContractError } {
  return {
    ok: false,
    error: createContractError(
      "validation",
      "mesh.stream_scope_required",
      `The event stream is scoped to one run and '${parameter}' was not a well-formed mesh id. The scope is required rather than optional because the snapshot fallback is filed under a (projectId, runId) pair: a stream that did not say which run it was could be answered with another run's state, and reading the scope out of whatever the gateway happened to retain would do exactly that without anybody choosing to.`,
    ),
  }
}
