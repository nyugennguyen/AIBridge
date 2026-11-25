import type {
  ConfirmOptions,
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
 *
 * `readChunk` is the raw half of the same source: whatever text is buffered,
 * or else the next chunk the source delivers, without waiting for a newline.
 * Secret entry needs it because, with the terminal in raw mode, every
 * keystroke arrives as its own chunk and there is no line to wait for. It
 * lives on the SAME reader as `readLine` on purpose: stdin has one stream
 * reader, and a second reader for secrets would either be refused by the
 * locked stream or steal bytes a later `readLine` was owed.
 */
export interface LineReader {
  readLine(): Promise<string | null>
  readChunk?(): Promise<string | null>
}

/**
 * Create a `LineReader` backed by a `ReadableStream<Uint8Array>`.
 * Buffers chunks internally and yields one line per `readLine()` call.
 */
export function createStreamLineReader(stream: ReadableStream<Uint8Array>): LineReader {
  const reader = stream.getReader()
  // One decoder in streaming mode, so a multi-byte character split across two
  // chunks is decoded once both halves have arrived instead of as two U+FFFDs.
  const decoder = new TextDecoder()
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
        text += decoder.decode(result.value, { stream: true })
      }

      if (text.length > 0) {
        const remaining = text
        text = ""
        return remaining
      }
      return null
    },

    async readChunk(): Promise<string | null> {
      if (text.length > 0) {
        const buffered = text
        text = ""
        return buffered
      }
      while (!done) {
        const result = await reader.read()
        if (result.done) {
          done = true
          break
        }
        const decoded = decoder.decode(result.value, { stream: true })
        if (decoded.length > 0) return decoded
      }
      return null
    },
  }
}

// ── Secret key handling ────────────────────────────────────────────────

/**
 * Thrown when the operator aborts secret entry with Ctrl-C (or Ctrl-D on an
 * empty entry). Callers surface it as an ordinary error, so `aibr setup` exits
 * non-zero instead of carrying on with a half-typed secret.
 */
export class PromptAbortedError extends Error {
  constructor(message = "Input aborted") {
    super(message)
    this.name = "PromptAbortedError"
  }
}

const KEY_ENTER_CR = "\r"
const KEY_ENTER_LF = "\n"
const KEY_CTRL_C = "\u0003"
const KEY_CTRL_D = "\u0004"
const KEY_BACKSPACE = "\b"
const KEY_DEL = "\u007f"
const KEY_ESC = "\u001b"

/**
 * Feed one chunk of raw keystrokes into a secret buffer.
 *
 * Returns `"submit"` when Enter (or Ctrl-D after some input) ends the entry,
 * and `"continue"` when more input is needed. Throws `PromptAbortedError` on
 * Ctrl-C, or on Ctrl-D with nothing typed.
 *
 * Escape sequences (arrow keys, bracketed-paste markers) are dropped whole:
 * with raw mode on an arrow key is `ESC [ A`, and keeping the `[A` would put
 * invisible characters into a token the operator believes they pasted
 * cleanly. Other C0 control characters are ignored for the same reason.
 */
function consumeSecretChunk(
  chunk: string,
  buf: string[],
  echo: (s: string) => void,
): "submit" | "continue" {
  const chars = [...chunk]
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    if (ch === KEY_ENTER_CR || ch === KEY_ENTER_LF) return "submit"
    if (ch === KEY_CTRL_C) throw new PromptAbortedError("Input aborted (Ctrl-C)")
    if (ch === KEY_CTRL_D) {
      if (buf.length === 0) throw new PromptAbortedError("Input aborted (Ctrl-D)")
      return "submit"
    }
    if (ch === KEY_BACKSPACE || ch === KEY_DEL) {
      if (buf.length > 0) {
        buf.pop()
        echo("\b \b")
      }
      continue
    }
    if (ch === KEY_ESC) {
      // CSI (`ESC [`) and SS3 (`ESC O`) sequences end at the first character in
      // 0x40-0x7E after the introducer; a lone ESC is simply dropped.
      const next = chars[i + 1]
      if (next === "[" || next === "O") {
        i += 2
        while (i < chars.length) {
          const code = chars[i]!.charCodeAt(0)
          if (code >= 0x40 && code <= 0x7e) break
          i++
        }
      }
      continue
    }
    if (ch.charCodeAt(0) < 0x20) continue
    buf.push(ch)
    echo("*")
  }
  return "continue"
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
   * Switches the terminal in and out of raw (no-echo, unbuffered) mode.
   *
   * Production passes `process.stdin.setRawMode`. Required on the production
   * secret path: without it nothing stops the terminal from echoing what the
   * operator types, so `promptSecret` refuses rather than echo a secret. It
   * is always called with `false` again in a `finally`.
   */
  readonly setRawMode?: (enabled: boolean) => void
  /**
   * Optional async iterable of keystroke chunks for secret input.
   * When provided, `promptSecret` reads from this instead of the reader and
   * does not touch the terminal mode. Exists solely for deterministic test
   * control of masking and key handling.
   */
  readonly secretChars?: AsyncIterable<string>
}

/**
 * Interactive prompter with four variants: input, secret, confirm, select.
 *
 * - **secret** — switches the terminal to raw mode (echo OFF), reads
 *   keystrokes, writes `*` per character, handles Backspace/DEL, aborts on
 *   Ctrl-C, and restores the terminal mode in a `finally`. MUST reject when
 *   stdin is not a TTY (no safe way to suppress echo).
 * - **confirm** — reads a line, normalises to `"y"` or `"n"`; an empty answer
 *   takes the default, which is "no" unless the caller passes `defaultYes`.
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
  private readonly setRawMode: ((enabled: boolean) => void) | undefined

  constructor(deps: BunPrompterDeps) {
    this.reader = deps.reader
    this.writer = deps.writer
    this.isTTY = deps.isTTY
    this.secretChars = deps.secretChars
    this.setRawMode = deps.setRawMode
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
    const pendingEchoes: Array<void | Promise<void>> = []
    const echo = (s: string): void => {
      pendingEchoes.push(this.writer.write(encoder.encode(s)))
    }

    await this.writer.write(encoder.encode(message))

    try {
      await this.readSecretInto(buf, echo, pendingEchoes)
    } catch (err) {
      // End the masked line so whatever reports the abort starts on its own line.
      await this.writer.write(encoder.encode("\n"))
      throw err
    }

    await this.writer.write(encoder.encode("\n"))
    return buf.join("")
  }

  private async readSecretInto(
    buf: string[],
    echo: (s: string) => void,
    pendingEchoes: Array<void | Promise<void>>,
  ): Promise<void> {
    if (this.secretChars !== undefined) {
      // Test path: keystroke chunks from the injected iterable, with the same
      // key handling as production and the terminal mode untouched.
      for await (const chunk of this.secretChars) {
        if (consumeSecretChunk(chunk, buf, echo) === "submit") break
      }
      await Promise.all(pendingEchoes)
    } else {
      // Production path. The terminal does not suppress echo by itself: in
      // cooked mode every typed character is printed before we ever see it.
      // Raw mode turns echo, line buffering, and ISIG off, so the secret never
      // reaches the screen and Ctrl-C arrives as a byte handled above. Without
      // both seams there is no safe way to read a secret, so this refuses
      // rather than falling back to an echoing line read.
      const readChunk = this.reader.readChunk?.bind(this.reader)
      if (this.setRawMode === undefined || readChunk === undefined) {
        throw new Error("promptSecret requires raw-mode terminal input to suppress echo")
      }
      this.setRawMode(true)
      try {
        for (;;) {
          const chunk = await readChunk()
          if (chunk === null) break
          if (consumeSecretChunk(chunk, buf, echo) === "submit") break
        }
        await Promise.all(pendingEchoes)
      } finally {
        this.setRawMode(false)
      }
    }
  }

  async promptConfirm(message: string, options?: ConfirmOptions): Promise<string> {
    const defaultYes = options?.defaultYes === true
    const answer = (await this.promptInput(message + (defaultYes ? " (Y/n) " : " (y/n) ")))
      .trim()
      .toLowerCase()
    if (answer === "") return defaultYes ? "y" : "n"
    return answer === "y" || answer === "yes" ? "y" : "n"
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
