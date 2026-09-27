import { describe, expect, it } from "vitest"
import { BoundedTerminalOutput, presentTerminalBytes } from "../../../../src/tui/terminal/index.js"
import { decode, text } from "./fixtures.js"

describe("bounded terminal presentation", () => {
  it("retains one ordered tail and reports exact truncation", () => {
    const output = new BoundedTerminalOutput(5)
    output.append(text("abc"))
    output.append(text("defg"))

    expect(decode(output.bytes())).toBe("cdefg")
    expect(output.byteLength).toBe(5)
    expect(output.droppedByteCount).toBe(2)
    expect(output.truncated).toBe(true)

    const copy = output.bytes()
    copy.fill(0)
    expect(decode(output.bytes())).toBe("cdefg")
  })

  it("renders terminal escape and control bytes as inert visible text", () => {
    const presented = presentTerminalBytes(Uint8Array.of(0x61, 0x1b, 0x5b, 0x32, 0x4a, 0x1d, 0x0a, 0x62))

    expect(presented).toBe("a␛[2J␝\nb")
    expect(presented).not.toContain("\u001b")
    expect(presented).not.toContain("\u001d")
  })
})
