import type {
  HttpProbe,
  PlatformInspector,
  PlatformInfo,
  ProbeOptions,
  ProbeResult,
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
  Prompter,
  PromptOptions,
  PromptResult,
  SelectOption,
  Sleeper,
} from "../../../src/host/types.js"

// ── FakeProcessRunner ──────────────────────────────────────────────────

export class FakeProcessRunner implements ProcessRunner {
  public calls: Array<{ argv: readonly string[]; options?: ProcessOptions }> = []
  private readonly result: ProcessResult

  constructor(result: ProcessResult) {
    this.result = result
  }

  async exec(argv: readonly string[], options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push({ argv, options })
    return this.result
  }
}

// ── FakePrompter ───────────────────────────────────────────────────────

export interface FakePrompterCall {
  readonly options: PromptOptions
}

export class FakePrompter implements Prompter {
  public calls: FakePrompterCall[] = []
  public secretCalls: string[] = []
  public plainCalls: string[] = []
  public confirmCalls: string[] = []
  public selectCalls: Array<{ message: string; options: readonly SelectOption[] }> = []

  private readonly inputValue: string
  private readonly secretValue: string
  private readonly confirmValue: string
  private readonly selectValue: string

  constructor(params: {
    inputValue?: string
    secretValue?: string
    confirmValue?: string
    selectValue?: string
  }) {
    this.inputValue = params.inputValue ?? ""
    this.secretValue = params.secretValue ?? ""
    this.confirmValue = params.confirmValue ?? "y"
    this.selectValue = params.selectValue ?? ""
  }

  async prompt(options: PromptOptions): Promise<PromptResult> {
    this.calls.push({ options })

    switch (options.kind) {
      case "input":
        return { value: this.inputValue }
      case "secret":
        return { value: this.secretValue }
      case "confirm":
        return { value: this.confirmValue }
      case "select":
        return { value: this.selectValue }
    }
  }

  async promptInput(message: string): Promise<string> {
    this.plainCalls.push(message)
    return this.inputValue
  }

  async promptSecret(message: string): Promise<string> {
    this.secretCalls.push(message)
    return this.secretValue
  }

  async promptConfirm(message: string): Promise<string> {
    this.confirmCalls.push(message)
    return this.confirmValue
  }

  async promptSelect(message: string, options: readonly SelectOption[]): Promise<string> {
    this.selectCalls.push({ message, options })
    return this.selectValue
  }
}

// ── FakePlatformInspector ──────────────────────────────────────────────

export class FakePlatformInspector implements PlatformInspector {
  private readonly info: PlatformInfo

  constructor(info: PlatformInfo) {
    this.info = info
  }

  inspect(): PlatformInfo {
    return this.info
  }
}

// ── FakeHttpProbe ──────────────────────────────────────────────────────

export class FakeHttpProbe implements HttpProbe {
  public calls: Array<{ url: string; options?: ProbeOptions }> = []
  private readonly result: ProbeResult

  constructor(result: ProbeResult) {
    this.result = result
  }

  async probe(url: string, options?: ProbeOptions): Promise<ProbeResult> {
    this.calls.push({ url, options })
    return this.result
  }
}

// ── FakeSleeper ────────────────────────────────────────────────────────

export class FakeSleeper implements Sleeper {
  public sleptMs: number[] = []

  async sleep(ms: number): Promise<void> {
    this.sleptMs.push(ms)
  }
}
