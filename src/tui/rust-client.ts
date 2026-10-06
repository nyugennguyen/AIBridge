/**
 * Launch the Rust workspace client (`aibr-tui`).
 *
 * The Rust binary is an immediate-mode presentation layer that attaches to the
 * daemon over the IPC socket and draws every pane itself. It is preferred over the
 * older OpenTUI shell when it is present, and the older shell remains the fallback
 * so `aibr tui` never becomes "command not found" on a machine where only the npm
 * package was installed.
 *
 * Why a subprocess rather than an in-process switch: the client owns the terminal.
 * Raw mode, the alternate screen and mouse capture are process-global, and a
 * `Bun.spawn`ed child gets them without this process having to give them up first.
 * The alternative -- making the parent restore the terminal, exec, and hand it back
 * -- would mean the client had to be able to run after the engine's own shutdown
 * hooks had run.
 *
 * The exit code is propagated, not translated. `aibr-tui` distinguishes "you have to
 * start the daemon" (1) from "this is a bug" (2), and a supervising script needs to
 * see that difference.
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { CliExitCode } from "../cli.js"

/** Where the binary may live, in preference order. */
const CANDIDATE_PATHS = (): readonly string[] => {
  const here = dirname(fileURLToPath(import.meta.url))
  // `dist/` after a build, `src/` under tsx.
  const roots = [resolve(here, ".."), resolve(here, "..", "..")]
  return roots.flatMap((root) => [
    join(root, "target", "release", "aibr-tui"),
    join(root, "target", "debug", "aibr-tui"),
  ])
}

/** The path of the Rust client, or `null` when it has not been built. */
export function findTuiBinary(): string | null {
  for (const candidate of CANDIDATE_PATHS()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Run the Rust client to completion.
 *
 * `profile` is accepted and ignored: the client takes its world from the daemon over
 * the socket, and the profile already selected which daemon that is by the time this
 * runs. Keeping the parameter is what lets this slot into the same CLI dep as the
 * OpenTUI shell rather than special-casing the dispatch.
 */
export function runRustTui(_profile: string): Promise<CliExitCode> {
  const binary = findTuiBinary()
  if (binary === null) {
    return Promise.reject(
      new Error("aibr-tui is not built; run `cargo build --release -p aibr-tui` (or keep using the OpenTUI shell)"),
    )
  }
  return new Promise((resolvePromise) => {
    // `stdio: "inherit"`: the client writes escape sequences to the real terminal,
    // and anything piped here would have to be re-emitted byte for byte.
    const child = spawn(binary, [], { stdio: "inherit" })
    child.on("error", (error: Error) => {
      resolvePromise(1)
      process.stderr.write(`aibr tui: could not start the client: ${error.message}\n`)
    })
    child.on("close", (code: number | null) => {
      // `null` means the child was killed by a signal, which is neither a clean
      // detach nor a client bug -- reported as 1, the "something is wrong with the
      // environment" code, so a supervising script does not read it as success.
      if (code === null) {
        resolvePromise(1)
        return
      }
      // The client uses 0, 1 and 2. Anything else would be a bug in the client, and
      // clamping keeps the value inside the declared range rather than widening it.
      resolvePromise(code === 2 ? 2 : code === 0 ? 0 : 1)
    })
  })
}