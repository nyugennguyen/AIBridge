/**
 * The slice of `ws` this repository's WebSocket tests use.
 *
 * `@fastify/websocket` depends on `ws` but does not ship its types, and
 * `@types/ws` is not a dependency here — M4.7 is not permitted to add one, and a
 * test-only dependency that exists only to satisfy a compiler is a dependency.
 *
 * So the surface is DECLARED rather than imported, and the declaration is narrow
 * on purpose. It is also the reason `src/mesh/gateway/terminal/route.ts` declares
 * its own structural socket type instead of importing `WebSocket`: a named list of
 * members is a record of what the terminal gateway depends on, and an ambient
 * `any` is not. `skipLibCheck` means a mismatch between this and the real `ws`
 * cannot fail the build, so the failure mode of an incomplete declaration is a
 * test that genuinely cannot use a member — a five-second error at the call site
 * rather than a silently wrong assertion.
 *
 * The class is declared as `export default class WebSocket` rather than as a named
 * export with a separate default alias, because a default-imported CLASS is both
 * a value and a type. A named export plus `export default typeof` would make a
 * bare `WebSocket` in type position fall through to the global `WebSocket` that
 * `@types/node` declares for undici — which has no `terminate()` and no `on()`,
 * and the resulting errors name neither the module nor the cause.
 */
declare module "ws" {
  export type RawData = Buffer | ArrayBuffer | Buffer[]

  export interface ClientOptions {
    readonly headers?: Record<string, string>
    readonly handshakeTimeout?: number
  }

  /** The parts of `http.IncomingMessage` the `unexpected-response` test reads. */
  export interface UpgradeResponse {
    readonly statusCode: number
    on(event: "data", listener: (chunk: Buffer) => void): this
    on(event: "end", listener: () => void): this
  }

  export class WebSocketServer {
    readonly clients: Set<WebSocket>
    handleUpgrade(request: unknown, socket: unknown, head: unknown, callback: (socket: WebSocket) => void): void
    close(callback?: () => void): void
  }

  export default class WebSocket {
    static readonly CONNECTING: 0
    static readonly OPEN: 1
    static readonly CLOSING: 2
    static readonly CLOSED: 3

    readonly readyState: 0 | 1 | 2 | 3
    /**
     * Bytes accepted by the transport and not yet written to the wire.
     *
     * The transport half of the terminal backpressure bound, and the reason this
     * member is declared rather than the whole class being `any`: a fake cannot
     * produce it, and it is the only honest way to test a slow reader.
     */
    readonly bufferedAmount: number

    constructor(address: string, options?: ClientOptions)
    send(data: string): void
    /**
     * A `Buffer` with no options is sent as a BINARY frame by the real `ws`, and
     * the terminal tests depend on that: it is how a data frame arrives on the
     * binary opcode. The overload is declared because without it a one-argument
     * `send(buffer)` resolves to the string overload and the compiler's complaint
     * — "not assignable to parameter of type string" — is the only warning that
     * a data frame was about to go out as text.
     */
    send(data: Buffer): void
    send(data: Buffer, options: { readonly binary: boolean }): void
    close(code?: number, reason?: string): void
    /** The abrupt close. No handshake, no wait. */
    terminate(): void
    on(event: "open", listener: () => void): this
    on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this
    on(event: "close", listener: (code: number, reason: Buffer) => void): this
    on(event: "error", listener: (error: Error) => void): this
    on(event: "unexpected-response", listener: (request: unknown, response: UpgradeResponse) => void): this
  }
}
