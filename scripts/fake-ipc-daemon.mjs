/**
 * A fake IPC daemon for exercising `aibr-tui` without a configured engine.
 *
 * # Why this exists
 *
 * `aibr worker --ipc-publish` is the real listener, but `crates/aibr-pty` is not
 * yet wired to it (see the implementation report, "Not delivered"). So against the
 * real worker today you see the chrome, the workspace list, jobs, and the live
 * outbox count -- and every pane is empty, because no `PtyChunk` can flow.
 *
 * This script speaks the wire protocol directly, which means every layer of the
 * client below the PTY host is reachable: pane content, truecolor, the alternate
 * screen, border dragging, and the approval modal.
 *
 * It is a DEVELOPMENT AID. It implements no authorization, no state, and no
 * admission -- it is not a daemon, and nothing that matters should ever run
 * against it. It binds 0600 in a 0700 directory precisely so it cannot be
 * mistaken for one.
 *
 * # Usage
 *
 *   node scripts/fake-ipc-daemon.mjs [socket-path]
 *
 * then, in another terminal:
 *
 *   AIBRIDGE_IPC_SOCKET=<socket-path> ./target/release/aibr-tui
 *
 * Omit the path to use the client's default (`$XDG_RUNTIME_DIR/aibr/daemon.sock`,
 * else `/tmp/aibr/aibrd.sock`), which is what you want if you are also testing
 * path resolution.
 *
 * # What it serves
 *
 * - two panes, so a split border exists to drag
 * - truecolor output and an alternate-screen switch, so the VT engine is exercised
 * - a job in `blocked` with a destructive plan, so the approval modal opens at attach
 * - a live `state_diff` bumping the outbox count, so the header updates
 * - a `pty_exit` after a few seconds, so pane exit is reachable
 *
 * Every command the client sends is logged to stderr, so you can see that resizes
 * and detaches actually reach the wire.
 */

import net from "node:net"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_SOCKET = "/tmp/aibr-tui-dev/aibrd.sock"
const socketPath = process.argv[2] ?? DEFAULT_SOCKET

// 0700: a socket in a world-writable directory would let any local user reach a
// daemon. This script has no authority to protect, but leaving the door open on a
// path people will actually use is how someone ends up running it on a real box.
const parent = path.dirname(socketPath)
fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
try {
  fs.chmodSync(parent, 0o700)
} catch {
  /* pre-existing directory owned by someone else; the bind below will fail loudly */
}

// Refuse to steal a live listener's socket. Unlinking one would split the fleet
// silently, and the symptom would be a client talking to nothing.
if (fs.existsSync(socketPath)) {
  const probe = net.connect(socketPath)
  probe.on("connect", () => {
    console.error(`refusing: something is already listening on ${socketPath}`)
    process.exit(1)
  })
  probe.on("error", () => {
    // Nothing answered, so the file is stale and safe to replace.
    fs.unlinkSync(socketPath)
    bind()
  })
} else {
  bind()
}

/** A pane's content, as the PTY would have emitted it. */
function paneScript(label, rows, columns) {
  // Truecolor prompt, a header, and a rule -- enough to show that colour and
  // character positioning survive the round trip.
  const bar = "─".repeat(Math.max(4, Math.min(columns - 1, 60)))
  return [
    `\x1b[38;2;0;220;140m${label}\x1b[0m \x1b[2m(${rows}x${columns})\x1b[0m`,
    `\x1b[38;2;90;90;110m${bar}\x1b[0m`,
    `\x1b[38;2;0;200;120m$\x1b[0m opencode refactor src/controllers/order.ts`,
    `\x1b[38;2;250;250;250mReading AST tree...\x1b[0m`,
    `\x1b[38;2;250;250;250mSynthesizing patch:\x1b[0m`,
    `\x1b[38;2;255;90;90m- \x1b[0mconst legacy = require('legacy/orders')`,
    `\x1b[38;2;120;220;120m+ \x1b[0mimport { OrderService } from '../domain/order.js'`,
    `\x1b[38;2;255;90;90m- rm -rf build/cache\x1b[0m`,
    `\x1b[38;2;120;220;120m+ rm -rf build/cache --preserve=tmp\x1b[0m`,
    // Box drawing plus a CJK glyph: exercises wide-character continuation cells,
    // which is where a naive renderer doubles every character.
    `\x1b[38;2;180;180;200m┌─ 検証 ─┐\x1b[0m`,
    "",
  ].join("\r\n")
}

/** The snapshot every client is answered with. */
function snapshot(sequence) {
  return {
    type: "state_snapshot",
    protocolVersion: 1,
    nodeId: "dev-node",
    sequence,
    generatedAt: new Date().toISOString(),
    tailscale: { status: "active", address: "100.66.222.45/10", peerCount: 3 },
    outboxPendingCount: 5,
    workspaces: [
      {
        workspaceId: "ws-web",
        name: "web-store",
        projectId: "proj-web",
        projectRoot: "/srv/web",
        selected: true,
      },
      {
        workspaceId: "ws-api",
        name: "api-gateway",
        projectId: "proj-api",
        projectRoot: "/srv/api",
        selected: false,
      },
    ],
    jobs: [
      {
        jobId: "job-refactor",
        projectId: "proj-web",
        workspaceId: "ws-web",
        sessionId: "sess-1",
        // Blocked, so the approval modal opens at attach -- the single most
        // visible acceptance criterion, and the one a static screenshot cannot prove.
        state: "blocked",
        blockedReason: "plan_review",
        detail: "4 files, 2 deletions, rm -rf build/cache",
        updatedAt: new Date().toISOString(),
      },
      {
        jobId: "job-tests",
        projectId: "proj-api",
        workspaceId: "ws-api",
        sessionId: "sess-2",
        state: "working",
        blockedReason: null,
        detail: null,
        updatedAt: new Date().toISOString(),
      },
    ],
    panes: [
      {
        paneId: "pane-left",
        workspaceId: "ws-web",
        kind: "terminal",
        title: "OpenCode",
        jobId: "job-refactor",
        sessionId: "sess-1",
        columns: 100,
        rows: 30,
        scrollOffset: 0,
      },
      {
        paneId: "pane-right",
        workspaceId: "ws-api",
        kind: "terminal",
        title: "OpenCode",
        jobId: null,
        sessionId: null,
        columns: 100,
        rows: 30,
        scrollOffset: 0,
      },
    ],
  }
}

function frame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

const base64 = (text) => Buffer.from(text, "utf8").toString("base64")

/** Serve one client. */
function serve(socket) {
  let buffer = Buffer.alloc(0)
  let sequence = 1
  let chunkSequence = 0
  const timers = []

  const send = (payload) => {
    if (!socket.destroyed) socket.write(frame(payload))
  }

  /** Feed a pane's content as a chunk, advancing the per-pane sequence. */
  const feed = (paneId, text) => {
    chunkSequence += 1
    send({
      type: "pty_chunk",
      paneId,
      sequence: chunkSequence,
      data: base64(text),
      final: false,
    })
  }

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (buffer.length < 4 + length) break
      let message
      try {
        message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"))
      } catch {
        console.error("unparseable frame; dropping the connection")
        socket.destroy()
        return
      }
      buffer = buffer.subarray(4 + length)
      console.error(`client -> ${message.type}${describe(message)}`)
      handle(message)
    }
  })

  function describe(message) {
    switch (message.type) {
      case "pty_input":
        return ` (${JSON.stringify(Buffer.from(message.data ?? "", "base64").toString("utf8"))})`
      case "resize_pane":
        return ` (${message.paneId} ${message.columns}x${message.rows})`
      case "approve_plan":
        return ` (scope=${message.scope})`
      case "reject_plan":
        return ` (${JSON.stringify(message.justification ?? null)})`
      default:
        return ""
    }
  }

  function handle(message) {
    switch (message.type) {
      case "request_snapshot": {
        send(snapshot(sequence))
        timers.push(
          setTimeout(() => feed("pane-left", paneScript("web-store", 30, 100)), 150),
          setTimeout(() => feed("pane-right", paneScript("api-gateway", 30, 100)), 250),
          // The alternate screen: a full-screen program switching buffers. A pane
          // that ignores `?1049h` smears the program's UI over the shell output.
          setTimeout(() => feed("pane-left", "\x1b[?1049h\x1b[2J\x1b[H\x1b[38;2;220;220;120mALTERNATE SCREEN\x1b[0m\r\nthe primary screen is retained behind this"), 600),
          // A live diff, so the header's outbox count moves under a running client.
          setTimeout(() => {
            sequence += 1
            send({
              type: "state_diff",
              protocolVersion: 1,
              nodeId: "dev-node",
              baseSequence: sequence - 1,
              sequence,
              changes: [{ type: "outbox_count_changed", pendingCount: 9 }],
            })
          }, 1200),
          // A pane exiting, so `pty_exit` is reachable.
          setTimeout(
            () =>
              send({
                type: "pty_exit",
                paneId: "pane-right",
                exitStatus: 0,
                signal: null,
                final: true,
              }),
            6000,
          ),
        )
        break
      }

      case "approve_plan":
      case "reject_plan":
        // Answered `false` on purpose. A client that got no answer would sit on the
        // modal forever, and a fake `true` would report a decision the real engine
        // has not agreed to.
        send({
          type: "ack",
          commandId: `ack-${message.type}`,
          command: message.type,
          accepted: false,
          detail: "fake daemon: the engine's plan-review path is not wired",
        })
        break

      case "detach":
        console.error("client detached; the connection closes and nothing stops")
        socket.end()
        break

      default:
        // Everything else (spawn_pane, pty_input, close_pane, set_active_workspace)
        // is acknowledged silently. A pane command the client believes succeeded and
        // that quietly did nothing is confusing; an explicit refusal would be
        // better, but the real refusal lives in `aibr worker`, not here.
        break
    }
  }

  socket.on("error", () => {
    /* the client detached or was killed */
  })

  // A client that vanishes must not leave timers writing to a dead socket.
  socket.on("close", () => {
    for (const timer of timers) clearTimeout(timer)
    console.error("connection closed")
  })
}

function bind() {
  const server = net.createServer(serve)
  server.on("error", (error) => {
    console.error(`cannot bind ${socketPath}: ${error.message}`)
    process.exit(1)
  })
  server.listen(socketPath, () => {
    console.error(`fake IPC daemon listening on ${socketPath}`)
    console.error(`try:  AIBRIDGE_IPC_SOCKET=${socketPath} ./target/release/aibr-tui`)
    console.error("this is a DEVELOPMENT AID -- it has no authorization and no state")
  })
  const shutdown = () => {
    server.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}
