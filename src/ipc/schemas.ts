/**
 * Wire contracts for the local daemon/client IPC bus (Phase 2 of
 * `Docs/implementation-plans/AIBridge_TUI_and_Daemon_Modernization_Plan.md`).
 *
 * WHY THIS FILE IS THE SOURCE OF TRUTH AND NOT THE RUST ONE. The repository
 * already runs a contract chain — Zod -> `contracts/v1/*.schema.json` ->
 * `router/src/contracts.rs` — and ADR 0008 §2.3 exists to keep exactly one
 * declaration per shape. Introducing hand-written Rust structs for the IPC
 * messages would add a second declaration that nothing keeps in step, which is
 * the failure mode ADR 0008 §2.3 names. So the IPC families are declared here
 * and generated on both sides like every other contract.
 *
 * WHY THESE LIVE BESIDE THE INGRESS CONTRACTS BUT NOT IN THE ROUTER'S BINARY.
 * `contracts/v1/` is already a single directory holding families the admission
 * router never reads (`run`, `memory`, `mesh`), so one directory per consumer
 * would be a directory per consumer, not a boundary. What IS a boundary is
 * which generated Rust file a family lands in: `aibr-contract-gen` partitions
 * `contracts/v1/` into the router's compilation unit and the IPC crate's, and
 * refuses to generate if any file is claimed by neither or both. The admission
 * router therefore keeps compiling exactly the families it validates, and the
 * TUI pulls in no axum, no bundled SQLite and no ingress surface.
 *
 * TRANSPORT. Every field here is JSON, and the transport is length-prefixed
 * JSON rather than bincode: the two endpoints are written in two languages
 * (Rust and TypeScript), and a self-describing frame can be replayed through
 * `socat` when a state divergence has to be explained. The framing layer that
 * carries these messages is NOT expressible in JSON Schema and therefore lives
 * in code on each side, with the frame cap stated once here and enforced there.
 *
 * TRUST. This is a local socket, not the network boundary: the router's
 * constant-time bearer check and body caps apply to ingress, and nothing here
 * weakens them. What this channel does carry is agent output, so every string
 * that originates from an agent is required to pass the redaction pipeline
 * before it is published (Phase 6 §6.2 telemetry redaction self-audit). The
 * comments on those fields record the obligation; the enforcement lives in
 * `src/observability/redaction.ts` and in the client-side screen filter.
 */
import { z } from "zod"

import {
  nodeIdSchema,
  projectIdSchema,
  sessionIdSchema,
  timestampSchema,
} from "../orchestration/identifiers.js"

/**
 * The opaque identifier pattern shared by every id on this bus.
 *
 * Duplicated from `src/orchestration/identifiers.ts` rather than imported as a
 * symbol because that module exports one schema PER ENTITY, and a job id is a
 * legacy identifier (`src/jobs/types.ts`) with no domain counterpart there. A
 * new export on that module would be a schema nothing on the orchestration side
 * validates; the pattern itself is the shared thing, so the pattern is shared.
 */
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const jobIdSchema = z.string().regex(opaqueIdPattern)

/** Bounds reused by several families. */
const SHORT_TEXT_MAX = 256
const TEXT_MAX = 4096
const ARRAY_MAX = 512
const PANE_ARRAY_MAX = 256
const WORKSPACE_ARRAY_MAX = 64
const CHANGE_ARRAY_MAX = 1024

/**
 * The IPC protocol version, distinct from the domain `schemaVersion`.
 *
 * A domain record may sit at schema version 1 or 2 for months while this bus
 * breaks compatibility in an afternoon. Conflating the two would make a wire
 * change look like a persistence change, so the wire version is its own literal
 * and only ever moves when a frame a v1 client cannot parse becomes possible.
 */
export const IPC_PROTOCOL_VERSION = 1
const protocolVersionSchema = z.literal(IPC_PROTOCOL_VERSION)

/**
 * Local transport socket path, resolved per platform.
 *
 * A user-scoped directory rather than `/var/run/aibr/`: the daemon is a
 * per-user service (see `src/host/tmux.ts` for the existing per-user model),
 * and a path under `/var/run` would need root to create and would then be
 * shared by every user on the box. `$XDG_RUNTIME_DIR` is the filesystem's
 * answer to "a directory only this user may read", and it is cleaned on logout.
 */
export const IPC_SOCKET_PATH_ENV = "AIBRIDGE_IPC_SOCKET"

/** POSIX default: `/tmp` is world-visible, so a private subdirectory is created inside it. */
export const DEFAULT_POSIX_IPC_SOCKET_PATH = "/tmp/aibr/aibrd.sock"

/** Windows default, matching the plan's `\\.\pipe\aibr-daemon`. */
export const DEFAULT_WINDOWS_IPC_PIPE = "\\\\.\\pipe\\aibr-daemon"

/**
 * Maximum bytes in one frame's payload, excluding the 4-byte length prefix.
 *
 * A PTY read is bounded well below this and a snapshot of a large workspace
 * would still fit, so the cap is a denial-of-service guard rather than a
 * working limit: a client that announces a larger frame is disconnected rather
 * than allowed to allocate it. Both sides enforce it before allocating.
 */
export const MAX_IPC_FRAME_BYTES = 8 * 1024 * 1024

/**
 * Maximum raw PTY bytes in one `PtyChunk`, chosen so the base64 payload stays
 * inside a single frame with room for the envelope, and so a slow reader cannot
 * be starved by one write: the daemon coalesces rather than queueing without
 * bound. 256 KiB is roughly two full screens of dense truecolor output.
 */
export const MAX_PTY_CHUNK_BYTES = 256 * 1024
const MAX_PTY_CHUNK_BASE64_LENGTH = Math.ceil((MAX_PTY_CHUNK_BYTES * 4) / 3) + 4

/**
 * PTY bytes as base64.
 *
 * Base64 rather than a byte array because the frame is JSON and JSON has no
 * byte type; a lossy `latin1` string would corrupt every byte above 0x7F, which
 * is most of a truecolor ANSI stream. The pattern is enforced so a decoder is
 * never handed a string it has to guess about.
 */
const ptyPayloadSchema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(MAX_PTY_CHUNK_BASE64_LENGTH)

const paneIdSchema = z.string().regex(opaqueIdPattern)
const workspaceIdSchema = z.string().regex(opaqueIdPattern)
const shortTextSchema = z.string().min(1).max(SHORT_TEXT_MAX)
const nullableShortTextSchema = shortTextSchema.nullable()

/** A terminal geometry. Both are positive because a zero-sized PTY is not a terminal. */
const columnsSchema = z.number().int().min(1).max(1000)
const rowsSchema = z.number().int().min(1).max(1000)
const nonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

/**
 * The four agent states the whole workspace manager is organised around
 * (plan §1.2.2).
 *
 * `blocked` is the human-in-the-loop state and is the only one that opens the
 * approval modal; `idle` is readiness, not success. A run that stopped without
 * reaching a terminal state is `blocked`, never `done` — inferring success from
 * silence is the failure mode `Docs/implementation-plans/README.md` already
 * forbids adapters elsewhere in this repository.
 */
export const jobStateSchema = z.enum(["working", "blocked", "done", "idle"])

/** Why a job is `blocked`. Drives the modal's title and the sidebar badge. */
export const blockedReasonSchema = z.enum(["plan_review", "permission", "user_input", "policy_violation"])

/**
 * What a job is waiting for, as the sidebar and modal render it.
 *
 * `detail` is agent-authored free text and therefore REDACTED before it is
 * published: a plan reason is the most likely place for an agent to quote back a
 * token it read out of the environment. Consumers must not treat an unredacted
 * `detail` as acceptable, because there is no code path that produces one.
 */
export const jobViewSchema = z
  .object({
    jobId: jobIdSchema,
    projectId: projectIdSchema,
    workspaceId: workspaceIdSchema,
    sessionId: sessionIdSchema.nullable(),
    state: jobStateSchema,
    blockedReason: blockedReasonSchema.nullable(),
    detail: nullableShortTextSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((job, ctx) => {
    // A job with no reason cannot explain itself in the modal, and a job that is
    // not blocked cannot have one. Both directions are checked because the
    // sidebar renders the pair together and a mismatch would read as a reason
    // that does not exist.
    if (job.state === "blocked" && job.blockedReason === null) {
      ctx.addIssue({
        code: "custom",
        path: ["blockedReason"],
        message: "A blocked job must name why it is blocked",
      })
    }
    if (job.state !== "blocked" && job.blockedReason !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["blockedReason"],
        message: `blockedReason is only meaningful while blocked, not while ${job.state}`,
      })
    }
  })

/**
 * What a pane IS, which decides what the client renders into it.
 *
 * `terminal` is the embedded VT grid, `plan_review` the diff widget, and
 * `audit_log` the redacted stream. The kind is server-declared rather than
 * chosen by the client so a re-attaching client cannot come back with a
 * different topology than the one it left.
 */
export const paneKindSchema = z.enum(["terminal", "plan_review", "audit_log"])

export const paneViewSchema = z
  .object({
    paneId: paneIdSchema,
    workspaceId: workspaceIdSchema,
    kind: paneKindSchema,
    title: shortTextSchema,
    jobId: jobIdSchema.nullable(),
    sessionId: sessionIdSchema.nullable(),
    /** Current PTY window size. The client echoes it back on resize. */
    columns: columnsSchema,
    rows: rowsSchema,
    scrollOffset: nonNegativeIntegerSchema,
  })
  .strict()

export const workspaceViewSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    name: shortTextSchema,
    projectId: projectIdSchema,
    /** Already resolved and allowlist-checked by the daemon; the client never resolves a path. */
    projectRoot: z.string().min(1).max(TEXT_MAX),
    selected: z.boolean(),
  })
  .strict()

/**
 * Tailscale status as the header bar shows it.
 *
 * `unknown` is a first-class value rather than a fallback into `stopped`: the
 * distinction between "I asked and could not tell" and "tailscaled said no" is
 * the difference between a broken install and a down network, and collapsing
 * them would make the header lie about why ingress is unreachable.
 */
export const tailscaleStatusSchema = z.enum(["active", "stopped", "unavailable", "unknown"])

export const tailscaleStatusViewSchema = z
  .object({
    status: tailscaleStatusSchema,
    /** CGNAT address with prefix, e.g. `100.64.42.18/10`, when one is bound. */
    address: z.string().min(1).max(SHORT_TEXT_MAX).nullable(),
    peerCount: nonNegativeIntegerSchema,
  })
  .strict()

/**
 * The complete topology a client hydrates from on attach.
 *
 * This is the re-attach mechanism (Phase 6 §6.2): a client that reconnects gets
 * the world as it is, not a delta it has to have kept. `sequence` orders later
 * `StateDiff` frames, and a client whose last applied sequence is older than
 * `baseSequence` of the next diff must re-request a snapshot rather than apply
 * it — the alternative is a client that is quietly wrong about a pane.
 */
export const stateSnapshotSchema = z
  .object({
    type: z.literal("state_snapshot"),
    protocolVersion: protocolVersionSchema,
    nodeId: nodeIdSchema,
    sequence: nonNegativeIntegerSchema,
    generatedAt: timestampSchema,
    tailscale: tailscaleStatusViewSchema,
    /** Rows in `ingress_outbox` still pending. Drives the header's queue count. */
    outboxPendingCount: nonNegativeIntegerSchema,
    workspaces: z.array(workspaceViewSchema).max(WORKSPACE_ARRAY_MAX),
    jobs: z.array(jobViewSchema).max(ARRAY_MAX),
    panes: z.array(paneViewSchema).max(PANE_ARRAY_MAX),
  })
  .strict()

/**
 * One incremental change.
 *
 * A union rather than a partial record because a partial record cannot say
 * "this job was REMOVED": absence is ambiguous between removed and never
 * existed, and a client that guesses wrong shows a phantom job forever. Each
 * variant is self-contained and idempotent — applying the same diff twice
 * leaves the same state — because a re-attach replays from the last sequence a
 * client acknowledged.
 */
export const stateChangeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("job_added"),
      job: jobViewSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("job_state_changed"),
      jobId: jobIdSchema,
      state: jobStateSchema,
      blockedReason: blockedReasonSchema.nullable(),
      detail: nullableShortTextSchema,
      updatedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("job_removed"),
      jobId: jobIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("queue_item_added"),
      jobId: jobIdSchema,
      status: z.enum(["pending", "sending"]),
      attempts: nonNegativeIntegerSchema,
      queuedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("queue_item_removed"),
      jobId: jobIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("outbox_count_changed"),
      pendingCount: nonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("pane_added"),
      pane: paneViewSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("pane_removed"),
      paneId: paneIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("pane_geometry_changed"),
      paneId: paneIdSchema,
      columns: columnsSchema,
      rows: rowsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("workspace_selected"),
      workspaceId: workspaceIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("audit_log_appended"),
      paneId: paneIdSchema,
      /** Monotonic per pane, so a client can drop a line it already rendered. */
      lineSequence: nonNegativeIntegerSchema,
      /** Already redacted. See the module header. */
      line: z.string().max(TEXT_MAX),
    })
    .strict(),
])

export const stateDiffSchema = z
  .object({
    type: z.literal("state_diff"),
    protocolVersion: protocolVersionSchema,
    nodeId: nodeIdSchema,
    /** The sequence the client must already be at for this diff to apply. */
    baseSequence: nonNegativeIntegerSchema,
    sequence: nonNegativeIntegerSchema,
    changes: z.array(stateChangeSchema).max(CHANGE_ARRAY_MAX),
  })
  .strict()
  .superRefine((diff, ctx) => {
    // A diff whose sequence does not advance carries no information a client can
    // act on, and one that does not move forward relative to its base describes a
    // gap. Both are wire bugs; refusing them here means a client never has to
    // decide what an out-of-order frame meant.
    if (diff.sequence <= diff.baseSequence) {
      ctx.addIssue({
        code: "custom",
        path: ["sequence"],
        message: "A diff must advance the sequence past its base",
      })
    }
  })

export const ptyChunkSchema = z
  .object({
    type: z.literal("pty_chunk"),
    paneId: paneIdSchema,
    /** Monotonic per pane, so a client can detect a gap and re-request scrollback. */
    sequence: nonNegativeIntegerSchema,
    /** Base64 of raw PTY bytes, undecoded: the VT parser owns interpretation. */
    data: ptyPayloadSchema,
    /** True on the last chunk for a pane; the client keeps the grid and stops the reader. */
    final: z.boolean(),
  })
  .strict()

/**
 * Approval scope.
 *
 * Step-by-step is a separate scope rather than a boolean because "apply the
 * whole plan" and "apply this one step and ask again" are different grants, and
 * the daemon has to persist which one it was given before resuming the PTY.
 */
export const approvalScopeSchema = z.enum(["apply", "step_by_step"])

export const controlCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("request_snapshot"),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_active_workspace"),
      workspaceId: workspaceIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("spawn_pane"),
      paneId: paneIdSchema,
      workspaceId: workspaceIdSchema,
      kind: paneKindSchema,
      /** Executable plus argv. Resolved and allowlist-checked by the daemon. */
      command: shortTextSchema,
      workingDirectory: z.string().min(1).max(TEXT_MAX),
      columns: columnsSchema,
      rows: rowsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("close_pane"),
      paneId: paneIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("resize_pane"),
      paneId: paneIdSchema,
      columns: columnsSchema,
      rows: rowsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("pty_input"),
      paneId: paneIdSchema,
      data: ptyPayloadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("approve_plan"),
      jobId: jobIdSchema,
      scope: approvalScopeSchema,
      justification: nullableShortTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("reject_plan"),
      jobId: jobIdSchema,
      justification: nullableShortTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("cancel_job"),
      jobId: jobIdSchema,
    })
    .strict(),
  /**
   * The client is leaving. NOT a shutdown: the daemon keeps every PTY and job
   * running (plan §6.1), and the fact that this is a distinct command from any
   * stop/shutdown is what keeps that guarantee from being lost to a future
   * "detach means stop" convenience.
   */
  z
    .object({
      type: z.literal("detach"),
    })
    .strict(),
  z
    .object({
      type: z.literal("ping"),
    })
    .strict(),
])

/** How a PTY ended. `signal` is POSIX-only and null on Windows. */
export const ptyExitSchema = z
  .object({
    type: z.literal("pty_exit"),
    paneId: paneIdSchema,
    exitStatus: z.number().int().nullable(),
    signal: z.number().int().nullable(),
  })
  .strict()

export const ackSchema = z
  .object({
    type: z.literal("ack"),
    /** Echoes the command this acknowledges, so a client can retire a pending action. */
    commandType: z.string().min(1).max(SHORT_TEXT_MAX),
    accepted: z.boolean(),
  })
  .strict()

/**
 * A refusal the client must surface rather than swallow.
 *
 * `message` is daemon-authored and non-sensitive by construction; it must not
 * carry a command line, a path outside the allowlist, or any part of a token,
 * because it is displayed verbatim in the status bar. Anything that would need
 * those belongs in a redacted audit line instead.
 */
export const serverErrorSchema = z
  .object({
    type: z.literal("error"),
    code: z
      .enum([
        "not_found",
        "not_allowed",
        "invalid_command",
        "frame_too_large",
        "protocol_mismatch",
        "internal",
      ]),
    message: z.string().min(1).max(SHORT_TEXT_MAX),
  })
  .strict()

/**
 * Everything the daemon sends.
 *
 * A DISCRIMINATED union on `type`, not an untagged one, and the discriminator is
 * the reason: an untagged `z.union` makes serde try each arm in declaration order
 * and accept the first that parses, so `PtyChunk` and `PtyExit` -- both keyed by
 * `paneId` -- would be tried against each other, and the winner would depend on
 * field ORDER in the JSON rather than on the message's identity. A frame would
 * decode into the wrong type and nothing would report it. With `type` present,
 * `z.discriminatedUnion` maps onto serde's `#[serde(tag = "type")]`, which
 * dispatches on the tag and rejects an unknown one outright.
 *
 * The tag is on each member rather than wrapped in an envelope because an
 * envelope would add a second `{type, ...}` indirection that every consumer
 * unwraps and every replayer must strip. Each member is self-describing on the
 * wire, which is what makes a frame captured with `socat` readable on its own.
 */
export const serverMessageSchema = z.discriminatedUnion("type", [
  stateSnapshotSchema,
  stateDiffSchema,
  ptyChunkSchema,
  ptyExitSchema,
  ackSchema,
  serverErrorSchema,
])

export type IpcJobState = z.infer<typeof jobStateSchema>
export type IpcJobView = z.infer<typeof jobViewSchema>
export type IpcPaneKind = z.infer<typeof paneKindSchema>
export type IpcPaneView = z.infer<typeof paneViewSchema>
export type IpcWorkspaceView = z.infer<typeof workspaceViewSchema>
export type IpcTailscaleStatusView = z.infer<typeof tailscaleStatusViewSchema>
export type IpcStateSnapshot = z.infer<typeof stateSnapshotSchema>
export type IpcStateChange = z.infer<typeof stateChangeSchema>
export type IpcStateDiff = z.infer<typeof stateDiffSchema>
export type IpcPtyChunk = z.infer<typeof ptyChunkSchema>
export type IpcPtyExit = z.infer<typeof ptyExitSchema>
export type IpcAck = z.infer<typeof ackSchema>
export type IpcServerError = z.infer<typeof serverErrorSchema>
export type IpcServerMessage = z.infer<typeof serverMessageSchema>
export type IpcApprovalScope = z.infer<typeof approvalScopeSchema>
export type IpcControlCommand = z.infer<typeof controlCommandSchema>
export type IpcBlockedReason = z.infer<typeof blockedReasonSchema>