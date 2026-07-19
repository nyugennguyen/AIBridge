/**
 * Minimal ambient declarations for Bun globals used by this module.
 *
 * Only the subset used by BunProcessRunner and BunPrompter is declared
 * here.  The full bun-types package is not installed.
 */

declare namespace Bun {
  interface Subprocess {
    readonly exited: Promise<number>
    readonly stdout: ReadableStream
    readonly stderr: ReadableStream
    kill(signal?: string): void
  }

  interface SpawnOptions {
    readonly cwd?: string
    readonly env?: Record<string, string | undefined>
    readonly timeout?: number
    readonly stdout?: "pipe" | "inherit" | "ignore"
    readonly stderr?: "pipe" | "inherit" | "ignore"
  }

  function spawn(
    command: readonly string[],
    options?: SpawnOptions,
  ): Subprocess

  interface FileSink {
    write(data: string | Uint8Array): void
    flush(): void
  }

  interface BunFile {
    stream(): ReadableStream
    writer(): FileSink
  }

  const stdin: BunFile & { readonly isTTY: boolean }
  const stdout: BunFile & { readonly isTTY: boolean }
}
