import { describe, expect, it } from "vitest"
import type { Prompter, SelectOption } from "../../../src/host/types.js"
import {
  BunPrompter,
  PromptAbortedError,
  createStreamLineReader,
} from "../../../src/host/runtime.js"
import type {
  StreamWriter,
  LineReader,
} from "../../../src/host/runtime.js"
import {
  FakePrompter,
} from "./fixtures.js"

// ── Prompter tests ─────────────────────────────────────────────────────

describe("Prompter", () => {
  describe("FakePrompter (manual fake)", () => {
    it("returns configured input value via promptInput", async () => {
      const prompter = new FakePrompter({ inputValue: "alice" })

      const value = await prompter.promptInput("Name:")

      expect(value).toBe("alice")
      expect(prompter.plainCalls).toEqual(["Name:"])
    })

    it("returns configured secret value via promptSecret", async () => {
      const prompter = new FakePrompter({ secretValue: "s3cret" })

      const value = await prompter.promptSecret("Token:")

      expect(value).toBe("s3cret")
      expect(prompter.secretCalls).toEqual(["Token:"])
    })

    it("returns configured confirm value via promptConfirm", async () => {
      const prompter = new FakePrompter({ confirmValue: "n" })

      const value = await prompter.promptConfirm("Proceed?")

      expect(value).toBe("n")
      expect(prompter.confirmCalls).toEqual(["Proceed?"])
    })

    it("returns configured select value via promptSelect", async () => {
      const opts: SelectOption[] = [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ]
      const prompter = new FakePrompter({ selectValue: "b" })

      const value = await prompter.promptSelect("Choose:", opts)

      expect(value).toBe("b")
      expect(prompter.selectCalls).toEqual([{ message: "Choose:", options: opts }])
    })

    it("dispatches prompt() by kind", async () => {
      const prompter = new FakePrompter({
        inputValue: "text",
        secretValue: "hidden",
        confirmValue: "y",
        selectValue: "opt",
      })

      const input = await prompter.prompt({ kind: "input", message: "?" })
      const secret = await prompter.prompt({ kind: "secret", message: "?" })
      const confirm = await prompter.prompt({ kind: "confirm", message: "?" })
      const select = await prompter.prompt({ kind: "select", message: "?", options: [] })

      expect(input.value).toBe("text")
      expect(secret.value).toBe("hidden")
      expect(confirm.value).toBe("y")
      expect(select.value).toBe("opt")
    })

    it("records all calls independently", async () => {
      const prompter = new FakePrompter({ inputValue: "x", secretValue: "y" })

      await prompter.promptInput("A:")
      await prompter.promptSecret("B:")
      await prompter.promptInput("C:")
      await prompter.promptConfirm("D?")

      expect(prompter.plainCalls).toEqual(["A:", "C:"])
      expect(prompter.secretCalls).toEqual(["B:"])
      expect(prompter.confirmCalls).toEqual(["D?"])
      expect(prompter.selectCalls).toHaveLength(0)
    })
  })

  describe("BunPrompter", () => {
    it("reads a line from the reader for promptInput", async () => {
      const lines = ["hello world"]
      const { output, ...prompter } = createTestPrompter(lines)

      const value = await prompter.promptInput("Enter:")

      expect(value).toBe("hello world")
      expect(output).toEqual(["Enter:"])
    })

    it("masks secret input with asterisks on the writer", async () => {
      const chars = secretChars("abc")
      const { output, ...prompter } = createTestPrompter([], { isTTY: true, chars })

      const value = await prompter.promptSecret("Password:")

      expect(value).toBe("abc")
      // Should write the prompt message, then mask each char, then newline
      expect(output[0]).toBe("Password:")
      expect(output).toContain("*")
      expect(output).toContain("\n")
      // The raw secret value must NOT appear in the output stream
      expect(output.join("")).not.toContain("abc")
    })

    it("rejects promptSecret when stdin is not a TTY", async () => {
      const { ...prompter } = createTestPrompter(["ignored"], { isTTY: false })

      await expect(prompter.promptSecret("Token:")).rejects.toThrow(
        "promptSecret requires a TTY",
      )
    })

    it("returns 'y' for confirm when user types y", async () => {
      const { ...prompter } = createTestPrompter(["y"])

      const value = await prompter.promptConfirm("Proceed?")

      expect(value).toBe("y")
    })

    it("returns 'n' for confirm when user types n", async () => {
      const { ...prompter } = createTestPrompter(["n"])

      const value = await prompter.promptConfirm("Proceed?")

      expect(value).toBe("n")
    })

    it("returns 'n' for confirm when user enters empty string", async () => {
      const { ...prompter } = createTestPrompter([""])

      const value = await prompter.promptConfirm("Proceed?")

      expect(value).toBe("n")
    })

    it("selects the option matching the user's input", async () => {
      const options: SelectOption[] = [
        { label: "First", value: "first" },
        { label: "Second", value: "second" },
      ]
      const { ...prompter } = createTestPrompter(["second"])

      const value = await prompter.promptSelect("Pick:", options)

      expect(value).toBe("second")
    })

    it("returns the first option value for empty select input", async () => {
      const options: SelectOption[] = [
        { label: "Alpha", value: "alpha" },
        { label: "Beta", value: "beta" },
      ]
      const { ...prompter } = createTestPrompter([""])

      const value = await prompter.promptSelect("Pick:", options)

      expect(value).toBe("alpha")
    })

    it("dispatches prompt() for all four kinds", async () => {
      const lines = ["text-input", "y", "first"]
      const chars = secretChars("s3cret")
      const { ...prompter } = createTestPrompter(lines, { isTTY: true, chars })

      const input = await prompter.prompt({ kind: "input", message: "?" })
      const secret = await prompter.prompt({ kind: "secret", message: "?" })
      const confirm = await prompter.prompt({ kind: "confirm", message: "?" })
      const select = await prompter.prompt({
        kind: "select",
        message: "?",
        options: [
          { label: "First", value: "first" },
          { label: "Second", value: "second" },
        ],
      })

      expect(input.value).toBe("text-input")
      expect(secret.value).toBe("s3cret")
      expect(confirm.value).toBe("y")
      expect(select.value).toBe("first")
    })

    it("rejects prompt({ kind: 'secret' }) when not a TTY", async () => {
      const { ...prompter } = createTestPrompter(["ignored"], { isTTY: false })

      await expect(prompter.prompt({ kind: "secret", message: "?" })).rejects.toThrow(
        "promptSecret requires a TTY",
      )
    })

    it("defaults an empty confirm to 'y' only when defaultYes is requested", async () => {
      const { output, ...prompter } = createTestPrompter(["", ""])

      expect(await prompter.promptConfirm("Save?", { defaultYes: true })).toBe("y")
      expect(await prompter.promptConfirm("Overwrite?")).toBe("n")
      expect(output[0]).toBe("Save? (Y/n) ")
      expect(output[1]).toBe("Overwrite? (y/n) ")
    })

    it("still honours an explicit 'n' when defaultYes is requested", async () => {
      const { ...prompter } = createTestPrompter(["n", "yes"])

      expect(await prompter.promptConfirm("Save?", { defaultYes: true })).toBe("n")
      expect(await prompter.promptConfirm("Save?", { defaultYes: true })).toBe("y")
    })
  })

  // ── C2: real no-echo secret entry ──────────────────────────────────────

  describe("BunPrompter secret entry (raw mode)", () => {
    it("handles Backspace and DEL by removing the last character", async () => {
      const { output, ...prompter } = createTestPrompter([], {
        chars: chunks(["a", "b", "\u007f", "c", "\b", "d", "\r"]),
      })

      const value = await prompter.promptSecret("Token:")

      expect(value).toBe("ad")
      expect(output.join("")).toContain("\b \b")
    })

    it("aborts on Ctrl-C with an error instead of returning a partial secret", async () => {
      const { ...prompter } = createTestPrompter([], { chars: chunks(["s", "e", "\u0003", "x"]) })

      await expect(prompter.promptSecret("Token:")).rejects.toThrow(PromptAbortedError)
    })

    it("aborts on Ctrl-D with nothing typed, submits on Ctrl-D after input", async () => {
      const empty = createTestPrompter([], { chars: chunks(["\u0004"]) })
      await expect(empty.promptSecret("Token:")).rejects.toThrow(/Ctrl-D/)

      const typed = createTestPrompter([], { chars: chunks(["o", "k", "\u0004", "ignored"]) })
      expect(await typed.promptSecret("Token:")).toBe("ok")
    })

    it("accepts a pasted secret arriving as one chunk and drops escape sequences", async () => {
      const { output, ...prompter } = createTestPrompter([], {
        chars: chunks(["\u001b[200~paste-me\u001b[201~", "\u001b[A", "!\r"]),
      })

      const value = await prompter.promptSecret("Token:")

      expect(value).toBe("paste-me!")
      expect(output.join("")).not.toContain("paste-me")
    })

    it("production path: turns raw mode on, never echoes the secret, restores the mode", async () => {
      const modes: boolean[] = []
      const { writer, output } = fakeStreamWriter()
      const prompter = new BunPrompter({
        reader: fakeChunkReader(["s3", "cr", "et\r", "next line\n"]),
        writer,
        isTTY: true,
        setRawMode: (enabled) => void modes.push(enabled),
      })

      const value = await prompter.promptSecret("Password:")

      expect(value).toBe("s3cret")
      expect(modes).toEqual([true, false])
      expect(output.join("")).not.toContain("s3cret")
      expect(output.join("")).toBe("Password:******\n")
    })

    it("production path: restores the terminal mode even when the operator aborts", async () => {
      const modes: boolean[] = []
      const { writer } = fakeStreamWriter()
      const prompter = new BunPrompter({
        reader: fakeChunkReader(["ab\u0003"]),
        writer,
        isTTY: true,
        setRawMode: (enabled) => void modes.push(enabled),
      })

      await expect(prompter.promptSecret("Password:")).rejects.toThrow(PromptAbortedError)
      expect(modes).toEqual([true, false])
    })

    it("production path: refuses rather than echo when raw mode is unavailable", async () => {
      const { writer } = fakeStreamWriter()
      const prompter = new BunPrompter({
        reader: fakeChunkReader(["secret\r"]),
        writer,
        isTTY: true,
      })

      await expect(prompter.promptSecret("Password:")).rejects.toThrow(/raw-mode/)
    })

    it("createStreamLineReader serves lines and raw chunks from one stream", async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("first\nbuffered"))
          controller.enqueue(encoder.encode("raw"))
          controller.close()
        },
      })
      const reader = createStreamLineReader(stream)

      expect(await reader.readLine()).toBe("first")
      expect(await reader.readChunk?.()).toBe("buffered")
      expect(await reader.readChunk?.()).toBe("raw")
      expect(await reader.readChunk?.()).toBeNull()
    })
  })
})

/** Keystroke chunks for the injected `secretChars` seam. */
function chunks(values: string[]): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next(): Promise<IteratorResult<string>> {
          if (i < values.length) return { value: values[i++] as string, done: false }
          return { value: undefined, done: true }
        },
      }
    },
  }
}

/** A LineReader whose `readChunk` yields the given raw chunks in order. */
function fakeChunkReader(values: string[]): LineReader {
  let i = 0
  return {
    async readLine(): Promise<string | null> {
      return i < values.length ? (values[i++] ?? null) : null
    },
    async readChunk(): Promise<string | null> {
      return i < values.length ? (values[i++] ?? null) : null
    },
  }
}

// ── Type compatibility ──────────────────────────────────────────────────

describe("Type compatibility", () => {
  it("fakes satisfy their interface contracts at compile time", () => {
    const prompter: Prompter = new FakePrompter({})
    expect(prompter).toBeDefined()
  })
})

// ── Test helpers ───────────────────────────────────────────────────────

/**
 * Create a fake LineReader that yields lines from an array one at a time.
 * Lines are consumed sequentially across multiple `readLine()` calls.
 */
function fakeLineReader(lines: string[]): LineReader {
  let index = 0
  return {
    async readLine(): Promise<string | null> {
      if (index < lines.length) {
        return lines[index++] ?? null
      }
      return null
    },
  }
}

/**
 * Create a fake StreamWriter that captures written chunks.
 */
function fakeStreamWriter(): { writer: StreamWriter; output: string[] } {
  const output: string[] = []
  const writer: StreamWriter = {
    write(data: Uint8Array): void {
      output.push(new TextDecoder().decode(data))
    },
  }
  return { writer, output }
}

/**
 * Produce an async iterable that yields individual characters from a
 * secret string, simulating keystroke-by-keystroke input for masking tests.
 */
function secretChars(value: string): AsyncIterable<string> {
  const chars = value.split("")
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next(): Promise<IteratorResult<string>> {
          if (i < chars.length) {
            return { value: chars[i++] as string, done: false }
          }
          return { value: undefined, done: true }
        },
      }
    },
  }
}

/**
 * Create a BunPrompter wired to fake reader/writer for deterministic testing.
 */
function createTestPrompter(
  lines: string[],
  opts?: { isTTY?: boolean; chars?: AsyncIterable<string> },
): {
  promptInput: (message: string) => Promise<string>
  promptSecret: (message: string) => Promise<string>
  promptConfirm: (message: string, options?: { defaultYes?: boolean }) => Promise<string>
  promptSelect: (message: string, options: readonly SelectOption[]) => Promise<string>
  prompt: (options: import("../../../src/host/types.js").PromptOptions) => Promise<import("../../../src/host/types.js").PromptResult>
  output: string[]
} {
  const { writer, output } = fakeStreamWriter()
  const prompter = new BunPrompter({
    reader: fakeLineReader(lines),
    writer,
    isTTY: opts?.isTTY ?? true,
    secretChars: opts?.chars,
  })
  return {
    promptInput: (msg: string) => prompter.promptInput(msg),
    promptSecret: (msg: string) => prompter.promptSecret(msg),
    promptConfirm: (msg: string, o?: { defaultYes?: boolean }) => prompter.promptConfirm(msg, o),
    promptSelect: (msg: string, o: readonly SelectOption[]) => prompter.promptSelect(msg, o),
    prompt: (o: import("../../../src/host/types.js").PromptOptions) => prompter.prompt(o),
    output,
  }
}
