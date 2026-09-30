import { z } from "zod"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import {
  epochSchema,
  nodeIdSchema,
  projectIdSchema,
  sessionIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
} from "../../orchestration/identifiers.js"
import {
  MAX_TERMINAL_BUFFER_BYTES,
  MAX_TERMINAL_FRAME_BYTES,
  MAX_TERMINAL_FRAMES_PER_SECOND,
  MAX_VIEWERS_PER_TERMINAL,
} from "./bounds.js"
import { defineFamily, sameId } from "./envelope.js"
import { base64Schema, decodedBase64Bytes } from "./identifiers.js"

/**
 * `mesh.terminal.*` — the terminal stream.
 *
 * Control and data are SEPARATE SCHEMAS with separate `recordType` values, never
 * one union with a `kind` discriminator. A union means every reader has to
 * decide which arm it holds before it can read a field, and a reader that guesses
 * wrong either drops terminal bytes into a control handler's log line or drops a
 * resize into the byte path. The milestone's guardrail is "stop if terminal
 * output can enter logs, events, or another project stream", and the cheapest
 * way to keep that from being an accident is to make the two shapes incapable of
 * being confused.
 *
 * TERMINAL CONTENT NEVER APPEARS ANYWHERE ELSE. Not in a `mesh.event`, not in a
 * `ContractError` message, not in a structured log. The `chunk` field below is
 * the only place terminal bytes exist on the wire, and the reason strings here
 * are authored by the control path, which never holds a chunk.
 */

const MAX_ROWS = 1_000
const MAX_COLS = 1_000
const MAX_REASON_LENGTH = 1_024

export const TERMINAL_OPERATIONS = [
  "attach",
  "detach",
  "resize",
  "request_input",
  "release_input",
  "takeover_input",
] as const

export type TerminalOperation = (typeof TERMINAL_OPERATIONS)[number]

/**
 * `rows`/`cols` are bound, not just positive.
 *
 * A pty resize is a single `TIOCSWINSZ` on the runtime's side, so a `rows` of a
 * billion is not a big terminal, it is an allocation request the runtime will
 * try to satisfy. The bound is the size of the guard, and it is enforced here
 * rather than at the gateway so a second gateway cannot forget it.
 */
export const terminalControlSchema = z
  .object({
    terminalId: terminalIdSchema,
    projectId: projectIdSchema,
    sessionId: sessionIdSchema,
    nodeId: nodeIdSchema,
    clientId: terminalClientIdSchema,
    operation: z.enum(TERMINAL_OPERATIONS),
    /** Required for `takeover_input`, forbidden elsewhere. */
    reason: z.string().min(1).max(MAX_REASON_LENGTH).optional(),
    rows: z.number().int().positive().max(MAX_ROWS).optional(),
    cols: z.number().int().positive().max(MAX_COLS).optional(),
    /**
     * The controller epoch at the moment input ownership is granted. Carried on
     * EVERY control frame, not only on `request_input`, because a `takeover_input`
     * that arrives after a lease expiry must be refusable on the same evidence as
     * the request that preceded it — a frame without an epoch is a frame the
     * gateway can only check against whatever it last happened to see.
     */
    epoch: epochSchema,
  })
  .strict()
  .superRefine((frame, ctx) => {
    if (frame.operation === "resize") {
      if (frame.rows === undefined || frame.cols === undefined) {
        ctx.addIssue({ code: "custom", path: ["rows"], message: "A resize must carry both rows and cols; a half-resize is a corrupt pty size" })
      }
    } else if (frame.rows !== undefined || frame.cols !== undefined) {
      ctx.addIssue({ code: "custom", path: ["rows"], message: `Only a resize carries a terminal size; '${frame.operation}' does not` })
    }
    if (frame.operation === "takeover_input" && frame.reason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A takeover of input ownership must record a reason; the displaced client is notified with it",
      })
    }
    if (frame.operation !== "takeover_input" && frame.reason !== undefined) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: `Only a takeover carries a takeover reason; '${frame.operation}' does not` })
    }
  })

/**
 * The data frame.
 *
 * `chunk` is base64, and its DECODED length is what `MAX_TERMINAL_FRAME_BYTES`
 * bounds. The bound is checked against the string without decoding it: a
 * gateway that decoded first would have to allocate the attacker's bytes before
 * it could refuse them, which is the resource exhaustion the bound exists to
 * prevent.
 */
export const terminalDataSchema = z
  .object({
    terminalId: terminalIdSchema,
    clientId: terminalClientIdSchema,
    direction: z.enum(["to_runtime", "to_viewer"]),
    /** A single-member literal, so a second encoding is a version bump. */
    encoding: z.literal("base64"),
    chunk: base64Schema,
    /** Per client, monotonic. Per CLIENT, not per terminal: two viewers of one terminal have independent streams. */
    sequence: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine((frame, ctx) => {
    const bytes = decodedBase64Bytes(frame.chunk)
    if (bytes > MAX_TERMINAL_FRAME_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["chunk"],
        // The message reports the SIZE and never the content. A `ContractError`
        // message is a log line and a log line is somewhere terminal output can
        // end up, which is the milestone's stop condition.
        message: `Terminal frame decodes to ${bytes} bytes, over the ${MAX_TERMINAL_FRAME_BYTES} byte bound`,
      })
    }
    if (frame.chunk === "") {
      ctx.addIssue({ code: "custom", path: ["chunk"], message: "An empty data frame carries no information and only costs a sequence number" })
    }
  })

export const terminalControlFamily = defineFamily({
  recordType: "mesh.terminal.control",
  payloadSchema: terminalControlSchema,
  refine: (envelope, ctx) => {
    if (!sameId(envelope.correlationId, envelope.payload.clientId)) {
      ctx.addIssue({ code: "custom", path: ["correlationId"], message: `A terminal control frame correlates on the client that sent it; got '${envelope.correlationId}' for '${envelope.payload.clientId}'` })
    }
    if (envelope.recipientNodeId !== null && !sameId(envelope.recipientNodeId, envelope.payload.nodeId)) {
      ctx.addIssue({ code: "custom", path: ["recipientNodeId"], message: `A terminal control frame is addressed to the node holding the runtime; got '${envelope.recipientNodeId}' for '${envelope.payload.nodeId}'` })
    }
  },
})

export const terminalDataFamily = defineFamily({
  recordType: "mesh.terminal.data",
  payloadSchema: terminalDataSchema,
  refine: (envelope, ctx) => {
    if (!sameId(envelope.correlationId, envelope.payload.clientId)) {
      ctx.addIssue({ code: "custom", path: ["correlationId"], message: `A terminal data frame correlates on the client that sent it; got '${envelope.correlationId}' for '${envelope.payload.clientId}'` })
    }
  },
})

export type MeshTerminalControl = z.infer<typeof terminalControlSchema>
export type MeshTerminalData = z.infer<typeof terminalDataSchema>
export type MeshTerminalControlEnvelope = z.infer<typeof terminalControlFamily.envelopeSchema>
export type MeshTerminalDataEnvelope = z.infer<typeof terminalDataFamily.envelopeSchema>

// --- Per-client resource evaluation --------------------------------------

export type TerminalAdmission =
  | { readonly admitted: true; readonly detail: string }
  | { readonly admitted: false; readonly limit: "viewers" | "frame_bytes" | "frame_rate" | "buffer"; readonly error: ContractError }

/**
 * Viewer count for one terminal.
 *
 * Many viewers, ONE input owner. The count is checked here, purely, so the
 * gateway does not have to know the number; the number living in a handler is
 * the reason it is 16 in one gateway and unbounded in the next.
 */
export function evaluateViewerCount(currentViewers: number): TerminalAdmission {
  if (currentViewers + 1 > MAX_VIEWERS_PER_TERMINAL) {
    return {
      admitted: false,
      limit: "viewers",
      error: createContractError(
        "policy_denied",
        "mesh.terminal_viewer_limit",
        `Terminal already has ${currentViewers} viewers, at the ${MAX_VIEWERS_PER_TERMINAL} bound`,
      ),
    }
  }
  return { admitted: true, detail: `viewer ${currentViewers + 1} of ${MAX_VIEWERS_PER_TERMINAL}` }
}

/**
 * A single frame's size.
 *
 * Reports the SIZE and never the chunk, on the same reasoning as the schema
 * refinement: the error is a log line.
 */
export function evaluateFrameSize(decodedBytes: number): TerminalAdmission {
  if (decodedBytes > MAX_TERMINAL_FRAME_BYTES) {
    return {
      admitted: false,
      limit: "frame_bytes",
      error: createContractError(
        "policy_denied",
        "mesh.terminal_frame_too_large",
        `Terminal frame is ${decodedBytes} bytes, over the ${MAX_TERMINAL_FRAME_BYTES} byte bound`,
      ),
    }
  }
  return { admitted: true, detail: `${decodedBytes} of ${MAX_TERMINAL_FRAME_BYTES} bytes` }
}

/**
 * A per-client frame rate over a caller-supplied window.
 *
 * `windowMs` is a parameter and the count is the caller's, so the limit is
 * testable without a timer. `frames` is a count, not a timestamp list, so the
 * caller does not have to keep terminal traffic in an array — keeping terminal
 * bytes in memory to rate-limit them would defeat the buffer bound.
 */
export function evaluateFrameRate(framesInWindow: number, windowMs: number): TerminalAdmission {
  if (windowMs <= 0) {
    return {
      admitted: false,
      limit: "frame_rate",
      error: createContractError("validation", "mesh.terminal_invalid_window", "Frame-rate evaluation needs a positive window"),
    }
  }
  const allowed = Math.max(1, Math.floor((MAX_TERMINAL_FRAMES_PER_SECOND * windowMs) / 1_000))
  if (framesInWindow > allowed) {
    return {
      admitted: false,
      limit: "frame_rate",
      error: createContractError(
        "policy_denied",
        "mesh.terminal_frame_rate_exceeded",
        `Client sent ${framesInWindow} frames in ${windowMs}ms; the bound is ${allowed}`,
      ),
    }
  }
  return { admitted: true, detail: `${framesInWindow} of ${allowed} frames` }
}

/**
 * The backpressure bound.
 *
 * The outcome is DROPPED, not disconnected: a slow client loses frames and
 * reconnects from a snapshot, where disconnecting everyone over one slow
 * consumer turns a resource bound into a denial of service against the whole
 * terminal. Which frames survive is the gateway's business, but that the
 * decision is "drop" and not "grow" is this module's.
 */
export function evaluateBufferPressure(pendingBytes: number): TerminalAdmission {
  if (pendingBytes > MAX_TERMINAL_BUFFER_BYTES) {
    return {
      admitted: false,
      limit: "buffer",
      error: createContractError(
        "policy_denied",
        "mesh.terminal_client_too_slow",
        `Client buffer holds ${pendingBytes} bytes, over the ${MAX_TERMINAL_BUFFER_BYTES} byte bound; frames are dropped, not buffered`,
      ),
    }
  }
  return { admitted: true, detail: `${pendingBytes} of ${MAX_TERMINAL_BUFFER_BYTES} bytes pending` }
}

/**
 * How many frames to drop when the buffer is over its bound.
 *
 * Dropping from the FRONT is deliberate: the tail is what the user is currently
 * looking at, and a client that reconnects from a snapshot is better served by
 * losing history it will re-fetch than by losing the last prompt it sent.
 */
export function framesToDrop(pendingBytes: number, oldestBytes: number): number {
  const overflow = pendingBytes - MAX_TERMINAL_BUFFER_BYTES
  if (overflow <= 0 || oldestBytes <= 0) return 0
  return Math.max(1, Math.ceil(overflow / oldestBytes))
}

export function checkTerminalAdmission(admission: TerminalAdmission): Result<true> {
  return admission.admitted ? { ok: true, value: true } : { ok: false, error: admission.error }
}
