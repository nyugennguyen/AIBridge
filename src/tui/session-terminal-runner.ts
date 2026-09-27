#!/usr/bin/env bun

import { SdkOpencodeClientAdapter } from "../opencode/client.js"
import { spawn } from "node:child_process"

export interface SessionTerminalRunnerDependencies {
  readonly spawnAttach: (argv: readonly string[], env: NodeJS.ProcessEnv) => { readonly exited: Promise<number>; kill(): void }
  readonly abortSession: (options: { baseUrl: string; username: string; password?: string; providerSessionId: string }) => Promise<void>
  readonly retryDelay?: (milliseconds: number) => Promise<void>
}

const realDependencies: SessionTerminalRunnerDependencies = {
  spawnAttach: (argv, env) => {
    const child = spawn(argv[0]!, [...argv.slice(1)], { stdio: "inherit", env })
    return {
      exited: new Promise<number>((resolve) => {
        child.once("exit", (code) => resolve(code ?? 1))
        child.once("error", () => resolve(1))
      }),
      kill: () => { child.kill("SIGTERM") },
    }
  },
  abortSession: async ({ baseUrl, username, password, providerSessionId }) => {
    await new SdkOpencodeClientAdapter({ baseUrl, username, password }).abortSession(providerSessionId)
  },
}

function validOpaque(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) }
function literalLoopback(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1") &&
      !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

/** tmux-owned OpenCode attachment and deadline supervisor; it survives TUI exit. */
export async function runSessionTerminal(argv: readonly string[], dependencies: SessionTerminalRunnerDependencies = realDependencies): Promise<0 | 1> {
  const [baseUrl, username, passwordEnv, providerSessionId, directory, timeoutText] = argv
  const timeoutSeconds = Number(timeoutText)
  if (!baseUrl || !literalLoopback(baseUrl) || !username || !passwordEnv || !validOpaque(providerSessionId ?? "") ||
    !directory?.startsWith("/") || directory.includes("\0") || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    process.stderr.write("AIBridge terminal binding is invalid.\n")
    return 1
  }
  const password = process.env[passwordEnv]
  const child = dependencies.spawnAttach(
    ["opencode", "attach", baseUrl, "--session", providerSessionId!, "--dir", directory, "--mini"],
    {
      ...process.env,
      OPENCODE_SERVER_USERNAME: username,
      ...(password === undefined ? {} : { OPENCODE_SERVER_PASSWORD: password }),
    },
  )
  let timedOut = false
  let aborting: Promise<void> | undefined
  const ensureAborted = (message: string): Promise<void> => {
    aborting ??= (async () => {
      for (;;) {
        try {
          await dependencies.abortSession({ baseUrl, username, password, providerSessionId: providerSessionId! })
          process.stderr.write(message)
          child.kill()
          return
        } catch {
          process.stderr.write("\nAIBridge: provider abort outcome is UNKNOWN; retaining the supervisor and retrying.\n")
          await (dependencies.retryDelay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(1_000)
        }
      }
    })()
    return aborting
  }
  const timer = setTimeout(() => {
    timedOut = true
    void ensureAborted("\nAIBridge: approved runtime timeout elapsed; OpenCode abort confirmed.\n")
  }, timeoutSeconds * 1000)
  const exitCode = await child.exited
  await ensureAborted("\nAIBridge: terminal attachment ended; OpenCode abort confirmed.\n")
  clearTimeout(timer)
  return timedOut ? 1 : (exitCode === 0 ? 0 : 1)
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/session-terminal-runner.js") || process.argv[1]?.endsWith("/session-terminal-runner.ts")
if (isMain) process.exit(await runSessionTerminal(process.argv.slice(2)))
