/**
 * Deterministic script steps of a capability profile (`script`, `pre`,
 * `post`; Phase 5).
 *
 * Rules, each enforced here rather than trusted to the profile author:
 * - the path is relative to the job's working directory and must resolve
 *   (symlinks included) to a regular file inside it;
 * - it is executed directly, never through a shell, with no arguments: nothing
 *   from the request is interpolated into a command line;
 * - the environment is sanitized like the Claude child's
 *   (`sanitizeChildProcessEnv`, no provider credentials at all), plus a few
 *   non-secret `AIBR_*` facts about the job;
 * - it runs in its own process group so a timeout or the kill switch stops
 *   everything it started;
 * - only a bounded tail of stdout/stderr is kept, and it is redacted.
 */
import { spawn as defaultSpawn } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { ScriptResult } from "../config/types.js"
import { isPathContained, redactSecretsFromText, sanitizeChildProcessEnv } from "./sanitizer.js"

export const SCRIPT_OUTPUT_TAIL_CHARS = 4_000
const KILL_GRACE_MS = 5_000

export class ScriptPathError extends Error {
  readonly code = "script_path"
}

/**
 * The absolute path of a profile script inside `cwd`. Throws
 * `ScriptPathError` for an absolute path, an escape (`..` or a symlink out of
 * the tree) or a missing / non-regular file.
 */
export async function resolveScriptPath(cwd: string, script: string): Promise<string> {
  if (isAbsolute(script)) throw new ScriptPathError(`Script path must be relative to the job directory: ${script}`)
  const candidate = resolve(cwd, script)
  if (!isPathContained(candidate, cwd)) throw new ScriptPathError(`Script path escapes the job directory: ${script}`)
  let real: string
  let realCwd: string
  try {
    real = await realpath(candidate)
    realCwd = await realpath(cwd)
  } catch {
    throw new ScriptPathError(`Script not found: ${script}`)
  }
  if (!isPathContained(real, realCwd)) throw new ScriptPathError(`Script path escapes the job directory: ${script}`)
  const info = await stat(real)
  if (!info.isFile()) throw new ScriptPathError(`Script is not a regular file: ${script}`)
  return real
}

/** The slice of a child process the runner uses (a fake in tests). */
export interface ScriptProcess {
  readonly pid?: number | undefined
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
}

export type ScriptSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; detached: boolean; stdio: ["ignore", "pipe", "pipe"]; shell: false },
) => ScriptProcess

export interface ScriptRunRequest {
  readonly phase: ScriptResult["phase"]
  /** The path as configured; reported back verbatim. */
  readonly script: string
  readonly cwd: string
  readonly timeoutMs: number
  /** Non-secret facts for the script (`AIBR_JOB_ID`, `AIBR_SHA`). */
  readonly extraEnv?: Readonly<Record<string, string>>
}

export interface RunningScript {
  readonly result: Promise<ScriptResult>
  /** Stops the script's process group (SIGTERM, then SIGKILL). */
  kill(): void
}

export interface ScriptRunnerOptions {
  /** Source environment; sanitized before use. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly spawn?: ScriptSpawn
  /** Exact values to redact from output tails (tokens, keys). */
  readonly knownSecrets?: readonly string[]
  readonly clock?: () => number
}

/** Keeps the last `max` characters written to it. */
class Tail {
  #text = ""
  constructor(private readonly max: number) {}
  push(chunk: Buffer | string): void {
    this.#text = (this.#text + chunk.toString()).slice(-this.max * 2)
  }
  value(): string {
    return this.#text.length > this.max ? `…${this.#text.slice(-this.max)}` : this.#text
  }
}

export class ScriptRunner {
  readonly #env: Readonly<Record<string, string | undefined>>
  readonly #spawn: ScriptSpawn
  readonly #knownSecrets: readonly string[]
  readonly #clock: () => number

  constructor(options: ScriptRunnerOptions = {}) {
    this.#env = options.env ?? process.env
    this.#spawn = options.spawn ?? ((command, args, spawnOptions) => defaultSpawn(command, [...args], spawnOptions) as unknown as ScriptProcess)
    this.#knownSecrets = options.knownSecrets ?? []
    this.#clock = options.clock ?? Date.now
  }

  /** The environment a script gets: sanitized, no provider credentials, plus `extraEnv`. */
  scriptEnvironment(extraEnv: Readonly<Record<string, string>> = {}): Record<string, string> {
    return { ...sanitizeChildProcessEnv({ ...this.#env }, []), ...extraEnv }
  }

  start(request: ScriptRunRequest): RunningScript {
    let child: ScriptProcess | undefined
    let killed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const started = this.#clock()

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child === undefined) return
      try {
        // Negative pid: the whole process group (the child is a group leader).
        if (child.pid !== undefined) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          /* already gone */
        }
      }
    }
    const stop = (): void => {
      if (killed) return
      killed = true
      signalGroup("SIGTERM")
      const escalate = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS)
      escalate.unref?.()
    }

    const result = (async (): Promise<ScriptResult> => {
      const base = { phase: request.phase, script: request.script }
      let path: string
      try {
        path = await resolveScriptPath(request.cwd, request.script)
      } catch (error) {
        return { ...base, exit_code: null, timed_out: false, duration_ms: 0, stdout_tail: "", stderr_tail: this.#redact(errorMessage(error)) }
      }
      if (killed) {
        return { ...base, exit_code: null, signal: "SIGTERM", timed_out: false, duration_ms: 0, stdout_tail: "", stderr_tail: "" }
      }

      const stdout = new Tail(SCRIPT_OUTPUT_TAIL_CHARS)
      const stderr = new Tail(SCRIPT_OUTPUT_TAIL_CHARS)
      return await new Promise<ScriptResult>((done) => {
        const finish = (exitCode: number | null, signal: string | null, spawnError?: string): void => {
          if (timer !== undefined) clearTimeout(timer)
          if (spawnError !== undefined) stderr.push(spawnError)
          done({
            ...base,
            exit_code: exitCode,
            ...(signal !== null ? { signal } : {}),
            timed_out: timedOut,
            duration_ms: Math.max(0, Math.round(this.#clock() - started)),
            stdout_tail: this.#redact(stdout.value()),
            stderr_tail: this.#redact(stderr.value()),
          })
        }
        try {
          child = this.#spawn(path, [], {
            cwd: request.cwd,
            env: this.scriptEnvironment(request.extraEnv),
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
          })
        } catch (error) {
          finish(null, null, errorMessage(error))
          return
        }
        let settled = false
        child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
        child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
        child.on("error", (error) => {
          if (settled) return
          settled = true
          finish(null, null, errorMessage(error))
        })
        child.on("exit", (code, signal) => {
          if (settled) return
          settled = true
          finish(code, signal)
        })
        timer = setTimeout(() => {
          timedOut = true
          stop()
        }, Math.max(1, request.timeoutMs))
        timer.unref?.()
        if (killed) signalGroup("SIGTERM")
      })
    })()

    return { result, kill: stop }
  }

  #redact(text: string): string {
    return redactSecretsFromText(text, [...this.#knownSecrets])
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
