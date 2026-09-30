/**
 * M5.4 — the deterministic redaction pipeline.
 *
 * # What it guarantees
 *
 * 1. **Determinism.** For a given `(text, policy)` the returned
 *    `RedactionOutcome` is byte-identical on every run. No clock, no random, no
 *    `Map`/`Set` iteration over user data, no locale-sensitive comparison in a
 *    path that affects output. `defaultDetectors()` returns a frozen array and
 *    overlap resolution sorts by an explicit total order.
 * 2. **No secret material in the result.** The outcome carries `ruleId`,
 *    `start`, `end` and a `text` with the matched spans replaced. There is no
 *    field anywhere in `RedactionOutcome` for matched content, and this module
 *    never builds one — a detector reports offsets, and this module only ever
 *    slices. `describe` is the diagnostic surface and it emits the record id
 *    and nothing else.
 * 3. **Explicit labels.** A `prohibits: true` rule makes the outcome
 *    `status: "prohibited"` with `text: "[PROHIBITED]"`. Nothing from the input
 *    survives, not even a prefix, so a prohibited outcome cannot be used as an
 *    oracle for the length or the shape of what it rejected beyond the span
 *    count.
 * 4. **Stability under reapplication.** `redact(redact(x).text) === redact(x)`.
 *    A stored record that is rewritten on supersession, re-imported, or
 *    re-rendered for a new audience must not accumulate markers or grow spans
 *    on every pass. See the dedicated section below — this one is subtler than
 *    it looks.
 *
 * # What it does not guarantee
 *
 * Detection. The pipeline is a faithful executor; the recall of the rule set is
 * `detectors.ts`'s problem and is explicitly best-effort. This module's docblock
 * for `redact` restates that, because the failure mode of a redaction
 * pipeline is a caller who reads "redacted" as "clean".
 *
 * # Overlap resolution
 *
 * Detectors are independent and overlapping: a GitHub token is also a long
 * high-entropy string; an `Authorization: Bearer` header wrapping a JWT is
 * matched by two rules and only one span may survive. The rule, in full:
 *
 *   Sort candidate matches by `(start asc, length desc, ruleId asc)` and take
 *   each one whose `start` is at or past the end of the last accepted match.
 *
 * That is leftmost-longest, and each component earns its place:
 *
 * - `start asc` because a span beginning earlier usually *contains* more of the
 *   meaningful structure — `Bearer eyJ…` must win over the bare `eyJ…`, or the
 *   header word survives next to a `[REDACTED]`.
 * - `length desc` because at an identical start the wider match is the one the
 *   author meant. This is what makes a `-----BEGIN … PRIVATE KEY-----` block
 *   swallow the key body rather than the body alone.
 * - `ruleId asc` last, and it is the *only* thing that makes the result
 *   independent of `policy.detectors` order. Two rules can produce byte-identical
 *   spans — a 39-character `AIza…` key is matched by both `google_api_key` and
 *   the catch-all entropy rule — and without a named tiebreak the winner would
 *   be whichever the caller listed first. The tiebreak is lexicographic on the
 *   id, which is why `detectors.ts` names the catch-all `unclassified_…` so it
 *   sorts last and the *specific* rule gets the credit.
 *
 * Because a candidate that overlaps an accepted match is dropped rather than
 * merged, a rule can be reported in `ruleIds` only via a span that survived.
 * That is deliberate: `ruleIds` is an operator's triage list, and listing a
 * rule whose span was already covered by a wider one is a rule that fired on
 * nothing.
 *
 * # Stability under reapplication, in detail
 *
 * The naive implementation — run the same rules over the output — is wrong in
 * two ways, and both are fixed here:
 *
 * - A replacement like `[REDACTED]` that *looks like* a value would be matched
 *   again. The `sensitiveKeys` assignment rule's bare-value class excludes `[`,
 *   so `password = [REDACTED]` is not a match, but a caller may configure a
 *   `replacement` that does match. The pipeline therefore drops any candidate
 *   span whose text is *exactly* the replacement it is about to substitute.
 *   A real secret can never be equal to the replacement by accident, and if one
 *   is, it is by definition already redacted.
 * - A `prohibited` outcome is a label, not a redaction. Re-running the pipeline
 *   over `[PROHIBITED]` finds nothing and returns `status: "none"`, which is
 *   correct and is asserted: the prohibition is a property of the *input*, and
 *   the input is gone.
 *
 * # No filesystem access
 *
 * `RedactionPolicy.sensitivePaths` is a list of strings a document may
 * *mention*. The pipeline does not read, stat, or resolve any of them, and this
 * module imports nothing from `node:fs`. "Redact the mention of
 * `~/.aws/credentials`" is a statement that a credential file exists on a
 * machine, which is reconnaissance even though the file is never opened.
 * Enforcing the project/node/role policy on actual artifact reads belongs to
 * the artifact reader, per the milestone's Redaction Design.
 */

import type { RedactionMatch, RedactionOutcome, RedactionPipeline, RedactionPolicy, SecretDetector } from "../ports.js"
import { createSensitiveKeyDetector, createSensitivePathDetector, defaultDetectors } from "./detectors.js"

/** The default replacement. A fixed constant, so redaction is deterministic. */
export const DEFAULT_REPLACEMENT = "[REDACTED]"

/**
 * The only text a `prohibited` outcome may carry.
 *
 * A constant, and not the input with its secrets replaced, because "prohibited"
 * means the input is not storable at all. Leaving any part of it in the outcome
 * — even a redaction of it — would put prohibited content in the one object
 * that gets serialized onto a record and into a diagnostic.
 */
export const PROHIBITED_TEXT = "[PROHIBITED]"

export interface DeterministicRedactionPipelineOptions {
  /**
   * Detectors used by `describe`, which has no policy parameter and so has to
   * pick its own. Defaults to `defaultDetectors()`.
   *
   * Deliberately *not* a fallback for `redact`: a policy's `detectors` list is
   * the complete rule set for that call, and silently unioning it with a
   * built-in set would mean a caller who narrowed the rules got the union
   * instead. "Which rules applied to this record" has to be answerable from the
   * policy alone.
   */
  readonly diagnosticDetectors?: readonly SecretDetector[]
}

/**
 * Sort into the total order overlap resolution depends on: leftmost, then
 * longest, then lowest rule id. The third key is what makes the result
 * independent of the order `policy.detectors` happens to list rules in.
 */
function compareMatches(left: RedactionMatch, right: RedactionMatch): number {
  if (left.start !== right.start) return left.start - right.start
  const leftLength = left.end - left.start
  const rightLength = right.end - right.start
  if (leftLength !== rightLength) return rightLength - leftLength
  if (left.ruleId === right.ruleId) return 0
  return left.ruleId < right.ruleId ? -1 : 1
}

function sameMatch(left: RedactionMatch, right: RedactionMatch): boolean {
  return left.ruleId === right.ruleId && left.start === right.start && left.end === right.end
}

/**
 * Leftmost-longest, non-overlapping selection.
 *
 * `isReplacement` marks spans to drop: a span byte-identical to the text about
 * to replace it is already redacted. See the module docblock's section on
 * reapplication.
 */
function resolveOverlaps(
  matches: readonly RedactionMatch[],
  text: string,
  isReplacement: (candidate: string) => boolean,
): readonly RedactionMatch[] {
  const ordered = [...matches].sort(compareMatches)
  const accepted: RedactionMatch[] = []
  let acceptedEnd = 0
  for (const candidate of ordered) {
    if (isReplacement(text.slice(candidate.start, candidate.end))) continue
    const previous = accepted[accepted.length - 1]
    if (previous !== undefined && sameMatch(previous, candidate)) continue
    // Candidates are start-ascending, so every span already accepted ends at or
    // before `acceptedEnd`; testing the last one is sufficient and a scan back
    // over the rest would be dead code.
    if (candidate.start < acceptedEnd) continue
    accepted.push(candidate)
    acceptedEnd = candidate.end
  }
  return accepted
}

function substitute(text: string, matches: readonly RedactionMatch[], replacement: string): string {
  let result = ""
  let cursor = 0
  for (const match of matches) {
    result += text.slice(cursor, match.start) + replacement
    cursor = match.end
  }
  return result + text.slice(cursor)
}

function ruleIdsOf(matches: readonly RedactionMatch[]): readonly string[] {
  return [...new Set(matches.map((match) => match.ruleId))].sort()
}

export class DeterministicRedactionPipeline implements RedactionPipeline {
  readonly #diagnosticDetectors: readonly SecretDetector[]

  constructor(options: DeterministicRedactionPipelineOptions = {}) {
    this.#diagnosticDetectors = Object.freeze([...(options.diagnosticDetectors ?? defaultDetectors())])
  }

  /**
   * Redact `text` under `policy`.
   *
   * Best-effort by construction: a `status` of `"none"` means *no rule in the
   * configured set fired*, and must not be read as "this text contains no
   * secrets". `tests/unit/memory/redaction/corpus.ts` records the classes of
   * secret this cannot see — connection strings, webhooks, short tokens, values
   * in prose, and anything a human invented.
   */
  redact(text: string, policy: RedactionPolicy): RedactionOutcome {
    const replacement = policy.replacement ?? DEFAULT_REPLACEMENT

    // Policy-derived detectors are built per call from `sensitiveKeys` and
    // `sensitivePaths`. Order is cosmetic — `resolveOverlaps` sorts — but a
    // caller that supplies its own `sensitive_key_assignment` is legal and both
    // instances simply contribute candidates.
    const detectors: SecretDetector[] = [
      ...(policy.sensitiveKeys !== undefined ? [createSensitiveKeyDetector(policy.sensitiveKeys)] : []),
      ...(policy.sensitivePaths !== undefined ? [createSensitivePathDetector(policy.sensitivePaths)] : []),
      ...policy.detectors,
    ].filter((detector): detector is SecretDetector => detector !== undefined)

    const candidates: RedactionMatch[] = []
    const prohibiting: RedactionMatch[] = []
    for (const detector of detectors) {
      if (!detector.appliesTo(text)) continue
      const found = detector.detect(text)
      if (found.length === 0) continue
      candidates.push(...found)
      if (detector.prohibits === true) prohibiting.push(...found)
    }

    if (prohibiting.length > 0) {
      // A prohibiting match is never dropped for being "already redacted": if a
      // detector classified the input as must-not-store, the outcome is
      // must-not-store, and that is not a decision this module gets to
      // second-guess because the literal happened to be the replacement.
      const prohibitingSpans = resolveOverlaps(prohibiting, text, () => false)
      return {
        text: PROHIBITED_TEXT,
        ruleIds: ruleIdsOf(prohibitingSpans),
        matches: prohibitingSpans,
        status: "prohibited",
        spanCount: prohibitingSpans.length,
      }
    }

    const accepted = resolveOverlaps(candidates, text, (candidate) => candidate === replacement)
    if (accepted.length === 0) {
      return { text, ruleIds: [], matches: [], status: "none", spanCount: 0 }
    }

    return {
      text: substitute(text, accepted, replacement),
      ruleIds: ruleIdsOf(accepted),
      matches: accepted,
      status: "redacted",
      spanCount: accepted.length,
    }
  }

  /**
   * A one-line, non-sensitive description of a record.
   *
   * Takes only `{ memoryId }` by contract: there is no parameter through which
   * content could be passed, which is why this is safe rather than careful.
   * The id is still passed through the built-in detectors as defence in
   * depth — a `memoryId` is expected to be an identifier and the ontology's id
   * schemas enforce that, but a diagnostic string is the last place a
   * mis-assigned argument should be able to leak.
   */
  describe(record: { memoryId: string }): string {
    const safe = this.redact(record.memoryId, { detectors: this.#diagnosticDetectors })
    return `memory ${safe.text}`
  }
}
