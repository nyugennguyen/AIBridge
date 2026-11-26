/**
 * The PID identity helper shared by the state lock and the runtime process
 * registry. The state lock's own tests (tests/integration/state-lock.test.ts)
 * are unchanged and still exercise it through `acquireStateLock`.
 */
import { spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import {
  compareProcessStart,
  isProcessAlive,
  readProcessGroupId,
  readProcessGroupIdAsync,
  readProcessStartTime,
  readProcessStartTimeAsync,
  startTimeForm,
} from "../../../src/host/process-identity.js"
import * as stateLock from "../../../src/host/state-lock.js"

describe("readProcessStartTime", () => {
  it("is what the state lock re-exports", () => {
    expect(stateLock.readProcessStartTime).toBe(readProcessStartTime)
    expect(stateLock.isProcessAlive).toBe(isProcessAlive)
  })

  it("reads this process with a prefix, identically twice, independent of TZ and locale", () => {
    const first = readProcessStartTime(process.pid)
    expect(first).toBeDefined()
    expect(first).toMatch(/^(linux|ps):/)
    expect(readProcessStartTime(process.pid)).toBe(first)
    const other = readProcessStartTime(process.pid, { env: { ...process.env, TZ: "Asia/Ho_Chi_Minh", LC_ALL: "fr_FR.UTF-8" } })
    expect(other).toBe(first)
  })

  it("on Linux reads field 22 of /proc/<pid>/stat and the boot id, with a comm holding spaces and parentheses", () => {
    const fields = Array.from({ length: 50 }, (_, index) => String(index + 3))
    const value = readProcessStartTime(7, {
      platform: "linux",
      readFile: (path) =>
        path === "/proc/7/stat" ? `7 (a (b) c) ${fields.join(" ")}\n` : path === "/proc/sys/kernel/random/boot_id" ? "boot-1\n" : undefined,
      runPs: () => {
        throw new Error("ps must not run on Linux")
      },
    })
    expect(value).toBe("linux:boot-1:22")
  })

  it("is undefined for a PID that does not exist", () => {
    expect(readProcessStartTime(2 ** 22 + 12345)).toBeUndefined()
  })
})

describe("readProcessStartTimeAsync / readProcessGroupIdAsync", () => {
  it("read the same values as the synchronous readers", async () => {
    expect(await readProcessStartTimeAsync(process.pid)).toBe(readProcessStartTime(process.pid))
    expect(await readProcessGroupIdAsync(process.pid)).toBe(readProcessGroupId(process.pid))
  })

  it("on Linux read /proc without ps", async () => {
    const fields = Array.from({ length: 50 }, (_, index) => String(index + 3))
    const sources = {
      platform: "linux" as const,
      readFile: async (path: string) =>
        path === "/proc/7/stat" ? `7 (a b) ${fields.join(" ")}\n` : path === "/proc/sys/kernel/random/boot_id" ? "boot-1\n" : undefined,
      runPs: async () => {
        throw new Error("ps must not run on Linux")
      },
    }
    expect(await readProcessStartTimeAsync(7, { sources })).toBe("linux:boot-1:22")
    expect(await readProcessGroupIdAsync(7, { sources })).toBe(5)
  })

  it("pass the timeout to ps and read a failed ps as undefined", async () => {
    const timeouts: number[] = []
    const sources = {
      platform: "darwin" as const,
      runPs: async (_column: string, _pid: number, _env: Record<string, string | undefined>, timeoutMs: number) => {
        timeouts.push(timeoutMs)
        return undefined
      },
    }
    expect(await readProcessStartTimeAsync(7, { timeoutMs: 250, sources })).toBeUndefined()
    expect(await readProcessGroupIdAsync(7, { timeoutMs: 250, sources })).toBeUndefined()
    expect(timeouts).toEqual([250, 250])
  })
})

describe("compareProcessStart", () => {
  it("same only when both are read, of the same form, and equal", () => {
    expect(compareProcessStart("ps:Thu Nov 26 09:00:00 2026", "ps:Thu Nov 26 09:00:00 2026")).toBe("same")
    expect(compareProcessStart("linux:b:10", "linux:b:10")).toBe("same")
  })

  it("different for two readings of the same form that differ (a reused PID)", () => {
    expect(compareProcessStart("ps:Mon", "ps:Tue")).toBe("different")
    expect(compareProcessStart("linux:b1:10", "linux:b2:10")).toBe("different")
  })

  it("unverifiable when either is missing or empty, or the forms differ", () => {
    expect(compareProcessStart(undefined, "ps:Mon")).toBe("unverifiable")
    expect(compareProcessStart("", "ps:Mon")).toBe("unverifiable")
    expect(compareProcessStart("ps:Mon", undefined)).toBe("unverifiable")
    expect(compareProcessStart("linux:b:10", "ps:Mon")).toBe("unverifiable")
    expect(compareProcessStart("Mon", "ps:Mon")).toBe("unverifiable")
  })

  it("names the form", () => {
    expect(startTimeForm("linux:b:1")).toBe("linux")
    expect(startTimeForm("ps:Mon")).toBe("ps")
    expect(startTimeForm("Mon")).toBe("")
  })
})

describe("readProcessGroupId", () => {
  it("on Linux reads field 5 of /proc/<pid>/stat", () => {
    expect(
      readProcessGroupId(7, {
        platform: "linux",
        readFile: (path) => (path === "/proc/7/stat" ? "7 (sh (x)) S 1 4242 4242 0 -1" : undefined),
        runPs: () => undefined,
      }),
    ).toBe(4242)
  })

  it("elsewhere parses ps -o pgid=, and is undefined for garbage", () => {
    expect(readProcessGroupId(7, { platform: "darwin", runPs: () => "  4242\n" })).toBe(4242)
    expect(readProcessGroupId(7, { platform: "darwin", runPs: () => "" })).toBeUndefined()
    expect(readProcessGroupId(7, { platform: "darwin", runPs: () => undefined })).toBeUndefined()
  })

  it("reads a real detached child as the leader of its own group", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { detached: true, stdio: "ignore" })
    try {
      const pid = child.pid!
      expect(isProcessAlive(pid)).toBe(true)
      expect(readProcessGroupId(pid)).toBe(pid)
      expect(readProcessGroupId(process.pid)).not.toBe(pid)
    } finally {
      child.kill("SIGKILL")
      await new Promise((done) => child.once("exit", done))
    }
  })
})
