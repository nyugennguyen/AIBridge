import { describe, expect, it } from "vitest"
import { LineStreamSplitter, safeParseJsonLine, stripAnsi } from "../../../src/runtime/stream-parser.js"

describe("Stream Adversity & Robustness Contracts", () => {
  it("assembles partial chunks split across JSON boundaries", () => {
    const splitter = new LineStreamSplitter()
    const part1 = '{"type":"progress","mes'
    const part2 = 'sage":"analyzing"}\n{"type":"sys'
    const part3 = 'tem","ok":true}\n'

    const lines1 = splitter.push(part1)
    expect(lines1).toEqual([])

    const lines2 = splitter.push(part2)
    expect(lines2).toEqual(['{"type":"progress","message":"analyzing"}'])

    const lines3 = splitter.push(part3)
    expect(lines3).toEqual(['{"type":"system","ok":true}'])

    expect(safeParseJsonLine(lines2[0])).toEqual({ type: "progress", message: "analyzing" })
    expect(safeParseJsonLine(lines3[0])).toEqual({ type: "system", ok: true })
  })

  it("strips ANSI color, cursor, and style escape sequences", () => {
    const rawAnsi = "\u001b[31mError\u001b[0m: \u001b[1mSomething failed\u001b[22m\u001b[2K\r\n"
    const stripped = stripAnsi(rawAnsi)
    expect(stripped).toBe("Error: Something failed\r\n")

    const splitter = new LineStreamSplitter({ stripAnsi: true })
    const lines = splitter.push(rawAnsi)
    expect(lines).toEqual(["Error: Something failed"])
  })

  it("strips ANSI escape sequences that span across chunk boundaries", () => {
    const splitter = new LineStreamSplitter({ stripAnsi: true })
    const chunk1 = "Prefix \u001b["
    const chunk2 = "32mGreen Text\u001b[0m suffix\n"
    const lines1 = splitter.push(chunk1)
    const lines2 = splitter.push(chunk2)
    expect(lines1).toEqual([])
    expect(lines2).toEqual(["Prefix Green Text suffix"])
  })

  it("preserves multi-byte Unicode characters split across chunks", () => {
    const splitter = new LineStreamSplitter()
    // Unicode text: 🚀 Task 進行中 (Progressing)
    const line = '{"status":"🚀 進行中"}\n'
    const chunk1 = line.slice(0, 15)
    const chunk2 = line.slice(15)

    const lines1 = splitter.push(chunk1)
    const lines2 = splitter.push(chunk2)

    expect([...lines1, ...lines2]).toEqual(['{"status":"🚀 進行中"}'])
    const parsed = safeParseJsonLine<{ status: string }>([...lines1, ...lines2][0])
    expect(parsed?.status).toBe("🚀 進行中")
  })

  it("bounds oversized lines and prevents unbounded memory growth", () => {
    const splitter = new LineStreamSplitter({ maxLineLength: 100 })
    const longString = "A".repeat(500)
    const lines = splitter.push(longString)

    // Unbounded line without newline reaches safety cap and flushes truncated chunk
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0].length).toBeLessThanOrEqual(100)
  })

  it("gracefully handles corrupted or non-JSON lines", () => {
    expect(safeParseJsonLine("not json at all")).toBeUndefined()
    expect(safeParseJsonLine("{ broken json: true ")).toBeUndefined()
    expect(safeParseJsonLine('{"valid": true}')).toEqual({ valid: true })
  })
})
