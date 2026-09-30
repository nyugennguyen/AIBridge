# Test-harness notes: WebSocket in this repository

Discovered while preparing M4.7. Every claim here was measured on this machine
(Bun 1.3.14, Node 26.9.0, `@fastify/websocket@11.3.1`, `ws@8.22.0`, Fastify 5.8.5).
Re-measure before changing any of it — these are observations, not guarantees.

## 1. `injectWS` does not work here. Do not use it.

`@fastify/websocket@11.3.1` does export `injectWS`, and the plan asks for
"`injectWS` tests". In this environment it does not work on **either** runtime:

| Runtime | `app.injectWS("/ws")` |
| --- | --- |
| `bun test` (Bun's runner) | throws `Invalid url for WebSocket null` — `node_modules/@fastify/websocket/index.js:62` does `new WebSocket(null)` |
| `bunx vitest run` (Node) | never settles; the test times out |

Its implementation reaches into `ws` internals (`ws.setSocket(clientStream, head, …)`,
`ws._isServer = false`) and hand-rolls the HTTP upgrade with `duplexify`. Those
internals are exactly what a future `ws` bump is free to move. Driving the plugin
this way buys nothing over a real socket and costs a silent hang when it breaks.

**Decision: test the WebSocket gateway over a real loopback listener with the `ws`
client, and unit-test the gateway's session logic against an injected socket
interface.** The plan's "injectWS tests" is satisfied in substance — the gateway
logic is covered exhaustively without a socket at all — and the transport is
covered by a real upgrade. Record this deviation in the M4 gate report.

## 2. What does work

A real listener plus a real `ws` client round-trips a message successfully on
**both** runtimes:

```ts
const app = Fastify()
await app.register(websocket)
app.get("/ws", { websocket: true }, (socket) => {
  socket.on("message", (raw: Buffer) => socket.send(`echo:${raw.toString()}`))
})
const address = await app.listen({ port: 0, host: "127.0.0.1" })
const client = new WebSocket(`${address.replace("http", "ws"))}/ws`)
```

`port: 0` is mandatory: a hard-coded port collides with a parallel test worker and
produces a flake that looks like a gateway bug.

## 3. Teardown: `app.close()` HANGS if a client is still open

This is the one that will burn an afternoon. Measured:

| Sequence | `app.close()` |
| --- | --- |
| never connected | resolves |
| connected, then `client.terminate()` | resolves |
| connected, then `client.close()` (graceful) | **never resolves** — test times out |
| connected, `client.close()`, then forced-close every `websocketServer.clients` entry | **never resolves** |

The graceful close handshake never completes, and terminating the server-side
sockets afterwards does not recover it. A graceful `client.close()` is the trap.

**Required teardown, in this order:**

1. for each client of `app.websocketServer.clients` → `terminate()`
2. client side → `terminate()` (never `close()`)
3. `await app.close()`

`terminate()` is the abrupt close and does not wait for a handshake. There is also
a test-visible hazard here worth noting in the gateway: because a graceful close can
never be relied on to complete, **the gateway's server-side cleanup must not depend on
the peer closing gracefully**. Disconnect detection has to come from the socket's
`close`/`error` events, and every test must assert that path explicitly rather than
assuming a well-behaved peer.

## 4. Bun's runner vs vitest

`bun test` runs Bun's own runner; `bun run test` runs `vitest`. The repository's
`package.json` `test` script is `vitest run`. **The milestone gate uses `bun test`.**
Both are needed:

- `bun test` — the gate, and the only runner where `Bun.spawn` works.
- `bunx vitest run` — useful when a test genuinely needs Node semantics.

A WebSocket test must pass on `bun test`, since that is what the gate runs.

## 5. What `bun test` cannot observe about a socket (measured during M4.7)

Bun's `ws` shim is not a TCP implementation, and three of its gaps are properties
of the transport rather than of any test:

| Observation | `bun test` (Bun's shim) | `bunx vitest run` (real `ws`) |
| --- | --- | --- |
| `client._socket` (the `net.Socket`) | `undefined` — there is nothing to `pause()` | present |
| server `socket.bufferedAmount` after a 13 MB burst | stays `0`; the client receives all of it | rises, as a real send buffer does |
| client `unexpected-response` event | not implemented — only `Expected 101 status code` | implemented, with the status and body |

Three consequences, and they are why `tests/integration/terminal-websocket.test.ts`
is shaped the way it is.

**A refused upgrade is read over a hand-written `net.Socket`.** Requirement 1's
observable half is that an unauthenticated client is answered with an HTTP status
rather than a `101` followed by a close frame, and a client that cannot see the
status cannot prove it. The test therefore writes the upgrade request itself —
same request line, same `Sec-WebSocket-Key` headers, same bytes — and reads the
status line and body off the socket. It needs no new dependency, works identically
on both runners, and reads the ACTUAL response rather than a client's
interpretation of it.

**A slow reader cannot be provoked through a socket on the gate's runner.** With no
`_socket` to pause and a `bufferedAmount` that never moves, there is no way to make
a client stop reading. The backpressure MECHANISM is therefore proven in
`tests/unit/mesh/gateway/terminal/admission-and-limits.test.ts`, against the
gateway's injected socket interface where `pendingBytes()` is a number a test
sets. That is the payoff of the seam, and it is the second reason the seam has the
shape it has: a test seam that only works against the real thing is not a seam.
What the integration file proves about the bound is the half a real socket CAN
show — a burst of 13 MB through a 1 MiB bound with nothing dropped, and a client
that disappears mid-burst leaving the other untouched.

**Mixing runtimes does not work.** Loading the real `ws` package by absolute path
under `bun test` and pointing it at Bun's server fails the upgrade with
`Unexpected server response: 101`, so "use the real client and the shim server" is
not an option. Both ends are Bun's, or neither is.

## 6. A `preHandler` refusal really does prevent the upgrade

Measured, and it is the fact `src/mesh/gateway/terminal/route.ts` is built on.
`@fastify/websocket` overrides the route handler so that it calls
`wss.handleUpgrade`; every Fastify hook runs BEFORE the handler. A `preValidation`
(or `preHandler`) that replies therefore means `handleUpgrade` is never called, the
plugin's `onResponse` hook destroys the raw socket, and the client receives an HTTP
status. The order that follows from it is `preValidation` = M4.2's identity hook,
`preHandler` = the attach guard, so the node is authenticated before the attach
scope is looked at. The reverse order would be a project-existence oracle for a
peer that had presented no credential at all.

One measured detail worth keeping: **Fastify does not coerce query values.**
`?epoch=4` arrives at `request.query` as the string `"4"`, so a resolver written
against a `number` rejects every real request and the symptom is a gateway that
refuses all attaches rather than a parse bug.
