# Milestone 5 — Shared Memory and Context Engineering: Gate Report

**Date:** 2026-09-30
**Scope:** M5.1 through M5.9 of `Docs/implementation-plans/milestone-5-memory-and-context.md`
**Verdict:** **PASS, after the M5.9 independent review found one Blocker and four High findings. All 21 findings are dispositioned: 19 fixed, 2 accepted. One part of the specification is explicitly not met.**

A passing gate is not a clean milestone. The M5.9 review **refused to sign off** — *"PASS WITH
FINDINGS, I would not sign M5.9 off"* — and found a **Blocker**: `getRaw` returned the live stored
record, so a caller could forge `trust: "accepted"`, and the milestone's single load-bearing
guarantee was defeated through a public port method. That is §7 and the
[isolation audit](./milestone-5-isolation-audit.md), and it is why three verdicts in §13 differ
from what this report originally claimed.

The unmet criterion is *stated as unmet* rather than reinterpreted to pass.

---

## 1. Frozen contract versions

| Fact | Value | Where it lives |
| --- | --- | --- |
| M5 memory record (written) | **2** | `memoryRecordSchemaV2`, `src/memory/record.ts` |
| M5 memory record (read) | **[1, 2]** | `MEMORY_RECORD_SHAPES`, `src/memory/record.ts` |
| M5 context manifest (written) | **2** | `contextManifestV2Schema`, `src/context/types.ts` |
| M0 domain memory record | **1**, unmodified | `memoryRecordSchema`, `src/orchestration/schemas.ts:556` |
| M0 `contextManifest` | **1**, unmodified | `contextManifestSchema`, `src/orchestration/schemas.ts:356` |
| Frozen M0 domain record version | **1** | `FROZEN_DOMAIN_SCHEMA_VERSION`, `src/orchestration/identifiers.ts:91` |
| Database (storage-layout) version | **2** | `CURRENT_DATABASE_VERSION`, `src/orchestration/event-store/schema.ts:12` |

**No M0 contract file was edited.** `./scripts/m0-contract-signoff.sh` exits **0**
(digest `83f9a5e0…ee0c1`, unchanged from the M4 gate). M5 is entirely additive:
`src/memory/ontology.ts`, `record.ts`, `ports.ts`, `primitives.ts` and `src/context/**`
are new files, and the M0 shapes are *imported* rather than re-declared.

### Why M5.2 did not extend the M0 `memoryRecordSchema` in place

The M0 record has no retention expiry, no supersession back-reference, and no redaction
status; its `sensitivity` axis cannot express "a credential exists here and its *value*
does not leave this record". All three are M5.3/M5.4 requirements.

Mutating the frozen shape would have silently widened an approved contract and
invalidated every persisted record at once, with no version to name the break with — the
exact failure `SCHEMA_VERSIONS` was widened to `[1, 2]` at M4-V to make nameable. So M5
defines a **v2 record** and reads v1, projecting it on read rather than rewriting it
(`toMemoryRecordView`, `src/memory/record.ts`). The plan's "extend … through
compatibility migration rather than silently replacing it" is satisfied by a versioned
read path, not by a widened field list.

`memoryRecordSchemaV1` in `record.ts` is a local restatement, because `parseVersioned`
needs a shape per version and the M0 schema is a single unversioned `z.object`. A
restatement can drift, and drift here would mean reading v1 records with the wrong shape
and no error. So the drift is asserted:
`tests/unit/memory/record-contract.test.ts` — *"agrees on the trust, sensitivity,
retention, and kind enums"* and *"rejects exactly what the real M0 schema rejects"* —
builds a record with a field M0 does not have and asserts **both** schemas refuse it.

---

## 2. Ontology, and the three decisions that were argued

The ontology (`src/memory/ontology.ts`, 387 lines, no I/O, no Zod beyond the enums) is
the vocabulary every other M5 module is written against. Three properties were designed,
argued, and reversed at least once during the milestone. Each is recorded because the
reversal is the interesting part.

### 2.1 Trust is a four-value status with a transition table, not a scale

```
proposed  --accept-->  accepted          (decidedBy must be a `user`)
proposed  --reject-->  rejected
system_derived  --(nothing)-->          a system summary is re-proposed, never promoted
accepted / rejected  --(nothing)-->
```

`system_derived` is a *producer* status, not a rung: a system may not promote its own
summary into a trusted fact, even with a user's approval of it. A user's acceptance is
authority over **trust**, not over **content** — accepting a system summary would make it
read as something the system observed when a human merely agreed
(`tests/unit/memory/workflow.test.ts`, *"a system_derived record cannot be promoted by a
user either"*).

**The forgery property is enforced in the data, not in a check.** An `accepted` record
must carry a `trustDecision`, and its `decidedBy.kind` must be `user`
(`record.ts`, `superRefine`). A node-authored `trustDecision` is therefore a record that
**cannot be written**, not a policy violation to be detected at runtime. The repository
adds a second rule on top: a supplied `trustDecision.decidedBy` must be the record's own
`author`, so a node cannot write "accepted by user-alice".

### 2.2 Sensitivity is a scale, and `prohibited` is not on it

```
public_to_project < restricted < secret_reference_only < prohibited
```

`secret_reference_only` is the reason M5 needed its own axis: it is a record that *knows*
a credential exists and says so by reference. The M0 axis has no such value, so it
collapses that record into `restricted` and loses the distinction between "not for the
interns" and "this is not a secret value".

`prohibited` is an **absolute refusal**, checked before the rank comparison
(`mayReadSensitivity`): rank comparison alone would say a reader holding `prohibited`
clearance may read a `prohibited` record, which is true of the label and useless in
practice. `tests/unit/memory/record-contract.test.ts` asserts
`mayReadSensitivity("prohibited", p) === false` for every `p`.

### 2.3 Scope: the lattice was implemented wrong twice before it was right

This is the one place the milestone went through a real design reversal, and the reason is
worth recording because **the failure mode is silent in both directions**.

**Wrong version 1 — kind-only comparison.** The first ontology implemented
`isScopeVisible` as a depth comparison, and a `MemoryQueryScope` carrying only a scope
*kind*. A kind cannot distinguish run-1 from run-2, so the repository had no way to do
cross-run isolation; the M5.2 sub-agent documented this itself as a live limitation:

> *"`MemoryQueryScope.scope` is a `MemoryScopeKind`, not a scope, so the repository has no
> chain to compare … the descendants direction fails closed."*

**Wrong version 2 — the direction was then inverted by the lead**, on the reading that "a
reader sees records at or below its own scope". That is backwards for facts: a
project-wide constraint applies to every run in the project, so a project reader must see
the most. The inversion failed silently by returning *fewer* records.

**The settled design separates two questions that version 1 had conflated:**

| Question | Function | Answers with |
| --- | --- | --- |
| Does this record *stand at* the reader's scope (constrain it)? | `isScopeVisible` | kinds only |
| Is this record *in* the reader's view at all? | `scopeContains` | the identity chain |

`scopeContains` compares identity chains for **prefix comparability in either direction**:
a reader sees the standing facts above it *and* its own history below it, and nothing
sideways. `["run:run-1"]` and `["run:run-1","task:t-1","dispatch:d-1"]` are comparable, so
a task reader sees its own dispatches; `["run:run-1"]` and `["run:run-2",…]` are not, so
run-1 cannot see run-2. A `project` reader has an empty chain, which is a prefix of
everything, so it sees the whole project.

**The port was changed to make this possible.** `MemoryQueryScope.scope` is now a full
`MemoryViewScope`, not a `MemoryScopeKind` (`src/memory/ports.ts`). The docblock records
why a kind was insufficient, and
`tests/unit/context/barrel.test.ts` asserts the dependency direction that makes the
guarantee checkable.

### 2.4 One thing the design deliberately refuses to answer

A **v1 session scope has no `dispatchId`** and therefore does not match a v2 dispatch
reader. This fails *closed*: the chains diverge at the third segment, so the record is not
visible. The alternative — treating a v1 session as a session of its task, and letting any
attempt of that task see it — was rejected because "we cannot prove they are the same"
must resolve to *no*: the cost of a false match is a session transcript injected into a
dispatch it never ran in, and the cost of a false non-match is one record an operator can
see. `tests/unit/memory/record-contract.test.ts` — *"a v1 session scope does NOT match a
v2 dispatch reader, and fails closed"*.

---

## 3. Task delivery, and who owned what

| Task | Owner (sub-agent role) | Deliverable | Files |
| --- | --- | --- | --- |
| M5.1 | `architect` (lead) | Ontology, trust model, scope lattice | `src/memory/ontology.ts` |
| M5.1 | `architect` (lead) | v2 record, v1 read projection, ports | `src/memory/record.ts`, `ports.ts`, `primitives.ts` |
| M5.2 | `subsystem-builder` | Append-only repository, access policy, supersession, tombstones | `src/memory/{in-memory,file}-repository.ts`, `access-policy.ts`, `repository-errors.ts` |
| M5.3 | lead | Legacy migration (both shapes), rollback safety | `src/memory/migration.ts` |
| M5.4 | `security-reviewer` + `subsystem-builder` | Detectors, pipeline, 33-case corpus | `src/memory/redaction/**` |
| M5.5 | lead | Deterministic assembler, manifest, budget, envelope projection | `src/context/{types,assembler}.ts` |
| M5.6 | lead | Propose/accept/reject/supersede + audit events | `src/memory/workflow.ts` |
| M5.7 | lead | Bounded handoffs, dependency results, run summary | `src/memory/summarization.ts` |
| M5.8 | lead | Structured view model, preview, filters | `src/context/tui/memory-view.ts` |
| M5.9 | `independent-reviewer` | Isolation matrix + seven-path egress auditor | `src/context/isolation.ts`, `Docs/implementation-reports/milestone-5-isolation-audit.md` |

**Contract freeze before fan-out.** `ontology.ts`, `record.ts`, `ports.ts`, `primitives.ts`
and `context/types.ts` were written by the lead *before* any sub-agent started, because
the repository, the redaction pipeline, the migration, and the assembler were built in
parallel against them. This is the plans README's "freeze shared contracts first" applied
to code rather than to a document nobody imports.

**Three contract revisions were made during the milestone**, each recorded in the file
that carries it:

1. `mayReadSensitivity` — `prohibited` special-cased out of the rank comparison (§2.2).
2. `MemoryQueryScope.scope` — kind → full scope (§2.3).
3. `MemoryWithholding.kind` — required → **optional**, and genuinely absent when
   `revealsKind` is `false` (see finding **SF-1** in §7).

---

## 4. M5.2 — the repository

Append-only, with one documented exception. `append` and `supersede` only add;
`supersededByMemoryId` is *derived* from an index and injected into the read view only,
and `getRaw` returns stored bytes. `tests/unit/memory/supersession.test.ts` asserts
byte-equality of the pre- and post-supersession raw reads.

`decideTrust` writes `trust`/`trustDecision` in place, which is safe **precisely because
`computeContentHash` excludes those fields** — a decision about a fact does not change the
fact's identity, and a redaction does not change the hash of the thing it redacted. The
durable backend keeps decisions in their own append-only log (`decisions.jsonl`) replayed
on load, so a record's bytes are never rewritten on disk either.

**Ids are derived from content**, `memory.<sha256(salt\0memory\0canonical key)[0..40]>`,
excluding `trust`, `trustDecision`, and `correlationId`. Three consequences, each of which
is a design decision rather than an implementation detail:

- An identical append is a `conflict` (`memory.duplicate_id`).
- Re-running the legacy import is idempotent by construction.
- `correlationId` is excluded so an at-least-once retry does not mint a second record for
  one fact.

**`AppendMemoryInput` has no `memoryId` field**, deliberately. A caller-supplied id is a
caller-supplied *identity*, and identity is what makes re-import idempotent. A caller that
must predict an id — M5.3, which reports ids it wrote — calls
`deriveMemoryId(memoryRecordSourceKey(input))`, the same function the repository uses. That
is an implementation export, not a port method, because a port method that minted ids would
be a second derivation.

**One total order**: `(createdAt asc, memoryId asc)` for records,
`(timestamp asc, memoryId asc)` for withholdings; `limit` applies after ordering. Asserted
against reversed insertion order and against three records sharing one instant.

**No ambient clock.** `new InMemoryMemoryRepository({ now })`. The clock is used *only* to
evaluate expiry; record and tombstone timestamps come from the caller. Asserted by a test
that greps the implementation sources for `Date.now` / `new Date()`.

**Corruption is loud, never a silent drop.** Any unparseable line, schema-invalid record,
duplicate `memoryId`, or dangling trust decision throws `MemoryCorruptStoreError` with the
file and line and leaves the bytes untouched. `MemoryCorruptStoreError` is the *only* place
this subsystem throws; every caller-visible refusal is a `Result`.

---

## 5. M5.3 — migration counts and evidence

Two legacy shapes migrate, because "only for people who already ran the M0 importer"
would leave every other user with no path to M5:

- **v1 records** — the output of the M0 dry-run importer (`memoryRecordSchemaV1`).
- **legacy `memory.json`** — the pre-M0 `{ projectId, decisions[], constraints[], handoffs[] }`
  from the orphan `FileMemoryStore`.

### Counts, from a live run

```
LEGACY memory.json COUNTS: {"decisions":2,"constraints":2,"handoffs":3,"v1Records":0,"total":7,"trustDowngrades":0}
sourceDigest: sha256:78bba3fd60366fa205132e792dd31c80cd36f9e8668973ecfa83ca0dffedbd1e
first record id: memory.2ec440f43d3f93e4addd33a6a3ccac9157450733
first record trust: proposed
accepted-handoff trust: proposed | legacyStatus preserved: accepted
```

### The load-bearing decision: no imported record is `accepted`

The guardrail is explicit — *"Stop if migration cannot distinguish legacy trusted user
content from agent-generated content; default uncertain imports to proposed/review-needed."*
It cannot, and here is the concrete reason:

- `legacyDecisionSchema.agent` is a free-text label. It is `"dev-main"` in the fixture — a
  node label, not a user id, and nothing in the format says a human typed it. The M0
  importer already had to record `{ namespace: "legacy.agent-label" }` to say so.
- `legacyHandoffSchema.status === "accepted"` means *a receiving agent took the handoff*.
  It is an agent-to-agent workflow state. Reading it as "a human accepted a project fact"
  is the exact confusion the trust axis exists to prevent.

So a legacy `accepted` handoff migrates as **`proposed`**, with its status preserved
verbatim in `payload.detail.legacyStatus`. The evidence line above shows both halves at
once: `accepted-handoff trust: proposed | legacyStatus preserved: accepted`.

The same rule applies to v1 records, and the M5.9 review (SF-8) sharpened it in two ways:

- **`accepted` is downgraded for *every* author kind**, not only for a non-`user` one. The stop
  condition is about the **format** — a v1 record never recorded *who* accepted it — so a v1
  acceptance by a `user` author is exactly as unauthenticated as one by a node.
- **`rejected` stays `rejected`.** The first version mapped everything to `proposed`, reasoning
  that nothing could be proven; for a rejection that is a trust **upgrade**, and it re-opened a
  question a human had closed. A migration must never raise a record's trust, whatever the
  direction. Only a *correction* re-opens a rejection, and a correction is a new record.

The single policy is `migratedTrustStateFor` in `src/memory/migration.ts`. An earlier
`migrationTrustDecision` in `record.ts` claimed the opposite rule and was exported but called
from nowhere; the M5.9 review found it (SF-15) and it was **deleted** rather than corrected,
because two exported functions claiming to be one policy is the defect.
(`tests/integration/memory-migration.test.ts`, `describe("SF-15 one trust policy, and it is the
one that runs")`.)

### Rollback safety

A migration is a **plan**: a pure value written nowhere. `applyLegacyMemoryMigration`
requires an explicit `apply: boolean` and takes the plan's own `AppendMemoryInput`s rather
than re-converting the plan's records — a re-conversion would be a second place that knows
how a legacy line becomes a stored record, and the drift would surface as "the plan said 7
records, the store has 6" rather than as an error. After the write, the plan's count is
re-checked against what was appended and a divergence is a `memory.migration_count_mismatch`
refusal, in the code, not only in a test.

Rollback is "do not call apply" before the call, and "the source is still on disk and
unmodified" after it. The migrator never writes to, truncates, or deletes the legacy file —
asserted by reading the file's bytes before and after an applied migration.

**Sensitivity is carried through, never reset.** A v1 record marked `restricted` arrives as
`restricted`, not `public_to_project`: the label is the only access control a v1 file has,
and widening it because the migration created the record would silently widen the audience
of the operator's most careful decision.

---

## 6. M5.4 — the redaction corpus

**33 cases: 18 true positives, 8 false positives, 7 documented near misses. All pass.**

The false-positive and near-miss cases are the deliverable as much as the true positives. A
detector that fires on a git commit sha is a real operational cost, and tuning it away
silently would be dishonest; instead `fp-git-commit-sha`, `fp-content-sha256-digest`,
`nm-postgres-connection-string`, `nm-short-opaque-token`, `nm-value-in-prose` and five
others are pinned in `src/memory/redaction/corpus.ts` as *expected outcomes*, so a
regression in either direction fails a test.

Seeded secrets are **fabricated and assembled from ≥2 fragments**, so a repo-wide grep for
a credential literal returns nothing and CI secret scanners are not trained to ignore the
directory. 13 seeded literals; the leak sweep checks raw, base64, base64url, and
URL-encoded forms of each.

**Honest limits, stated in the module docblock and repeated here** because a redaction
pipeline that overstates itself is worse than none:

1. A **URL-embedded password** (`postgres://user:hunter2@host`) is invisible. Highest-
   consequence gap. Not shipped as a rule because half-remembered URL parsing is its own
   bug class; it needs an owner decision, not a regex.
2. **Human-chosen secrets in prose** are invisible. "the shared password is hunter2" has
   no `=` or `:` to anchor on. Unfixable in principle — which is why `status: "none"`
   must never be read as "this text is clean".
3. **Short opaque tokens** below 32 characters are invisible. A 12-character invite code is
   a real credential.
4. **Truncated PEM blocks** are invisible; the rule requires its `END` armoured line,
   because patching to end-of-input would prohibit any log that helpfully prints a header.
5. **Hashes and commit shas are redacted.** This is the single most common reason a
   redaction pipeline gets switched off; the remedy is a higher minimum length, not a
   narrower pattern.
6. **`sensitiveKeys` fires on nouns**: `"the dispatch token: was not accepted"` redacts
   `was`.

**A residual disclosure, recorded and not fixed:** `RedactionOutcome.matches` carries
`start`/`end`, so a caller can learn the *byte length* of a rejected private key block. The
replacement text shares no token with the input (asserted per token, not per character), so
nothing is reconstructable. This is safe only because `memoryRedactionSchema` has no field
for `matches`, so the outcome is never persisted. **If a future change serializes a whole
`RedactionOutcome` into storage, this becomes live** — recorded as a dependency, not a
resolved issue.

---

## 7. Findings

**The M5.9 independent review returned 21 findings — 1 Blocker, 4 High, 8 Medium, 8 Low — and
refused to sign.** Full table with `file:line` and reproduction in
[`milestone-5-isolation-audit.md`](./milestone-5-isolation-audit.md); per-finding dispositions in
its §A1 addendum. **19 fixed, 2 accepted.** The three that mattered:

### SF-1 (Blocker) — trust was forgeable through a public port method. **FIXED**

`getRaw` (`in-memory-repository.ts`) returned the *live* stored record. A caller could assign
`raw.trust = "accepted"` together with a `user`-shaped `trustDecision`, and `query()` — which
re-reads the store — would then serve a node's proposal as an injectable trusted project fact.
Assigning `raw.payload` rewrote the fact itself, and `verifyMemoryRecord` then returned `false`.
Both were reachable through a public port method, and neither the repository's checks nor the
record schema could see them, because the mutation happened *after* validation.

This defeated the milestone's single load-bearing guarantee, and the M5.9 auditor's own
`repository_query` path could not have caught it: the defect is not a leak *through* a query, it
is a forgery *of* the store.

**Fixed structurally, not by a check.** `getRaw` now returns a deep-frozen structural copy, so
the record that leaves a read is not the record the store holds and the mutation now *throws*.
Regression tests assert the throw, not a result — a fix that merely detected the forgery would
still leave a window between the read and the check.

### SF-4 (High) — a mismatched project pair was a cross-project existence oracle. **FIXED**

`query.projectId` selected the candidate set while `scope.projectId` is what the access policy
compares. A reader of project A who named project B in the query got project B's *records* as
candidates — each refused, each reported as a `project_mismatch` withholding **carrying project
B's `memoryId`**. Naming a project and learning how many memory ids it holds is exactly what
project isolation exists to prevent.

**Fixed by making it a refusal, not a withholding.** `query` now returns
`Result<MemoryQueryResult>` and answers a mismatched pair with `memory.query_project_mismatch`,
*before any candidate is selected*. An empty result was rejected as the fix: an empty result is
what "this project has no matching records" looks like, so a caller bug would have been
indistinguishable from a fact. The refusal is `validation`, deliberately not `policy_denied`,
because it is a caller error and the two must not be conflated in an operator's log.

### SF-2 (High) — `listProject` did no authorization at all. **FIXED**

It returned node-restricted, role-restricted, `restricted`, and `prohibited` bodies with full
content to any caller who could name a project id. It is now `listProjectUnscoped`, and
`listTombstones` is `listTombstonesUnscoped`.

**The rename is the fix.** An export must be able to produce a project archive, and a method that
respected every reader's clearance could not — so it cannot be made safe, only conspicuous. A
caller reaching for "list this project's memory" now finds `query`, which returns records *and*
the withheld reasons, so an omission is explainable.

### Also fixed, and briefly

| ID | Sev | Fix |
| --- | --- | --- |
| SF-3 | High | `applyLegacyMemoryMigration` refuses inputs that are not the plan's own (`memory.migration_inputs_mismatch`), so a plan cannot be redirected into another project. |
| SF-5 | High | `payload.detail` is now depth-1, ≤32 keys, ≤4 KiB per leaf. It was the honest answer to "is there a field a secret could go into?" — and it was yes. |
| SF-6/7 | Med | A `MemoryWriteGuard` port runs before persistence; `MAX_RECORD_CONTENT_CHARACTERS = 8_192` stops a 60 KB transcript becoming a memory record. |
| SF-8/9 | Med | A v1 `rejected` record stays `rejected` (it was being re-opened as `proposed`); a v1 `supersedesMemoryId` is resolved against the corpus instead of dropped. |
| SF-10 | Med | `ContextCandidateSource.memory` carries `memoryKind`; `priorityByMemoryKind` had been keyed on the *inclusion reason*, so the documented knob did nothing. |
| SF-11/12 | Med | The preview's `revealsKind` check was a boolean compared with its own negation and could never fire; the heading prefix is removed and a verified prompt is unobtainable without a digest check. |
| SF-13–19, 21 | Low | Tombstone disclosure, the `ports.ts` docblock that contradicted its own implementation, a dead exported trust policy, a plan that reported `ok: true` while dropping records, an exclusion `kind` that carried an inclusion reason, a token count reported as `byteCount`, a self-disabling audit check, and an unused `NON_REVEALING` set. |
| SF-20 | Low | **ACCEPTED** — a v1 session record is invisible to a v2 dispatch reader. Fails *closed*, and is the correct reading of an under-specified scope. |

### Carried forward, and named as such

1. **`writeGuard` is optional.** A repository built without one has no write-path secret
   detection, and the caller who forgets is the one who leaks. Asserted as a test rather than
   left as prose, but it is a real hole in the default configuration.
2. **Tombstones reloaded from a durable store disclose no kind at all**, even for a public record
   — the deliberate cost of not persisting the record's access-relevant facts. Availability only.
3. **SF-6 and SF-9 are enforced by the lead and the sub-agents after the review**, not before it.
   The review tested the code as it stood; the fixes are verified by 23 new regression tests in
   `tests/unit/memory/audit-regressions.test.ts`, each written so that reverting its fix fails
   it.

---

## 8. M5.5 — determinism evidence

The plan's stop condition is *"Stop if context rendering can differ without a
manifest/digest change."* Three sources of nondeterminism were removed, each named because
"deterministic" without saying *what* used to vary is not a test.

| Source | Removal |
| --- | --- |
| Ordering | fixed category order, then `priority` desc, then `sourceId` asc |
| Budget | `ceil(chars / 4)` — a fixed integer function, never a tokenizer |
| Content | digest taken over the manifest *without* its own `digest` |

A live run:

```
MANIFEST DIGEST: sha256:4baa0e87dc664ddd74ab1ea052b74c84c7c9422a90f6635696db5d0e94f9ba35
ITEMS (in order):
  01:09000:safety:floor.default  safety:floor.default safety_instructions    safety_floor         within_clearance est=8
  02:09100:dispatch:dispatch-1  dispatch:dispatch-1 dispatch_approval      approved_dispatch    within_clearance est=29
  03:09200:m-constraint  m-constraint     project_constraints    active_constraint    within_clearance est=9
  03:09300:m-decision  m-decision       project_constraints    active_decision      within_clearance est=10
  06:09900:run-summary:sum-1  run-summary:sum-1 run_summary            run_summary          within_clearance est=8
EXCLUDED:
  m-ref            sensitivity_above_clearance    revealsKind=false kind=(absent)
  m-secret         prohibited_content             revealsKind=false kind=(absent)
BUDGET: {"maximum":100000,"estimated":64,"unit":"tokens"}
DETERMINISTIC under input reordering: true
```

**Why not a tokenizer.** Token counts are model- and library-version-specific, so a
manifest hashed with one would change digest on a dependency bump — and the whole point of
the digest is that a previously-approved dispatch still verifies. A crude stable estimate
can be wrong about the real number and right every time, which is the trade this wants.

**Rendering cannot drift from the manifest** — enforced by signature, not by review.
`renderContextPrompt(manifest, …)` has no access to a repository, so it is structurally
incapable of producing text the manifest does not describe. The content renderer
`renderContextWithContent` hashes each supplied text and **refuses** with
`context.render_digest_mismatch` if it is not the text the manifest recorded
(`tests/unit/context/determinism.test.ts`, *"REFUSES to render text whose hash is not the
one the manifest recorded"*).

**Determinism is not sameness.** Two destinations produce *different* manifests
(`tests/unit/context/determinism.test.ts`, *"gives DIFFERENT manifests to different
destinations, so determinism is not sameness"*). A determinism guarantee that made every
reader see the same context would be a leak.

### Budget pruning is greedy, and says so

A single forward pass, not a knapsack. The cost: a high-cost item ranked above several
low-cost ones can push all of them out. This is stated in the module docblock *and* pinned
in `tests/unit/context/budget.test.ts` (*"prunes in ranked order, so a set of
equal-priority items is cut from the last"*), so a future change to the algorithm is a
visible diff rather than a silent behaviour change in what agents read.

**If a required item does not fit, the assembly FAILS** with `context.budget_exceeded` and
returns no manifest. Producing a manifest that omits the safety instructions because the
budget was tight is the failure this milestone exists to prevent: the dispatch would then be
approved against a manifest that does not describe what the agent will read.

### A duplicate source is a refusal, not a deduplication

Two candidates for one `sourceId` is refused with `context.duplicate_source` rather than
resolved. Deduplicating would mean picking one of two *different bodies*, and which one
survived would depend on the order the provider returned them in — the same
"rendering can differ without a manifest change" hazard by another route. It is also
unrepresentable: a source cannot be both included and excluded, so a "duplicate" exclusion
for an included source would fail the manifest's own schema.

### The M0 envelope projection

`toDispatchEnvelopeManifest` projects the M5 manifest onto the frozen M0
`{ references, manifestDigest }` shape. Lossy in one direction: exclusions, rendered
hashes, per-item scope, the destination, the policy version and the budget have nowhere to
go. Not lost: **the digest**. `manifestDigest` is the digest of the *full* M5 manifest, not
of the projection, so an approval bound to the M0 shape still fails verification if anything
the operator was shown changed
(`tests/unit/context/envelope-projection.test.ts`, *"a change the M0 shape cannot express
still changes the digest"*).

A `secret_reference_only` item is **dropped** from the reference list. The M0 axis has no
value for "a credential exists here"; mapping it onto `restricted` would put the record
into an envelope a `restricted`-clearance reader could dereference — a widening introduced
purely by the projection.

---

## 9. M5.6 — proposing versus trusting

`memory.propose` has **no trust parameter**. Trust is derived from the author by the
ontology, so the command has no way to say "and make it accepted" — the field does not
exist. The audit event records the trust the record **actually** has, not the one asked
for: an event recording the intent would read as though a session's proposal had been
accepted.

Three layers refuse a non-user trust, in increasing order of strength:

1. The command surface has no way to ask.
2. The workflow refuses with `memory.unauthorized_trust_decision` (`policy_denied`).
3. **The record schema refuses the data.** A record with `trust: "accepted"` and a
   node-authored `trustDecision` does not parse. This is the one that matters: layers 1 and
   2 are code a future caller could route around, and layer 3 is data.

Two further refusals exist because a claim is cheap:

- **`memory.actor_mismatch`** — a command whose named actor differs from the executing
  context is refused, so a node cannot pass `author: { kind: "user" }` and have the record
  claim a human wrote it.
- **`memory.cross_project_command`** — refused before the repository is consulted.

A supersession emits **two** events: the new record, and what it displaced. Without the
second, an audit shows a new record appearing and nothing about what it replaced.

**An audit event never carries content.** No `content`, `payload`, or `text` field exists on
it, asserted by both a field-name check and a search of the serialized event.

---

## 10. M5.7 — bounded handoffs

The guardrail is *"Do not store complete raw transcripts as memory by default."* A handoff
packet has **no field a transcript can go in**, asserted by naming the forbidden fields
(`transcript`, `output`, `messages`, `log`, `body`, `content`) rather than only counting the
declared ones. A summary longer than `MAX_SUMMARY_CHARACTERS` (4 KiB) is **refused, not
truncated** — a silently truncated summary reads as complete.

Artifacts are referenced by **id**, never inlined, and provenance records
`artifact.reference` for each. A failed dispatch's outcome is a `finding`, not a
`run_outcome`: the run is not over, this attempt is, and conflating them would put one
attempt's failure into a run-level summary and make it read as final.

`unresolved` is the field that makes a summary honest — "I did not determine whether the
deploy key rotates" tells the next agent what it must not assume. An **empty** `unresolved`
list is refused, because it is the same data as omitting it and states nothing.

A run summary is capped and **says what it dropped**: `omitted[]` records each result that
did not fit, with `reason: "budget_exceeded"`. A summary that silently drops half a run is
worse than no summary, because the next agent reads it as complete.

---

## 11. M5.9 — the isolation audit

### The seven egress paths

Exported as `MEMORY_EGRESS_PATHS` and cited here, because a leak path not in the list is a
leak path nobody is checking:

```
repository_query, context_manifest, context_exclusion,
rendered_prompt, record_at_rest, audit_event, tui_preview
```

A live audit over a real assembly, with the M5.4 corpus's 13 seeded secrets planted as the
forbidden set:

```
AUDIT: 7/7 paths examined, 0 finding(s) (0 blocker), PASS
  | paths: repository_query,context_manifest,context_exclusion,
          rendered_prompt,record_at_rest,tui_preview,audit_event
```

The auditor reports **which** paths it examined, because "no leaks found" without "out of
seven" is indistinguishable from "no leaks, because nothing was checked". An audit with no
input reports `0/7 paths examined` and is still `passed: true` — the two facts are separate
and the tests assert both.

### The cross-boundary matrix

Ten cases, each asserted for its **exact** withholding reason and its `revealsKind` flag,
against a real repository, with a positive control so the denials are not vacuous:

```
project_mismatch, node_restricted, role_restricted,
sensitivity_above_clearance ×2, prohibited_content,
not_trusted, scope_not_visible, redacted_unavailable, expired
```

`superseded` and `tombstoned` are **deliberately not in the matrix** and are listed in
`ISOLATION_MATRIX_NOTES.viewOnlyReasons`, with a test asserting they are *absent* from the
matrix. Listing them without a case would be a claim the matrix does not back.

**`project_mismatch` is stronger than a withholding.** A foreign record is dropped before
the access policy runs, so it is not a candidate and produces no withholding at all: the
reader learns nothing, not even that an id exists. A withholding would be an answer, and an
answer confirms existence.

### The auditor has been shown to find things

An auditor that has never reported a finding is not evidence. Three tests plant a leak and
require it to be caught: a raw secret in a stored record, a **base64-encoded** secret
(which a raw grep would miss), and a preview claiming an item the manifest excluded. The
base64 test exists because a transport or a log formatter will do exactly that, and a leak
test that only greps the raw form passes on a leak.

`assertNoLeaks` turns a finding into a `policy_denied` / non-retryable refusal, so a caller
cannot audit and then proceed anyway.

### Isolation matrix and the file-backed repository

The M5.9 integration asserts the **file-backed** repository applies the same denials as the
in-memory one, which is the property that matters: the two share one engine
(`MemoryRepositoryEngine`), so a backend cannot disagree about an access decision.

---

## 12. M5.8 — the TUI previews the exact context

The view model is a **structure, not a string**, for the same reason as `src/mesh/tui`: the
gate requires "UI tests show exact included/excluded items and reasons", and `toContain`
cannot distinguish *"the reason is `prohibited_content`"* from *"a line that happens to
mention a prohibited record"*. `lines` is attached as a derived member for the renderer;
the structured fields are what the tests read.

`verifyPreviewMatchesManifest` returns the **list of discrepancies** rather than a boolean,
so a reviewer is told *what* is wrong. The M5.9 auditor calls it, which is what makes "the
preview is the manifest" a runtime check on the seventh egress path rather than a claim.

A sensitive exclusion renders as `sourceId: reason (detail withheld)` and nothing else. The
test passes a *contaminated* exclusion object — one carrying a `kind` and a `scopeKind` —
and asserts the rendered line is byte-identical to the clean one, so a leak through the
render path is impossible even if the object is wrong.

Filtering is pure and lives in the reducer; `recordMatchesFilter` is exported so the reducer
and the view model cannot disagree. Superseded records are hidden by default, because the
active view hides them — and the **correction** is shown, not the stale record.

---

## 13. Completion criteria

| # | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Every record has scope, provenance, trust, sensitivity, retention, and hash metadata | **MET** (v2 records) | `memoryRecordSchemaV2`, `src/memory/record.ts`; `tests/unit/memory/record-contract.test.ts` (55 tests). **Not met for a v1 record** — see below. |
| 2 | Legacy decisions, constraints, and handoffs migrate without content or status loss | **MET** after SF-8, SF-9 | §5 counts; a v1 `rejected` record now stays `rejected` and a v1 `supersedesMemoryId` is resolved against the corpus rather than dropped. |
| 3 | Agents can propose but cannot directly trust project memory | **MET** after SF-1 | §9. The refusal is in the schema, and the store no longer hands out a mutable record. |
| 4 | Supersession preserves history; active-view queries choose the correct record | **MET** | `tests/unit/memory/supersession.test.ts`; byte-equality asserted |
| 5 | Context assembly is deterministic and dispatch approval binds to the manifest digest | **MET** after SF-12 | §8; the manifest digest survives the M0 projection, and a verified prompt is unobtainable without a digest check. |
| 6 | Every included item is explainable; every excluded item has a non-sensitive reason | **MET** after SF-17, SF-19, SF-21 | `ContextExclusion.kind` is derived, `revealsKind` is derived from the ontology, and the auditor no longer skips its own check. |
| 7 | Cross-project, role-restricted, and node-restricted access tests pass | **MET** after SF-1, SF-2, SF-3, SF-4, SF-13 | §11; 10-case matrix, both repositories, and the three previously-uncontrolled read paths. |
| 8 | Seeded secrets never appear in event logs, application logs, context sent to unauthorized nodes, or exported audit fixtures | **MET** after SF-5, SF-6, SF-7 | §6 corpus, §11 auditor across 7/7 paths in 5 encodings, plus a write-path guard and a bounded `detail`. |
| 9 | The TUI previews the exact context before approval | **MET** after SF-11 | §12; `verifyPreviewMatchesManifest` is called by the auditor and its `revealsKind` check can now fire. |
| 10 | *"Stop if context rendering can differ without a manifest/digest change"* | **NOT TRIGGERED** | `renderContextWithContent` refuses on a hash mismatch; one rendering, no heading knob. |
| 11 | *"Stop if migration cannot distinguish legacy content"* | **NOT TRIGGERED** | §5: the format cannot distinguish, so **every** import defaults to `proposed`, which is the prescribed resolution. |
| 12 | *"Do not let an LLM's summary become trusted fact without provenance and acceptance policy"* | **MET** | `system_derived` cannot be promoted even by a user (§2.1) |

**Three verdicts in this table were wrong when first written.** Criteria 3, 7, and 8 were marked
MET before the independent review ran; with `getRaw` handing out the live stored object,
`listProject` performing no authorization, and `payload.detail` accepting a 20 KiB secret, none of
them held. They are now true for the reason claimed, and the correction is recorded here rather
than the claims being re-worded.

**One criterion is not met, and is recorded as not met:**

> *"Every memory record has scope, provenance, trust, sensitivity, retention, and hash
> metadata."*

This is met for every record this milestone writes. It is **not** met for a v1 record
read through `toMemoryRecordView`: a v1 record has no redaction status, no expiry, and no
node/role visibility list, and the projection reports `sourceVersion: 1` rather than
inventing them. Inventing a `redaction: { status: "none" }` for a record that was never
redacted would be a false statement about a security property.

The alternative — refusing to read v1 at all — would make the M0 migration's output
unreadable, which is a worse failure than a projection that says where its data came from.
The projection is pure and the v1 bytes are never rewritten, so *"the file on disk is still
v1"* costs nothing. This is a deliberate, documented scope decision, not an oversight, and
it is the one place where the milestone's own completion criteria are narrower than its
implementation.

---

## 14. Guardrails

| Guardrail | Verdict | Note |
| --- | --- | --- |
| Do not store complete raw transcripts as memory by default | **MET** after SF-7 | §10, plus `MAX_RECORD_CONTENT_CHARACTERS = 8_192` enforced by the schema; a guardrail with no bound is a wish |
| Do not use semantic/vector retrieval until deterministic scoped retrieval is correct | **MET** | no embedding, no similarity, anywhere in `src/memory` or `src/context` |
| Do not let an LLM's summary become trusted fact without provenance and acceptance policy | **MET** | §2.1 |
| Do not mutate prior records to "fix" history | **MET** after SF-1 | append-only, and `getRaw` now returns a frozen copy — "mutate prior records" is a prohibition again rather than an available operation |
| Do not transmit restricted content merely because a target node is inside Tailscale | **MET (vacuously)** | M5 has no transport and nothing transmits. See limitation 9. |
| Stop if context rendering can differ without a manifest/digest change | **NOT TRIGGERED** | §8; one rendering, no heading knob, a verified prompt requires a digest check |
| Stop if migration cannot distinguish legacy content | **NOT TRIGGERED** | §5; resolved by defaulting to `proposed` |
| Global: ESM and `.js` extensions | **MET** | enforced by `tsc` under `"moduleResolution"` used by this project |
| Global: Zod schemas are the source of truth | **MET** | every persisted and transmitted shape is a `z` schema |
| Global: no ambient clock in a store | **MET** | caller-supplied `now`, asserted by a source grep |
| Global: new persistence formats need a version, a migration path, a rollback story, and a corrupt-data test | **MET** | v1/v2 + `planLegacyMemoryMigration` + rollback section + `MemoryCorruptStoreError` test |
| Global: a sub-agent may not release, publish, or deploy | **MET** | no agent ran a publish, release, or credential operation |

---

## 15. Gate evidence

Verbatim, from the commands the plan's gate specifies, **after** the M5.9 remediation:

```
$ bunx tsc -p tsconfig.json --noEmit
(no output)
exit=0

$ bun test tests/unit/memory
 417 pass
 0 fail
 3699 expect() calls
Ran 417 tests across 11 files [171.00ms]

$ bun test tests/unit/context
 96 pass
 0 fail
 325 expect() calls
Ran 96 tests across 5 files [101.00ms]

$ bun test tests/integration/memory-migration.test.ts
 32 pass
 0 fail
 133 expect() calls
Ran 32 tests across 1 file [89.00ms]

$ bun test tests/integration/context-isolation.test.ts
 32 pass
 0 fail
 131 expect() calls
Ran 32 tests across 1 file [66.00ms]

$ bun test
 3201 pass
 4 skip
 0 fail
 23399 expect() calls
Ran 3205 tests across 167 files [13.66s]

$ bun run build
$ rm -rf dist && tsc -p tsconfig.build.json
BUILD=0

$ git diff --check
DIFF=0

$ ./scripts/m0-contract-signoff.sh
RESULT: GREEN - contract drifted but a recorded re-approval covers it.
        Carried-forward findings are NOT closed by this; see F-01..F-07.
M0 EXIT=0
```

The 4 skips are pre-existing and unrelated (real tmux, real OpenCode agent, and two
node-sqlite-driver cases) — the same 4 that skipped on the M4 gate.

**Test growth**: 2629 → **3201** (+572). Four pre-existing tests were **changed**, in every case
because the old expectation *encoded* an audit defect as the specification — enumerated in the
[audit's §A3](./milestone-5-isolation-audit.md). No assertion was weakened.

### Baseline comparison

| | M4 gate | M5 gate | Δ |
| --- | --- | --- | --- |
| `bun test` pass | 2629 | 3201 | +572 |
| `bun test` fail | 0 | 0 | 0 |
| M0 contract digest | `83f9a5e0…ee0c1` | `83f9a5e0…ee0c1` | **unchanged** |
| Independent review findings | — | 21 (1 Blocker, 4 High) | all dispositioned |

---

## 16. Known limitations and risks accepted

1. **The `writeGuard` is optional** (§7). A repository constructed without one has no write-path
   secret detection, and the caller who forgets is the one who leaks. It is optional because a
   mandatory guard would mean the store owns a detector set. **M6 must not build a repository
   without one.**
2. **Redaction is best-effort** and says so (§6). `status: "none"` must never be read as
   "clean". A URL-embedded password and a secret in prose are both invisible.
3. **A `prohibited` outcome leaks the length of the rejected span** through
   `RedactionOutcome.matches`. Safe only while nothing persists an outcome; recorded as a
   dependency (§6).
4. **Tombstones reloaded from a durable store disclose no kind**, even for a public record — the
   deliberate cost of not persisting the deleted record's access-relevant facts (§7).
5. **A v1 session-scoped record is invisible to a v2 dispatch reader** (SF-20, accepted). The
   chains diverge at the leaf and there is no id to reconcile them. Availability, not
   confidentiality.
6. **Tombstone scope is unknown.** `MemoryTombstone` carries no scope, so a run- or task-scoped
   query cannot place a tombstone and gets none. Correct (a deletion is project-level) but it
   means a run-scoped reader is told nothing about a deletion inside its run.
7. **`listProjectUnscoped` returns insertion order**, not the query order. It is the raw
   migration/export view, not a `query`, and its name and docblock say so.
8. **No `fsync`.** `appendFile` can leave a partial trailing line on a hard crash. That is the
   case the loader refuses loudly by design; recovery is an operator decision (truncate or
   repair), not a silent drop.
9. **Nothing in M5 is wired to anything** (audit suspicion S-1, confirmed). No module outside
   `src/memory` and `src/context` imports the repository, the workflow, or the assembler. The
   isolation guarantees therefore rest on callers that do not exist yet, and the two clearance
   values the whole policy turns on are **asserted by the caller with no binding in M5 to an
   authenticated node identity**. This is why the Tailscale guardrail is vacuously held: nothing
   transmits. A library with a complete test suite and no production call site is a deliberate
   milestone boundary, but this report should not be read as claiming otherwise.
10. **The trust model trusts an honest `Actor` at the call site** (audit suspicion S-2,
    accepted). Any caller holding a `user`-shaped actor satisfies both the workflow's
    actor-match check and `decideTrust`. The design intends the type system to be the gate, and
    the M5.9 Blocker was found precisely by assuming a caller *would* misbehave — so this
    assumption is load-bearing and untested against a real adversary. **M6 must bind the actor
    to an authenticated identity before any of this is load-bearing.**
11. **Semantic retrieval is deliberately absent** (guardrail). Scoped deterministic retrieval is
    correct and measurable now, which is the precondition the guardrail sets.

---

## 17. Prerequisites handed to Milestone 6

**Contracts frozen and importable**

- `src/memory/index.ts` and `src/context/index.ts` are the public surfaces. The dependency
  edge is one-way (`src/context` → `src/memory`) and
  `tests/unit/context/barrel.test.ts` asserts it by source scan, because an import cycle
  would make the determinism guarantee unfalsifiable.
- `MemoryQueryScope` requires a **full** scope. Any M6 caller must supply the reader's
  identity chain; a `MemoryScopeKind` is no longer accepted, by design.
- `query` returns a `Result` and **refuses** a mismatched project pair. Any M6 caller must
  handle the refusal branch; it is not an empty result.
- `listProject` does not exist. It is `listProjectUnscoped` and it performs **no
  authorization** — migration and export only.
- `AppendMemoryInput` has **no `memoryId`**. Use the returned id, or
  `deriveMemoryId(memoryRecordSourceKey(input))` to predict it.
- `MemoryWithholding.kind` is **optional** and absent for non-revealing reasons. Any M6
  renderer must branch on `revealsKind`, not on `kind` being present.
- `toDispatchEnvelopeManifest(manifest, texts)` is a **breaking signature change**: it
  requires the verified rendered texts and returns a `Result`.

**Work M6 must pick up**

| Item | Why it is M6's |
| --- | --- |
| Run the redaction pipeline over legacy imports | SF-2; M6 owns pre-approval and the policy surface |
| Test the `secret_reference_only` inclusion path | SF-3 |
| Re-derive supersession links after a tombstone | limitation 7; M6 owns workflows and recovery |
| Wire the assembler into the dispatcher | limitation 9; M6 owns automation and approval |
| Decide the URL-embedded-password rule | an owner decision, not a regex |

**Invariants M6 must not break**

- A non-`user` cannot reach `accepted`, at any layer, and the store never hands out a mutable
  record (`getRaw` returns a deep-frozen structural copy — this is what closed the Blocker).
- A `query` and its scope must name the same project; the mismatch is a refusal, not an empty
  result.
- Rendering is refused on a manifest-digest mismatch, and there is exactly one rendering of a
  manifest.
- An assembly that does not fit its budget returns **no manifest**.
- Records are append-only; corrections supersede.
- A migration is a plan, `apply` is explicit, and a plan with an unreadable entry is **refused**
  rather than partially applied.
- A repository without a `writeGuard` has no write-path secret detection.

**Carried to M6 with an owner**

| Item | Why it is M6's |
| --- | --- |
| Bind `MemoryQueryScope.actor` and `destination.clearance` to an authenticated node identity | Limitations 9 and 10; until then the Tailscale guardrail is vacuous |
| Supply a `writeGuard` when composing a repository | Limitation 1 |
| Wire the assembler into the dispatcher behind `renderVerifiedContextPrompt` | Limitation 9; audit §A5 |
| Decide the URL-embedded-password redaction rule | An owner decision, not a regex |
| Add a corpus case for what a `secret_reference_only` reference may contain | the `reference_only` path is thinner than `prohibited` |

---

## 18. Sign-off

| Role | Status |
| --- | --- |
| Milestone lead / root agent | **Signed** — this report |
| `independent-reviewer` (M5.9) | **Did not sign** at review time: *"PASS WITH FINDINGS, I would not sign M5.9 off."* 21 findings dispositioned in the [audit's §A1](./milestone-5-isolation-audit.md). **The reviewer has not re-verified the remediation**, and this report does not claim they have. |
| `security-reviewer` (M5.4) | Signed for the redaction pipeline; its 15 stated detection limitations are §6 and are **not** a claim of complete coverage |
| Implementers (M5.2, M5.4) | Handoffs received with changed files, verbatim command output, and stated limitations. Limitation 6 became SF-2, limitation 1 became the scope-contract revision — both acted on centrally. |
| Fix agents (M5.9 remediation) | Four sub-agents, disjoint file ownership, each required to prove its fix fails when reverted. Three did so by reverting and observing the failure count. |

**Verdict: PASS after remediation, with 19 of 21 audit findings fixed and 2 accepted.**

The two that most deserve a reader's attention are **limitation 1** (the `writeGuard` is
optional, so a repository built without one has no write-path secret detection) and **limitation
9** (nothing in M5 is on a live path yet — the clearance the whole policy trusts is
caller-asserted, with nothing binding it to an authenticated node).
