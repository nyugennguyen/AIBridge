/**
 * File logs for a profile's bridge, and the reader behind `aibr logs`.
 *
 * One file per profile: `<stateDir>/logs/aibridge.log`.
 *
 * - `aibr serve` appends its own lines here (startup, listen address, one line
 *   per HTTP request: method, path, status, duration). It mirrors them to stdout
 *   only when stdout is a terminal (`aibr start --foreground`, a developer's
 *   shell), so a supervisor that redirects stdout into this same file does not
 *   get every line twice.
 * - The user service (`aibr start`) points the supervisor's stdout AND stderr at
 *   this file, so a crash before the logger exists (a bad config, a port in use,
 *   an uncaught exception's stack) still lands where `aibr logs` looks.
 *
 * What is never logged: headers (the bearer token and signature live there),
 * request or response bodies (prompts, reports), query strings. A line carries
 * a method, a path, a status code and a duration.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs"
import { join } from "node:path"

/** Rotated to `aibridge.log.1` when a new bridge starts and the file is larger than this. */
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024

export function logDirFor(stateDir: string): string {
  return join(stateDir, "logs")
}

export function bridgeLogPath(stateDir: string): string {
  return join(logDirFor(stateDir), "aibridge.log")
}

export type LogLevel = "info" | "warn" | "error"

export interface FileLogger {
  readonly path: string
  log(level: LogLevel, message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  close(): void
}

export interface FileLoggerOptions {
  readonly path: string
  /** Also hand each formatted line here (stdout when it is a terminal). */
  readonly mirror?: (line: string) => void
  readonly now?: () => Date
  /** Rotate on open when the file is larger than this. Default {@link LOG_ROTATE_BYTES}. */
  readonly rotateBytes?: number
}

/**
 * Opens (creating) the log file in append mode. Writes are synchronous so the
 * last line before a crash is on disk, and `O_APPEND` keeps lines whole when a
 * supervisor writes into the same file.
 */
export function createFileLogger(options: FileLoggerOptions): FileLogger {
  const dir = options.path.slice(0, options.path.lastIndexOf("/"))
  if (dir !== "") mkdirSync(dir, { recursive: true, mode: 0o700 })
  rotateIfLarge(options.path, options.rotateBytes ?? LOG_ROTATE_BYTES)
  let fd: number | null = openSync(options.path, "a", 0o600)
  const now = options.now ?? (() => new Date())

  const log = (level: LogLevel, message: string): void => {
    const line = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${oneLine(message)}\n`
    if (fd !== null) {
      try {
        writeSync(fd, line)
      } catch {
        // A full disk must not take the bridge down; the mirror still gets it.
      }
    }
    options.mirror?.(line)
  }

  return {
    path: options.path,
    log,
    info: (m) => log("info", m),
    warn: (m) => log("warn", m),
    error: (m) => log("error", m),
    close: () => {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // already closed
        }
        fd = null
      }
    },
  }
}

function rotateIfLarge(path: string, limit: number): void {
  try {
    if (statSync(path).size > limit) renameSync(path, `${path}.1`)
  } catch {
    // absent: nothing to rotate
  }
}

/** Control characters (a newline in a path, an ANSI escape) never reach the file raw. */
function oneLine(message: string): string {
  // eslint-disable-next-line no-control-regex
  return message.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "?").replace(/\n/g, " | ")
}

/** One access-log line: never headers, bodies or query strings. */
export function formatRequestLine(input: {
  readonly method: string
  readonly url: string
  readonly status: number
  readonly durationMs: number
}): string {
  const path = input.url.split("?")[0] ?? input.url
  return `${input.method} ${path} ${input.status} ${Math.round(input.durationMs)}ms`
}

// ── reading ─────────────────────────────────────────────────────────────

/** Reads at most this much from the end of the file to find the last lines. */
const TAIL_WINDOW_BYTES = 256 * 1024

export interface LogFileReader {
  /** Size in bytes, or `null` when the file does not exist. */
  size(path: string): number | null
  /** Bytes `[start, end)` of the file as UTF-8. */
  read(path: string, start: number, end: number): string
}

export const fsLogFileReader: LogFileReader = {
  size(path) {
    try {
      return statSync(path).size
    } catch {
      return null
    }
  },
  read(path, start, end) {
    if (end <= start) return ""
    const fd = openSync(path, "r")
    try {
      const length = Math.min(end - start, fstatSync(fd).size - start)
      if (length <= 0) return ""
      const buffer = Buffer.alloc(length)
      const read = readSync(fd, buffer, 0, length, start)
      return buffer.subarray(0, read).toString("utf8")
    } finally {
      closeSync(fd)
    }
  },
}

/** The last `lines` lines of the file (fewer when it is shorter), and the offset the read ended at. */
export function tailLines(reader: LogFileReader, path: string, lines: number): { readonly text: string; readonly end: number } | null {
  const size = reader.size(path)
  if (size === null) return null
  const start = Math.max(0, size - TAIL_WINDOW_BYTES)
  const chunk = reader.read(path, start, size)
  const all = chunk.split("\n")
  // A window that starts mid-file starts mid-line: drop the partial first line.
  if (start > 0) all.shift()
  if (all.length > 0 && all[all.length - 1] === "") all.pop()
  const kept = lines <= 0 ? [] : all.slice(-lines)
  return { text: kept.length === 0 ? "" : `${kept.join("\n")}\n`, end: size }
}

export interface FollowOptions {
  readonly reader: LogFileReader
  readonly path: string
  readonly from: number
  readonly write: (text: string) => void
  readonly sleep: (ms: number) => Promise<void>
  /** Resolves `true` when following should stop (Ctrl-C). Checked between polls. */
  readonly stopped: () => boolean
  readonly pollMs?: number
}

/**
 * `tail -f`: prints what is appended after `from` until `stopped()`. A file
 * that shrinks (rotated by a restarting bridge) is read again from the start.
 */
export async function followLog(options: FollowOptions): Promise<void> {
  let offset = options.from
  const poll = options.pollMs ?? 500
  while (!options.stopped()) {
    const size = options.reader.size(options.path)
    if (size !== null) {
      if (size < offset) offset = 0
      if (size > offset) {
        options.write(options.reader.read(options.path, offset, size))
        offset = size
      }
    }
    await options.sleep(poll)
  }
}
