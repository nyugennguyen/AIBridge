import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  bridgeLogPath,
  createFileLogger,
  followLog,
  formatRequestLine,
  logDirFor,
  tailLines,
  type LogFileReader,
} from "../../../src/host/logs.js"

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aibr-logs-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** In-memory log file: `files[path]` is the content, absent = missing. */
function memReader(files: Record<string, string>): LogFileReader {
  return {
    size: (path) => (files[path] === undefined ? null : Buffer.byteLength(files[path]!)),
    read: (path, start, end) => Buffer.from(files[path] ?? "").subarray(start, end).toString("utf8"),
  }
}

describe("paths", () => {
  it("puts the log under <stateDir>/logs/aibridge.log", () => {
    expect(logDirFor("/s")).toBe("/s/logs")
    expect(bridgeLogPath("/s")).toBe("/s/logs/aibridge.log")
  })
})

describe("createFileLogger", () => {
  it("creates the directory and appends formatted lines", () => {
    const dir = tempDir()
    const path = join(dir, "logs", "aibridge.log")
    const logger = createFileLogger({ path, now: () => new Date("2026-01-02T03:04:05.000Z") })
    logger.info("hello")
    logger.warn("careful")
    logger.error("broken")
    logger.close()
    expect(readFileSync(path, "utf8")).toBe(
      "2026-01-02T03:04:05.000Z INFO  hello\n" +
        "2026-01-02T03:04:05.000Z WARN  careful\n" +
        "2026-01-02T03:04:05.000Z ERROR broken\n",
    )
  })

  it("appends to an existing file and mirrors each line", () => {
    const dir = tempDir()
    const path = join(dir, "a.log")
    writeFileSync(path, "old\n")
    const mirrored: string[] = []
    const logger = createFileLogger({ path, mirror: (line) => mirrored.push(line), now: () => new Date(0) })
    logger.log("info", "x")
    logger.close()
    expect(readFileSync(path, "utf8")).toBe(`old\n${mirrored[0]}`)
    expect(mirrored).toEqual(["1970-01-01T00:00:00.000Z INFO  x\n"])
  })

  it("flattens newlines and control characters into one line", () => {
    const dir = tempDir()
    const path = join(dir, "a.log")
    const logger = createFileLogger({ path, now: () => new Date(0) })
    logger.info("a\nb\u001b[2Jc\u0007d\te")
    logger.close()
    const text = readFileSync(path, "utf8")
    expect(text.split("\n").filter(Boolean)).toHaveLength(1)
    expect(text).toContain("a | b?[2Jc?d\te")
    expect(text).not.toContain("\u001b")
  })

  it("rotates a file larger than rotateBytes to .1 on open", () => {
    const dir = tempDir()
    const path = join(dir, "a.log")
    writeFileSync(path, "x".repeat(200))
    const logger = createFileLogger({ path, rotateBytes: 100, now: () => new Date(0) })
    logger.info("fresh")
    logger.close()
    expect(readFileSync(`${path}.1`, "utf8")).toBe("x".repeat(200))
    expect(readFileSync(path, "utf8")).toBe("1970-01-01T00:00:00.000Z INFO  fresh\n")
  })

  it("does not rotate a small file", () => {
    const dir = tempDir()
    const path = join(dir, "a.log")
    writeFileSync(path, "small\n")
    createFileLogger({ path, rotateBytes: 100 }).close()
    expect(existsSync(`${path}.1`)).toBe(false)
    expect(readFileSync(path, "utf8")).toBe("small\n")
  })

  it("ignores writes after close but still mirrors them", () => {
    const dir = tempDir()
    const path = join(dir, "a.log")
    const mirrored: string[] = []
    const logger = createFileLogger({ path, mirror: (l) => mirrored.push(l) })
    logger.close()
    logger.close()
    logger.info("late")
    expect(readFileSync(path, "utf8")).toBe("")
    expect(mirrored).toHaveLength(1)
  })
})

describe("formatRequestLine", () => {
  it("drops the query string and rounds the duration", () => {
    expect(formatRequestLine({ method: "GET", url: "/jobs/abc?token=secret", status: 200, durationMs: 12.6 })).toBe(
      "GET /jobs/abc 200 13ms",
    )
    expect(formatRequestLine({ method: "POST", url: "/trigger", status: 401, durationMs: 0.2 })).toBe("POST /trigger 401 0ms")
  })
})

describe("tailLines", () => {
  it("returns null for a missing file", () => {
    expect(tailLines(memReader({}), "/x", 10)).toBeNull()
  })

  it("returns the last n lines and the end offset", () => {
    const content = "a\nb\nc\nd\n"
    expect(tailLines(memReader({ "/x": content }), "/x", 2)).toEqual({ text: "c\nd\n", end: content.length })
    expect(tailLines(memReader({ "/x": content }), "/x", 100)).toEqual({ text: content, end: content.length })
  })

  it("returns nothing for -n 0 and for an empty file", () => {
    expect(tailLines(memReader({ "/x": "a\nb\n" }), "/x", 0)).toEqual({ text: "", end: 4 })
    expect(tailLines(memReader({ "/x": "" }), "/x", 5)).toEqual({ text: "", end: 0 })
  })

  it("keeps a last line without a trailing newline", () => {
    expect(tailLines(memReader({ "/x": "a\nb" }), "/x", 5)?.text).toBe("a\nb\n")
  })

  it("drops the partial first line when the window starts mid-file", () => {
    // The window is 256 KiB: a file longer than that is read from the middle.
    const long = `${"p".repeat(300 * 1024)}\nwhole-1\nwhole-2\n`
    const tail = tailLines(memReader({ "/x": long }), "/x", 1000)
    expect(tail?.text).toBe("whole-1\nwhole-2\n")
    expect(tail?.end).toBe(Buffer.byteLength(long))
  })
})

describe("followLog", () => {
  it("prints appended bytes, re-reads a shrunk file from 0, and stops when told", async () => {
    const files: Record<string, string> = { "/x": "start\n" }
    const written: string[] = []
    let polls = 0
    const script = [
      () => {
        files["/x"] = "start\nmore\n"
      },
      () => {
        files["/x"] = "new\n" // rotated: shorter than the offset
      },
      () => {
        delete files["/x"] // briefly missing
      },
      () => {
        files["/x"] = "new\nlast\n"
      },
    ]
    await followLog({
      reader: memReader(files),
      path: "/x",
      from: 6,
      write: (t) => written.push(t),
      sleep: async (ms) => {
        expect(ms).toBe(7)
        script[polls]?.()
        polls += 1
      },
      stopped: () => polls > script.length,
      pollMs: 7,
    })
    expect(written).toEqual(["more\n", "new\n", "last\n"])
  })

  it("does nothing when already stopped", async () => {
    const written: string[] = []
    await followLog({
      reader: memReader({ "/x": "a\n" }),
      path: "/x",
      from: 0,
      write: (t) => written.push(t),
      sleep: async () => undefined,
      stopped: () => true,
    })
    expect(written).toEqual([])
  })
})
