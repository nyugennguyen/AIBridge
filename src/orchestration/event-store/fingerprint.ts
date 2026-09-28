import { digestJson } from "../digest.js"
import type { Digest } from "../identifiers.js"
import type { OrchestrationCommand } from "../types.js"

/**
 * The set of command fields excluded from the duplicate-detection fingerprint.
 *
 * These are transport/envelope fields: a client that retries a command it
 * never got an answer for legitimately regenerates them. Fingerprinting them
 * turns an ordinary at-least-once retry into a false `FingerprintConflictError`,
 * which is exactly the defect recorded as B8 in the Milestone 3 plan
 * ("Duplicate commands cannot launch duplicate sessions or submit duplicate
 * prompts").
 *
 * Everything else in the parsed command is *semantic* and stays in the
 * fingerprint:
 *
 *  - `type` + `payload`         the requested state change
 *  - `projectId` / `runId`      the authority scope (also part of the receipt key)
 *  - `actor`                    who is asking
 *  - `controllerNodeId` / `controllerEpoch` / `leaseId`
 *                              which authority issued the command
 *  - `correlationId` / `causation`
 *                              the causal chain the command belongs to
 *  - `schemaVersion`            the contract version being committed
 *
 * So a genuinely mutated command under a reused `commandId` still conflicts:
 * changing the payload, the actor, the epoch or the scope all change the
 * digest, while re-issuing the same command with a new clock window does not.
 */
export const NON_SEMANTIC_COMMAND_FIELDS = ["commandId", "issuedAt", "expiresAt"] as const

export type CommandFingerprintVersion = 1 | 2

export const CURRENT_COMMAND_FINGERPRINT_VERSION: CommandFingerprintVersion = 2

export interface CommandFingerprints {
  /** v2 semantic fingerprint — the value stored for newly accepted commands. */
  readonly semantic: Digest
  /** v1 whole-command fingerprint, computed only to resolve legacy receipts. */
  readonly legacy: Digest
}

export function fingerprintCommand(command: OrchestrationCommand): CommandFingerprints {
  const {
    commandId: _commandId,
    issuedAt: _issuedAt,
    expiresAt: _expiresAt,
    ...semantic
  } = command
  void _commandId
  void _issuedAt
  void _expiresAt
  return {
    semantic: digestJson(semantic),
    legacy: digestJson(command),
  }
}

export function commandFingerprintMatches(
  stored: Digest | string,
  fingerprints: CommandFingerprints
): boolean {
  return stored === fingerprints.semantic || stored === fingerprints.legacy
}
