/**
 * Typed, side-effect-free host interaction interfaces.
 *
 * Every interface abstracts a platform capability so that callers never
 * depend on Bun/Node globals directly and tests can supply manual fakes.
 */

// ── Process ────────────────────────────────────────────────────────────

export interface ProcessOptions {
  /** Working directory for the child process. */
  readonly cwd?: string
  /** Extra environment variables merged on top of the current process env. */
  readonly env?: Readonly<Record<string, string>>
  /** Maximum wall-clock time in milliseconds before the process is killed. */
  readonly timeoutMs?: number
}

export interface ProcessResult {
  /** Process exit code. `null` when the process was killed by a signal. */
  readonly exitCode: number | null
  /** Normalized stdout string (trimmed, trailing newlines collapsed). */
  readonly stdout: string
  /** Normalized stderr string (trimmed, trailing newlines collapsed). */
  readonly stderr: string
}

/**
 * argv-based process runner.
 *
 * Callers MUST pass the executable and its arguments as individual strings —
 * never as a concatenated shell command.  Implementations MUST NOT invoke a
 * shell.
 */
export interface ProcessRunner {
  exec(argv: readonly string[], options?: ProcessOptions): Promise<ProcessResult>
}

// ── Prompt ─────────────────────────────────────────────────────────────

/** Discriminated prompt variants. */
export type PromptKind = "input" | "secret" | "confirm" | "select"

export interface SelectOption {
  readonly label: string
  readonly value: string
}

export interface PromptOptions {
  readonly kind: PromptKind
  readonly message: string
  /** Choices for `"select"` prompts. */
  readonly options?: readonly SelectOption[]
  /** Default value for `"input"` prompts. */
  readonly default?: string
}

export interface PromptResult {
  readonly value: string
}

/**
 * Interactive user prompting with four variants:
 *
 * - `input`   — free-text entry
 * - `secret`  — masked entry, MUST suppress terminal echo
 * - `confirm` — yes/no, returns `"y"` or `"n"`
 * - `select`  — pick from a list, returns the chosen option's `value`
 *
 * `promptSecret` (convenience) is equivalent to `{ kind: "secret" }`.
 *
 * Non-TTY environments MUST reject `secret` prompts — there is no safe
 * way to suppress echo without a terminal.
 */
export interface Prompter {
  prompt(options: PromptOptions): Promise<PromptResult>
  /** Convenience: plain-text input. */
  promptInput(message: string): Promise<string>
  /** Convenience: masked secret input.  MUST reject when stdin is not a TTY. */
  promptSecret(message: string): Promise<string>
  /** Convenience: yes/no confirmation.  Returns `"y"` or `"n"`. */
  promptConfirm(message: string): Promise<string>
  /** Convenience: select from options. */
  promptSelect(message: string, options: readonly SelectOption[]): Promise<string>
}

// ── Platform ───────────────────────────────────────────────────────────

export interface PlatformInfo {
  /** OS identifier — e.g. `"linux"`, `"darwin"`, `"win32"`. */
  readonly platform: string
  /** CPU architecture — e.g. `"x64"`, `"arm64"`. */
  readonly arch: string
  /** Whether the current stdout is connected to a TTY. */
  readonly isTTY: boolean
}

/**
 * Inspect the host platform and terminal capabilities.
 */
export interface PlatformInspector {
  inspect(): PlatformInfo
}

// ── HTTP probe ─────────────────────────────────────────────────────────

export interface ProbeOptions {
  /** HTTP method (default GET). */
  readonly method?: string
  /** Request headers. */
  readonly headers?: Readonly<Record<string, string>>
  /** Maximum time in milliseconds to wait for a response. */
  readonly timeoutMs?: number
}

export interface ProbeResult {
  readonly status: number
  readonly ok: boolean
  readonly body: string
}

/**
 * Lightweight HTTP probe — health checks, readiness gates, etc.
 *
 * NOT a general-purpose HTTP client.
 */
export interface HttpProbe {
  probe(url: string, options?: ProbeOptions): Promise<ProbeResult>
}

// ── Sleep ──────────────────────────────────────────────────────────────

/**
 * Time abstraction for deterministic testing.
 */
export interface Sleeper {
  sleep(ms: number): Promise<void>
}
