# Milestone 5 — M5.9 Independent Isolation and Leakage Audit

Reviewer: `independent-reviewer` (adversarial, read-only on `src/` and `tests/`)
Date: 2026-09-30
Specification: `Docs/implementation-plans/milestone-5-memory-and-context.md`
Scope reviewed: `src/memory/**`, `src/context/**`, `tests/unit/memory/**`, `tests/unit/context/**`,
`tests/integration/memory-migration.test.ts`, `tests/integration/context-isolation.test.ts`,
and the frozen M0 contract as consumed (`src/orchestration/schemas.ts`,
`src/orchestration/legacy/migration.ts` — read, never proposed for edit except where a
re-approval is called for explicitly).

All throwaway proof tests live in
`/private/var/folders/w0/x5k33p5n7n7fn_4dlfdxfjj00000gn/T/opencode/m5-audit/` and were run with
`bun test <path>`. No file under the repository was created, edited, or deleted by this review
except this report.

---

## 1. Findings

| ID | Severity | file:line | Description | Proved by |
| --- | --- | --- | --- | --- |
| SF-1 | **Blocker** | `src/memory/in-memory-repository.ts:570` | `getRaw` returns the *live* stored record object; a caller that assigns `raw.trust = "accepted"` plus a `user`-shaped `trustDecision` makes `query()` serve the record as an injectable trusted project fact, and assigning `raw.payload` rewrites the fact so `verifyMemoryRecord` returns `false` — trust forged and append-only violated through a public port method. | executed: `SF-1 getRaw returns the live stored object, so a caller can forge trust > mutating the getRaw result changes what query() hands a reader`; `… > the mutation is visible to a fresh get() authorization too, and survives nothing on disk` |
| SF-2 | **High** | `src/memory/in-memory-repository.ts:846` (port: `src/memory/ports.ts:258`) | `listProject(projectId)` performs **no authorization at all** and returns every record in the project with full content — node-restricted, role-restricted, `restricted`, and `prohibited` bodies included — to any caller that can name the project id. | executed: `SF-2 listProject performs no authorization at all > hands a caller the raw content of node-restricted, role-restricted, and prohibited records` |
| SF-3 | **High** | `src/memory/migration.ts:497` | `applyLegacyMemoryMigration` takes the append inputs as a caller-supplied argument and never checks them against `plan.inputs` or `plan.projectId`; a caller can redirect an entire plan into a different project and the function still reports `ok: true, appended: N`. | executed: `SF-3 applyLegacyMemoryMigration writes whatever inputs the caller hands it > writes records into a DIFFERENT project than the plan names, and reports success` |
| SF-4 | **High** | `src/memory/in-memory-repository.ts:623-635`, `:690-700` | `query.projectId` is never reconciled with `scope.projectId`: `liveCandidates` filters on `query.projectId` while the policy compares against `scope.projectId`, so a project-A reader who names project-B in the query receives a `project_mismatch` withholding **carrying project-B's `memoryId`** — a cross-project existence oracle. The same query against a foreign tombstone returns `{ memoryId, kind: "handoff", reason: "project_mismatch", revealsKind: false }` — `kind` populated next to `revealsKind: false`, the exact shape `toWithholding` (`src/memory/access-policy.ts:288-301`) exists to make unrepresentable, and the shape `auditMemoryContext`'s own `repository_query` path would flag. | executed: `SF-12 query.projectId and scope.projectId are never reconciled > a reader of project A can enumerate the memoryIds of project B by naming B in the query`; `… > a foreign tombstone is reported with revealsKind:false AND its kind populated` |
| SF-5 | **High** | `src/memory/record.ts:217` | `payload.detail` is `z.record(z.string(), z.unknown())` — unbounded, unredacted, and never scanned by anything. A seeded secret written into `detail` is stored with `redaction.status: "none"` and served by `query()`. This is the answer to "is there any field in `memoryRecordSchemaV2` a secret value could go": `payload.content` (advisory redaction, SF-6) and `payload.detail` (no shape at all). | executed: `SF-22 payload.detail is an unbounded, unredacted, unscanned secret slot > a seeded secret survives in detail with redaction.status 'none' and is served by query()` |
| SF-6 | Med | `src/memory/in-memory-repository.ts:415-471` | Nothing on the write path runs the redaction pipeline. `AppendMemoryInput.redaction` is caller-asserted, so a live `AKIA…` key in `content` is stored and served with `redaction.status: "none"`. The Redaction Design's "redaction runs before persistence when input is prohibited" has no enforcement point in the repository. | executed: `SF-10 append never runs the redaction pipeline: a secret value can be stored verbatim > a record whose content is a live AWS key is stored and served`; `SF-24 a record that redacts to 'none' is still a record > the pipeline is advisory: appending unredacted content succeeds` |
| SF-7 | Med | `src/memory/workflow.ts:212-251`, `src/memory/primitives.ts:26` | The "do not store complete raw transcripts as memory by default" guardrail is enforced **only** on `handoffPacketSchema` (`MAX_SUMMARY_CHARACTERS` = 4 096). `repository.append` and `workflow.memory.propose` accept `content` up to `LARGE_TEXT_MAX` (65 536 chars) with no size check, so an agent can store a 60 KB transcript as a project-scoped `finding` and a single user accept makes it injectable into every context. | executed: `SF-23 the transcript guardrail is not enforced on the write path > an agent can append a 60 KB 'finding' that is a complete transcript` |
| SF-8 | Med | `src/memory/migration.ts:248`, `:412` | A v1 record with `trustState: "rejected"` is migrated as `proposed` — a trust **upgrade**, not a downgrade — and the plan counts it in `counts.trustDowngrades`. A fact a human explicitly rejected is re-opened for acceptance. | executed: `SF-4 a v1 'rejected' record is migrated as 'proposed' — a trust upgrade > re-opens a closed question for acceptance` |
| SF-9 | Med | `src/memory/migration.ts:413-438` | A v1 record's `supersedesMemoryId` is dropped entirely — not carried onto the migrated record and not preserved in `detail`. The correction chain of a legacy corpus is silently severed. | executed: `SF-16 a v1 record's supersedesMemoryId is dropped by the migration > the correction link survives in neither the record nor the detail` |
| SF-10 | Med | `src/context/assembler.ts:114-134` | `resolvePriority` looks up `policy.priorityByMemoryKind` with `kindOfCandidate(candidate)`, which returns `candidate.reason` — an *inclusion reason*, not a memory kind. `ContextCandidate` carries no memory kind at all, so the documented policy knob keyed by kind (`{ handoff: 999 }`) is inert, while an undocumented key that happens to match an inclusion reason (`{ handoff_packet: 999 }`) silently changes ordering. | executed: `SF-6 priorityByMemoryKind is keyed on the INCLUSION REASON, not the memory kind > an operator's priorityByMemoryKind: { handoff: 999 } has no effect at all`; `… > …but priorityByMemoryKind: { handoff_packet: 999 } DOES take effect` |
| SF-11 | Med | `src/context/tui/memory-view.ts:490` | `verifyPreviewMatchesManifest` tests `source.revealsKind === item.withheldDetail`, and `buildPreview` sets `withheldDetail: !entry.revealsKind` — a comparison of a boolean with its own negation, which is never true. The one drift check the TUI-preview criterion rests on is dead code; an inverted `withheldDetail` is reported as consistent. | executed: `SF-8 verifyPreviewMatchesManifest's revealsKind check can never fire > an inverted withheldDetail is not reported` |
| SF-12 | Med | `src/context/assembler.ts:419-505` | Two renderers produce two different texts for one manifest: `renderContextPrompt` accepts a `headingPrefix` option that `renderContextWithContent` hardcodes as `"##"`, and `manifest.renderedDigest` is optional, so `verifyRenderedDigest` is opt-in and a caller can hold a rendered prompt whose whole-prompt digest was never checked. Per-item `renderedHash` checks do bind the *content*, so this is a rendering-integrity finding, not a content leak. | executed: `SF-9 the two renderers produce different text for the same manifest, unverified > renderContextPrompt allows a custom heading prefix; renderContextWithContent hardcodes '##'` |
| SF-13 | Low | `src/memory/in-memory-repository.ts:623-635` | The tombstone withholding path bypasses the access policy and always populates `kind` with `revealsKind: true`, so a `prohibited`-sensitivity record reveals nothing while live but reveals its kind (`handoff`) to every reader of the project once it is privacy-deleted. | executed: `SF-11 a tombstoned PROHIBITED record reports its kind to every reader of the project > the withholding reveals what the live record's withholding refuses to` |
| SF-14 | Low | `src/memory/ports.ts:129-133` vs `src/memory/access-policy.ts:193` vs `src/context/isolation.ts:544` | The **frozen** port's docblock says `project_mismatch` has `revealsKind: true`; the implementation returns `false`; `ISOLATION_CASES[0].expectedRevealsKind` is `true` and is never asserted because `tests/integration/context-isolation.test.ts:132-138` returns early for `expectedCandidate: false`. The contract and its own matrix disagree about a security-relevant flag and no test covers the disagreement. Fixing either side needs a re-approval of `src/memory/ports.ts`. | by reading (`src/memory/ports.ts:129-133`, `src/memory/access-policy.ts:192-194`, `src/context/isolation.ts:538-546`, `tests/integration/context-isolation.test.ts:132-138`) |
| SF-15 | Low | `src/memory/record.ts:561-584` | `migrationTrustDecision` is exported and documented as *the* trust policy for legacy imports ("a v1 `accepted` record authored by a user is migrated as `accepted`") but is called from nowhere; the running policy is `trust: "proposed"` for everything at `src/memory/migration.ts:248`. The behaviour that runs is the safe one; the documentation is the defect. | by reading + grep (`migrationTrustDecision` appears only at `src/memory/record.ts:561` and in a comment at `src/memory/in-memory-repository.ts:422`) |
| SF-16 | Low | `src/memory/migration.ts:381-452` | `planV1MemoryMigration` returns `ok: true` while entries it could not read are dropped, with `severity: "error"` diagnostics buried inside `plan.value.diagnostics`. A caller that checks only `ok` loses those records silently. | executed: `SF-5 an unreadable v1 entry is dropped and the plan still returns ok:true > ok is true while an error-severity diagnostic is buried in the plan` |
| SF-17 | Low | `src/context/assembler.ts:195-208` | The assembler's `exclusion()` sets the exclusion's `kind` field to `candidate.reason` — an inclusion reason, not a record kind. A `budget_exceeded` exclusion reports `kind: "handoff_packet"`. Not a leak (the real kind is never disclosed), but the field name lies to every consumer including the TUI's `renderExclusion`. | executed: `SF-19 a non-sensitive exclusion's 'kind' field carries the INCLUSION REASON > budget_exceeded reports kind: 'active_decision', not the memory kind` |
| SF-18 | Low | `src/context/assembler.ts:522-538` | `toDispatchEnvelopeManifest` puts `estimatedCost` into the frozen M0 `byteCount` field. With a `tokens` budget that is `ceil(chars / 4)`, not bytes — a 400-character body is reported as `byteCount: 100`. | executed: `SF-18 toDispatchEnvelopeManifest reports a TOKEN count as byteCount > byteCount is ceil(chars/4) whenever the budget unit is tokens` |
| SF-19 | Low | `src/context/isolation.ts:312-323` | The rendered-prompt check is disabled whenever `clearedSourceIds` is empty or omitted and no manifest is supplied, and the auditor still returns `passed: true` for a prompt naming an arbitrary unknown source. | executed: `SF-21 the audit's rendered-prompt check is skipped when clearedSourceIds is empty > an empty clearedSourceIds disables the only check that names a source` |
| SF-20 | Low | `src/memory/record.ts:111-132`, `:156-165` | A v1 `session`-scoped record has no `dispatchId`, so its identity chain is `[run, task, session]` while a v2 `dispatch` reader's is `[run, task, dispatch]`; the chains diverge at index 2 and a dispatch reader cannot see a pre-M5 record from its own session. Fails closed (availability, not confidentiality). | executed: `SF-20 scopeContains: a v1 session-scoped record is invisible to its own dispatch > the v1 session scope has no dispatchId and the chain diverges` |
| SF-21 | Low | `src/context/assembler.ts:211-217` | `NON_REVEALING` — the set of exclusion reasons that must not name a kind — is declared and exported but never read. The invariant is maintained only by each call site remembering to pass `false`. The `contextExclusionSchema` superRefine (`src/context/types.ts:163-167`) is the only thing that actually enforces it, and it fires after the fact. | by reading + grep (`NON_REVEALING` appears only at `src/context/assembler.ts:211` and `:547`) |

### Suspicions (not executed — no executable path)

- **S-1 — nothing in Milestone 5 is wired to anything.** `grep` across `src/` finds no module outside
  `src/memory` and `src/context` that imports the repository, the workflow, `assembleContext`,
  `renderContextWithContent`, or `toDispatchEnvelopeManifest`. Every isolation guarantee in this
  milestone therefore rests on callers that do not exist yet, and the two clearance values the whole
  policy turns on — `MemoryQueryScope.clearance` and `request.destination.clearance` — are asserted
  by the caller with **no binding in M5 to an authenticated node identity**. I cannot execute a leak
  through this because there is no transport to leak through. This is the honest statement of the
  Tailscale guardrail's status inside M5: vacuously held, and only because nothing transmits.
- **S-2 — the trust model trusts the honesty of the `Actor` value at the call site.** Any caller
  holding a `user`-shaped actor satisfies both `assertActorMatches` (`src/memory/workflow.ts:150`)
  and `decideTrustInternal`'s `kind === "user"` gate (`src/memory/in-memory-repository.ts:729`).
  The design intends the type system to be the gate, so this is not a defect — but it is the single
  assumption every "an agent cannot mint a trusted fact" claim in this milestone rests on, and M5
  contains no test that a `user` actor cannot be synthesised by a node.

### Hypotheses tested and REFUTED (checked; the code holds)

- **R-1 — a v1 `accepted` record is never migrated as `accepted`.** `planV1MemoryMigration` writes
  `trust: "proposed"` unconditionally (`src/memory/migration.ts:248`); executed:
  `SF-4 … > no v1 record is ever migrated as accepted, whatever its trust state or author` returns
  `["proposed", "proposed", "proposed"]` for a user-authored `accepted`, a node-authored `accepted`,
  and a `proposed`. The guardrail holds.
- **R-2 — the redaction pipeline's `matches` array never reaches a persisted structure.**
  `memoryRedactionSchema` (`src/memory/record.ts:228-250`) carries `status`, `ruleIds`,
  `derivedFromMemoryId`, `redactedSpanCount` and nothing else. Executed:
  `SF-15 the redaction 'matches' array never reaches a persisted structure > a redacted record's
  on-disk form has rule ids and a count, no spans`.
- **R-3 — determinism.** Executed: `SF-17 … > 24 permutations of the same candidates produce one
  manifest digest` (one distinct digest across 24 of 120 permutations, spanning all six
  categories and a priority tie), `… > the same records inserted in opposite orders produce the same
  manifest`, and `… > renderContextWithContent is a pure function of the manifest`. No `Date`/
  clock, no `Map`/`Set` order, no floating point, and no locale-sensitive comparison affects the
  manifest or the rendered text. `orderingKey` is monotone in priority across the whole representable
  range (executed: `SF-7 (refutation) orderingKey is monotone in priority > no priority in range
  inverts the manifest order`).
- **R-4 — no diagnostic, `ContractError`, or refusal carries record content or a seeded secret.**
  Executed: `SF-14 no ContractError message carries a seeded secret > an invalid append's refusal
  names the record, not the body`; `… > handoffToMemoryRecord's refusal does not echo the packet`.
  `secretReferenceSchema` is `.strict()` with no `value` field, so a secret value has no slot in a
  `secretReferences` entry (executed: `… > proposeMemoryRecord refuses a secretReference carrying a
  'value'`).
- **R-5 — an oversized legacy entry is refused cleanly, not thrown.** Executed:
  `SF-13 (refutation) … > a 200 KB legacy decision is skipped with a diagnostic, and the planner
  still returns a Result` and `… > an oversized legacy decision in memory.json does the same`.
- **R-6 — trust cannot be forged through the schema, `buildMemoryRecord`, `trustDecision`, or
  `decideTrust`.** By reading plus the gate suite: a node/session author with
  `trust: "accepted"` cannot satisfy the schema's accepted-requires-a-decision rule
  (`src/memory/record.ts:329-345`); a `trustDecision` naming anyone but the author is refused by
  `buildRecord` (`src/memory/in-memory-repository.ts:425-434`); `decideTrust` re-validates
  `decidedBy.kind === "user"` and the transition table before writing
  (`src/memory/in-memory-repository.ts:729-736`). **The one hole is SF-1**, which bypasses all
  three by mutating the stored object rather than passing a bad value.
- **R-7 — the eleven withholding reasons.** Ten of the eleven are reachable and correct by
  `ScopeLatticeAccessPolicy.decide`; `superseded` and `tombstoned` are the two view-only reasons and
  are stated as such rather than claimed (`src/context/isolation.ts:643-649`, asserted by
  `tests/integration/context-isolation.test.ts:105-117`). `project_mismatch` is unreachable through
  a correctly-formed query — the two leaks that do reach it are **SF-4**; and the tombstone path's
  handling of it is **SF-13**.

---

## 2. Completion Criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Every memory record has scope, provenance, trust, sensitivity, retention, and hash metadata. | **MET** | `src/memory/record.ts:262-311` — all six are required fields of `memoryRecordSchemaV2`; `.strict()` and `.superRefine` at `:312-372`. `computeContentHash` (`:642-648`) covers kind + scope + payload. |
| Legacy decisions, constraints, and handoffs migrate without content or status loss. | **PARTIALLY MET** | Content and legacy status are preserved (`src/memory/migration.ts:283-351`, `:428-433`), and v1 sensitivity is carried conservatively (`:436`). **Loss found:** a v1 `supersedesMemoryId` is dropped entirely (**SF-9**), and a v1 `rejected` record arrives as `proposed` (**SF-8**). |
| Agents can propose but cannot directly trust project memory. | **NOT MET** | The schema, `trustDecision`-author identity rule, `decideTrust`, and `assertMayDecide` all hold (**R-6**), but `getRaw` hands out the live stored object and a caller can set `trust: "accepted"` on it (**SF-1**), after which `query()` serves it as an injectable trusted fact. |
| Supersession preserves history and active-view queries choose the correct record. | **MET** | `src/memory/in-memory-repository.ts:345-354`, `:402-404`, `:702-709` — the back-pointer is derived, never written back; the returned superseded record is the same object. Guarded by `tests/unit/memory/supersession.test.ts`. |
| Context assembly is deterministic and dispatch approval binds to the manifest digest. | **MET** | `src/context/assembler.ts:234-386` is pure in `(request, candidates, policy)`; `toDispatchEnvelopeManifest` (`:522-538`) sets `manifestDigest = manifest.digest`. Verified by execution (**R-3**). One rendering-integrity gap: **SF-12**. |
| Every included item is explainable; every excluded item has a non-sensitive reason. | **MET** | `src/context/types.ts:148-167` (`ContextExclusion` has no content/summary/hash field and refuses a `kind` beside `revealsKind: false`); `src/memory/access-policy.ts:282-301` (absent, not flagged); `src/context/assembler.ts:195-208`. Two of the three consumers of the `kind` field are mislabelled (**SF-17**) and one verification of it is dead (**SF-11**), but no exclusion leaks. |
| Cross-project, role-restricted, and node-restricted access tests pass. | **PARTIALLY MET** | The suite passes (`32 pass 0 fail`) and covers all nine access reasons (`src/context/isolation.ts:538-625`). But the same boundaries are crossable: `listProject` (**SF-2**), `query.projectId` ≠ `scope.projectId` (**SF-4**), and `getRaw` (**SF-1**). |
| Seeded secrets never appear in event logs, application logs, context sent to unauthorized nodes, or exported audit fixtures. | **PARTIALLY MET** | The corpus and the auditor hold for the paths they examine (**R-2**, **R-4**), and `MemoryAuditEvent` (`src/memory/workflow.ts:66-80`) carries no content field. But nothing on the write path redacts (**SF-6**) and `payload.detail` is an unscannable slot (**SF-5**), so a secret can reach storage and then any context. |
| The TUI previews the exact context before approval. | **PARTIALLY MET** | `buildPreview` (`src/context/tui/memory-view.ts:416-462`) is built from the manifest verbatim, and `renderExclusion` (`:318-324`) honours `revealsKind`. But `verifyPreviewMatchesManifest`'s `revealsKind` check is a tautology and cannot fire (**SF-11**), and the preview's `kind` field carries an inclusion reason (**SF-17**). |

---

## 3. Guardrails

| Guardrail | Status | Evidence |
| --- | --- | --- |
| Do not store complete raw transcripts as memory by default. | **NOT MET** | The bound exists only on `handoffPacketSchema` (`src/memory/summarization.ts:63`, `:130`). `repository.append` and `workflow.memory.propose` accept 65 536 characters and store them as a project-scoped finding. **SF-7**. |
| Do not use semantic/vector retrieval until deterministic scoped retrieval is correct and measurable. | **MET** | No embedding, vector, or similarity code exists in `src/memory` or `src/context`; retrieval is `(kind, trust, scope identity chain, clearance, node/role allow-list)` only (`src/memory/access-policy.ts:189-263`). |
| Do not let an LLM's summary become trusted fact without provenance and acceptance policy. | **MET** | `initialTrustFor` (`src/memory/ontology.ts:287-297`) makes only `user`-authored `decision`/`constraint`/`user_correction` born `accepted`; everything else is `proposed`. `system_derived` has no outgoing transition (`src/memory/ontology.ts:195-196`). M5.7 summaries are authored by whatever actor the caller names and are born `proposed` (`src/memory/summarization.ts:180-204`). |
| Do not mutate prior records to "fix" history. | **NOT MET** | Supersession and `decideTrust` are correct append-only operations (`src/memory/in-memory-repository.ts:551-566`, `:960-970`). But `getRaw` exposes the live stored object, so "mutate prior records" is not a prohibition — it is an available operation. **SF-1**. |
| Do not transmit restricted content merely because a target node is inside Tailscale. | **MET (vacuously)** | M5 contains no transport, no serialisation to the wire, and no Tailscale-awareness of any kind. Nothing transmits. The caveat is **S-1**: the clearance the policy trusts is asserted by a caller that M5 does not bind to an authenticated node, and the two unrestricted read paths (**SF-2**, **SF-4**) would hand a caller everything regardless of any Tailscale check. |
| Stop if context rendering can differ without a manifest/digest change. | **PARTIALLY MET** | `renderContextWithContent` verifies every item's `renderedHash` against the manifest before emitting (`src/context/assembler.ts:482-491`), and a mismatch is a refusal, not a substitution. The residual drift: the heading prefix is not bound (`renderContextPrompt` is parameterised, `renderContextWithContent` is not) and `manifest.renderedDigest` is optional, so the whole-prompt digest check is opt-in. **SF-12**. |
| Stop if migration cannot distinguish legacy trusted user content from agent-generated content; default uncertain imports to proposed/review-needed. | **MET** | Every imported record is `proposed` (`src/memory/migration.ts:248`), a legacy handoff's `accepted` is preserved as *data* in `detail.legacyStatus` and not read as trust (`:340-347`), and a free-text `agent` label is recorded as `legacy.agent-label` provenance (`:294`). Verified: no v1 record of any trust state or author kind migrates as `accepted` (**R-1**). |

---

## 4. Disposition

**PASS WITH FINDINGS.**

The milestone's design is sound and its two hardest properties hold under test: context assembly
is genuinely deterministic across 24 candidate permutations, two repository insertion orders, and
two `Map` construction orders, and no v1 record of any trust state or author kind migrates as
`accepted`. The redaction pipeline is structurally incapable of returning matched text, and the
`matches` array provably never reaches a persisted structure. The one schema-level trust forgery I
tried — a node author with `trust: "accepted"`, a `trustDecision` in someone else's name, a direct
`decideTrust` call — was refused by three independent checks.

It is not a PASS, because the load-bearing guarantees are bypassable through paths the milestone's
own audit never examines. `getRaw` hands out the live stored record and a caller forges trust through
it (SF-1, Blocker). `listProject` performs no authorization and returns `prohibited` bodies to
anyone who can name a project (SF-2). `query.projectId` is never reconciled with `scope.projectId`,
giving a cross-project existence oracle and a `revealsKind: false` withholding with its `kind`
populated anyway (SF-4). The two migration functions lose a legacy supersession chain and upgrade a
legacy rejection (SF-8, SF-9). The transcript guardrail is enforced only on the one path that was
not the risk (SF-7).

I would not sign M5.9 off on the strength of `tests/integration/context-isolation.test.ts` passing:
its `ISOLATION_CASES` matrix holds a *correct* pair of `(query.projectId, scope.projectId)` values
by construction, which is precisely the pair whose mismatch produces SF-4, and its
`project_mismatch` case returns before asserting `expectedRevealsKind` (SF-14). The auditor that
was supposed to catch the leakage examines six of seven declared paths and has no input for the
seventh.

---

## 5. Verbatim command output

### `bunx tsc -p tsconfig.json --noEmit`

```
$ bunx tsc -p tsconfig.json --noEmit
(no output)
```

Exit status 0. Clean.

### `bun test tests/unit/memory`

```
(pass) the corpus policy is the shipped policy > a shipped-policy redacted outcome still carries no seeded secret [0.62ms]

 387 pass
 0 fail
 3603 expect() calls
Ran 387 tests across 10 files. [117.00ms]
```

### `bun test tests/unit/context`

```
(pass) M5.5 rendering cannot differ from the manifest > a refused render is a refusal, not a manifest with substituted content [0.16ms]

 72 pass
 0 fail
 217 expect() calls
Ran 72 tests across 5 files. [64.00ms]
```

> Note on run-to-run variance observed during this review: an **earlier** invocation of
> `bun test tests/unit/context` in the same session reported
> `1 fail` —
> `(fail) M5 the milestone surface is reachable through its barrels > the memory barrel exports the
> ontology, the record, and the ports`, failing on
> `expect(typeof memory.memoryRecordSchemaV2).toBe("function")` at
> `tests/unit/context/barrel.test.ts:47` (a Zod v4 schema is an object, not a function). The file on
> disk at the time of this write already carries the corrected assertion
> (`expect(typeof memory.memoryRecordSchemaV2).toBe("object")` plus a `.parse` check, at
> `tests/unit/context/barrel.test.ts:50-51`), and re-runs pass. This was a race with a concurrent
> edit to the implementing session, not a defect in the milestone as it now stands. Similarly
> `context-isolation.test.ts` grew from 31 tests / 125 expects to 32 / 131 between two invocations.
> The tree was moving while this audit ran; all numbers above are from the final, consistent state.

### `bun test tests/integration/memory-migration.test.ts`

```
(pass) M5.3 a real legacy file on disk round-trips > reads a hand-formatted on-disk file and leaves it byte-identical [0.98ms]

 22 pass
 0 fail
 87 expect() calls
Ran 22 tests across 1 file. [58.00ms]
```

### `bun test tests/integration/context-isolation.test.ts`

```
(pass) M5.9 the audit's own refusal is shaped like every other refusal > a non-retryable policy_denied, as a leak must be [0.02ms]

 32 pass
 0 fail
 131 expect() calls
Ran 32 tests across 1 file. [51.00ms]
```

### `./scripts/m0-contract-signoff.sh`

```
[4/4] Contract surface diff
       src/orchestration/schemas.ts              | 284 ++++++++++++++++-
       src/orchestration/transitions.ts          | 506 ++++++++++++++++++++++++++++++++++++++++
       src/orchestration/types.ts                |  15 +-
       tests/contracts/examples/approval.v1.json  |   1 +
       tests/contracts/examples/command.v1.json   |   1 +
       tests/contracts/examples/run.v1.json       |   1 +
       tests/contracts/examples/session.v1.json   |   3 +-
       tests/contracts/examples/task.v1.json      |   1 +
       8 files changed, 788 insertions(+), 24 deletions(-)

      Frozen example changes (the whole M0 freeze):
      +  "state": "approved",
      +      "state": "approved",
      +  "paused": false,
      -  "state": "working",
      +  "lifecycleState": "running",
      +  "observedState": "working",
      +  "failurePolicy": "block",
------------------------------------------------------------
RESULT: GREEN - contract drifted but a recorded re-approval covers it.
        Carried-forward findings are NOT closed by this; see F-01..F-07.
```

The M0 contract is GREEN under its recorded re-approval. Nothing in M5 edits
`src/orchestration/schemas.ts` or `src/orchestration/legacy/migration.ts`; both are read-only
imports, which `tests/unit/context/barrel.test.ts` asserts by source scan. **SF-14** is the only
finding that would require touching a frozen file, and it says so.

### Throwaway proof tests (outside the repository)

```
$ bun test /private/var/.../m5-audit/sf-01-getraw-mutation.test.ts    3 pass  0 fail
$ bun test /private/var/.../m5-audit/sf-03-migration.test.ts          4 pass  0 fail
$ bun test /private/var/.../m5-audit/sf-06-context.test.ts            6 pass  0 fail
$ bun test /private/var/.../m5-audit/sf-12-crossproject-query.test.ts 2 pass  0 fail
$ bun test /private/var/.../m5-audit/sf-13-migration-errors.test.ts   7 pass  0 fail
$ bun test /private/var/.../m5-audit/sf-16-determinism.test.ts        4 pass  1 fail
$ bun test /private/var/.../m5-audit/sf-19-misc.test.ts               4 pass  0 fail
$ bun test /private/var/.../m5-audit/sf-22-secrets.test.ts            3 pass  0 fail
```

The single failure is the assertion that *proves* **SF-9** (the migrated record's
`supersedesMemoryId` is `undefined`). Every other assertion in every throwaway file passes,
including the ones written to *refute* a hypothesis (**R-2**, **R-3**, **R-5**).

---

# Addendum — Milestone lead's remediation

*Appended after the review above was completed. **Sections 1–4 are the reviewer's work and are
unaltered**; the reviewer's disposition — **PASS WITH FINDINGS, "I would not sign M5.9 off"** —
stands as their judgment of the code as it was at review time. This addendum records what was
changed afterwards, and it does not claim the reviewer re-verified any of it.*

**Date:** 2026-09-30
**Author:** milestone lead / root agent

## A1. Disposition of all 21 findings

The lead independently reproduced the Blocker and three of the four Highs against the code as it
stood (`getRaw` returning the live object, `listProject` returning restricted bodies,
`applyLegacyMemoryMigration` accepting foreign inputs, `payload.detail` accepting a 20 KiB
secret) before acting on any of them. All 21 were then assigned; 19 are fixed, 2 are accepted.

| ID | Sev | Disposition | Fix, or why accepted |
| --- | --- | --- | --- |
| SF-1 | Blocker | **FIXED** | `getRaw` now returns a deep-frozen structural copy (`in-memory-repository.ts`). The mutation now *throws* — `TypeError: Attempted to assign to readonly property` — so this is closed structurally, not by a check. Regression: `tests/unit/memory/audit-regressions.test.ts` → *"refuses to let a caller assign a forged trust state onto the returned record"* and *"…rewrite the fact itself"*. |
| SF-2 | High | **FIXED** | `listProject` → `listProjectUnscoped`, and `listTombstones` → `listTombstonesUnscoped`. The rename is the fix: a caller reaching for "list this project's memory" now finds `query`, which returns withheld reasons. Results are deep-frozen copies. Regression: *"is reachable only under a name that says it skips authorization"*. |
| SF-3 | High | **FIXED** | `applyLegacyMemoryMigration` now digests `options.inputs` and refuses on a mismatch (`memory.migration_inputs_mismatch`), plus an explicit per-input project check. Regression: *"REFUSES inputs that are not the plan's own, so a plan cannot be redirected"* and *"…even in one field"*. |
| SF-4 | High | **FIXED** | `query` now returns `Result<MemoryQueryResult>` and refuses a mismatched project pair with `memory.query_project_mismatch` (`validation`, not `policy_denied`). Chosen over an empty result because an empty result is exactly what "this project has no records" looks like — a caller bug indistinguishable from a fact. Regression: *"refuses the mismatch rather than reporting the other project's records"* and *"…so a caller cannot count records by reading refusals"*. |
| SF-5 | High | **FIXED** | `payload.detail` is now `memoryDetailSchema`: ≤32 keys, depth-1 scalar leaves or arrays of ≤32 scalars, each string ≤4 KiB. `detail` is no longer an answer to "is there a field a secret could go?". Regression: *"refuses a detail value that is not JSON-safe data"*. One caller adapted: `handoffToMemoryRecord` now writes `fromActorLabel: "session:s-1"` instead of the `Actor` object. |
| SF-6 | Med | **FIXED** | New `MemoryWriteGuard` port, run in `appendInternal` before the record is built. A guard **refuses**; it never rewrites, because a rewrite would change the content hash behind the caller's back. Regression composes the **real** M5.4 pipeline, not a stub: *"REFUSES an append whose content holds a live secret"*. |
| SF-7 | Med | **FIXED** | `MAX_RECORD_CONTENT_CHARACTERS = 8_192` in `record.ts`, enforced by the schema. Regression: *"refuses a record body large enough to be a transcript"* and *"…still accepts a body at the bound"*. |
| SF-8 | Med | **FIXED** | `migratedTrustFor` maps `rejected → rejected`. The original mapped everything to `proposed`, which re-opened a human-closed question. Regression: *"a v1 'rejected' record is NOT re-opened as 'proposed' for acceptance"*. |
| SF-9 | Med | **FIXED** | `planV1MemoryMigration` resolves a v1 `supersedesMemoryId` against the corpus and carries the resulting M5 link, preserving the legacy ids in `detail` and `sourceReferences`. Resolution is two-pass, because a target may appear later in the array. An unresolvable link is **reported**, not dropped silently. Regression: *"a v1 record's supersedesMemoryId is carried onto the migrated record"*. |
| SF-10 | Med | **FIXED** | `ContextCandidateSource.memory` gained `memoryKind`; `resolvePriority` uses `memoryKindOf`. Regression: `tests/unit/context/budget.test.ts` asserts a real kind takes effect and an inclusion reason does not. |
| SF-11 | Med | **FIXED** | The tautology is replaced by a comparison of the preview's *claim* against the manifest's truth, plus a second check that a `revealsKind: false` exclusion carries no `kind` at all. Regression: *"reports an INVERTED withheldDetail, and names the source"*. |
| SF-12 | Med | **FIXED** | `headingPrefix` removed; both renderers go through one `composeContext`. `renderVerifiedContextPrompt` refuses with `context.rendered_digest_missing` when the manifest records no whole-prompt digest, so a **verified** prompt is unobtainable without a check. Regression: *"the two renderers produce BYTE-IDENTICAL text for one manifest"*. |
| SF-13 | Low | **FIXED** | The tombstone path now consults the *same* policy via a probe, with the access-relevant facts captured at deletion time in memory only. `MemoryTombstone` is **unchanged**, so `ports.ts` and `file-repository.ts` needed no edit. Regression: 6 tests, 5 of which fail if the fix is reverted. |
| SF-14 | Low | **FIXED** | The **contract** was wrong, not the implementation: `ports.ts` now states `project_mismatch` is `revealsKind: false`, and `ISOLATION_CASES[0].expectedRevealsKind` is `false` to match. `src/memory/ports.ts` is M5's own file, so no M0 re-approval was needed. |
| SF-15 | Low | **FIXED** | The exported `migrationTrustDecision` is **deleted**, not corrected — two exported functions claiming to be one policy *is* the defect. The single policy is `migratedTrustStateFor` in `migration.ts`, and the stale comment in `in-memory-repository.ts` was corrected. |
| SF-16 | Low | **FIXED** | Error-severity diagnostics now **fail the plan** (`memory.migration_incomplete`) via one `finishPlan()` choke point both planners route through, plus a write-path guard placed *before* the `apply` gate. Chosen over a `canCommit: false` flag because a flag is one more field a caller can forget. Two existing tests were changed because their names documented the defect as intended behaviour — see A3. |
| SF-17 | Low | **FIXED** | `exclusionKindOf` returns the real memory kind, or the source discriminant for a non-memory candidate. The `ContextExclusion.kind` docblock in `types.ts` was corrected to say it holds two vocabularies. |
| SF-18 | Low | **FIXED** | `toDispatchEnvelopeManifest` now takes the rendered texts and reports real `Buffer.byteLength`, and returns a `Result` that refuses when a text is missing or does not match `renderedHash`. `byteCount` is required inside the frozen M0 schema, so omission was not available. |
| SF-19 | Low | **FIXED** | The `cleared.size > 0` guard is gone. With no ground truth the auditor now emits a **Medium `structure` finding** saying the check could not run, so "I could not check" can no longer be reported as "I checked and it was fine". |
| SF-20 | Low | **ACCEPTED** | Fails *closed* (availability, not confidentiality), and is the correct reading of an under-specified scope. Regression: *"a v1 session-scoped record is invisible to its own dispatch, and it fails closed"*. Carried forward as a known limitation. |
| SF-21 | Low | **FIXED** | `NON_REVEALING` is now **derived** from `SENSITIVE_EXCLUSION_REASONS` via `revealsKindForReason`, and the boolean is removed from every `exclusion()` call site. Regression: *"adding a reason to the ontology set makes it non-revealing HERE, with no edit to the assembler"*. |

**Suspicion S-1** (nothing in M5 is wired to anything; clearance is caller-asserted with no binding
to an authenticated node) is **confirmed and accepted** — it is recorded as limitation 9 in
`milestone-5-completion.md` and is the reason the Tailscale guardrail is vacuously held. **S-2**
(the trust model trusts an honest `Actor` at the call site) is **accepted** as a type-system
assumption, now stated in the M6 prerequisites.

## A2. What the review changed about the milestone's own claims

The review was right to refuse to sign, and three of its findings contradicted statements this
lead had made in `milestone-5-completion.md` as written:

- §13 claimed *"Agents can propose but cannot directly trust project memory — **MET**"*. With
  `getRaw` handing out the live object, that was **NOT MET**.
- §14 claimed the guardrail *"Do not mutate prior records to fix history — **MET**"*. `getRaw`
  made "mutate prior records" an available operation rather than a prohibition.
- §13 claimed *"Every memory record has … metadata — **MET**"*, and §8 claimed the seven-path
  audit was complete. The audit's own `repository_query` path could not have caught SF-1,
  because SF-1 is not a leak *through* the query — it is a forgery of the store.

All three are now true for the reason originally claimed, and the completion report has been
corrected rather than the claims being re-worded.

## A3. Existing tests that were changed, and why

Recorded because changing a test to make a fix pass is the easiest way to turn a review into
nothing. Four were changed, and in every case the old expectation **encoded the defect**:

1. *"records an unreadable entry as a diagnostic and migrates the readable ones"* → renamed
   *"REFUSES the plan when an unreadable entry"*. The old name documented a partial corpus as
   intended behaviour; that **is** SF-16.
2. *"refuses a v1 record belonging to a different project rather than importing it"* — old
   expectation `ok: true` with 0 records. "I migrated nothing, and that is a success" is the same
   silent loss with one filter removed.
3. *"returns nothing to a reader from another project and says only that"* → rewritten as *"REFUSES
   a query whose project disagrees with the scope, and reveals nothing"*. The old test asserted
   a `project_mismatch` withholding **carrying the foreign `memoryId`** — it encoded SF-4 as the
   specification.
4. *"reports byteCount from the item's estimated cost"* → replaced. `expect(byteCount).toBe(item.
   estimatedCost)` **was** SF-18: it asserted a token estimate was the correct byte count. The
   replacement asserts `byteCount === 400` *and* `estimatedCost === 100`, so the two can never be
   confused again.

No assertion was weakened anywhere.

## A4. Gate after remediation

```
$ bunx tsc -p tsconfig.json --noEmit      exit 0
$ bun test tests/unit/memory             417 pass  0 fail   (11 files)
$ bun test tests/unit/context             96 pass  0 fail   (5 files)
$ bun test tests/integration/memory-migration.test.ts     32 pass  0 fail
$ bun test tests/integration/context-isolation.test.ts     32 pass  0 fail
$ bun test                              3201 pass  4 skip  0 fail  (167 files)
$ bun run build                          exit 0
$ git diff --check                       exit 0
$ ./scripts/m0-contract-signoff.sh        exit 0   (digest 83f9a5e0…ee0c1, unchanged)
```

`tests/unit/memory/audit-regressions.test.ts` (23 tests) is the new file: one describe block per
fixed finding, each test written so that **reverting its fix fails it**. Three of the fixes were
verified by the implementing sub-agents by reverting them and observing the failure count.

## A5. What this addendum does not claim

- The reviewer has **not** re-verified any of this. Their disposition stands.
- **SF-6's guard is optional.** A repository constructed without a `writeGuard` has no
  write-path secret detection, and the caller who forgets is the one who leaks. This is asserted
  as a test rather than left as prose, but it is a real hole in the default configuration and
  M6 must not forget it.
- **SF-13's fix is process-local.** A tombstone reloaded from a durable store discloses no kind
  at all, even for a public record — the deliberate cost of not persisting the access-relevant
  facts. Availability only, never confidentiality.
- `toDispatchEnvelopeManifest` and `query` are **breaking signature changes**. Nothing in `src/`
  called either (S-1), so nothing else broke, but both callers' obligations changed.
