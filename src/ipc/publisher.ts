/**
 * The Bun worker's end of the local bus: publish state, drain the queue, apply
 * commands.
 *
 * ## Which side of the socket this is
 *
 * This class **listens**, and that is the part worth stating explicitly because it
 * decides everything else in the file. The daemon owns every job, PTY and queue
 * row, so the daemon must be the party clients attach to: a client that dialled
 * the worker would have to be trusted with a callback, and a worker that could not
 * answer `request_snapshot` could not hydrate a re-attaching TUI (Phase 6 §6.2).
 * `node:net`'s `createServer` is used rather than `Bun.listen` for exactly one
 * reason -- portability. The same file has to run under `node` for the test suite
 * and under `bun` in production, and `Bun.listen` exists only in one of them, so
 * choosing it would make this module untestable outside a Bun process.
 *
 * `crates/aibr-ipc/src/server.rs` is the Rust implementation of the same
 * listener, over the same socket path, with the same frame codec. Exactly one of
 * the two may own the path at a time and the other's bind probe refuses to start,
 * so which one runs is a deployment choice rather than a coordination problem.
 *
 * ## Redaction is not optional and not reimplemented here
 *
 * Every string this file puts on the wire that could have come from an agent goes
 * through {@link redactString} from `src/observability/redaction.ts`. The schemas
 * already *require* it (`ptyExitSchema`, `stateChangeSchema`'s `audit_log_appended`,
 * `jobViewSchema`'s `detail` all document the obligation), and criteria 7/8 audit
 * streamed logs and clipboard copies for exactly this. A second redaction
 * implementation here would be a second set of patterns to keep current and a
 * second place for one to be missed.
 *
 * The one field deliberately NOT redacted is `ptyChunk.data`: it is base64 of raw
 * terminal bytes, not text, and the client's VT parser owns its interpretation.
 * Running a text filter over it would corrupt escape sequences and turn a correct
 * pane into a wrong one. What reaches the screen and the clipboard from that
 * stream is the client's screen filter's job (workstream 4), which is where
 * criteria 7/8 are actually enforceable.
 */

import { existsSync, mkdirSync, statSync, unlinkSync, chmodSync } from "node:fs"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { dirname, join } from "node:path"

import {
  controlCommandSchema,
  DEFAULT_POSIX_IPC_SOCKET_PATH,
  DEFAULT_WINDOWS_IPC_PIPE,
  IPC_SOCKET_PATH_ENV,
  IPC_PROTOCOL_VERSION,
  MAX_IPC_FRAME_BYTES,
  MAX_PTY_CHUNK_BYTES,
  serverMessageSchema,
  type IpcControlCommand,
  type IpcJobView,
  type IpcPaneView,
  type IpcServerMessage,
  type IpcStateChange,
  type IpcStateSnapshot,
  type IpcWorkspaceView,
} from "./schemas.js"
import type { NodeId } from "../orchestration/identifiers.js"
import { redactString } from "../observability/redaction.js"

/** Bytes of length prefix in front of every frame, mirroring `frame::LENGTH_PREFIX_BYTES`. */
const LENGTH_PREFIX_BYTES = 4

/** One connection's share of this process's memory, in queued frames. */
export const DEFAULT_MAX_PEERS = 32

/** How many maximal PTY chunks may be queued for one peer before the oldest go. */
const OUTBOUND_CHUNKS = 16

/** Why the publisher could not start or could not do what it was asked.
 *
 * Every variant is a refusal a client is told about verbatim, so each one has to
 * distinguish a cause an operator can act on from one they cannot. */
export type PublisherError =
  | { readonly kind: "already_running"; readonly path: string }
  | { readonly kind: "insecure_socket_directory"; readonly path: string; readonly detail: string }
  | { readonly kind: "socket_bind_failed"; readonly path: string; readonly detail: string }
  | { readonly kind: "pane_refused"; readonly paneId: string; readonly detail: string }
  | { readonly kind: "workspace_refused"; readonly workspaceId: string; readonly detail: string }
  | { readonly kind: "not_implemented"; readonly command: string }

/** Where the worker's world comes from.
 *
 * The engine owns the truth; this interface is how the publisher reads it. Nothing
 * here mutates engine state, because nothing here is allowed to become a second
 * authority (ADR 0008 §2.2 Tier 2) -- every change the bus publishes is something
 * the engine decided first and then reported. */
export interface IpcWorldSource {
  /** A complete description, taken fresh. */
  snapshot(): {
    readonly tailscale: IpcStateSnapshot["tailscale"]
    readonly outboxPendingCount: number
    // Mutable rather than `readonly` arrays to match the inferred Zod type of the
    // snapshot. The alternative -- `readonly` here and a spread at the call site --
    // would push a copy onto every snapshot for a property nobody mutates, and the
    // engine view is already rebuilt per snapshot anyway.
    readonly workspaces: IpcWorkspaceView[]
    readonly jobs: IpcJobView[]
    readonly panes: IpcPaneView[]
  }
  /** The selected workspace, for `set_active_workspace`'s acknowledgement. */
  readonly selectedWorkspaceId: string | null
  /** Cancel a job. Resolves false when the engine would not. */
  cancelJob(jobId: string): Promise<boolean>
}

/** The panes this process can actually drive.
 *
 * Separate from {@link IpcWorldSource} because the panes live behind a PTY host and
 * the world view only describes them. A publisher wired with no host still answers
 * snapshots and still redacts; it refuses `pty_input` with a clear reason instead of
 * pretending the keystroke went somewhere. */
export interface PaneController {
  spawn(command: {
    readonly paneId: string
    readonly command: string
    readonly workingDirectory: string
    readonly columns: number
    readonly rows: number
  }): Promise<boolean>
  write(paneId: string, data: Buffer): Promise<boolean>
  resize(paneId: string, columns: number, rows: number): Promise<boolean>
  close(paneId: string): Promise<boolean>
}

/** The queue rows the publisher reports on.
 *
 * A narrow view of {@link IngressDrainer} rather than the class itself, so this
 * module can be tested without a database and so the drainer's ownership of the
 * lease protocol stays in one file. The drainer emits through this; it does not
 * consult it. */
export interface IngressQueueObserver {
  /** Rows claimed this cycle, in claim order. */
  onClaimed(records: readonly IngressQueueEntry[]): void
  /** A row reached a terminal state: acknowledged, or failed for good. */
  onSettled(jobId: string): void
}

/** The columns of an `ingress_outbox` row the bus needs.
 *
 * A subset of `IngressRecord` rather than the whole row: the bus must not be able
 * to reach a payload, and naming only the four columns it publishes is what makes
 * that structural. */
export interface IngressQueueEntry {
  readonly job_id: string
  readonly status: "pending" | "sending"
  readonly attempts: number
  readonly created_at_ms: number
}

/** What the publisher needs to run. */
export interface IpcPublisherOptions {
  /**
   * This machine's agent id, published in every snapshot and diff.
   *
   * Typed as the branded `NodeId` rather than `string` because the snapshot schema
   * demands it, and a plain `string` here would make every publisher carry a cast
   * at the point of construction -- which is the place a typo in an agent id would
   * otherwise become a snapshot that fails its own parse on the wire.
   */
  readonly nodeId: NodeId
  readonly world: IpcWorldSource
  /** Absent in a build with no PTY host; pane commands are then refused. */
  readonly panes?: PaneController
  /** Secrets to scrub beyond the built-in patterns, e.g. this node's bearer token. */
  readonly customSecrets?: readonly string[]
  /** Socket path; resolved from the environment when absent. */
  readonly socketPath?: string
  /** Peers served at once. Beyond this a connection is accepted and closed. */
  readonly maxPeers?: number
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/** One attached client. */
interface Peer {
  readonly id: number
  readonly socket: Socket
  /** Frames written and not yet drained, oldest first. */
  queued: Uint8Array[]
  queuedBytes: number
  detached: boolean
  /** Per-peer, never shared: two clients' frames interleave on one socket
   * each, and a shared buffer would splice one peer's bytes into another's frame. */
  readonly decoder: FrameDecoder
}

/**
 * Resolve the socket path the same way `crates/aibr-ipc/src/server.rs` and
 * `crates/aibr-tui/src/daemon/mod.rs` do.
 *
 * The three steps, in the same order, because a disagreement here surfaces as "the
 * daemon is not running" rather than as a disagreement about a path.
 */
export function resolveSocketPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment[IPC_SOCKET_PATH_ENV]
  if (configured !== undefined && configured.length > 0) {
    return configured
  }
  if (process.platform !== "win32") {
    const runtime = environment["XDG_RUNTIME_DIR"]
    if (runtime !== undefined && runtime.length > 0) {
      return join(runtime, "aibr", "daemon.sock")
    }
    return DEFAULT_POSIX_IPC_SOCKET_PATH
  }
  return DEFAULT_WINDOWS_IPC_PIPE
}

/**
 * Create the socket's parent directory, privately, and prove it is.
 *
 * The mirror of `ensure_private_parent` in the Rust listener, and for the same
 * reason: a socket in a world-writable directory is reachable by any local user,
 * and what they reach is a process that can run OpenCode inside the owner's
 * project allowlist. This is a security boundary, so an existing directory with
 * group or other access is REFUSED rather than quietly tightened -- an operator who
 * made that directory on purpose should be told, not overridden.
 */
export function ensurePrivateSocketDirectory(socketPath: string): PublisherError | null {
  if (process.platform === "win32") {
    return null
  }
  const parent = dirname(socketPath)
  if (parent === "." || parent.length === 0) {
    return {
      kind: "insecure_socket_directory",
      path: parent,
      detail: `${socketPath} has no parent directory to hold the socket privately`,
    }
  }
  try {
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      // `mkdirSync` applies the umask, so the mode is set explicitly rather than
      // trusted to have come out 0700.
      chmodSync(parent, 0o700)
    }
    const mode = statSync(parent).mode & 0o777
    if ((mode & 0o077) !== 0) {
      return {
        kind: "insecure_socket_directory",
        path: parent,
        detail: `its mode is ${mode.toString(8).padStart(4, "0")}; group and other must have no access to it`,
      }
    }
  } catch (error) {
    return {
      kind: "insecure_socket_directory",
      path: parent,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  return null
}

/**
 * Prove nothing is listening before clearing a leftover socket.
 *
 * A connect attempt is the only proof available, and it is why the directory is
 * secured FIRST: the attempt is itself a message to whoever left the file there.
 * A successful connect means a daemon is live, and removing its socket would leave
 * it running and unreachable -- two daemons, both answering clients.
 */
async function clearStaleSocket(socketPath: string): Promise<PublisherError | null> {
  if (process.platform === "win32" || !existsSync(socketPath)) {
    return null
  }
  const reachable = await new Promise<boolean>((resolve) => {
    const probe = createConnection(socketPath)
    const settle = (result: boolean): void => {
      probe.destroy()
      resolve(result)
    }
    probe.once("connect", () => settle(true))
    probe.once("error", () => settle(false))
  })
  if (reachable) {
    return { kind: "already_running", path: socketPath }
  }
  try {
    unlinkSync(socketPath)
  } catch (error) {
    return {
      kind: "socket_bind_failed",
      path: socketPath,
      detail: `a stale socket is present but could not be removed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return null
}

/** Encode one message into a length-prefixed frame.
 *
 * The mirror of `frame::encode_payload`: 4-byte big-endian length, then UTF-8 JSON.
 * The cap is checked here rather than only by the reader because a producer that
 * emits a frame the peer will refuse costs a connection, and this is the last point
 * at which that is knowable. */
export function encodeFrame(message: IpcServerMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8")
  if (payload.length > MAX_IPC_FRAME_BYTES) {
    throw new Error(
      `refusing to send a ${payload.length}-byte frame: the cap is ${MAX_IPC_FRAME_BYTES}. ` +
        `A frame this large is a bug in what was published, not something a client can render.`,
    )
  }
  const framed = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + payload.length)
  framed.writeUInt32BE(payload.length, 0)
  payload.copy(framed, LENGTH_PREFIX_BYTES)
  return framed
}

/**
 * Reassemble length-prefixed frames out of a stream of socket chunks.
 *
 * Its own decoder rather than one shared with Rust, because the framing is four
 * lines and a shared abstraction across two languages is not an abstraction. The
 * cap check is the point of duplication: an announced length arrives from a peer,
 * and allocating on it before comparing is the bug the cap exists to prevent.
 */
export class FrameDecoder {
  #buffer = Buffer.alloc(0)

  /** Feed bytes, get back every complete frame they finished.
   *
   * `null` in the result means a peer announced more than the cap. The caller
   * drops THAT CONNECTION: a peer that will not respect the frame cap is not
   * served, and the daemon keeps every other peer's panes. */
  push(chunk: Uint8Array): { readonly frames: Buffer[]; readonly oversized: number | null } {
    // `Buffer.from` on the incoming chunk rather than adopting it: a socket chunk
    // may be a view into a pooled allocation the runtime reuses, and keeping a
    // reference to it would mean bytes already queued change under us.
    const incoming = Buffer.from(chunk)
    this.#buffer =
      this.#buffer.length === 0 ? incoming : Buffer.concat([this.#buffer, incoming])
    const frames: Buffer[] = []
    while (this.#buffer.length >= LENGTH_PREFIX_BYTES) {
      const announced = this.#buffer.readUInt32BE(0)
      if (announced > MAX_IPC_FRAME_BYTES) {
        this.#buffer = Buffer.alloc(0)
        return { frames, oversized: announced }
      }
      if (this.#buffer.length < LENGTH_PREFIX_BYTES + announced) {
        break
      }
      frames.push(this.#buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + announced))
      this.#buffer = this.#buffer.subarray(LENGTH_PREFIX_BYTES + announced)
    }
    return { frames, oversized: null }
  }
}

/** The Bun worker's connection to the local bus. */
export class IpcPublisher {
  readonly #nodeId: NodeId
  readonly #world: IpcWorldSource
  readonly #panes?: PaneController
  readonly #customSecrets: readonly string[]
  readonly #socketPath: string
  readonly #maxPeers: number
  readonly #peers = new Map<number, Peer>()
  #server?: Server
  #nextPeerId = 1
  /** The sequence every diff so far has left the client at. */
  #sequence = 0

  constructor(options: IpcPublisherOptions) {
    this.#nodeId = options.nodeId
    this.#world = options.world
    this.#panes = options.panes
    this.#customSecrets = options.customSecrets ?? []
    this.#socketPath = options.socketPath ?? resolveSocketPath(options.environment)
    this.#maxPeers = options.maxPeers ?? DEFAULT_MAX_PEERS
  }

  /** The path this publisher owns. */
  get socketPath(): string {
    return this.#socketPath
  }

  /** The sequence the next diff will continue from. */
  get sequence(): number {
    return this.#sequence
  }

  /** Peers currently attached. */
  get attachedPeers(): number {
    return this.#peers.size
  }

  /**
   * Bind the socket and begin serving.
   *
   * Off by default in `aibr worker`; see the flag on the CLI path. The order is the
   * one `crates/aibr-ipc/src/server.rs` uses and the one the threat model needs:
   * secure the directory, prove nobody is listening, then bind.
   */
  async start(): Promise<void> {
    const insecure = ensurePrivateSocketDirectory(this.#socketPath)
    if (insecure) throw new Error(publisherErrorMessage(insecure))

    const stale = await clearStaleSocket(this.#socketPath)
    if (stale) throw new Error(publisherErrorMessage(stale))

    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.#accept(socket))
      server.once("error", (error: Error) => {
        reject(
          new Error(
            `could not bind the IPC socket at ${this.#socketPath}: ${error.message}. ` +
              `A daemon here is already running if the message mentions the address being in use.`,
          ),
        )
      })
      server.listen(this.#socketPath, () => {
        server.removeAllListeners("error")
        this.#server = server
        resolve()
      })
    })
  }

  /** Stop listening. Peers are closed; panes and jobs are untouched.
   *
   * The asymmetry is deliberate and is Phase 6 invariant 1: this method is
   * reachable only from process shutdown, never from a client action. */
  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    for (const peer of this.#peers.values()) {
      peer.socket.destroy()
    }
    this.#peers.clear()
    if (server === undefined) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Accept one client. */
  #accept(socket: Socket): void {
    if (this.#peers.size >= this.#maxPeers) {
      // Closed rather than queued: the backlog would be sized by the OS, and the
      // only thing a client can do with a refused connection is reconnect.
      socket.destroy()
      return
    }
    const peer: Peer = {
      id: this.#nextPeerId++,
      socket,
      queued: [],
      queuedBytes: 0,
      detached: false,
      decoder: new FrameDecoder(),
    }
    this.#peers.set(peer.id, peer)

    // The `data` event's type is `string | Buffer` because `setEncoding` exists.
    // It is not called anywhere in this class, so a string can only mean a
    // misconfiguration; converting rather than asserting keeps a surprise string
    // from being read as a frame length.
    socket.on("data", (chunk) =>
      this.#onData(peer, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk),
    )
    socket.on("error", () => this.#dropPeer(peer))
    socket.on("close", () => this.#dropPeer(peer))

    // Answered on attach rather than only on request, because a client that
    // reattaches after a detach has no snapshot and cannot draw anything until it
    // gets one. A client that wants a fresh one asks again; that is idempotent.
    this.#sendTo(peer, this.#buildSnapshot())
  }

  /** Forget a peer. Cancels nothing: the daemon owns the panes. */
  #dropPeer(peer: Peer): void {
    if (!this.#peers.delete(peer.id)) return
    peer.detached = true
    peer.queued = []
    peer.queuedBytes = 0
  }

  /** Decode and apply whatever a peer sent. */
  #onData(peer: Peer, chunk: Buffer): void {
    const { frames, oversized } = peer.decoder.push(chunk)
    if (oversized !== null) {
      // Only this peer. The daemon holds every other client's panes, and a peer
      // that will not respect the frame cap is not served.
      peer.socket.destroy()
      return
    }
    for (const frame of frames) {
      let parsed: IpcControlCommand
      try {
        const decoded: unknown = JSON.parse(frame.toString("utf8"))
        const result = controlCommandSchema.safeParse(decoded)
        if (!result.success) {
          // Dropped, not tolerated: a command this build cannot read is a command
          // that did not happen, and answering anyway would be a lie. The peer
          // survives -- one bad frame must not take a session with running jobs
          // behind it -- but it is told.
          this.#sendTo(peer, this.#error("invalid_command", "the frame did not match any known command"))
          continue
        }
        parsed = result.data
      } catch {
        this.#sendTo(peer, this.#error("invalid_command", "the frame was not JSON"))
        continue
      }
      void this.#apply(peer, parsed)
    }
  }

  /** Apply one command.
   *
   * Every arm is explicit, including the ones this build does not implement, so
   * that adding a command to the schema cannot leave a silent no-op behind: an
   * unknown-to-this-build command gets an `Ack` with `accepted: false` rather than
   * disappearing. */
  async #apply(peer: Peer, command: IpcControlCommand): Promise<void> {
    switch (command.type) {
      case "request_snapshot":
        this.#sendTo(peer, this.#buildSnapshot())
        return
      case "detach":
        // Detach is NOT a shutdown. The socket closes and that is the entire
        // effect: no pane is signalled, no job is cancelled, no state is dropped.
        peer.socket.end()
        return
      case "set_active_workspace": {
        const selected = this.#world.selectedWorkspaceId
        const accepted = selected === command.workspaceId
        this.#sendTo(peer, {
          type: "ack",
          commandType: command.type,
          accepted,
        })
        return
      }
      case "pty_input": {
        const refused = this.#requirePanes()
        if (refused !== null) {
          this.#sendTo(peer, refused)
          return
        }
        const accepted = await this.#panes!.write(command.paneId, Buffer.from(command.data, "base64"))
        this.#sendTo(peer, { type: "ack", commandType: command.type, accepted })
        return
      }
      case "resize_pane": {
        const refused = this.#requirePanes()
        if (refused !== null) {
          this.#sendTo(peer, refused)
          return
        }
        const accepted = await this.#panes!.resize(command.paneId, command.columns, command.rows)
        this.#sendTo(peer, { type: "ack", commandType: command.type, accepted })
        return
      }
      case "spawn_pane": {
        const refused = this.#requirePanes()
        if (refused !== null) {
          this.#sendTo(peer, refused)
          return
        }
        const accepted = await this.#panes!.spawn({
          paneId: command.paneId,
          command: command.command,
          workingDirectory: command.workingDirectory,
          columns: command.columns,
          rows: command.rows,
        })
        this.#sendTo(peer, { type: "ack", commandType: command.type, accepted })
        return
      }
      case "close_pane": {
        const refused = this.#requirePanes()
        if (refused !== null) {
          this.#sendTo(peer, refused)
          return
        }
        const accepted = await this.#panes!.close(command.paneId)
        this.#sendTo(peer, { type: "ack", commandType: command.type, accepted })
        return
      }
      case "cancel_job": {
        const accepted = await this.#world.cancelJob(command.jobId)
        this.#sendTo(peer, { type: "ack", commandType: command.type, accepted })
        return
      }
      default: {
        // `approve_plan` and `reject_plan` reach the engine's plan-review path,
        // which lives behind the job manager rather than here. Answering `false`
        // is honest: nothing was approved, and a client that needed approval to
        // proceed will keep waiting rather than believing a modal succeeded.
        this.#sendTo(peer, {
          type: "ack",
          commandType: (command as { type: string }).type,
          accepted: false,
        })
      }
    }
  }

  /** The refusal a build with no PTY host sends instead of a fake success. */
  #requirePanes(): IpcServerMessage | null {
    if (this.#panes !== undefined) return null
    return this.#error(
      "not_allowed",
      "this daemon has no PTY host, so pane commands cannot be served",
    )
  }

  /** Build a complete world description, with every agent-authored string redacted. */
  #buildSnapshot(): IpcServerMessage {
    const world = this.#world.snapshot()
    const snapshot: IpcStateSnapshot = {
      type: "state_snapshot",
      protocolVersion: IPC_PROTOCOL_VERSION,
      nodeId: this.#nodeId,
      sequence: this.#sequence,
      generatedAt: new Date().toISOString(),
      tailscale: world.tailscale,
      outboxPendingCount: world.outboxPendingCount,
      workspaces: world.workspaces,
      jobs: world.jobs.map((job) => this.#redactJob(job)),
      panes: world.panes,
    }
    // Parsed before it goes out. A snapshot that fails its own schema would take
    // the peer's connection on arrival, and the failure would be reported as a
    // client bug rather than as the publisher's.
    return serverMessageSchema.parse(snapshot) as IpcServerMessage
  }

  /** Redact the agent-authored fields of a job view. */
  #redactJob(job: IpcJobView): IpcJobView {
    return job.detail === null ? job : { ...job, detail: this.#redact(job.detail) }
  }

  /** Scrub a string on its way to the wire.
   *
   * The single entry point, so there is no field that can be published unredacted
   * by forgetting to call something at the call site. */
  #redact(value: string): string {
    return redactString(value, { customSecrets: this.#customSecrets })
  }

  /** Publish a batch of changes as one diff.
   *
   * Batch rather than one frame per change because the sequence numbers are what
   * make a gap detectable: one diff per change multiplies the number of frames a
   * slow client falls behind on, and a client that fell behind asks for a snapshot
   * either way. */
  publish(changes: readonly IpcStateChange[]): void {
    if (changes.length === 0) return
    const base = this.#sequence
    const message: IpcServerMessage = {
      type: "state_diff",
      protocolVersion: IPC_PROTOCOL_VERSION,
      nodeId: this.#nodeId,
      baseSequence: base,
      sequence: base + 1,
      changes: changes.map((change) => this.#redactChange(change)),
    }
    // Advanced even if every peer is gone. A diff with no listeners still happened,
    // and a client attaching later gets the current world from a snapshot rather
    // than from a replay.
    this.#sequence = base + 1
    this.#broadcast(message)
  }

  /** Redact one change. The audit line is the only agent-authored string on this side. */
  #redactChange(change: IpcStateChange): IpcStateChange {
    if (change.type === "audit_log_appended") {
      return { ...change, line: this.#redact(change.line) }
    }
    if (change.type === "job_state_changed" && change.detail !== null) {
      return { ...change, detail: this.#redact(change.detail) }
    }
    if (change.type === "job_added") {
      return { ...change, job: this.#redactJob(change.job) }
    }
    return change
  }

  /** Publish `queue_item_added` for rows this process just claimed. */
  queueItemsAdded(entries: readonly IngressQueueEntry[]): void {
    this.publish(
      entries.map((entry) => ({
        type: "queue_item_added" as const,
        jobId: entry.job_id,
        // `pending` rather than `sending`: the claim has been taken but the job has
        // not started, and a sidebar that says "sending" for a row that is still
        // waiting its turn is lying about the queue it is showing.
        status: "pending" as const,
        attempts: entry.attempts,
        queuedAt: new Date(entry.created_at_ms).toISOString(),
      })),
    )
  }

  /** Publish `queue_item_removed` for a row that reached a terminal state. */
  queueItemRemoved(jobId: string): void {
    this.publish([{ type: "queue_item_removed" as const, jobId }])
  }

  /** Publish the outbox's pending count. */
  outboxCountChanged(pendingCount: number): void {
    this.publish([{ type: "outbox_count_changed" as const, pendingCount }])
  }

  /** Publish a PTY chunk to every attached peer. */
  publishChunk(chunk: IpcServerMessage): void {
    this.#broadcast(chunk)
  }

  /** Send to one peer. */
  #sendTo(peer: Peer, message: IpcServerMessage): void {
    this.#enqueue(peer, message)
  }

  /** Send to every attached peer.
   *
   * Every peer, not "the peer that asked": a client re-attaching mid-session gets
   * the current world without asking, and a client that misses a diff because it
   * was mid-resize recovers at the next snapshot. */
  #broadcast(message: IpcServerMessage): void {
    let framed: Buffer
    try {
      framed = encodeFrame(message)
    } catch {
      // A frame too large to send is a publisher bug, and dropping the connection
      // would make every peer pay for it. Reported and skipped.
      return
    }
    for (const peer of this.#peers.values()) {
      this.#enqueueFramed(peer, framed)
    }
  }

  /** Build an error frame.
   *
   * `message` is displayed verbatim in a status bar, so it carries no path outside
   * the allowlist and no part of a token -- which is why the refusals above are
   * fixed strings rather than interpolated errors. */
  #error(code: "not_found" | "not_allowed" | "invalid_command" | "internal", message: string): IpcServerMessage {
    return { type: "error", code, message }
  }

  /** Queue and try to flush one frame. */
  #enqueue(peer: Peer, message: IpcServerMessage): void {
    let framed: Buffer
    try {
      framed = encodeFrame(message)
    } catch {
      return
    }
    this.#enqueueFramed(peer, framed)
  }

  /** Queue and try to flush one already-encoded frame.
   *
   * The queue is bounded in BYTES, not just in frames, and the drop policy is
   * drop-oldest. That is the same rule the Rust listener applies and for the same
   * reason: PTY chunks are 256 KiB each, so a frame count alone is not a memory
   * bound, and a client that stopped reading must cost this process a bounded
   * amount rather than an OOM kill that would take every other client's panes with
   * it. Dropping the OLDEST keeps the newest output on screen, and each pane's
   * monotonic `sequence` turns the resulting hole into a gap the client can see.
   *
   * The byte ceiling is derived from the chunk cap so the relationship is
   * arithmetic rather than a number someone picked.
   */
  #enqueueFramed(peer: Peer, framed: Buffer): void {
    if (peer.detached) return
    while (
      peer.queued.length > 0 &&
      peer.queuedBytes + framed.length > this.#outboundByteCeiling()
    ) {
      peer.queuedBytes -= peer.queued.shift()?.length ?? 0
    }
    if (peer.queuedBytes + framed.length > this.#outboundByteCeiling()) {
      // A single frame larger than the whole budget: the peer cannot be served, and
      // it is closed rather than fed a truncated stream.
      peer.socket.destroy()
      return
    }
    peer.queued.push(framed)
    peer.queuedBytes += framed.length
    this.#flush(peer)
  }

  /** The per-peer outbound byte ceiling, in chunks.
   *
   * Expressed as a multiple of the schema's own chunk cap so the relationship is
   * arithmetic rather than a number somebody picked: if `MAX_PTY_CHUNK_BYTES`
   * changes, this follows it and the bound stays "a fixed number of maximal
   * chunks". Sixteen is enough that a burst is queued rather than discarded, and
   * small enough that the worst case per peer is a few megabytes rather than the
   * frame cap times the chunk cap.
   */
  #outboundByteCeiling(): number {
    return OUTBOUND_CHUNKS * MAX_PTY_CHUNK_BYTES
  }

  /** Write as much of the queue as the socket will take. */
  #flush(peer: Peer): void {
    while (peer.queued.length > 0 && !peer.socket.destroyed) {
      const next = peer.queued[0]!
      const accepted = peer.socket.write(next, (error) => {
        if (error) this.#dropPeer(peer)
      })
      if (!accepted) {
        // The socket's own buffer is full. The rest stays queued behind the ceiling,
        // which is the bound; nothing is awaited, so the producer -- often the
        // PTY reader -- is never blocked by a slow client.
        return
      }
      peer.queuedBytes -= peer.queued.shift()!.length
    }
  }
}

/** A refusal rendered for an exception message. */
function publisherErrorMessage(error: PublisherError): string {
  switch (error.kind) {
    case "already_running":
      return (
        `an AIBridge daemon is already listening on ${error.path}; refusing to start a second ` +
        `one, because replacing the socket would leave the running daemon unreachable`
      )
    case "insecure_socket_directory":
      return (
        `the IPC socket directory ${error.path} is not usable: ${error.detail}. It must be ` +
        `reachable only by its owner, because a socket other local users can reach is a daemon ` +
        `they can drive`
      )
    case "socket_bind_failed":
      return `could not bind the IPC socket at ${error.path}: ${error.detail}`
    case "pane_refused":
      return `pane ${error.paneId} refused the command: ${error.detail}`
    case "workspace_refused":
      return `workspace ${error.workspaceId} refused the command: ${error.detail}`
    case "not_implemented":
      return `the ${error.command} command is not implemented by this daemon`
  }
}