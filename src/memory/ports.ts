/**
 * M5.2/M5.4 — the ports the memory subsystem is written against.
 *
 * These interfaces are the milestone's shared contract. They are declared here,
 * owned by the milestone lead, and *not* implemented in this file: the
 * repository, the redaction pipeline, and the context assembler are built
 * against them in parallel, which is only safe if the seam is written down
 * first. This is the "freeze shared contracts first" rule from the plans README
 * applied to the actual code rather than to a document nobody imports.
 *
 * Three rules the shapes enforce, and why they are shapes rather than comments:
 *
 * 1. **No ambient clock.** Every mutating and time-dependent method takes `now`.
 *    The event store's outbox already does this (`options.now: Timestamp`, with
 *    a comment saying it is required precisely so it cannot be forgotten) and a
 *    memory store that reads `Date.now()` internally is a memory store whose
 *    tests can only be written by sleeping.
 * 2. **A refusal is a value, not a throw.** Query and authorization paths return
 *    `Result`/`ok:false` because a caller iterating records must be *forced* to
 *    consider the "you may not see this" branch. A thrown error is catchable
 *    and skippable; a `null` is not.
 * 3. **No query is unrestricted by default.** Every read method requires an
 *    explicit `MemoryQueryScope` carrying a project id. There is no
 *    `all()` without a scope, because a repository that can list every project's
 *    memory has a cross-project leak waiting for a caller in a hurry.
 */

import type { Result } from "../orchestration/errors.js"
import type { Actor } from "../orchestration/types.js"
import type {
  MemoryPayload,
  MemoryRecordV1,
  MemoryRecordV2,
  MemoryRecordView,
  MemoryRedaction,
  MemoryViewScope,
} from "./record.js"
import type { MemoryKind, Sensitivity, TrustState } from "./ontology.js"

/** Who is asking. Scope, node, and role are all required for a cross-boundary read. */
export interface MemoryQueryScope {
  readonly projectId: string
  /**
   * Where the reader is, as a full scope — **not** a scope kind.
   *
   * This was a kind (`"run"`) in the first draft and that was wrong in a way no
   * test would have caught from the happy path: a kind cannot distinguish
   * run-1 from run-2, so a run-scoped reader would have been handed every run's
   * records. The identity is what `scopeContains` compares, and a scope without
   * it can only answer "is this the same KIND of place", which is not an access
   * question.
   *
   * A `project`-kind scope is a reader with no run context and legitimately sees
   * the whole project. Every other kind must carry the ids it descends through.
   */
  readonly scope: MemoryViewScope
  /** The reader's node. Present for every mesh or local node read. */
  readonly nodeId: string
  /** The reader's role, when it is acting as one. */
  readonly roleId?: string
  /** The reader's clearance on the sensitivity scale. */
  readonly clearance: Sensitivity
  /** Who the reader is, for audit and for the actor recorded on a new record. */
  readonly actor: Actor
}

/** What to look for. Every field is an AND filter; `undefined` means "any". */
export interface MemoryQuery {
  readonly projectId: string
  readonly kinds?: readonly MemoryKind[]
  readonly trustStates?: readonly TrustState[]
  /** Include records superseded by a later one. Off by default: the active view. */
  readonly includeSuperseded?: boolean
  /** Include expired records. Off by default. */
  readonly includeExpired?: boolean
  /** Restrict to a run. A project-scope record still matches, per the lattice. */
  readonly runId?: string
  readonly taskId?: string
  /** Exact ids, for a manifest that already decided what it wants. */
  readonly memoryIds?: readonly string[]
  /** Newest first within a category after the assembler's own sort. */
  readonly limit?: number
}

export interface MemoryQueryResult {
  /** Records visible to the querying scope, in a deterministic order. */
  readonly records: readonly MemoryRecordView[]
  /**
   * Records that existed, matched the filters, and were withheld — with the
   * reason. A query that cannot say *why* it withheld something is a query whose
   * omissions cannot be reviewed, which is the "every excluded item has a
   * non-sensitive reason" criterion, applied at the repository level so it
   * cannot be forgotten by one caller.
   */
  readonly withheld: readonly MemoryWithholding[]
}

export interface MemoryWithholding {
  readonly memoryId: string
  /**
   * The record's kind — **absent** when `revealsKind` is `false`.
   *
   * Optional rather than "present but flagged". A field that is populated and
   * carries a "do not show this" boolean is one refactor away from being
   * serialized into a log, a TUI line, or an HTTP response by a caller that
   * spread the object. Making the value itself absent means the safe rendering
   * is the *only* rendering: there is nothing to leak.
   *
   * This is the control that makes a cross-project, node-restricted, or
   * clearance-limited withholding safe to return at all. The M5.2
   * implementation originally always populated `kind` and relied on
   * `revealsKind`, which left the id itself a cross-project existence oracle;
   * `tests/unit/memory/access-policy.test.ts` asserts the field is genuinely
   * absent, not merely flagged.
   */
  readonly kind?: MemoryKind
  readonly reason: MemoryWithholdingReason
  /**
   * What the caller is permitted to learn even when `allowed` is false.
   *
   * `false` for every reason where the record's *subject* is itself what is
   * protected, not merely its content: `prohibited_content`,
   * `redacted_unavailable`, `sensitivity_above_clearance`, `node_restricted`,
   * `role_restricted`, and `project_mismatch`. Naming the kind of a record you
   * were not cleared for is a disclosure — "there is a `handoff` here you may
   * not read" tells a restricted node that work was handed off, and that is
   * frequently the sensitive fact. For `project_mismatch` it is stronger than
   * that: a record in another project is not even a *candidate* for this reader
   * (see `MemoryRepository.query`), so a `project_mismatch` withholding here
   * means "this id is not yours", and the kind is a topic oracle across a
   * boundary that exists precisely to stop one.
   *
   * `true` for the reasons that are about the *reader's* situation rather than
   * the record's secrecy, and only for records the reader can already see the
   * existence of: `scope_not_visible`, `not_trusted`, `superseded`, `expired`,
   * `tombstoned`. These say "you asked for something that is not yours, or not
   * this view", and the reader is looking at a record in their own project.
   */
  readonly revealsKind: boolean
}

export const MEMORY_WITHHOLDING_REASONS = [
  "project_mismatch",
  "scope_not_visible",
  "not_trusted",
  "superseded",
  "sensitivity_above_clearance",
  "prohibited_content",
  "node_restricted",
  "role_restricted",
  "expired",
  "tombstoned",
  "redacted_unavailable",
] as const
export type MemoryWithholdingReason = (typeof MEMORY_WITHHOLDING_REASONS)[number]

/**
 * An input to `append`. The repository computes the id, hash, and defaults.
 *
 * There is deliberately no `memoryId` field. A caller-supplied id is a caller-
 * supplied *identity*, and identity is what makes a re-import idempotent: the
 * repository derives it from the record's content, so the same fact always
 * produces the same id and a second `append` of the same fact is a
 * `memory.duplicate_id` refusal rather than a duplicate. A field here would let
 * a caller mint two ids for one fact, and there would be no way to tell which is
 * the record.
 *
 * A caller that genuinely needs to predict the id — the M5.3 migration, which
 * must report the ids it wrote before it wrote them — calls
 * `deriveMemoryId(memoryRecordSourceKey(input))`, which is the same derivation
 * the repository performs. That function is an implementation export, not a port
 * method, because a port method that minted ids would be a second derivation.
 */
export interface AppendMemoryInput {
  readonly projectId: string
  readonly kind: MemoryKind
  readonly scope: MemoryRecordV2["scope"]
  readonly author: Actor
  readonly createdAt: string
  readonly content: string
  readonly detail?: Record<string, unknown>
  readonly artifactReferences?: readonly string[]
  readonly secretReferences?: MemoryPayload["secretReferences"]
  readonly sensitivity?: Sensitivity
  readonly retention?: MemoryRecordV2["retention"]
  readonly expiresAt?: string
  readonly visibleToNodeIds?: readonly string[]
  readonly visibleToRoleIds?: readonly string[]
  readonly supersedesMemoryId?: string
  readonly redaction?: MemoryRedaction
  readonly sourceReferences?: readonly { namespace: string; id: string }[]
  readonly trust?: TrustState
  readonly trustDecision?: MemoryRecordV2["trustDecision"]
  /** Set by the repository. `undefined` on user input; every append passes one. */
  readonly correlationId?: string
}

export interface AppendMemoryResult {
  readonly record: MemoryRecordV2
  /** The record this one replaced, if any. Present in history, never mutated. */
  readonly superseded?: MemoryRecordV2
}

/** A record the user asked to be physically removed, for an explicit retention operation. */
export interface TombstoneRequest {
  readonly memoryId: string
  readonly projectId: string
  readonly requestedBy: Actor
  readonly requestedAt: string
  /** 1..1024. Required: a deletion with no stated reason is not auditable. */
  readonly reason: string
  /** Must be true. The repository refuses a tombstone from a non-user without it. */
  readonly authorized: boolean
}

/**
 * A non-sensitive record that a deletion left behind.
 *
 * `contentHash` is retained deliberately: without it, "this record existed and
 * said something" cannot be proven or disproven after a privacy deletion, which
 * turns an audit trail into a rumour. The hash is a one-way digest of content
 * that no longer exists anywhere.
 */
export interface MemoryTombstone {
  readonly schemaVersion: 1
  readonly memoryId: string
  readonly projectId: string
  readonly kind: MemoryKind
  readonly contentHash: string
  readonly deletedAt: string
  readonly deletedBy: Actor
  readonly reason: string
  /** Always true. A tombstone is non-sensitive by definition; stated so it can be asserted. */
  readonly nonSensitive: true
}

/**
 * An optional check every write passes through, BEFORE the record is stored.
 *
 * The plan's Redaction Design says "redaction runs before persistence when input
 * is prohibited", and the M5.9 review found (SF-6) that nothing on the write
 * path did it: `AppendMemoryInput.redaction` was caller-asserted, so a live AWS
 * key in `content` was stored and served with `redaction: { status: "none" }`.
 *
 * A *port* rather than a `RedactionPipeline` dependency on purpose. The
 * repository is storage plus authorization; making it own a detector set would
 * mean two places that decide what a secret looks like, and a detector upgrade
 * would then have to be coordinated with a storage change. A guard is one
 * function, supplied by whoever composes the repository, and it composes the
 * M5.4 pipeline.
 *
 * A guard **refuses**; it does not rewrite. A guard that silently substituted
 * text would change the record's `contentHash` behind the caller's back, and that
 * hash is what answers "is this the same fact?" — so a rewritten record would no
 * longer be describable as what its author wrote. The caller is the thing that
 * must be able to say what it stored.
 */
export interface MemoryWriteGuard {
  /**
   * Inspect a record that is about to be stored. `{ ok: false }` refuses the
   * write; the refusal must name the rule that fired and never the matched text.
   */
  inspect(input: AppendMemoryInput): Result<true>
  /** A short, safe description for an operator log. Never the content. */
  describe(): string
}

export interface MemoryRepository {
  /** Append one record. Refuses a duplicate id and an illegal supersession. */
  append(input: AppendMemoryInput): Promise<Result<AppendMemoryResult>>

  /**
   * Append a correction that supersedes `supersedesMemoryId`.
   *
   * The old record is never mutated. It is *marked* superseded in the derived
   * active view, and the returned `superseded` record is the same bytes as
   * before — `tests/unit/memory/supersession.test.ts` asserts byte equality of
   * the pre- and post-supersession reads.
   */
  supersede(memoryId: string, input: AppendMemoryInput): Promise<Result<AppendMemoryResult>>

  /** Append many records atomically. Used by the legacy migration. */
  appendAll(inputs: readonly AppendMemoryInput[]): Promise<Result<readonly MemoryRecordV2[]>>

  get(memoryId: string, scope: MemoryQueryScope): Promise<Result<MemoryRecordView | null>>

  /** Raw read with no authorization. Callers are the migration and the audit path only. */
  getRaw(memoryId: string): Promise<MemoryRecordV1 | MemoryRecordV2 | null>

  /**
   * Read a project's memory as `scope` is allowed to see it.
   *
   * Returns a `Result`, not a bare `MemoryQueryResult`, and the reason is
   * specific: the M5.9 review found that a query whose `projectId` disagreed
   * with the `scope`'s was answered with a *refusal-shaped* result — the other
   * project's records were selected as candidates, refused by the policy, and
   * each reported as a `project_mismatch` withholding **carrying the foreign
   * `memoryId`**. A reader could therefore enumerate another project's memory ids
   * by naming it.
   *
   * Returning an empty result instead would fix the leak and introduce a worse
   * one: an empty result is exactly what "this project has no matching records"
   * looks like, so a caller bug would be indistinguishable from a fact. The
   * refusal is `validation` / `memory.query_project_mismatch` — deliberately not
   * `policy_denied` / `project_mismatch`, because it is a *caller* error, and the
   * two must not be conflated in an operator's log either.
   */
  query(query: MemoryQuery, scope: MemoryQueryScope): Promise<Result<MemoryQueryResult>>

  /**
   * Every record in a project, **with no authorization at all**.
   *
   * Named `…Unscoped` rather than `listProject` on purpose. This is the
   * migration and export path and nothing else: an export must be able to produce
   * a project archive, and a method that respected every reader's clearance could
   * not. The M5.9 review found it as SF-2 — under the old name `listProject`,
   * with no `scope` parameter, it handed node-restricted, role-restricted,
   * `restricted`, and `prohibited` bodies with full content to any caller that
   * could name a project id.
   *
   * A caller reaching for "list this project's memory" must find `query`, which
   * returns records *and* the withheld reasons, so an omission is explainable.
   * Results are deep-frozen structural copies, so mutating an export cannot
   * corrupt the store.
   */
  listProjectUnscoped(projectId: string): Promise<readonly (MemoryRecordV1 | MemoryRecordV2)[]>

  /** Tombstones for a project, unscoped, for the same reason as `listProjectUnscoped`. */
  listTombstonesUnscoped(projectId: string): Promise<readonly MemoryTombstone[]>

  /** Accept or reject a proposed record. Only a user may accept. */
  decideTrust(
    memoryId: string,
    decision: { trust: "accepted" | "rejected"; decidedBy: Actor; decidedAt: string; reason?: string },
  ): Promise<Result<MemoryRecordV2>>

  /** Physical deletion for an explicit retention/privacy operation. */
  tombstone(request: TombstoneRequest): Promise<Result<MemoryTombstone>>
}

// ---------------------------------------------------------------------------
// M5.4 — redaction
// ---------------------------------------------------------------------------

export interface RedactionMatch {
  /** The rule that fired. Identifies the rule, never the matched text. */
  readonly ruleId: string
  readonly start: number
  readonly end: number
}

export interface RedactionOutcome {
  /** The text to store or send. Contains no matched span. */
  readonly text: string
  /** Rules that fired, sorted and unique. */
  readonly ruleIds: readonly string[]
  readonly matches: readonly RedactionMatch[]
  /** `prohibited` when a rule classified the input as must-not-store. */
  readonly status: "none" | "redacted" | "prohibited"
  /** How many spans were replaced. A count, never the counts per rule. */
  readonly spanCount: number
}

export interface SecretDetector {
  readonly ruleId: string
  /** Does this rule apply to this input at all? A cheap pre-filter. */
  appliesTo(text: string): boolean
  /** Non-overlapping matches, in ascending `start` order, without text. */
  detect(text: string): readonly RedactionMatch[]
  /**
   * Classification for a rule that says "this must not be stored at all", e.g.
   * a private key block. Optional: a plain redaction rule omits it.
   */
  readonly prohibits?: boolean
}

export interface RedactionPolicy {
  readonly detectors: readonly SecretDetector[]
  /**
   * Case-insensitive key names whose value is always redacted, e.g. `password`.
   * Deterministic and configured — never inferred from prose.
   */
  readonly sensitiveKeys?: readonly string[]
  /** Path-like substrings whose mention is redacted. */
  readonly sensitivePaths?: readonly string[]
  /** Replacement text. Fixed, so redaction is deterministic. */
  readonly replacement?: string
}

export interface RedactionPipeline {
  redact(text: string, policy: RedactionPolicy): RedactionOutcome
  /** A safe description of a record for a diagnostic. Never its content. */
  describe(record: { memoryId: string }): string
}

// ---------------------------------------------------------------------------
// M5.9 — access decisions
// ---------------------------------------------------------------------------

export interface MemoryAccessDecision {
  readonly allowed: boolean
  readonly reason: MemoryWithholdingReason | "allowed"
  /** See `MemoryWithholding.revealsKind`, which is the definition this defers to. */
  readonly revealsKind: boolean
}

export interface MemoryAccessPolicy {
  decide(record: MemoryRecordView, reader: MemoryQueryScope, now: string): MemoryAccessDecision
  /** A stable reason string for a decision, for the manifest and the TUI. */
  explain(decision: MemoryAccessDecision): string
}

export type { MemoryRecordV1, MemoryRecordV2, MemoryViewScope }
