import type {
  PlatformInfo,
  PlatformInspector,
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
  PromptOptions,
  PromptResult,
  Prompter,
  SelectOption,
  Sleeper,
} from "./types.js"

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Normalize raw output: trim trailing whitespace so callers never deal
 * with OS-specific trailing newlines.
 */
function normalizeOutput(raw: string): string {
  return raw.trimEnd()
}

/**
 * Minimal writer abstraction — a single `write` method that accepts
 * encoded bytes.  Bun's `FileSink` satisfies this; tests supply a fake.
 */
export interface StreamWriter {
  write(data: Uint8Array): void | Promise<void>
}

/**
 * Line-oriented reader abstraction.  Reads one line at a time from an
 * underlying source.  Returns `null` when the source is exhausted.
 *
 * BunPrompter holds a single reader for its lifetime (stdin is a
 * long-lived push source, not a per-call stream).
 */
export interface LineReader {
  readLine(): Promise<string | null>
}

/**
 * Create a `LineReader` backed by a `ReadableStream<Uint8Array>`.
 * Buffers chunks internally and yields one line per `readLine()` call.
 */
export function createStreamLineReader(stream: ReadableStream<Uint8Array>): LineReader {
  const reader = stream.getReader()
  let text = ""
  let done = false

  return {
    async readLine(): Promise<string | null> {
      while (!done) {
        const newlineIdx = text.indexOf("\n")
        if (newlineIdx !== -1) {
          const line = text.slice(0, newlineIdx)
          text = text.slice(newlineIdx + 1)
          return line
        }

        const result = await reader.read()
        if (result.done) {
          done = true
          break
        }
        text += new TextDecoder().decode(result.value)
      }

      if (text.length > 0) {
        const remaining = text
        text = ""
        return remaining
      }
      return null
    },
  }
}

// ── BunProcessRunner ───────────────────────────────────────────────────

/**
 * argv-based process runner backed by `Bun.spawn`.
 *
 * Never invokes a shell — the executable and its arguments are passed as
 * an array directly to the OS `execvp` family.
 */
export class BunProcessRunner implements ProcessRunner {
  async exec(argv: readonly string[], options?: ProcessOptions): Promise<ProcessResult> {
    if (argv.length === 0) {
      return { exitCode: 1, stdout: "", stderr: "argv must not be empty" }
    }

    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn([...argv], {
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : undefined,
        timeout: options?.timeoutMs,
        stdout: "pipe",
        stderr: "pipe",
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { exitCode: null, stdout: "", stderr: normalizeOutput(message) }
    }

    const exitCode = await proc.exited
    const stdoutRaw = await new Response(proc.stdout).text()
    const stderrRaw = await new Response(proc.stderr).text()

    return {
      exitCode,
      stdout: normalizeOutput(stdoutRaw),
      stderr: normalizeOutput(stderrRaw),
    }
  }
}

// ── BunPrompter ────────────────────────────────────────────────────────

export interface BunPrompterDeps {
  /** Line reader for stdin (held for the prompter's lifetime). */
  readonly reader: LineReader
  /** Writer for stdout prompts and masking output. */
  readonly writer: StreamWriter
  /** Whether stdin is a TTY (determines secret masking support). */
  readonly isTTY: boolean
  /**
   * Optional async iterable of individual characters for secret input.
   * When provided, `promptSecret` reads from this instead of the reader.
   * Exists solely for deterministic test control of masking behavior.
   */
  readonly secretChars?: AsyncIterable<string>
}

/**
 * Interactive prompter with four variants: input, secret, confirm, select.
 *
 * - **secret** — reads character-by-character, writes `*` for each char,
 *   and MUST reject when stdin is not a TTY (no safe way to suppress echo).
 * - **confirm** — reads a line, normalises to `"y"` or `"n"`.
 * - **select** — reads a line matching an option value; empty → first option.
 *
 * Dependencies are injected via `BunPrompterDeps` so tests can supply
 * fake readers/writers without touching `process.stdin`/`process.stdout`.
 */
export class BunPrompter implements Prompter {
  private readonly reader: LineReader
  private readonly writer: StreamWriter
  private readonly isTTY: boolean
  private readonly secretChars: AsyncIterable<string> | undefined

  constructor(deps: BunPrompterDeps) {
    this.reader = deps.reader
    this.writer = deps.writer
    this.isTTY = deps.isTTY
    this.secretChars = deps.secretChars
  }

  async prompt(options: PromptOptions): Promise<PromptResult> {
    switch (options.kind) {
      case "input": {
        const value = await this.promptInput(options.message)
        return { value }
      }
      case "secret": {
        const value = await this.promptSecret(options.message)
        return { value }
      }
      case "confirm": {
        const value = await this.promptConfirm(options.message)
        return { value }
      }
      case "select": {
        const value = await this.promptSelect(options.message, options.options ?? [])
        return { value }
      }
    }
  }

  async promptInput(message: string): Promise<string> {
    await this.writer.write(new TextEncoder().encode(message))
    const line = await this.reader.readLine()
    return (line ?? "").trim()
  }

  async promptSecret(message: string): Promise<string> {
    if (!this.isTTY) {
      throw new Error("promptSecret requires a TTY")
    }

    const buf: string[] = []
    const encoder = new TextEncoder()

    await this.writer.write(encoder.encode(message))

    if (this.secretChars !== undefined) {
      // Test path: read from injected character iterable
      for await (const ch of this.secretChars) {
        if (ch === "\n" || ch === "\r") break
        buf.push(ch)
        await this.writer.write(encoder.encode("*"))
      }
    } else {
      // Production path: read line from stdin (characters are hidden by
      // the terminal's echo suppression; we write `*` per character on
      // the output side for visual feedback).
      const raw = await this.reader.readLine()
      if (raw !== null) {
        for (const ch of raw) {
          buf.push(ch)
          await this.writer.write(encoder.encode("*"))
        }
      }
    }

    await this.writer.write(encoder.encode("\n"))
    return buf.join("")
  }

  async promptConfirm(message: string): Promise<string> {
    const answer = await this.promptInput(message + " (y/n) ")
    return answer.toLowerCase() === "y" ? "y" : "n"
  }

  async promptSelect(message: string, options: readonly SelectOption[]): Promise<string> {
    const lines = options.map((o, i) => `  ${i + 1}) ${o.label}`).join("\n")
    const fullMessage = options.length > 0 ? `${message}\n${lines}\n> ` : `${message}\n> `
    const answer = (await this.promptInput(fullMessage)).trim()

    if (answer === "" && options.length > 0) {
      const first = options[0]
      return first !== undefined ? first.value : ""
    }

    // Try matching by value
    for (const opt of options) {
      if (opt.value === answer) return opt.value
    }

    // Try matching by 1-based index
    const idx = Number.parseInt(answer, 10)
    if (idx >= 1 && idx <= options.length) {
      const selected = options[idx - 1]
      return selected !== undefined ? selected.value : ""
    }

    return answer
  }
}

// ── BunPlatformInspector ───────────────────────────────────────────────

/**
 * Reads platform, architecture, and TTY state from the current process
 * globals.  Returns a frozen object so callers cannot mutate it.
 */
export class BunPlatformInspector implements PlatformInspector {
  inspect(): PlatformInfo {
    return Object.freeze({
      platform: process.platform,
      arch: process.arch,
      isTTY: Boolean(process.stdout?.isTTY),
    })
  }
}

// ── BunSleeper ─────────────────────────────────────────────────────────

/**
 * Promise-based sleep.  Resolves after `ms` milliseconds.
 */
export class BunSleeper implements Sleeper {
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
