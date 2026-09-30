/**
 * M5.1 — the memory ontology: what a memory record is allowed to be.
 *
 * This file is the *vocabulary* layer of Milestone 5 and it is deliberately
 * dependency-free (no Zod, no I/O, no imports from the rest of `src/`). Every
 * other M5 module — the repository, the redaction pipeline, the context
 * assembler, the TUI — is written against these names, so a change here is a
 * change to the milestone contract and belongs in a re-approved docblock rather
 * than in a commit that also fixes an unrelated bug.
 *
 * # Why the M0 v1 record is not extended in place
 *
 * `memoryRecordSchema` in `src/orchestration/schemas.ts` is covered by the M0
 * contract digest (`scripts/m0-contract-signoff.sh`). It has no retention
 * expiry, no supersession back-reference, no redaction status, and its
 * `sensitivity` axis cannot express "a credential exists here, and its *value*
 * does not leave this record". Those are the three things M5.3/M5.4 need.
 *
 * Mutating the frozen schema would silently widen an approved contract and
 * would make every existing persisted record invalid at once. So M5 defines a
 * **new record version** (`schemaVersion: 2`) in `src/memory/schemas.ts`,
 * reads v1, and migrates forward. M0's shape is never mutated and never
 * rejected; it is read and translated.
 *
 * # Scope lattice
 *
 * A record applies to a reader when the record's scope is at or above the
 * reader's — a project-wide constraint reaches every run in the project, and a
 * single session's transcript reaches nothing else. That is the only visibility
 * rule that makes a run-scoped finding appear in the project-wide view (where it
 * belongs) without any per-record ACL list to keep in sync.
 *
 * Scope does two jobs, and conflating them is the trap: a record *standing at*
 * the reader's scope is a constraint on it (kinds alone answer this), and a
 * record *inside* the reader's scope is its own history (ids are required). Only
 * `scopeContains` in `record.ts` answers the second, and it is the one the
 * repository uses.
 *
 *   project  <- run <- task <- dispatch <- session
 *
 * `SCOPE_DEPTH` is that ordering, and it is the single definition of "broader".
 * Nothing else in M5 is allowed to hand-roll a scope comparison; see
 * `isScopeVisible`, which states the direction explicitly because inverting it
 * fails silently by returning *fewer* records, and `scopeContains` in
 * `record.ts`, which adds the identity comparison the kind-only check cannot do.
 *
 * # Trust lattice
 *
 * Trust is *not* a linear scale and is deliberately not modelled as one. It is
 * a four-value status with a legal-transition table, because the only
 * interesting question is "who may move this record from where to where", and a
 * numeric scale invites arithmetic nobody wants (`proposed + 1 === accepted`).
 *
 *   proposed  --accept-->  accepted
 *   proposed  --reject-->  rejected
 *   rejected  --propose--> proposed     (a re-proposal is a new record, never a
 *                                       transition of the rejected one)
 *
 * `system_derived` is a *producer* status, not a rung on the ladder: it marks a
 * record the system computed from facts it already accepted (a dependency
 * result, a run summary). It never becomes `accepted` by arithmetic; if a
 * system-derived record needs trust it is re-proposed as a new record with a
 * human author.
 *
 * The load-bearing rule, and the reason `ACCEPTING_ACTOR_KINDS` exists: only a
 * `user` actor can put a record into `accepted`. A node, a session, a system,
 * or an agent writing through any of those identities cannot mint a trusted
 * project fact, no matter what it calls itself. See `canTransitionTrust`.
 *
 * # Sensitivity lattice
 *
 * Sensitivity *is* a linear scale, because every consumer wants the same
 * monotone question: "may I read this at my clearance?". `SENSITIVITY_RANK`
 * is that scale and `mayReadSensitivity` is the only accessor.
 *
 *   public_to_project < restricted < secret_reference_only < prohibited
 *
 * `secret_reference_only` is the reason this axis cannot be copied from the M0
 * v1 enum. It is the state of a record that *knows* a credential exists and
 * says so by reference — "the deploy key is in 1Password, item X" — which is
 * safe to assemble into a context and is the entire point of the state. The
 * M0 axis has no such value, so it collapses that record into `restricted` and
 * loses the distinction between "don't show this to the intern team" and "this
 * is not a secret value".
 *
 * `prohibited` is terminal for content: it is never rendered, never
 * transmitted, and never included in a context manifest item. Only its
 * existence — id, kind, hash — is recordable.
 *
 * # Ordering
 *
 * `CONTEXT_CATEGORY_ORDER` is fixed and is the single definition of context
 * assembly order. The context assembler reads it; nothing re-spells the
 * sequence "1..6" inline, because a second spelling is a second ordering.
 *
 * Within a category the sort is `(priority desc, sourceId asc)`. `sourceId` is
 * the final tiebreak precisely because it is stable: two runs that select the
 * same records must produce the same order, and a record's id does not depend
 * on insertion time, map iteration, or which reader asked.
 */

import { z } from "zod"

/** Record kinds. The M0 v1 set, unchanged and extended with nothing. */
export const MEMORY_KINDS = [
  "decision",
  "constraint",
  "finding",
  "handoff",
  "summary",
  "artifact_reference",
  "user_correction",
  "run_outcome",
] as const
export const memoryKindSchema = z.enum(MEMORY_KINDS)
export type MemoryKind = z.infer<typeof memoryKindSchema>

/** Scope kinds, ordered narrowest-last by `SCOPE_DEPTH`. */
export const MEMORY_SCOPES = ["project", "run", "task", "dispatch", "session"] as const
export const memoryScopeKindSchema = z.enum(MEMORY_SCOPES)
export type MemoryScopeKind = z.infer<typeof memoryScopeKindSchema>

/** `SCOPE_DEPTH` defines "narrower" for the whole milestone. */
export const SCOPE_DEPTH: Readonly<Record<MemoryScopeKind, number>> = Object.freeze({
  project: 0,
  run: 1,
  task: 2,
  dispatch: 3,
  session: 4,
})

/**
 * `isScopeVisible(recordScope, readerScope)` — "does this record STAND at the
 * reader's scope?".
 *
 *   project  <- run  <- task  <- dispatch <- session
 *
 * A record at or above the reader is a standing fact that applies to it: a
 * project-wide constraint applies to every run, a run-wide finding to every
 * task, a task's finding to its dispatch. That is the one direction a comparison
 * of *kinds alone* can answer, and it is what this function answers.
 *
 * Two things it deliberately does NOT answer, because kinds cannot:
 *
 * 1. **Descendants.** A task reader also sees its own dispatches' and sessions'
 *    records. Those are *below* the reader, and whether a given one is its own
 *    depends on identity — a `dispatch`-kind record could belong to a different
 *    task. `scopeContains` in `record.ts` answers this.
 * 2. **Identity.** run-1's finding and run-2's finding are both `run` kind.
 *    Kinds cannot separate them; ids can.
 *
 * The root case is stated separately because it does not fit the ladder: a
 * `project`-scope reader has no run context, so *every* record in the project
 * stands at its scope. It sits at the widest point and still sees the most,
 * which is why this is not a plain `depth <= depth`.
 *
 * A call site that uses this function alone is comparing shapes, not scopes. The
 * docblock says so because the failure is silent: it returns `true` for another
 * run's record rather than an error.
 */
export function isScopeVisible(recordScope: MemoryScopeKind, readerScope: MemoryScopeKind): boolean {
  if (readerScope === "project") return true
  return SCOPE_DEPTH[recordScope] <= SCOPE_DEPTH[readerScope]
}

export const TRUST_STATES = ["proposed", "accepted", "rejected", "system_derived"] as const
export const trustStateSchema = z.enum(TRUST_STATES)
export type TrustState = z.infer<typeof trustStateSchema>

/** A record is trusted — and therefore injectable into a context — only when accepted. */
export function isTrusted(trust: TrustState): boolean {
  return trust === "accepted"
}

/**
 * The only actor kind permitted to author an `accepted` record.
 *
 * This single constant is the whole of M5.6's "agent cannot create trusted
 * project facts" guarantee. It is a *value*, not a check scattered across
 * call sites, so a new caller that forgets to ask still gets a wrong answer
 * from the type if it tries to enumerate the allowed set.
 */
export const ACCEPTING_ACTOR_KINDS: readonly string[] = Object.freeze(["user"])

export type TrustTransition = "accept" | "reject" | "repropose"

const TRUST_TRANSITIONS: Readonly<Record<TrustState, readonly TrustTransition[]>> = Object.freeze({
  proposed: Object.freeze(["accept", "reject"] as const),
  accepted: Object.freeze([] as const),
  rejected: Object.freeze([] as const),
  // A system-derived record is re-proposed by writing a NEW record with a
  // human author. Transitioning this one would let a system quietly promote
  // its own summary into a trusted fact, which is the exact failure M5.6 exists
  // to prevent.
  system_derived: Object.freeze([] as const),
})

export function canTransitionTrust(from: TrustState, to: TrustState): boolean {
  if (from === "proposed" && to === "accepted") return true
  if (from === "proposed" && to === "rejected") return true
  return TRUST_TRANSITIONS[from].includes(transitionVerb(from, to))
}

function transitionVerb(from: TrustState, to: TrustState): TrustTransition {
  if (to === "accepted") return "accept"
  if (to === "rejected") return "reject"
  return "repropose"
}

export const SENSITIVITY_LEVELS = ["public_to_project", "restricted", "secret_reference_only", "prohibited"] as const
export const sensitivitySchema = z.enum(SENSITIVITY_LEVELS)
export type Sensitivity = z.infer<typeof sensitivitySchema>

/** Higher rank is more sensitive. The scale is total and monotone. */
export const SENSITIVITY_RANK: Readonly<Record<Sensitivity, number>> = Object.freeze({
  public_to_project: 0,
  restricted: 1,
  secret_reference_only: 2,
  prohibited: 3,
})

/**
 * The one clearance question.
 *
 * `prohibited` is a special case rather than just the top of the scale. Rank
 * comparison alone would say a reader holding `prohibited` clearance may read a
 * `prohibited` record — true of the *label*, useless in practice, because the
 * label is how the system says "no reader may see this". So the comparison is
 * made first and the prohibition is checked separately, and the check cannot be
 * satisfied by holding a higher clearance. There is deliberately no
 * `clearance: "prohibited"` that unlocks anything.
 */
export function mayReadSensitivity(record: Sensitivity, clearance: Sensitivity): boolean {
  if (record === "prohibited") return false
  return SENSITIVITY_RANK[record] <= SENSITIVITY_RANK[clearance]
}

/** `prohibited` content is never rendered, logged, or transmitted. */
export function isRenderable(record: Sensitivity): boolean {
  return record !== "prohibited"
}

export const RETENTION_POLICIES = ["run", "project", "permanent"] as const
export const retentionPolicySchema = z.enum(RETENTION_POLICIES)
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>

export const REDACTION_STATUSES = ["none", "redacted", "prohibited", "derivative"] as const
export const redactionStatusSchema = z.enum(REDACTION_STATUSES)
export type RedactionStatus = z.infer<typeof redactionStatusSchema>

/**
 * Default retention per kind.
 *
 * `artifact_reference` defaults to `run`: a pointer to a file's contents
 * outlives its own usefulness and the file is not in memory anyway. Everything
 * else defaults to `project`, which is the conservative choice — a longer
 * default needs an author to ask for it, a shorter one silently loses facts.
 */
export const DEFAULT_RETENTION_BY_KIND: Readonly<Record<MemoryKind, RetentionPolicy>> = Object.freeze({
  decision: "project",
  constraint: "project",
  finding: "project",
  handoff: "run",
  summary: "run",
  artifact_reference: "run",
  user_correction: "permanent",
  run_outcome: "run",
})

/**
 * The initial trust an author of each kind may mint.
 *
 * Ownership is the point of this table. Before M5, "who owns this fact" was
 * answered by a free-text `agent` field on a legacy decision, which is why the
 * M0 migration had to label every imported record `legacy.agent-label` and mark
 * it unverified. Here the ownership is structural: a session or node author
 * proposing a *constraint* is legal (an agent can discover a constraint) but the
 * record is born `proposed` and only a user can accept it.
 */
export const INITIAL_TRUST_BY_AUTHOR_KIND: Readonly<Record<string, TrustState>> = Object.freeze({
  user: "accepted",
  node: "proposed",
  session: "proposed",
  system: "system_derived",
})

export function initialTrustFor(authorKind: string, kind: MemoryKind): TrustState {
  const base = INITIAL_TRUST_BY_AUTHOR_KIND[authorKind] ?? "proposed"
  // A `user` may only mint `accepted` for the kinds a person actually decides.
  // Everything a person writes that is *not* a decision is evidence, and
  // evidence gets proposed. This is why `findings` are `proposed` by default
  // even when a human types them into a comment.
  if (base === "accepted" && kind !== "decision" && kind !== "constraint" && kind !== "user_correction") {
    return "proposed"
  }
  return base
}

/** Fixed context assembly order. The assembler reads this; nothing re-spells it. */
export const CONTEXT_CATEGORIES = [
  "safety_instructions",
  "dispatch_approval",
  "project_constraints",
  "dependency_results",
  "task_references",
  "run_summary",
] as const
export const contextCategorySchema = z.enum(CONTEXT_CATEGORIES)
export type ContextCategory = z.infer<typeof contextCategorySchema>

export const CONTEXT_CATEGORY_ORDER: Readonly<Record<ContextCategory, number>> = Object.freeze({
  safety_instructions: 1,
  dispatch_approval: 2,
  project_constraints: 3,
  dependency_results: 4,
  task_references: 5,
  run_summary: 6,
})

/** Human-facing titles, used by the TUI and the rendered prompt sections. */
export const CONTEXT_CATEGORY_TITLES: Readonly<Record<ContextCategory, string>> = Object.freeze({
  safety_instructions: "System safety instructions",
  dispatch_approval: "Approved dispatch and role snapshot",
  project_constraints: "Active project constraints and decisions",
  dependency_results: "Direct dependency results and handoffs",
  task_references: "Task file and artifact references",
  run_summary: "Bounded run summary",
})

/**
 * Why an item is or is not in the context.
 *
 * These are the *complete* set of answers to "why is this here / why not". A
 * reason that is not in this table is a bug, and the enumerations here are
 * `Record` over the union so a new reason is a compile error in the assembler
 * and in the TUI at the same time.
 */
export const CONTEXT_INCLUSION_REASONS = [
  "safety_floor",
  "approved_dispatch",
  "active_decision",
  "active_constraint",
  "dependency_result",
  "handoff_packet",
  "task_artifact_reference",
  "run_summary",
] as const
export const contextInclusionReasonSchema = z.enum(CONTEXT_INCLUSION_REASONS)
export type ContextInclusionReason = z.infer<typeof contextInclusionReasonSchema>

export const CONTEXT_EXCLUSION_REASONS = [
  "not_trusted",
  "superseded",
  "scope_not_visible",
  "project_mismatch",
  "node_restricted",
  "role_restricted",
  "sensitivity_above_clearance",
  "prohibited_content",
  "redacted_unavailable",
  "expired",
  "tombstoned",
  "duplicate_source",
  "policy_disabled",
  "budget_exceeded",
  "superseded_by_newer_in_category",
] as const
export const contextExclusionReasonSchema = z.enum(CONTEXT_EXCLUSION_REASONS)
export type ContextExclusionReason = z.infer<typeof contextExclusionReasonSchema>

/**
 * Exclusion reasons whose *existence* is itself the answer.
 *
 * An exclusion for a prohibited or redacted record may not carry the record's
 * summary, kind, or hash of its content — a manifest that says "excluded:
 * prohibited" is fine, and a manifest that says "excluded: prohibited, the
 * deploy key AKIA... " is a leak with a documentation format. This set is
 * checked by the integration test that scans the whole manifest for seeded
 * secret material.
 */
export const SENSITIVE_EXCLUSION_REASONS: readonly ContextExclusionReason[] = Object.freeze([
  "prohibited_content",
  "sensitivity_above_clearance",
  "redacted_unavailable",
  "node_restricted",
  "role_restricted",
])
