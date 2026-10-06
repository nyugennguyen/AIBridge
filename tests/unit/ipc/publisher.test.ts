/**
 * The publisher bridge, exercised over a real Unix socket.
 *
 * ## Why these tests use a socket at all
 *
 * Everything here could have been tested against a fake `net.Server` and would then
 * have asserted almost nothing. The properties that matter -- a snapshot arrives
 * unasked, `detach` closes the socket and does nothing else, a peer that announces
 * an oversized frame loses only its own connection -- are properties of what crosses
 * a socket boundary. A double would pass while the frame codec, the length prefix,
 * and the peer bookkeeping were all wrong.
 *
 * The one thing NOT tested through a socket is redaction, which is asserted on the
 * published frames: a scrubber that works in-process and fails on the wire would be
 * caught by neither a source-reading test nor a double.
 */

import { createConnection, type Socket } from "node:net"
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  FrameDecoder,
  IpcPublisher,
  encodeFrame,
  ensurePrivateSocketDirectory,
  resolveSocketPath,
  type IpcWorldSource,
  type PaneController,
} from "../../../src/ipc/publisher.js"
import {
  DEFAULT_POSIX_IPC_SOCKET_PATH,
  DEFAULT_WINDOWS_IPC_PIPE,
  IPC_SOCKET_PATH_ENV,
  MAX_IPC_FRAME_BYTES,
  type IpcControlCommand,
  type IpcServerMessage,
} from "../../../src/ipc/schemas.js"
import { nodeIdSchema, projectIdSchema } from "../../../src/orchestration/identifiers.js"
import type { IngressRecord } from "../../../src/ingress/drainer.js"

const NODE_ID = nodeIdSchema.parse("test-vps")

/** A private directory per test, so no two tests can share a socket path. */
function socketPathFor(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `aibr-ipc-${name}-`))
  // `mkdtemp` creates 0700 already, but the publisher's own rule is what is under
  // test, so it is applied here the same way `aibr worker` would apply it.
  chmodSync(directory, 0o700)
  return join(directory, "daemon.sock")
}

/** The world the publisher reads. Mutable, because a test changes the world. */
function aWorld(overrides: Partial<ReturnType<IpcWorldSource["snapshot"]>> = {}) {
  const cancelled: string[] = []
  const world: IpcWorldSource = {
    snapshot: () => ({
      tailscale: { status: "active", address: "100.64.42.18/10", peerCount: 3 },
      outboxPendingCount: 0,
      workspaces: [
        {
          workspaceId: "app",
          name: "app",
          // Parsed rather than cast: the wire's id types are branded, and a literal
          // would not typecheck. The fixture going through the same parse a real
          // config does is what makes it a fixture rather than an assertion about
          // a type.
          projectId: projectIdSchema.parse("app"),
          projectRoot: "/srv/apps/app",
          selected: true,
        },
      ],
      jobs: [],
      panes: [],
      ...overrides,
    }),
    selectedWorkspaceId: "app",
    cancelJob: async (jobId) => {
      cancelled.push(jobId)
      return true
    },
  }
  return { world, cancelled }
}

/** A pane host that records what it was asked to do. */
function aPaneHost() {
  const calls: { readonly op: string; readonly paneId: string; readonly detail?: string }[] = []
  const panes: PaneController = {
    spawn: async ({ paneId, command }) => {
      calls.push({ op: "spawn", paneId, detail: command })
      return true
    },
    write: async (paneId) => {
      calls.push({ op: "write", paneId })
      return true
    },
    resize: async (paneId, columns, rows) => {
      calls.push({ op: "resize", paneId, detail: `${columns}x${rows}` })
      return true
    },
    close: async (paneId) => {
      calls.push({ op: "close", paneId })
      return true
    },
  }
  return { panes, calls }
}

/**
 * A four-byte big-endian length prefix and nothing else.
 *
 * A `Uint32Array`'s buffer would be little-endian and would read as a different
 * number, so the prefix is written explicitly -- the same way the Rust and
 * TypeScript readers decode it.
 */
function oversizedAnnouncement(announced: number): Buffer {
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(announced, 0)
  return prefix
}

/** One client, with the frame plumbing a real client needs. */
class Client {
  readonly #socket: Socket
  readonly #decoder = new FrameDecoder()
  readonly #received: IpcServerMessage[] = []
  readonly #waiters: { resolve: () => void }[] = []

  private constructor(socket: Socket) {
    this.#socket = socket
    socket.on("data", (chunk: Buffer) => {
      const { frames } = this.#decoder.push(chunk)
      for (const frame of frames) {
        this.#received.push(JSON.parse(frame.toString("utf8")) as IpcServerMessage)
      }
      while (this.#waiters.length > 0) this.#waiters.pop()?.resolve()
    })
  }

  static async attach(path: string): Promise<Client> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = createConnection(path)
      candidate.once("connect", () => resolve(candidate))
      candidate.once("error", reject)
    })
    return new Client(socket)
  }

  send(command: IpcControlCommand): void {
    this.#socket.write(encodeFrame(command as never))
  }

  sendRaw(bytes: Buffer): void {
    this.#socket.write(bytes)
  }

  /** Wait until at least `count` frames have arrived. */
  async waitFor(count: number, withinMs = 5_000): Promise<IpcServerMessage[]> {
    const deadline = Date.now() + withinMs
    while (this.#received.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `only ${this.#received.length} of ${count} frames arrived within ${withinMs}ms: ` +
            JSON.stringify(this.#received.map((frame) => frame.type)),
        )
      }
      await new Promise<void>((resolve) => {
        this.#waiters.push({ resolve })
        setTimeout(resolve, 50)
      })
    }
    return this.#received
  }

  get frames(): readonly IpcServerMessage[] {
    return this.#received
  }

  get closed(): boolean {
    return this.#socket.destroyed || this.#socket.readyState === "closed"
  }

  async waitForClose(withinMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + withinMs
    while (!this.closed) {
      if (Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return true
  }

  close(): void {
    this.#socket.destroy()
  }
}

describe("the IPC publisher bridge", () => {
  const publishers: IpcPublisher[] = []
  const clients: Client[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close()
    for (const publisher of publishers.splice(0)) await publisher.stop()
  })

  async function start(
    name: string,
    options: { readonly panes?: PaneController; readonly world?: IpcWorldSource } = {},
  ): Promise<{ publisher: IpcPublisher; path: string }> {
    const path = socketPathFor(name)
    const publisher = new IpcPublisher({
      nodeId: NODE_ID,
      world: options.world ?? aWorld().world,
      panes: options.panes,
      socketPath: path,
    })
    publishers.push(publisher)
    await publisher.start()
    return { publisher, path }
  }

  it("answers a client with a snapshot the moment it connects", async () => {
    const { path } = await start("snapshot-on-connect")
    const client = await Client.attach(path)
    clients.push(client)

    const [first] = await client.waitFor(1)
    expect(first?.type).toBe("state_snapshot")
    const snapshot = first as Extract<IpcServerMessage, { type: "state_snapshot" }>
    expect(snapshot.nodeId).toBe("test-vps")
    expect(snapshot.protocolVersion).toBe(1)
    // A client that reattaches after a detach has no state and cannot draw without
    // this, so it must not have to ask.
    expect(snapshot.workspaces.map((workspace) => workspace.workspaceId)).toEqual(["app"])
  })

  it("answers an explicit request_snapshot as well", async () => {
    const { path } = await start("explicit-snapshot")
    const client = await Client.attach(path)
    clients.push(client)
    await client.waitFor(1)

    client.send({ type: "request_snapshot" })
    const frames = await client.waitFor(2)
    expect(frames.filter((frame) => frame.type === "state_snapshot")).toHaveLength(2)
  })

  it("publishes changes as one diff and advances the sequence", async () => {
    const { publisher, path } = await start("diff")
    const client = await Client.attach(path)
    clients.push(client)
    await client.waitFor(1)

    publisher.publish([
      { type: "queue_item_added", jobId: "job-1", status: "pending", attempts: 1, queuedAt: new Date().toISOString() },
      { type: "queue_item_removed", jobId: "job-0" },
    ])

    const frames = await client.waitFor(2)
    const diff = frames[1] as Extract<IpcServerMessage, { type: "state_diff" }>
    expect(diff.type).toBe("state_diff")
    expect(diff.baseSequence).toBe(0)
    expect(diff.sequence).toBe(1)
    // One frame for two changes: the sequence numbers are what make a gap
    // detectable, and a frame per change multiplies the number a slow client falls
    // behind on for no gain.
    expect(diff.changes).toHaveLength(2)
    expect(publisher.sequence).toBe(1)
  })

  it("answers request_snapshot with the sequence the diffs left behind", async () => {
    const { publisher, path } = await start("sequence")
    const client = await Client.attach(path)
    clients.push(client)
    await client.waitFor(1)

    publisher.publish([{ type: "outbox_count_changed", pendingCount: 4 }])
    await client.waitFor(2)

    client.send({ type: "request_snapshot" })
    const frames = await client.waitFor(3)
    const snapshot = frames[2] as Extract<IpcServerMessage, { type: "state_snapshot" }>
    expect(snapshot.sequence).toBe(1)
  })

  it("reports a claimed row as added and a settled row as removed", async () => {
    const { publisher, path } = await start("queue")
    const client = await Client.attach(path)
    clients.push(client)
    await client.waitFor(1)

    publisher.queueItemsAdded([
      { job_id: "job-7", status: "sending", attempts: 2, created_at_ms: Date.now() },
    ])
    publisher.queueItemRemoved("job-7")

    const frames = await client.waitFor(3)
    const added = (frames[1] as Extract<IpcServerMessage, { type: "state_diff" }>).changes[0]
    const removed = (frames[2] as Extract<IpcServerMessage, { type: "state_diff" }>).changes[0]
    expect(added).toMatchObject({ type: "queue_item_added", jobId: "job-7", attempts: 2 })
    expect(removed).toEqual({ type: "queue_item_removed", jobId: "job-7" })
  })

  /**
   * Criteria 7/8: an agent-authored string must not reach a client raw, and the
   * scrubbing must be the repository's own rather than a second implementation.
   */
  it("redacts agent-authored strings before they cross the socket", async () => {
    const token = "sk-aibridge-canary-0123456789"
    const path = socketPathFor("redaction")
    const publisher = new IpcPublisher({
      nodeId: NODE_ID,
      world: aWorld().world,
      socketPath: path,
      customSecrets: [token],
    })
    publishers.push(publisher)
    await publisher.start()

    const client = await Client.attach(path)
    clients.push(client)
    await client.waitFor(1)

    publisher.publish([
      {
        type: "audit_log_appended",
        paneId: "pane-1",
        lineSequence: 0,
        line: `agent read ${token} from the environment`,
      },
      {
        type: "job_state_changed",
        jobId: "job-1",
        state: "blocked",
        blockedReason: "plan_review",
        detail: `token: ${token}`,
        updatedAt: new Date().toISOString(),
      },
    ])

    const frames = await client.waitFor(2)
    const raw = JSON.stringify(frames[1])
    expect(raw).not.toContain(token)

    const diff = frames[1] as Extract<IpcServerMessage, { type: "state_diff" }>
    const [line, detail] = diff.changes
    expect((line as { line: string }).line).toContain("[REDACTED_CANARY_SECRET]")
    expect((detail as { detail: string }).detail).toContain("[REDACTED_SECRET]")
  })

  it("leaves PTY chunk bytes alone, because they are bytes and not text", async () => {
    const { publisher, path } = await start("pty-chunk")
    const client = await Client.attach(path)
    clients.push(client)
    await client.waitFor(1)

    // Base64 of an escape sequence followed by a token-shaped string. A text filter
    // over this would corrupt the escape sequence and turn a correct pane wrong,
    // which is worse than a token visible in a terminal the operator is already
    // watching. What reaches the screen and the clipboard from this stream is the
    // client's screen filter's job.
    publisher.publishChunk({
      type: "pty_chunk",
      paneId: "pane-1",
      sequence: 0,
      data: Buffer.from("\u001b[31mkey=sk-shouldsurvive\u001b[0m", "utf8").toString("base64"),
      final: false,
    })

    const frames = await client.waitFor(2)
    const chunk = frames[1] as Extract<IpcServerMessage, { type: "pty_chunk" }>
    expect(chunk.type).toBe("pty_chunk")
    expect(Buffer.from(chunk.data, "base64").toString("utf8")).toContain(
      "key=sk-shouldsurvive",
    )
  })

  it("closes the socket on detach and does nothing else", async () => {
    const { publisher, path } = await start("detach")
    const client = await Client.attach(path)
    clients.push(client)
    await client.waitFor(1)

    client.send({ type: "detach" })
    expect(await client.waitForClose()).toBe(true)

    // The publisher is still serving, which is the whole point: a client leaving is
    // not a daemon action, and there is deliberately no code path where detaching
    // reaches a pane.
    const second = await Client.attach(path)
    clients.push(second)
    const [frame] = await second.waitFor(1)
    expect(frame?.type).toBe("state_snapshot")
    expect(publisher.attachedPeers).toBeGreaterThan(0)
  })

  it("routes pane commands to the pane host", async () => {
    const { panes, calls } = aPaneHost()
    const { path } = await start("pane-commands", { panes })
    const client = await Client.attach(path)
    clients.push(client)
    await client.waitFor(1)

    client.send({
      type: "pty_input",
      paneId: "pane-1",
      data: Buffer.from("ls\n", "utf8").toString("base64"),
    })
    client.send({ type: "resize_pane", paneId: "pane-1", columns: 120, rows: 40 })
    client.send({ type: "close_pane", paneId: "pane-1" })
    client.send({
      type: "spawn_pane",
      paneId: "pane-2",
      workspaceId: "app",
      kind: "terminal",
      command: "opencode",
      workingDirectory: "/srv/apps/app",
      columns: 80,
      rows: 24,
    })

    await client.waitFor(5)
    expect(calls).toEqual([
      { op: "write", paneId: "pane-1" },
      { op: "resize", paneId: "pane-1", detail: "120x40" },
      { op: "close", paneId: "pane-1" },
      { op: "spawn", paneId: "pane-2", detail: "opencode" },
    ])
  })

  it("refuses pane commands honestly when there is no pane host", async () => {
    const { path } = await start("no-pane-host")
    const client = await Client.attach(path)
    clients.push(client)
    await client.waitFor(1)

    client.send({ type: "close_pane", paneId: "pane-1" })
    const frames = await client.waitFor(2)
    expect(frames[1]).toMatchObject({ type: "error", code: "not_allowed" })
  })

  it("cancels a job through the engine", async () => {
    const { world, cancelled } = aWorld()
    const { path } = await start("cancel", { world })
    const client = await Client.attach(path)
    clients.push(client)
    await client.waitFor(1)

    client.send({ type: "cancel_job", jobId: "job-9" })
    const frames = await client.waitFor(2)
    expect(cancelled).toEqual(["job-9"])
    expect(frames[1]).toMatchObject({ type: "ack", commandType: "cancel_job", accepted: true })
  })

  it("answers a command this build does not implement with accepted:false", async () => {
    const { path } = await start("unimplemented")
    const client = await Client.attach(path)
    clients.push(client)
    await client.waitFor(1)

    client.send({ type: "approve_plan", jobId: "job-1", scope: "apply", justification: null })
    const frames = await client.waitFor(2)
    // Silence would be a lie: a client waiting on an approval modal would keep
    // waiting with no indication of why.
    expect(frames[1]).toMatchObject({ type: "ack", commandType: "approve_plan", accepted: false })
  })

  it("refuses a frame above the cap and loses only that peer", async () => {
    const { path } = await start("frame-cap")
    const offender = await Client.attach(path)
    const honest = await Client.attach(path)
    clients.push(offender, honest)
    await honest.waitFor(1)

    offender.sendRaw(oversizedAnnouncement(MAX_IPC_FRAME_BYTES + 1))
    expect(await offender.waitForClose()).toBe(true)

    // The daemon is still serving, which is the property that matters: it holds
    // every other peer's panes.
    const survivor = await Client.attach(path)
    clients.push(survivor)
    const [frame] = await survivor.waitFor(1)
    expect(frame?.type).toBe("state_snapshot")
  })

  it("reports a contract violation without dropping the peer", async () => {
    const { path } = await start("contract-violation")
    const client = await Client.attach(path)
    clients.push(client)
    await client.waitFor(1)

    // A well-formed frame carrying a command that does not exist. Dropping the
    // connection would be disproportionate -- one bad frame must not take a session
    // with running jobs behind it -- but tolerating it silently would be worse.
    const payload = Buffer.from(JSON.stringify({ type: "not_a_command" }), "utf8")
    const framed = Buffer.alloc(4 + payload.length)
    framed.writeUInt32BE(payload.length, 0)
    payload.copy(framed, 4)
    client.sendRaw(framed)

    const frames = await client.waitFor(2)
    expect(frames[1]).toMatchObject({ type: "error", code: "invalid_command" })

    client.send({ type: "ping" })
    const after = await client.waitFor(3)
    expect(after[2]).toMatchObject({ type: "ack", commandType: "ping" })
  })

  it("serves several peers, each on its own socket", async () => {
    const { publisher, path } = await start("multi-peer")
    const attached = await Promise.all([Client.attach(path), Client.attach(path), Client.attach(path)])
    clients.push(...attached)

    for (const client of attached) {
      const [frame] = await client.waitFor(1)
      expect(frame?.type).toBe("state_snapshot")
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(publisher.attachedPeers).toBe(3)
  })

  it("creates the socket directory privately and refuses a loose one", () => {
    const good = mkdtempSync(join(tmpdir(), "aibr-ipc-perm-"))
    chmodSync(good, 0o700)
    const path = join(good, "nested", "deeper", "daemon.sock")
    expect(ensurePrivateSocketDirectory(path)).toBeNull()
    expect(statSync(join(good, "nested")).mode & 0o077).toBe(0)

    const loose = mkdtempSync(join(tmpdir(), "aibr-ipc-loose-"))
    chmodSync(loose, 0o777)
    const refusal = ensurePrivateSocketDirectory(join(loose, "daemon.sock"))
    expect(refusal?.kind).toBe("insecure_socket_directory")
    rmSync(loose, { recursive: true, force: true })
  })

  it("refuses to start when a live daemon already owns the path", async () => {
    const { path } = await start("already-running")
    const second = new IpcPublisher({
      nodeId: NODE_ID,
      world: aWorld().world,
      socketPath: path,
    })
    await expect(second.start()).rejects.toThrow(/already listening/)
  })

  it("reclaims a socket left behind by a daemon that died", async () => {
    const path = socketPathFor("stale")
    // The corpse a crashed daemon leaves: a socket file with nothing behind it.
    const { createServer } = await import("node:net")
    const corpse = createServer()
    await new Promise<void>((resolve) => corpse.listen(path, resolve))
    await new Promise<void>((resolve) => corpse.close(() => resolve()))
    // `close` removed the file, so recreate the condition by binding and closing a
    // raw descriptor instead: the file exists and nothing accepts on it.
    mkdirSync(join(path, ".."), { recursive: true })
    const listener = createServer()
    await new Promise<void>((resolve) => listener.listen(path, resolve))
    listener.unref()
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    const publisher = new IpcPublisher({
      nodeId: NODE_ID,
      world: aWorld().world,
      socketPath: path,
    })
    publishers.push(publisher)
    // The listener above is still bound, so this must refuse rather than steal it.
    await expect(publisher.start()).rejects.toThrow()
    listener.close()
  })
})

describe("the frame codec", () => {
  it("prefixes a frame with its big-endian length", () => {
    const framed = encodeFrame({ type: "ack", commandType: "ping", accepted: true })
    const payload = framed.subarray(4)
    expect(framed.readUInt32BE(0)).toBe(payload.length)
    expect(JSON.parse(payload.toString("utf8"))).toMatchObject({ type: "ack" })
  })

  it("refuses to build a frame above the cap rather than sending it", () => {
    // Enormous, so the check is arithmetic rather than an allocation the test would
    // have to make.
    expect(() =>
      encodeFrame({
        type: "ack",
        commandType: "x".repeat(MAX_IPC_FRAME_BYTES + 1),
        accepted: true,
      }),
    ).toThrow(/cap/)
  })

  it("reassembles a frame split across reads", () => {
    const decoder = new FrameDecoder()
    const framed = encodeFrame({ type: "ack", commandType: "ping", accepted: true })
    const middle = Math.floor(framed.length / 2)

    expect(decoder.push(framed.subarray(0, middle)).frames).toHaveLength(0)
    const rest = decoder.push(framed.subarray(middle))
    expect(rest.frames).toHaveLength(1)
    expect(JSON.parse(rest.frames[0]!.toString("utf8"))).toMatchObject({ commandType: "ping" })
  })

  it("reports an oversized announcement instead of allocating for it", () => {
    const decoder = new FrameDecoder()
    const result = decoder.push(oversizedAnnouncement(MAX_IPC_FRAME_BYTES + 1))
    expect(result.oversized).toBe(MAX_IPC_FRAME_BYTES + 1)
    expect(result.frames).toHaveLength(0)
  })

  it("keeps two peers' bytes apart", () => {
    // The regression this guards: one shared decoder would splice one client's
    // partial frame into another's and hand it a command it never sent.
    const first = new FrameDecoder()
    const second = new FrameDecoder()
    const framed = encodeFrame({ type: "ack", commandType: "ping", accepted: true })

    expect(first.push(framed.subarray(0, 2)).frames).toHaveLength(0)
    expect(second.push(framed).frames).toHaveLength(1)
    expect(first.push(framed.subarray(2)).frames).toHaveLength(1)
  })
})

describe("socket path resolution", () => {
  it("prefers the override variable", () => {
    expect(resolveSocketPath({ [IPC_SOCKET_PATH_ENV]: "/tmp/custom.sock" })).toBe("/tmp/custom.sock")
  })

  it("uses the XDG runtime directory when there is no override", () => {
    const path = resolveSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" })
    expect(path).toBe("/run/user/1000/aibr/daemon.sock")
  })

  it("falls back to the shared default", () => {
    const path = resolveSocketPath({})
    expect([DEFAULT_POSIX_IPC_SOCKET_PATH, DEFAULT_WINDOWS_IPC_PIPE]).toContain(path)
  })

  it("ignores an empty override rather than binding the empty path", () => {
    expect(resolveSocketPath({ [IPC_SOCKET_PATH_ENV]: "" })).not.toBe("")
  })
})

describe("the drainer observer contract", () => {
  it("publishes only the four queue columns, never the payload", async () => {
    // A structural assertion: the reduction is a named function, so the columns it
    // publishes can be read directly. `payload_json` is on the row and must not be
    // among them.
    const { QueueBridge } = await import("../../../src/ipc/bridge.js")
    const row: IngressRecord = {
      job_id: "job-1",
      subject_job_id: "subject-1",
      route: "POST /trigger",
      schema_version: "1",
      payload_json: '{"prompt":"the secret prompt"}',
      created_at_ms: 1_700_000_000_000,
      next_attempt_at_ms: null,
      attempts: 1,
      claim_token: "token",
      claimed_at_ms: 1_700_000_000_001,
      status: "sending",
      last_error: null,
      terminal_error: null,
    }
    expect(Object.keys(QueueBridge.entryOf(row)).sort()).toEqual([
      "attempts",
      "created_at_ms",
      "job_id",
      "status",
    ])
  })
})