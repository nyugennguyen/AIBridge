import { MAX_TERMINAL_PRESENTATION_BYTES } from "./types.js"

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_TERMINAL_PRESENTATION_BYTES) {
    throw new RangeError(`Terminal presentation limit must be an integer from 1 to ${MAX_TERMINAL_PRESENTATION_BYTES}`)
  }
}

/** Ephemeral tail buffer. It deliberately has no serialization or persistence API. */
export class BoundedTerminalOutput {
  private data = new Uint8Array()
  private dropped = 0

  constructor(readonly limit: number) {
    assertLimit(limit)
  }

  get byteLength(): number {
    return this.data.byteLength
  }

  get droppedByteCount(): number {
    return this.dropped
  }

  get truncated(): boolean {
    return this.dropped > 0
  }

  append(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) return
    const totalLength = this.data.byteLength + chunk.byteLength
    if (totalLength <= this.limit) {
      const combined = new Uint8Array(totalLength)
      combined.set(this.data)
      combined.set(chunk, this.data.byteLength)
      this.data = combined
      return
    }

    const drop = totalLength - this.limit
    this.dropped += drop
    if (chunk.byteLength >= this.limit) {
      this.data = Uint8Array.from(chunk.subarray(chunk.byteLength - this.limit))
      return
    }
    const retained = this.data.subarray(Math.min(drop, this.data.byteLength))
    const combined = new Uint8Array(retained.byteLength + chunk.byteLength)
    combined.set(retained)
    combined.set(chunk, retained.byteLength)
    this.data = combined
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.data)
  }

  clear(): void {
    this.data.fill(0)
    this.data = new Uint8Array()
    this.dropped = 0
  }
}
