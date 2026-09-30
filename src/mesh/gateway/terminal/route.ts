// Type-only, and LOAD-BEARING rather than decorative: `@fastify/websocket` declares
// its `FastifyRequest.ws` flag and its `websocket: true` route overload inside a
// `declare module "fastify"` block in its own `.d.ts`, and a module augmentation
// only takes effect when that declaration file is part of the program. This
// import is what puts it there. Without it, `app.get(path, { websocket: true },
// ...)` does not typecheck at all, and the failure reads as "the plugin has no
// such option" rather than "the augmentation was never loaded".
import type {} from "@fastify/websocket"
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify"
import { createContractError, type ContractError } from "../../../orchestration/errors.js"
import type { NodeId } from "../../../orchestration/identifiers.js"
import { authenticatedNodeFor, createMeshIdentityHook, type MeshIdentityHookOptions } from "../../identity/middleware.js"
import type { MeshTerminalGateway, TerminalAttachDecision, TerminalInboundFrame, TerminalSocket } from "./types.js"

/**
 * M4.7 — the Fastify and WebSocket adapter. THIS MODULE IS ALLOWED TO TOUCH THE
 * FRAMEWORK AND THE SOCKET, and nothing else under `src/mesh/gateway/terminal/`
 * is.
 *
 * The same division M4.2's `middleware.ts` and M4.6's `route.ts` use, for the
 * same reason: everything that is a DECISION lives in a pure function elsewhere,
 * and what is left is the part that can only be proven with a real request. A
 * gateway that decided inside its route handler would be a gateway whose
 * authorization could only be tested by opening a socket.
 *
 * ### Four things that are load-bearing about the wiring below
 *
 *   1. **The identity hook is a `preValidation`, not the handler.** On a
 *      `websocket: true` route the plugin overrides the handler so that it
 *      performs `handleUpgrade` — which is the actual protocol switch. Every
 *      Fastify hook runs BEFORE the handler, so a hook that replies 401 means
 *      `handleUpgrade` is never called, the socket is destroyed by the plugin's
 *      `onResponse` hook, and the client receives an HTTP status rather than a
 *      `101` followed by a close frame. That is requirement 1: an unauthenticated
 *      client never reaches the handler. It is also why the hook is M4.2's own,
 *      unmodified — `src/mesh/identity/middleware.ts` says at length why the
 *      bridge's shared bearer token must not be added "in addition" here.
 *   2. **The attach guard is a `preHandler`, after identity.** Fastify's order is
 *      `preValidation` then `preHandler`, so the node is authenticated before the
 *      attach scope is looked at. A guard that ran first would be a project
 *      enumeration oracle for a peer that had presented no credential at all: it
 *      could learn whether a terminal existed by reading the difference between a
 *      400 and a 403.
 *   3. **The guard's decision is stashed on the request, and the handler requires
 *      it.** `gateway.attach` takes a `TerminalAttachDecision` with no overload
 *      that omits it, so the handler cannot attach without a decision having been
 *      taken pre-upgrade. A `WeakMap` rather than a declared field on
 *      `FastifyRequest`, for the reason `authenticatedNodeFor` gives: declaring the
 *      field would put a mesh-terminal question into the type of EVERY request in
 *      the process and make "was this authorized" a question the compiler lets a
 *      route answer `undefined` about.
 *   4. **The socket is adapted to four methods and then forgotten.** After
 *      `attach` the route holds no reference to the connection's frames; it holds
 *      two listeners that push IN to the gateway and nothing else. The gateway
 *      cannot leak a listener, because it never owned one.
 *
 * ### Teardown, and why it is in this file's contract
 *
 * `Docs/implementation-plans/websocket-test-harness.md` §3 measured that
 * `app.close()` HANGS when a graceful close was attempted on this transport. The
 * gateway's `TerminalSocket.close()` therefore maps to `terminate()`, never to
 * `close()`, on both sides: a revocation, a session termination and a peer's own
 * disconnect all have to release a socket that may be the reason for the release.
 * A close frame asks that peer for a handshake, and a peer that is gone, wedged
 * or hostile answers never.
 */

export const MESH_TERMINAL_PATH = "/v1/mesh/terminal"

/**
 * The `ws` surface this adapter uses, as a structural type.
 *
 * Declared here rather than imported from `ws`, for two reasons and the second
 * is the important one. The first is that `@types/ws` is not a dependency of
 * this repository and M4.7 is not allowed to add one. The second is that a
 * structural declaration is a *narrowing*: it names the six members of `ws` this
 * file touches and therefore states exactly what a `ws` upgrade could break. An
 * imported `WebSocket` type would let this file call anything `ws` happens to
 * export, and the record of what the terminal gateway depends on would be a
 * `package.json` version rather than a list.
 *
 * `bufferedAmount` is the whole reason this is worth declaring precisely: it is
 * the transport half of the backpressure bound, and a socket type that did not
 * have it could not be adapted without either dropping the bound or lying about
 * it.
 */
interface WebSocketTransport {
  send(data: string): void
  send(data: Buffer, options: { readonly binary: boolean }): void
  /** The abrupt close. See the note at the top of this file. */
  terminate(): void
  readonly bufferedAmount: number
  on(event: "message", listener: (raw: unknown, isBinary: boolean) => void): void
  on(event: "close" | "error", listener: () => void): void
}

/**
 * The query an attach carries.
 *
 * Every id is a QUERY parameter rather than a header, and the reason is the
 * identity hook's own default `signedPath`: it signs `request.raw.url`, which
 * INCLUDES the query string. So `?projectId=` is inside the signature, and a
 * client that changed the project it is asking for after signing would fail
 * verification. A header would be outside the signature and would let one
 * authenticated node name a project the signature did not cover.
 */
export interface TerminalAttachScope {
  readonly terminalId: string
  readonly projectId: string
  readonly sessionId: string
  readonly clientId: string
  readonly nodeId: string
  readonly epoch: number
}

/**
 * Reads the attach scope from a query.
 *
 * Deliberately takes the QUERY and not the request: the resolver is handed the
 * narrowest thing that carries the answer, so it cannot reach the headers and
 * cannot become a second place where "which node is this" is decided. The
 * `expectedNodeId` M4.2's hook is configured with is the seam's, and a resolver
 * that could read a node id from a header would be a peer naming itself.
 *
 * `epoch` is the one member that arrives as a STRING, because every query
 * parameter does — Fastify's query parser does not coerce. `Number()` is NOT used
 * on it: `Number("")` is `0`, `Number(" 4 ")` is `4` and `Number("0x4")` is `4`,
 * and a controller epoch that can be spelled three different ways is a fence
 * somebody will spell the third way by accident. The digits-only pattern is the
 * whole of the parse, and the gateway's `epochSchema` then has the final say on
 * range — so an unparseable epoch and an out-of-range one are two different
 * answers, which is the distinction an operator needs.
 */
export function terminalAttachScopeFromQuery(query: unknown): TerminalAttachScope | null {
  const read = (key: string): unknown => {
    if (typeof query !== "object" || query === null) return undefined
    return (query as Record<string, unknown>)[key]
  }
  const terminalId = read("terminalId")
  const projectId = read("projectId")
  const sessionId = read("sessionId")
  const clientId = read("clientId")
  const nodeId = read("nodeId")
  const epoch = read("epoch")
  if (typeof terminalId !== "string" || typeof projectId !== "string" || typeof sessionId !== "string" || typeof clientId !== "string" || typeof nodeId !== "string") {
    return null
  }
  if (typeof epoch === "number") return { terminalId, projectId, sessionId, clientId, nodeId, epoch }
  if (typeof epoch !== "string" || !/^[1-9][0-9]{0,15}$/.test(epoch)) return null
  return { terminalId, projectId, sessionId, clientId, nodeId, epoch: Number(epoch) }
}

export interface TerminalRouteDependencies {
  readonly gateway: MeshTerminalGateway
  /** M4.2's hook options, passed straight through. This route composes no auth. */
  readonly identity: MeshIdentityHookOptions
  /**
   * Overrides the query resolver.
   *
   * Present for the same reason `EventStreamRouteDependencies.scopeOf` is: a
   * caller that wants a different spelling of the scope should supply it here
   * rather than editing this file, so "which query parameter names the terminal"
   * has one answer per deployment rather than one per gateway.
   */
  readonly scopeOf?: (query: unknown) => TerminalAttachScope | null
}

export function registerTerminalRoute(app: FastifyInstance, dependencies: TerminalRouteDependencies): void {
  const scopeOf = dependencies.scopeOf ?? terminalAttachScopeFromQuery
  const decisions = new WeakMap<FastifyRequest, TerminalAttachDecision>()

  const attachGuard: preHandlerHookHandler = function terminalAttachPreHandler(request, reply, done): void {
    // Not an upgrade: there is no socket to attach to, and the plugin's handler
    // answers 404. Running the guard anyway would turn a stray `GET` into a
    // project-existence oracle.
    if (request.ws !== true) {
      done()
      return
    }
    const scope = scopeOf(request.query)
    if (scope === null) {
      void reply.code(400).send({ error: missingScope() })
      return
    }
    const requesterNodeId: NodeId | null = authenticatedNodeFor(request)?.nodeId ?? null
    void dependencies.gateway
      .authorizeAttach({ ...scope, requesterNodeId })
      .then((decision) => {
        if (decision.admitted) {
          decisions.set(request, decision)
          done()
          return
        }
        void reply.code(statusForAttachRefusal(decision.error)).send({ error: decision.error })
      })
      .catch((cause: unknown) => {
        // A hook that never calls `done()` HANGS the request, and a hung upgrade
        // is a socket the client holds open with nothing behind it. The access
        // port is the only thing below that can reject, and a rejected port is a
        // store that could not be read — which is a refusal, not an admission.
        // The reason is named as an internal fault because it is one: a port that
        // throws is a wiring bug, and an operator who saw 401 would go looking for
        // a credential problem that does not exist.
        void reply
          .code(500)
          .send({
            error: createContractError(
              "internal_failure",
              "terminal.access_port_failed",
              `The access port could not answer whether this attach is admissible (${cause instanceof Error ? cause.name : "a non-Error throw"}). The attach is refused rather than admitted: a store that could not be read is an absence of evidence, and admitting on one would be the permissive reading this milestone exists to refuse.`,
            ),
          })
      })
  }

  app.get<{ Querystring: Record<string, unknown> }>(
    MESH_TERMINAL_PATH,
    {
      websocket: true,
      preValidation: createMeshIdentityHook(dependencies.identity),
      preHandler: attachGuard,
    },
    (socket: WebSocketTransport, request: FastifyRequest) => {
      const decision = decisions.get(request)
      if (decision === undefined || !decision.admitted) {
        // Unreachable through Fastify (the guard refuses first) and present
        // because the handler cannot express "no decision" and a cast would be a
        // cast that is wrong whenever the guard is edited. `terminate`, not
        // `close`, for the same reason the adapter uses `terminate`.
        socket.terminate()
        return
      }
      const clientId = decision.clientId
      const adapter: TerminalSocket = {
        sendText: (payload) => socket.send(payload),
        sendBinary: (payload) => socket.send(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength), { binary: true }),
        // `terminate`, not `close`. See the note at the top of this file.
        close: () => socket.terminate(),
        pendingBytes: () => socket.bufferedAmount,
      }
      void dependencies.gateway
        .attach(decision, adapter)
        .then((attached) => {
          if (!attached.ok) {
            socket.terminate()
            return
          }
          socket.on("message", (raw: unknown, isBinary: boolean) => {
            const payload = toBytes(raw)
            if (payload === null) return
            const frame: TerminalInboundFrame = isBinary
              ? { opcode: "binary", payload }
              : { opcode: "text", payload: utf8(payload) }
            void dependencies.gateway.receive(clientId, frame).catch(() => {
              // A gateway that throws has lost the ability to decide anything
              // about this stream, so the stream goes rather than continuing to
              // look healthy. Nothing about the frame is reported here.
              socket.terminate()
            })
          })
          // BOTH `close` and `error` are wired, and that is not belt and braces.
          // `websocket-test-harness.md` §3 measured that a graceful close on this
          // transport never completes, so a peer that goes away does so through
          // one of these two and the gateway cannot assume a well-behaved peer.
          // `disconnect` is idempotent (a second call finds no attachment), so
          // wiring both cannot release ownership twice.
          socket.on("close", () => {
            dependencies.gateway.disconnect(clientId, "the socket closed")
          })
          socket.on("error", () => {
            dependencies.gateway.disconnect(clientId, "the socket errored")
          })
        })
        .catch(() => {
          socket.terminate()
        })
    },
  )
}

/**
 * Which HTTP status an attach refusal becomes.
 *
 * The same two-way split `statusForIdentityRefusal` and M4.6's
 * `statusForRefusal` make, because it is the same distinction: "we do not accept
 * this request" versus "we accept it and it conflicts with what we hold". A
 * viewer over the limit is a conflict with this gateway's state, and answering it
 * 400 would tell an operator their request was malformed when it was well-formed
 * and the answer was no.
 */
export function statusForAttachRefusal(error: ContractError): 400 | 401 | 403 | 409 | 500 {
  if (error.code === "terminal.attach_unauthenticated") return 401
  if (error.category === "validation") return 400
  if (error.category === "policy_denied" || error.category === "stale_epoch" || error.category === "approval_required") return 403
  // A store that could not be READ is a fault, not a policy decision, and it is
  // deliberately not folded into 409: an operator told their request conflicts
  // with the gateway's state goes and reconciles a run, and the reconciliation
  // fails the same way for a reason that has nothing to do with what they were
  // sent to do.
  if (error.category === "internal_failure") return 500
  return 409
}

function missingScope(): ContractError {
  return createContractError(
    "validation",
    "terminal.attach_scope_required",
    "A terminal attach must carry 'terminalId', 'projectId', 'sessionId', 'clientId', 'nodeId' and 'epoch' as query parameters, each a well-formed mesh id. They are query parameters and not headers because the identity hook signs the full request target INCLUDING the query: a header naming the project would be outside the signature, and one authenticated node could then ask about a project the signature did not cover.",
  )
}

/**
 * UTF-8, from a `Uint8Array` that may be a VIEW onto a larger buffer.
 *
 * `TextDecoder` rather than `Buffer.toString("utf8")`, and the reason is the
 * offset: `ws` hands over a `Buffer` that is very often a slice of a pooled
 * 64 KiB `ArrayBuffer`, and `buffer.toString()` on the underlying `ArrayBuffer`
 * would decode every byte of the pool that happened to be adjacent. The decoder
 * is given the view, and the `Buffer` path is given the same three arguments, so
 * neither can read a neighbour's bytes.
 */
function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

function toBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw
  if (Array.isArray(raw)) {
    // A fragmented message arrives as an array of Buffers. Concatenating is the
    // transport's job, and doing it here rather than in the gateway keeps the
    // gateway's input type a single frame.
    const parts = raw.filter((part): part is Uint8Array => part instanceof Uint8Array)
    if (parts.length === 0) return null
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
    const joined = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      joined.set(part, offset)
      offset += part.byteLength
    }
    return joined
  }
  // `ws` has delivered Buffer, Buffer[] and ArrayBuffer across its versions. The
  // last is handled rather than refused, so a future `ws` that starts delivering
  // it does not silently drop every data frame — a silent drop here would look
  // exactly like a client that had stopped typing.
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  return null
}
