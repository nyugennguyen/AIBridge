/**
 * Terminal Backend DI Factory (Phase 3).
 *
 * WHY THIS FACTORY:
 * Constructs the `TmuxTerminalBackend` with zero global state. The Herdr
 * backend was removed in 3.1.1; `terminal.backend: "herdr"` is still accepted
 * in config (deprecated) and gets the tmux backend.
 */

import type { ProcessRunner } from "../host/types.js"
import type { Result } from "../orchestration/errors.js"
import type { CreateTerminalRequest } from "./schemas.js"
import type { TerminalAuthorizer } from "./tmux-terminal-backend.js"
import type { TerminalBackend } from "./types.js"
import { TmuxTerminalBackend } from "./tmux-terminal-backend.js"

export interface CreateTerminalBackendOptions {
  readonly processRunner: ProcessRunner
  readonly authorizer?: TerminalAuthorizer
  readonly recoveryDirectory?: string
  readonly clock?: () => Date
  readonly sessionCommand?: (request: CreateTerminalRequest) => Promise<Result<readonly [string, ...string[]]>>
}

/**
 * Constructs the configured TerminalBackend without global singletons.
 */
export function createTerminalBackend(
  config: { backend: "tmux" | "herdr" },
  options: CreateTerminalBackendOptions,
): TerminalBackend {
  switch (config.backend) {
    case "herdr": // deprecated, removed backend: falls through to tmux
    case "tmux":
      return new TmuxTerminalBackend({
        processRunner: options.processRunner,
        authorizer: options.authorizer ?? { authorize: async () => ({ ok: true, value: undefined }) },
        recoveryDirectory: options.recoveryDirectory ?? "/tmp/aibr-terminals",
        clock: options.clock,
        sessionCommand: options.sessionCommand,
      })
  }
}
