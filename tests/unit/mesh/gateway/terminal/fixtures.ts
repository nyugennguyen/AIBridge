/**
 * M4.7 test fixtures.
 *
 * Four rules, each of which exists because breaking it produced a test that
 * passed for the wrong reason during an earlier milestone:
 *
 *   1. **Nothing here reads a clock.** Every instant is `T0` plus a number and
 *      the clock is a closure the test moves by hand. The subjects of this
 *      directory are "a thousand frames in one second", "a client that stopped
 *      reading" and "a lease that expired ten minutes ago" — a fixture that
 *      called `Date.now()` would turn all three into sleeps, and a sleeping test
 *      passes on a slow machine and fails on a fast one.
 *   2. **Every record is built RAW and left for the gateway to parse.** A fixture
 *      that parsed first would let a negative test pass for the wrong reason,
 *      because the record would already be valid by the time the seam was asked
 *      to refuse it.
 *   3. **Branded ids are PARSED, never cast.** A fixture that laundered a string
 *      into a brand would let a test pass against an id no peer could address,
 *      which is the exact class of defect the brands exist to prevent.
 *   4. **The fake socket is a TRANSPORT, not a client.** It records what was
 *      written to it and reports how many bytes it is still holding; it never
 *      decides anything. That is the whole of the seam M4.7's session logic is
 *      tested through, and a fake that decided anything would make the tests
 *      below it rather than of it.
 */
import { canonicalJson } from "../../../../../src/orchestration/digest.js"
import { createContractError, type ContractError } from "../../../../../src/orchestration/errors.js"
import {
  epochSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  sessionIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
  type Epoch,
  type NodeId,
  type ProjectId,
  type RunId,
  type SessionId,
  type TerminalClientId,
  type TerminalId,
} from "../../../../../src/orchestration/identifiers.js"
import { CURRENT_SCHEMA_VERSION } from "../../../../../src/orchestration/identifiers.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../../../../src/mesh/protocol/negotiation.js"
import { messageIdSchema } from "../../../../../src/mesh/protocol/identifiers.js"
import type { MeshTerminalControl, MeshTerminalData } from "../../../../../src/mesh/protocol/terminal.js"
import type {
  TerminalAccessOutcome,
  TerminalAccessPort,
  TerminalAccessRefusal,
  TerminalAccessRequest,
  TerminalBinding,
  TerminalEncodedFrame,
  TerminalInputRequest,
  TerminalOutputSink,
  TerminalOutputSubscription,
  TerminalResizeRequest,
  TerminalRuntimePort,
  TerminalSnapshotRequest,
  TerminalSocket,
  TerminalTelemetry,
  TerminalTelemetryEvent,
} from "../../../../../src/mesh/gateway/terminal/index.js"

export const CONTROLLER: NodeId = nodeIdSchema.parse("node-controller-1")
export const WORKER: NodeId = nodeIdSchema.parse("node-worker-1")
export const PEER: NodeId = nodeIdSchema.parse("node-peer-1")
export const PROJECT: ProjectId = projectIdSchema.parse("project-release")
export const OTHER_PROJECT: ProjectId = projectIdSchema.parse("project-other")
export const RUN: RunId = runIdSchema.parse("run-release-1")
export const OTHER_RUN: RunId = runIdSchema.parse("run-release-2")
export const SESSION: SessionId = sessionIdSchema.parse("sess-release-1")
export const OTHER_SESSION: SessionId = sessionIdSchema.parse("sess-release-2")
export const TERMINAL: TerminalId = terminalIdSchema.parse("term-release-1")
export const OTHER_TERMINAL: TerminalId = terminalIdSchema.parse("term-release-2")
export const ALICE: TerminalClientId = terminalClientIdSchema.parse("client-alice")
export const BOB: TerminalClientId = terminalClientIdSchema.parse("client-bob")
export const CAROL: TerminalClientId = terminalClientIdSchema.parse("client-carol")
export const EPOCH: Epoch = epochSchema.parse(4)
export const NEXT_EPOCH: Epoch = epochSchema.parse(5)

export const T0_MS = Date.parse("2026-09-28T00:00:00.000Z")

/** A clock the test moves by hand. */
export class TestClock {
  #ms: number

  constructor(startMs: number = T0_MS) {
    this.#ms = startMs
  }

  now = (): number => this.#ms

  set(ms: number): void {
    this.#ms = ms
  }

  advance(ms: number): void {
    this.#ms += ms
  }

  iso(): string {
    return new Date(this.#ms).toISOString()
  }
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export function binding(overrides: Partial<TerminalBinding> = {}): TerminalBinding {
  return {
    terminalId: TERMINAL,
    projectId: PROJECT,
    sessionId: SESSION,
    nodeId: WORKER,
    runId: RUN,
    ...overrides,
  }
}

// --- The transport seam ----------------------------------------------------

/**
 * A socket that records rather than decides.
 *
 * `pendingBytes` is a plain mutable number a test sets directly, which is what
 * makes "a client that stopped reading" a state rather than a simulation: a real
 * `ws` socket's `bufferedAmount` only grows when the peer's receive window
 * closes, and driving that from a test would mean driving TCP. The two tests that
 * need the real thing are in `tests/integration/terminal-websocket.test.ts`.
 */
export class RecordingSocket implements TerminalSocket {
  readonly frames: TerminalEncodedFrame[] = []
  closed = 0
  #pendingBytes = 0

  sendText(payload: string): void {
    this.frames.push({ kind: "control", text: payload, byteLength: Buffer.byteLength(payload, "utf8") })
  }

  sendBinary(payload: Uint8Array): void {
    this.frames.push({ kind: "data", bytes: payload, byteLength: payload.byteLength })
  }

  close(): void {
    this.closed += 1
  }

  pendingBytes(): number {
    return this.#pendingBytes
  }

  /** Pretends the transport is holding this many bytes. */
  hold(bytes: number): void {
    this.#pendingBytes = bytes
  }

  /** Every control frame this socket was written to, parsed. */
  controlPayloads(): MeshTerminalControl[] {
    return this.frames
      .filter((frame): frame is { kind: "control"; text: string; byteLength: number } => frame.kind === "control")
      .map((frame) => (JSON.parse(frame.text) as { payload: MeshTerminalControl }).payload)
  }

  /** Every data frame this socket was written to, parsed. */
  dataPayloads(): MeshTerminalData[] {
    return this.frames
      .filter((frame): frame is { kind: "data"; bytes: Uint8Array; byteLength: number } => frame.kind === "data")
      .map((frame) => (JSON.parse(Buffer.from(frame.bytes).toString("utf8")) as { payload: MeshTerminalData }).payload)
  }

  /** The raw text of every frame, joined — for a leak sweep. */
  everythingWritten(): string {
    return this.frames.map((frame) => (frame.kind === "control" ? frame.text : Buffer.from(frame.bytes).toString("utf8"))).join("\n")
  }
}

// --- The access seam -------------------------------------------------------

export interface AccessCall {
  readonly request: TerminalAccessRequest
  readonly intent: TerminalAccessRequest["intent"]
}

/**
 * A scriptable access port.
 *
 * `answers` is a QUEUE rather than a predicate, because the property under test
 * is that the gateway asks TWICE — once at attach and once at ownership — and a
 * predicate could not distinguish "asked once and got the right answer twice" from
 * "asked once and cached it". A queue makes the re-ask observable: an empty queue
 * when a third call arrives is a test failure that names the call that should not
 * have happened.
 */
export class FakeAccessPort implements TerminalAccessPort {
  readonly calls: AccessCall[] = []
  #answers: (TerminalAccessOutcome | ((request: TerminalAccessRequest) => TerminalAccessOutcome))[]

  constructor(
    answers: (TerminalAccessOutcome | ((request: TerminalAccessRequest) => TerminalAccessOutcome))[] = [],
    private readonly fallback: TerminalAccessOutcome | ((request: TerminalAccessRequest) => TerminalAccessOutcome) = () => grant(),
  ) {
    this.#answers = [...answers]
  }

  get intents(): readonly TerminalAccessRequest["intent"][] {
    return this.calls.map((call) => call.intent)
  }

  async authorize(request: TerminalAccessRequest): Promise<TerminalAccessOutcome> {
    this.calls.push({ request, intent: request.intent })
    const next = this.#answers.shift()
    const answer = next ?? this.fallback
    return typeof answer === "function" ? answer(request) : answer
  }
}

export function grant(overrides: Partial<TerminalBinding> = {}, epoch: Epoch = EPOCH): TerminalAccessOutcome {
  return { granted: true, binding: binding(overrides), epoch }
}

export function denial(reason: TerminalAccessRefusal, message = `Access refused: ${reason}`): TerminalAccessOutcome {
  return { granted: false, reason, error: createContractError("policy_denied", `terminal.access_${reason}`, message) }
}

// --- The runtime seam ------------------------------------------------------

export interface RuntimeWrite {
  readonly kind: "input" | "resize" | "snapshot"
  readonly request: TerminalInputRequest | TerminalResizeRequest | TerminalSnapshotRequest
}

/**
 * A pty the test writes to.
 *
 * `emit` is how runtime OUTPUT reaches the gateway. It exists rather than a
 * `read()` the gateway polls, because the gateway is not supposed to decide how
 * often to ask a remote runtime for bytes — see the note on `TerminalRuntimePort`.
 */
export class FakeRuntime implements TerminalRuntimePort {
  readonly writes: RuntimeWrite[] = []
  readonly inputs: Uint8Array[] = []
  readonly resizes: { readonly rows: number; readonly columns: number }[] = []
  subscriptions = 0
  subscriptionsClosed = 0
  #sinks: TerminalOutputSink[] = []
  #subscribeFails = false
  #writeFails: ContractError | null = null

  async subscribe(_binding: TerminalBinding, sink: TerminalOutputSink): Promise<{ ok: true; value: TerminalOutputSubscription } | { ok: false; error: ContractError }> {
    if (this.#subscribeFails) {
      return { ok: false, error: createContractError("runtime_failure", "terminal.runtime_unavailable", "The runtime refused a subscription.") }
    }
    this.subscriptions += 1
    this.#sinks.push(sink)
    return {
      ok: true,
      value: {
        close: () => {
          this.subscriptionsClosed += 1
          this.#sinks = this.#sinks.filter((candidate) => candidate !== sink)
        },
      },
    }
  }

  async writeInput(request: TerminalInputRequest): Promise<{ ok: true; value: void } | { ok: false; error: ContractError }> {
    this.writes.push({ kind: "input", request })
    if (this.#writeFails !== null) return { ok: false, error: this.#writeFails }
    this.inputs.push(request.bytes)
    return { ok: true, value: undefined }
  }

  async resize(request: TerminalResizeRequest): Promise<{ ok: true; value: void } | { ok: false; error: ContractError }> {
    this.writes.push({ kind: "resize", request })
    this.resizes.push(request.dimensions)
    return { ok: true, value: undefined }
  }

  async snapshot(request: TerminalSnapshotRequest): Promise<{ ok: true; value: Uint8Array } | { ok: false; error: ContractError }> {
    this.writes.push({ kind: "snapshot", request })
    return { ok: true, value: new Uint8Array(0) }
  }

  /** Runtime output, delivered to every subscription the gateway opened. */
  emit(bytes: Uint8Array): void {
    for (const sink of this.#sinks) sink(bytes)
  }

  get sinkCount(): number {
    return this.#sinks.length
  }

  failSubscriptions(): void {
    this.#subscribeFails = true
  }

  failWrites(error: ContractError): void {
    this.#writeFails = error
  }
}

// --- Telemetry -------------------------------------------------------------

export class RecordingTelemetry implements TerminalTelemetry {
  readonly events: TerminalTelemetryEvent[] = []

  record(event: TerminalTelemetryEvent): void {
    this.events.push(event)
  }

  kinds(): readonly string[] {
    return this.events.map((event) => event.kind)
  }

  find(kind: TerminalTelemetryEvent["kind"]): TerminalTelemetryEvent | undefined {
    return this.events.find((event) => event.kind === kind)
  }
}

// --- Records the tests send and expect -------------------------------------

let messageCounter = 0

function nextMessageId(): string {
  messageCounter += 1
  return messageIdSchema.parse(`msg-test-${messageCounter}`)
}

/**
 * A `mesh.terminal.control` ENVELOPE, raw, and its JSON text.
 *
 * Raw on purpose, for the reason rule 2 gives. Every override exists because a
 * test has to be able to make the record wrong in exactly one way: `operation`
 * and `reason` are separate overrides so a takeover can be built without a reason
 * (the schema refuses it) and a request can be built with one (it also refuses
 * that), and `issuedAt`/`expiresAt` are settable so the replay window can be
 * violated without waiting five minutes.
 */
export function controlFrame(overrides: Partial<MeshTerminalControl> = {}, envelope: Record<string, unknown> = {}): string {
  messageCounter += 1
  return canonicalJson({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.terminal.control",
    messageId: nextMessageId(),
    correlationId: overrides.clientId ?? ALICE,
    causation: null,
    senderNodeId: CONTROLLER,
    recipientNodeId: overrides.nodeId ?? WORKER,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: iso(T0_MS),
    expiresAt: iso(T0_MS + 300_000),
    payload: {
      terminalId: TERMINAL,
      projectId: PROJECT,
      sessionId: SESSION,
      nodeId: WORKER,
      clientId: ALICE,
      operation: "attach",
      epoch: EPOCH,
      ...overrides,
    },
    ...envelope,
  })
}

/** A `mesh.terminal.data` ENVELOPE's bytes, for a BINARY frame. */
export function dataFrame(overrides: Partial<MeshTerminalData> = {}, envelope: Record<string, unknown> = {}): Uint8Array {
  messageCounter += 1
  const text = canonicalJson({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.terminal.data",
    messageId: nextMessageId(),
    correlationId: overrides.clientId ?? ALICE,
    causation: null,
    senderNodeId: CONTROLLER,
    recipientNodeId: WORKER,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: iso(T0_MS),
    expiresAt: iso(T0_MS + 300_000),
    payload: {
      terminalId: TERMINAL,
      clientId: ALICE,
      direction: "to_runtime",
      encoding: "base64",
      chunk: Buffer.from("ls", "utf8").toString("base64"),
      sequence: 1,
      ...overrides,
    },
    ...envelope,
  })
  return new Uint8Array(Buffer.from(text, "utf8"))
}

export function text(bytes: string | Uint8Array): string {
  return typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8")
}

/** The parsed payload of a control envelope this module built. */
export function payloadOf(frame: string): MeshTerminalControl {
  return (JSON.parse(frame) as { payload: MeshTerminalControl }).payload
}

export function bytes(text_: string): Uint8Array {
  return new Uint8Array(Buffer.from(text_, "utf8"))
}
