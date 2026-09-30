import { canonicalJson } from "../../../orchestration/digest.js"
import { createContractError, type ContractError, type Result } from "../../../orchestration/errors.js"
import { CURRENT_SCHEMA_VERSION } from "../../../orchestration/identifiers.js"
import { MAX_TERMINAL_FRAME_BYTES } from "../../protocol/bounds.js"
import { decodedBase64Bytes, messageIdSchema } from "../../protocol/identifiers.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../protocol/negotiation.js"
import { safeParseMeshEnvelope } from "../../protocol/registry.js"
import type { MeshTerminalControl, MeshTerminalData } from "../../protocol/terminal.js"
import type { MeshEnvelope } from "../../protocol/types.js"
import type { TerminalEncodedFrame, TerminalInboundFrame } from "./types.js"

/**
 * M4.7 — the terminal wire codec, and the place requirement 3 is enforced.
 *
 * **Why a codec module at all.** A WebSocket carries bytes and the protocol
 * carries records, so somebody has to decide which bytes are which. In the route
 * handler that decision would be made a second time by the next handler, and the
 * two would disagree about what a data frame is. So there are exactly four
 * functions here, and they are the only things under `src/mesh/` that turn
 * terminal bytes into or out of a wire form.
 *
 * **The separation, and why an opcode alone is not enough.**
 *
 * The transport already distinguishes them: a control frame travels as a TEXT
 * WebSocket frame and a data frame as a BINARY one, so the two cannot arrive
 * through each other's door. That is the cheap half, and it is a property of the
 * transport rather than of the protocol — any client that wrote a control record
 * into a binary frame would be caught only by what we happened to tell it, and a
 * proxy that re-framed would erase the distinction entirely.
 *
 * So the second half is here and it is the half that is asserted: each frame
 * goes through `safeParseMeshEnvelope` — M4-V's single entry point, which
 * dispatches on `recordType` BEFORE the shape is chosen — and the resulting
 * `recordType` is then compared against the one the opcode promised. A
 * `mesh.terminal.data` sent as TEXT is refused; a `mesh.terminal.control` sent as
 * BINARY is refused.
 *
 * This matters beyond tidiness because of the milestone's stop condition: "stop
 * if terminal output can enter logs, events, or another project stream". The
 * cheapest route from terminal bytes to a log line is a record that parses as a
 * control frame and is then handled as one — a control handler has a `detail`
 * string, a `ContractError` message and a structured record of its own, and a
 * misrouted data frame lands in all three. A data frame refused at the door
 * cannot be logged by a handler that never sees it.
 *
 * **Base64, and why the encode is not a cast.** The data frame's `chunk` is
 * standard base64 with padding, per §4.9 and `base64Schema`. It is base64 rather
 * than raw bytes because the same record has to survive being quoted into a bug
 * report or carried in a `mesh.event` payload without a length or encoding
 * ambiguity — and because a JSON string cannot hold arbitrary bytes. The FRAME
 * is binary on the wire, which is a separate concern: a binary frame carries the
 * canonical JSON of the data envelope, so the bytes crossing the socket are a
 * JSON document and a proxy that logs a frame body logs base64 inside a record
 * rather than terminal output.
 */

/**
 * A terminal frame's replay window, in milliseconds.
 *
 * A control frame is an instruction, so replaying one is acting twice — hence a
 * window at all, and hence `evaluateReplayWindow` being applied on the control
 * path. It is NOT applied to data frames: a dropped data frame is not a hole in
 * an instruction stream, it is a hole the client recovers from by re-basing on a
 * snapshot, and refusing a stale-by-window chunk would turn a slow client into a
 * disconnected one. That asymmetry is the reason the window lives here rather
 * than on the envelope schema, which both families share.
 */
export const TERMINAL_FRAME_REPLAY_WINDOW_MS = 300_000

/**
 * The `chunk` of a data frame, base64-encoded.
 *
 * `Buffer` rather than `btoa` because `btoa` throws on every byte above `0x7f` —
 * which is most of a terminal — and a codec that throws on the content it exists
 * to carry is a codec every caller has to wrap in a try/catch.
 */
export function encodeTerminalChunk(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")
}

/**
 * A base64 `chunk`, decoded.
 *
 * Deliberately NOT re-checking the frame bound: the family schema has already
 * refused anything over `MAX_TERMINAL_FRAME_BYTES` using {@link decodedBase64Bytes},
 * which reads the STRING and allocates nothing. A bound checked after decoding
 * would be a bound that only fires once the allocation it exists to prevent has
 * already happened.
 */
export function decodeTerminalChunk(chunk: string): Uint8Array {
  return new Uint8Array(Buffer.from(chunk, "base64"))
}

/** Everything an outbound frame needs that is not the payload. */
export interface TerminalFrameOrigin {
  /** The node sending. */
  readonly senderNodeId: string
  /**
   * The node the frame is addressed to, or `null` for a broadcast.
   *
   * A control frame's recipient is the runtime's node and the family REFUSES any
   * other, because a control frame is an instruction to the node holding the
   * runtime and one delivered to a peer is a misroute rather than a fan-out. A
   * data frame's recipient is `null`: the gateway — not the envelope — is what
   * knows who is on the other end of that socket, and the family deliberately
   * does not check it.
   */
  readonly recipientNodeId: string | null
  readonly issuedAt: string
  readonly expiresAt: string
  /**
   * Supplied by the caller rather than generated.
   *
   * `Math.random` is not permitted outside injected clocks in this codebase, and
   * a message id that cannot be predicted cannot be asserted on: the two
   * terminals in `tests/unit/mesh/gateway/terminal/fixtures.ts` produce the same
   * ids on every run, so a duplicate-id bug is a reproducible failure rather
   * than a flake.
   */
  readonly messageId: string
}

/**
 * A control frame, as a TEXT frame.
 *
 * `correlationId` is the payload's `clientId` because the family requires it: a
 * control frame is about one client, and a correlation id that named something
 * else would leave a client unable to tell which of its own frames an answer
 * referred to.
 */
export function encodeControlFrame(payload: MeshTerminalControl, origin: TerminalFrameOrigin): TerminalEncodedFrame {
  const text = canonicalJson({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.terminal.control",
    messageId: messageIdSchema.parse(origin.messageId),
    correlationId: payload.clientId,
    causation: null,
    senderNodeId: origin.senderNodeId,
    recipientNodeId: origin.recipientNodeId,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: origin.issuedAt,
    expiresAt: origin.expiresAt,
    payload,
  })
  return { kind: "control", text, byteLength: Buffer.byteLength(text, "utf8") }
}

/** A data frame, as a BINARY frame. */
export function encodeDataFrame(payload: MeshTerminalData, origin: TerminalFrameOrigin): TerminalEncodedFrame {
  const text = canonicalJson({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.terminal.data",
    messageId: messageIdSchema.parse(origin.messageId),
    correlationId: payload.clientId,
    causation: null,
    senderNodeId: origin.senderNodeId,
    recipientNodeId: origin.recipientNodeId,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: origin.issuedAt,
    expiresAt: origin.expiresAt,
    payload,
  })
  const bytes = new Uint8Array(Buffer.from(text, "utf8"))
  return { kind: "data", bytes, byteLength: bytes.byteLength }
}

/** What a decoded frame turned out to be. */
export type TerminalDecodedFrame =
  | { readonly family: "control"; readonly envelope: MeshEnvelope; readonly payload: MeshTerminalControl }
  | { readonly family: "data"; readonly envelope: MeshEnvelope; readonly payload: MeshTerminalData }

/**
 * Decodes one inbound frame, and refuses anything whose family does not match
 * its opcode.
 *
 * This is the choke point for the second half of requirement 3. The two
 * directions are separate codes rather than one, because they mean opposite
 * things to whoever has to fix them: a data record in a TEXT frame is a client
 * that put terminal CONTENT in a control slot, and a control record in a BINARY
 * frame is a client that put an INSTRUCTION where content goes. The second is
 * the more dangerous of the two, because an instruction that reaches a control
 * handler is a control handler acting on it.
 *
 * `parseJson`'s failure message is authored here and reports nothing about the
 * input. A malformed frame is exactly the case where a gateway tempted to quote
 * the input into an error would write terminal content to a log line, and the
 * milestone's stop condition is that it never does.
 */
export function decodeTerminalFrame(frame: TerminalInboundFrame): Result<TerminalDecodedFrame> {
  const raw = frame.opcode === "text" ? frame.payload : decodeUtf8(frame.payload)
  const json = parseJson(raw)
  if (!json.ok) return json
  const parsed = safeParseMeshEnvelope(json.value)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const envelope = parsed.value
  if (frame.opcode === "text" && envelope.recordType !== "mesh.terminal.control") {
    return { ok: false, error: familyMismatch(envelope.recordType, "text", "mesh.terminal.control") }
  }
  if (frame.opcode === "binary" && envelope.recordType !== "mesh.terminal.data") {
    return { ok: false, error: familyMismatch(envelope.recordType, "binary", "mesh.terminal.data") }
  }
  if (envelope.recordType === "mesh.terminal.control") {
    return { ok: true, value: { family: "control", envelope, payload: envelope.payload } }
  }
  if (envelope.recordType === "mesh.terminal.data") {
    return { ok: true, value: { family: "data", envelope, payload: envelope.payload } }
  }
  // Unreachable: the two comparisons above returned for every other type, and
  // `MeshEnvelope` has no other member. Written as a refusal rather than a cast
  // so that ADDING a family to the protocol is a compile-visible event here
  // rather than a `payload` that silently narrows to the wrong arm.
  return {
    ok: false,
    error: createContractError(
      "internal_failure",
      "terminal.family_unhandled",
      `The terminal gateway received a '${envelope.recordType}', which is neither terminal family. This is a wiring fault in this build, not a peer problem: the codec's two opcode checks should have returned for every other record type.`,
    ),
  }
}

function familyMismatch(found: string, opcode: "text" | "binary", expected: string): ContractError {
  return createContractError(
    "validation",
    "terminal.frame_family_mismatch",
    `A ${opcode} WebSocket frame carried a '${found}' where a '${expected}' was required. The two terminal families are separate schemas and separate opcodes on purpose: a control frame is an INSTRUCTION and a data frame is terminal CONTENT, and a reader that cannot tell them apart before choosing a handler is a reader that can log terminal output in that handler's error message. The frame was refused unparsed, and its bytes are not reported.`,
  )
}

function parseJson(raw: string): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "terminal.frame_not_json",
        "A terminal WebSocket frame did not parse as JSON. The bytes are deliberately not reported: a malformed frame is exactly the case where a gateway tempted to log its input would write terminal content to a log line, and the milestone's stop condition is that it never does.",
      ),
    }
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")
}

/**
 * A chunk's decoded byte count, WITHOUT decoding it.
 *
 * The same arithmetic `evaluateFrameSize` performs on a number, exported so the
 * gateway can apply the frame bound to a frame it is about to BUILD — where the
 * bytes are still a `Uint8Array` and the bound has to be asked about them before
 * they are base64-encoded. It is asserted equal to `decodedBase64Bytes` of the
 * encoded form rather than assumed, because the two agreeing is the whole reason
 * the bound can be applied on either side of the encoding.
 */
export function decodedChunkBytes(bytes: Uint8Array): number {
  return bytes.byteLength
}

export { MAX_TERMINAL_FRAME_BYTES, decodedBase64Bytes }
