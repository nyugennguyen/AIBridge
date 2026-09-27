const ANSI_REGEX =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "")
}

export interface StreamSplitterOptions {
  stripAnsi?: boolean
  maxLineLength?: number
}

export class LineStreamSplitter {
  private buffer = ""
  private readonly shouldStripAnsi: boolean
  private readonly maxLineLength: number

  constructor(options: StreamSplitterOptions = {}) {
    this.shouldStripAnsi = options.stripAnsi ?? true
    this.maxLineLength = options.maxLineLength ?? 65_536
  }

  push(chunk: string): string[] {
    this.buffer += chunk

    const lines: string[] = []
    let newlineIndex: number

    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)

      if (line.endsWith("\r")) {
        line = line.slice(0, -1)
      }

      if (this.shouldStripAnsi) {
        line = stripAnsi(line)
      }

      if (line.length > this.maxLineLength) {
        line = line.slice(0, this.maxLineLength)
      }

      const trimmed = line.trim()
      if (trimmed.length > 0) {
        lines.push(trimmed)
      }
    }

    // Safety: prevent unbounded buffer growth on infinite line without newline
    if (this.buffer.length > this.maxLineLength * 2) {
      let truncated = this.buffer.slice(0, this.maxLineLength)
      this.buffer = ""
      if (this.shouldStripAnsi) {
        truncated = stripAnsi(truncated)
      }
      const trimmed = truncated.trim()
      if (trimmed.length > 0) {
        lines.push(trimmed)
      }
    }

    return lines
  }

  flush(): string[] {
    let remaining = this.buffer
    this.buffer = ""
    if (this.shouldStripAnsi) {
      remaining = stripAnsi(remaining)
    }
    const trimmed = remaining.trim()
    return trimmed.length > 0 ? [trimmed] : []
  }
}

export function safeParseJsonLine<T = Record<string, unknown>>(line: string): T | undefined {
  try {
    return JSON.parse(line) as T
  } catch {
    return undefined
  }
}
