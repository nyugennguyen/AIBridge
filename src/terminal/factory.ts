/**
 * Terminal Backend DI Factory (Phase 3).
 *
 * WHY THIS FACTORY:
 * Provides provider-neutral dependency injection for constructing either
 * `TmuxTerminalBackend` (default headless production backend) or
 * `HerdrTerminalBackend` (multiplexed workspace manager backend) strictly
 * driven by profile configuration (`terminal.backend`), with zero global state.
 */

import type { ProcessRunner } from "../host/types.js"
import type { Result } from "../orchestration/errors.js"
import type { CreateTerminalRequest } from "./schemas.js"
import type { TerminalAuthorizer } from "./tmux-terminal-backend.js"
import type { TerminalBackend } from "./types.js"
import type { HerdrClient } from "./herdr-terminal-backend.js"
import { TmuxTerminalBackend } from "./tmux-terminal-backend.js"
import { HerdrTerminalBackend } from "./herdr-terminal-backend.js"

export interface CreateTerminalBackendOptions {
  readonly processRunner: ProcessRunner
  readonly authorizer?: TerminalAuthorizer
  readonly recoveryDirectory?: string
  readonly herdrClient?: HerdrClient
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
    case "herdr":
      return new HerdrTerminalBackend({
        client: options.herdrClient,
        processRunner: options.processRunner,
        authorizer: options.authorizer,
        clock: options.clock,
        sessionCommand: options.sessionCommand,
      })
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
