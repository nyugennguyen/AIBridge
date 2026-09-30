/**
 * Shared fixtures for the M5.4 redaction tests.
 *
 * # Why the leak assertion lives here and not in each test file
 *
 * The property "no matched secret reaches the outcome" is only worth anything if
 * it is asserted against *the entire serialized outcome*, not against a field
 * the author remembered to check. `assertOutcomeCarriesNoSecret` renders with
 * `JSON.stringify`, which is what a log line, an audit fixture, or a
 * `MemoryRedaction` written to disk would do — and it is also what a reviewer
 * reading a failing message needs to see. The established idiom in
 * `tests/unit/mesh/identity/no-secret-leak.test.ts` is the same one: sweep the
 * rendered value, not the source, because a leak is a *value* and a value only
 * exists once something has actually been produced.
 *
 * The seeded literals themselves come from `src/memory/redaction/corpus.ts`,
 * which assembles them from fragments so a repo-wide grep for a credential
 * literal finds nothing and CI secret scanners are not trained to ignore this
 * directory.
 */

import { expect } from "vitest"
import type { RedactionMatch, RedactionOutcome, RedactionPolicy, SecretDetector } from "../../../../src/memory/ports.js"
import { CORPUS_POLICY, PEM_BODY_LINES, SEEDED_SECRET_LITERALS, SEEDED_SECRETS } from "../../../../src/memory/redaction/corpus.js"
import { DeterministicRedactionPipeline } from "../../../../src/memory/redaction/pipeline.js"

export { CORPUS_POLICY, PEM_BODY_LINES, SEEDED_SECRETS, SEEDED_SECRET_LITERALS }

/** A fresh pipeline. Stateless, but one per test keeps spy detectors isolated. */
export function aPipeline(): DeterministicRedactionPipeline {
  return new DeterministicRedactionPipeline()
}

/**
 * Assert that nothing derived from `outcome` contains a seeded secret.
 *
 * Serializes the whole object on purpose. Checking `outcome.text` alone would
 * pass for an implementation that stashed the secret in `ruleIds` or invented a
 * field, and the whole object is what a caller will eventually log.
 */
export function assertOutcomeCarriesNoSecret(outcome: RedactionOutcome, what: string): void {
  const rendered = JSON.stringify(outcome)
  for (const secret of SEEDED_SECRET_LITERALS) {
    expect(rendered, `${what} leaked a seeded secret`).not.toContain(secret)
  }
  // The PEM body lines as well as the joined secrets: the armoured block is
  // assembled by the corpus, so the joined secret table does not contain it and
  // an outcome could leak the key body without tripping the loop above.
  for (const line of PEM_BODY_LINES) {
    expect(rendered, `${what} leaked PEM key material`).not.toContain(line)
  }
}

/** Matches are ascending, non-overlapping, and carry no text. */
export function expectAscendingNonOverlapping(matches: readonly RedactionMatch[]): void {
  for (let index = 1; index < matches.length; index += 1) {
    expect(matches[index].start, "matches must be ascending by start").toBeGreaterThanOrEqual(matches[index - 1].end)
  }
  for (const match of matches) {
    expect(match.end).toBeGreaterThan(match.start)
    expect(Object.keys(match).sort()).toEqual(["end", "ruleId", "start"])
  }
}

export interface RecordedDetector extends SecretDetector {
  readonly appliedTo: string[]
  readonly detected: string[]
}

/**
 * A `SecretDetector` that reports fixed spans and records how often the
 * pipeline called it.
 *
 * Used to prove two things that a corpus case cannot: that the `appliesTo` gate
 * actually short-circuits `detect` (the contract says it is a cheap pre-filter,
 * and an un-gated detector is a performance bug that also means the gate is
 * untested), and that a caller-supplied rule is genuinely used rather than
 * being quietly replaced by the built-in set.
 */
export function recordedDetector(options: {
  ruleId: string
  appliesTo?: (text: string) => boolean
  spans?: (text: string) => readonly RedactionMatch[]
  prohibits?: boolean
}): RecordedDetector {
  const appliedTo: string[] = []
  const detected: string[] = []
  return {
    ruleId: options.ruleId,
    ...(options.prohibits === true ? { prohibits: true } : {}),
    appliedTo,
    detected,
    appliesTo(text: string): boolean {
      appliedTo.push(text)
      return options.appliesTo === undefined ? true : options.appliesTo(text)
    },
    detect(text: string): readonly RedactionMatch[] {
      detected.push(text)
      if (options.spans !== undefined) return options.spans(text)
      const at = text.indexOf("MARK")
      return at === -1 ? [] : [{ ruleId: options.ruleId, start: at, end: at + 4 }]
    },
  }
}

/** A policy over an explicit detector list, with no key or path rules. */
export function aPolicy(detectors: readonly SecretDetector[]): RedactionPolicy {
  return { detectors }
}
