/**
 * M5.2 — the access policy, tested against the promise the milestone makes about
 * exclusions.
 *
 * The plan's completion criteria say: "Every included item is explainable; every
 * excluded item has a non-sensitive reason." The second half is the dangerous
 * half, because a *reason* is still a disclosure. A context manifest that
 * records "excluded: prohibited — the deploy key" has leaked the thing the
 * prohibition protects, and it has done so in a format that looks like an
 * audit feature. So these tests assert two separate things for every denial:
 *
 * 1. the reason is right, and
 * 2. the denial identifies the record by id alone — never by kind, content,
 *    summary, or hash of content.
 *
 * The second is checked by serializing the withholding and asserting that the
 * record's own text does not appear in it, and by asserting `revealsKind` is
 * false exactly where the ontology says it must be. `revealsKind` is the flag
 * the ports' docblock says is "the only thing a manifest exclusion is allowed to
 * echo", so it is treated here as a security boundary rather than as metadata.
 */

import { describe, expect, it } from "vitest"

import {
  EMPTY_MEMORY_ACCESS_STATE,
  ScopeLatticeAccessPolicy,
  createMemoryAccessPolicy,
  isExpired,
  isRecordVisibleToReader,
  toWithholding,
  type MemoryAccessState,
} from "../../../src/memory/access-policy.js"
import { MEMORY_WITHHOLDING_REASONS, type MemoryQueryScope, type MemoryWithholdingReason } from "../../../src/memory/ports.js"
import { digestJson } from "../../../src/orchestration/digest.js"
import {
  memoryRecordSchemaV1,
  proposeMemoryRecord,
  toMemoryRecordView,
  type MemoryRecordV2,
} from "../../../src/memory/record.js"
import type { MemoryKind, MemoryScopeKind, Sensitivity } from "../../../src/memory/ontology.js"
import {
  FIXED_NOW,
  PROJECT_A,
  T_INSTANT,
  T_PLUS_THREE,
  T_PLUS_TWO,
  dispatchScope,
  nodeActor,
  projectScope,
  reader,
  runScope,
  scopeOf,
  sessionScope,
  systemActor,
  taskScope,
  userActor,
} from "./fixtures.js"

const PROHIBITED_CONTENT = "-----BEGIN PRIVATE KEY----- mno-secret-material -----END PRIVATE KEY-----"

/**
 * A stored record, projected to the view the policy actually reads.
 *
 * `proposeMemoryRecord` is the record's own constructor, so a fixture here goes
 * through the same schema a real append does. A hand-written `MemoryRecordView`
 * would be able to hold a combination the store can never produce — a
 * `prohibited` record with no redaction decision, say — and the policy would
 * then be tested against a fiction.
 */
interface RecordOverrides {
  readonly projectId?: string
  readonly kind?: MemoryKind
  readonly scope?: MemoryRecordV2["scope"]
  readonly author?: MemoryRecordV2["author"]
  readonly createdAt?: string
  readonly content?: string
  readonly sensitivity?: Sensitivity
  readonly expiresAt?: string
  readonly visibleToNodeIds?: readonly string[]
  readonly visibleToRoleIds?: readonly string[]
  readonly secretReferences?: Parameters<typeof proposeMemoryRecord>[0]["secretReferences"]
  readonly redaction?: Parameters<typeof proposeMemoryRecord>[0]["redaction"]
  readonly trust?: MemoryRecordV2["trust"]
  readonly trustDecision?: MemoryRecordV2["trustDecision"]
}

const MEMORY_ID = "memory.1111111111111111111111111111111111111111"

function viewOf(overrides: RecordOverrides = {}) {
  const trust = overrides.trust ?? "accepted"
  return toMemoryRecordView(
    proposeMemoryRecord({
      memoryId: MEMORY_ID,
      projectId: overrides.projectId ?? PROJECT_A,
      kind: overrides.kind ?? "decision",
      scope: overrides.scope ?? projectScope(),
      author: overrides.author ?? userActor(),
      createdAt: overrides.createdAt ?? T_INSTANT,
      content: overrides.content ?? "A standing decision.",
      ...(overrides.sensitivity === undefined ? {} : { sensitivity: overrides.sensitivity }),
      ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
      ...(overrides.visibleToNodeIds === undefined ? {} : { visibleToNodeIds: [...overrides.visibleToNodeIds] }),
      ...(overrides.visibleToRoleIds === undefined ? {} : { visibleToRoleIds: [...overrides.visibleToRoleIds] }),
      ...(overrides.secretReferences === undefined ? {} : { secretReferences: overrides.secretReferences }),
      ...(overrides.redaction === undefined ? {} : { redaction: overrides.redaction }),
      trust,
      // A `proposed` record legitimately has no decision; an `accepted` one must.
      ...(trust === "accepted"
        ? { trustDecision: overrides.trustDecision ?? { decidedBy: userActor(), decidedAt: T_INSTANT } }
        : overrides.trustDecision === undefined
          ? {}
          : { trustDecision: overrides.trustDecision }),
    }),
  )
}

function policyFor(state: Partial<MemoryAccessState> = {}, options: { includeSuperseded?: boolean; includeExpired?: boolean } = {}) {
  return createMemoryAccessPolicy({ state: { ...EMPTY_MEMORY_ACCESS_STATE, ...state }, ...options })
}

function decide(
  overrides: RecordOverrides,
  readerScope: MemoryQueryScope = reader(),
  state: Partial<MemoryAccessState> = {},
  now: string = FIXED_NOW,
) {
  return policyFor(state).decide(viewOf(overrides), readerScope, now)
}

describe("ScopeLatticeAccessPolicy: the allow path", () => {
  it("allows a trusted, in-clearance, unrestricted record in scope", () => {
    const decision = decide({})

    expect(decision).toEqual({ allowed: true, reason: "allowed", revealsKind: true })
  })

  it("explains an allowing decision as a stable string", () => {
    const policy = policyFor()

    expect(policy.explain(policy.decide(viewOf({}), reader(), FIXED_NOW))).toBe("allowed")
    expect(policy.explain({ allowed: false, reason: "not_trusted", revealsKind: true })).toBe("withheld:not_trusted")
  })
})

describe("ScopeLatticeAccessPolicy: every denial has its own reason", () => {
  const cases: readonly {
    name: string
    reason: MemoryWithholdingReason
    revealsKind: boolean
    run: () => ReturnType<typeof decide>
  }[] = [
    {
      name: "a reader from another project",
      reason: "project_mismatch",
      revealsKind: false,
      run: () => decide({}, reader({ projectId: "project-beta" })),
    },
    {
      name: "a record whose content was deleted",
      reason: "tombstoned",
      revealsKind: true,
      run: () => decide({}, reader(), { isTombstoned: () => true }),
    },
    {
      name: "prohibited content",
      reason: "prohibited_content",
      revealsKind: false,
      run: () => decide({ content: PROHIBITED_CONTENT, sensitivity: "prohibited", redaction: { status: "prohibited", ruleIds: ["secret.private-key"] } }),
    },
    {
      name: "content the redaction pipeline classified as must-not-store",
      reason: "redacted_unavailable",
      revealsKind: false,
      run: () => decide({ redaction: { status: "prohibited", ruleIds: ["secret.private-key"] } }),
    },
    {
      name: "a record outside the reader's own run",
      reason: "scope_not_visible",
      revealsKind: true,
      run: () => decide({ scope: runScope("run-other") }, reader({ scope: runScope("run-1") })),
    },
    {
      name: "content above the reader's clearance",
      reason: "sensitivity_above_clearance",
      revealsKind: false,
      run: () => decide(
        { sensitivity: "secret_reference_only", secretReferences: [{ reference: "op://vault/prod/deploy", summary: "The deploy credential" }] },
        reader({ clearance: "restricted" }),
      ),
    },
    {
      name: "a node that is not on the allow-list",
      reason: "node_restricted",
      revealsKind: false,
      run: () => decide({ visibleToNodeIds: ["node-alpha"] }, reader({ nodeId: "node-bravo" })),
    },
    {
      name: "a role that is not on the allow-list",
      reason: "role_restricted",
      revealsKind: false,
      run: () => decide({ visibleToRoleIds: ["role-lead"] }, reader({ roleId: "role-intern" })),
    },
    {
      name: "a record that was never accepted",
      reason: "not_trusted",
      revealsKind: true,
      run: () => decide({ trust: "proposed", author: nodeActor(), kind: "finding" }),
    },
    {
      name: "a record that was explicitly rejected",
      reason: "not_trusted",
      revealsKind: true,
      run: () => decide({ trust: "rejected", author: nodeActor(), kind: "finding" }),
    },
    {
      name: "a system-derived record",
      reason: "not_trusted",
      revealsKind: true,
      run: () => decide({ trust: "system_derived", author: systemActor(), kind: "summary" }),
    },
    {
      name: "a superseded record",
      reason: "superseded",
      revealsKind: true,
      run: () => decide({}, reader(), { isSuperseded: () => true }),
    },
    {
      name: "an expired record",
      reason: "expired",
      revealsKind: true,
      // The reference time is the caller's, so this case supplies a later one:
      // a policy that read the machine's clock could not be tested here at all.
      run: () => decide({ expiresAt: T_PLUS_TWO }, reader(), {}, T_PLUS_THREE),
    },
  ]

  for (const testCase of cases) {
    it(`withholds ${testCase.name} as ${testCase.reason}`, () => {
      const decision = testCase.run()

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe(testCase.reason)
      expect(decision.revealsKind).toBe(testCase.revealsKind)
    })
  }

  it("only ever produces a reason the contract enumerates", () => {
    for (const testCase of cases) {
      expect([...MEMORY_WITHHOLDING_REASONS]).toContain(testCase.run().reason)
    }
  })
})

describe("ScopeLatticeAccessPolicy: a prohibited record is never identifiable by its content", () => {
  it("marks a prohibited withholding revealsKind: false and carries no content", () => {
    const view = viewOf({
      content: PROHIBITED_CONTENT,
      sensitivity: "prohibited",
      redaction: { status: "prohibited", ruleIds: ["secret.private-key"] },
    })
    const decision = policyFor().decide(view, reader(), FIXED_NOW)
    const withholding = toWithholding(view, decision)

    expect(withholding.reason).toBe("prohibited_content")
    expect(withholding.revealsKind).toBe(false)
    expect(withholding.memoryId).toBe(view.memoryId)
  })

  it("serializes a prohibited withholding without any of the record's identifying text", () => {
    const view = viewOf({
      content: PROHIBITED_CONTENT,
      sensitivity: "prohibited",
      redaction: { status: "prohibited", ruleIds: ["secret.private-key"] },
    })
    const serialized = JSON.stringify(toWithholding(view, policyFor().decide(view, reader(), FIXED_NOW)))

    expect(serialized).not.toContain("PRIVATE KEY")
    expect(serialized).not.toContain("mno-secret-material")
    expect(serialized).not.toContain(view.content)
    expect(serialized).not.toContain(view.contentHash)
    expect(serialized).not.toContain(view.payload.content)
  })

  it("keeps the same promise for a record the redaction pipeline refused to store", () => {
    const view = viewOf({ content: PROHIBITED_CONTENT, redaction: { status: "prohibited" } })
    const decision = policyFor().decide(view, reader(), FIXED_NOW)

    expect(decision).toEqual({ allowed: false, reason: "redacted_unavailable", revealsKind: false })
  })

  it("withholds prohibited content from a reader holding the highest clearance", () => {
    // `mayReadSensitivity` already ranks `prohibited` above every clearance, but
    // the policy must not depend on that ranking for the one case where the
    // ranking is not the reason.
    const view = viewOf({
      content: PROHIBITED_CONTENT,
      sensitivity: "prohibited",
      redaction: { status: "prohibited" },
    })

    for (const clearance of ["public_to_project", "restricted", "secret_reference_only", "prohibited"] as const) {
      expect(policyFor().decide(view, reader({ clearance }), FIXED_NOW)).toEqual({
        allowed: false,
        reason: "prohibited_content",
        revealsKind: false,
      })
    }
  })

  it("does not reveal a prohibited record's project to a foreign reader either", () => {
    const view = viewOf({
      content: PROHIBITED_CONTENT,
      sensitivity: "prohibited",
      redaction: { status: "prohibited" },
    })

    expect(policyFor().decide(view, reader({ projectId: "project-beta" }), FIXED_NOW)).toEqual({
      allowed: false,
      reason: "project_mismatch",
      revealsKind: false,
    })
  })

  it("refuses to build a withholding from an allowing decision", () => {
    expect(() =>
      toWithholding({ memoryId: "memory.1", kind: "decision" }, { allowed: true, reason: "allowed", revealsKind: true }),
    ).toThrow(/withholding/)
  })
})

describe("ScopeLatticeAccessPolicy: the scope lattice", () => {
  it("lets a reader see a standing fact and its own history, and nothing else", () => {
    // All five records live in the same run/task/dispatch chain, so the only
    // variable is where in that chain the record and the reader sit.
    const expectations: readonly [MemoryScopeKind, MemoryScopeKind, boolean][] = [
      // [record scope, reader scope, visible]
      ["project", "project", true],
      ["run", "project", true],
      ["task", "project", true],
      ["dispatch", "project", true],
      ["session", "project", true],
      // A standing fact constrains the reader below it: a project-wide decision
      // is not a secret from a session that has to obey it.
      ["project", "run", true],
      ["run", "run", true],
      ["run", "task", true],
      ["task", "task", true],
      ["task", "session", true],
      // And the reader's own history is its own.
      ["session", "task", true],
      ["dispatch", "session", true],
      ["session", "session", true],
    ]

    for (const [recordScope, readerScope, visible] of expectations) {
      const decision = policyFor().decide(viewOf({ scope: scopeOf(recordScope) }), reader({ scope: scopeOf(readerScope) }), FIXED_NOW)
      expect([recordScope, readerScope, decision.allowed]).toEqual([recordScope, readerScope, visible])
    }
  })

  it("separates two runs that share a scope kind", () => {
    // This is the case a kind-only comparison gets wrong, and it gets it wrong
    // silently: both records are `run` kind, so the check returns true for both
    // and the reader is handed another run's findings.
    const runOne = policyFor().decide(viewOf({ scope: runScope("run-1") }), reader({ scope: runScope("run-1") }), FIXED_NOW)
    const runTwo = policyFor().decide(viewOf({ scope: runScope("run-2") }), reader({ scope: runScope("run-1") }), FIXED_NOW)
    const siblingTask = policyFor().decide(
      viewOf({ scope: sessionScope("run-1", "task-2", "dispatch-9", "session-9") }),
      reader({ scope: sessionScope() }),
      FIXED_NOW,
    )

    expect(runOne.allowed).toBe(true)
    expect(runTwo.reason).toBe("scope_not_visible")
    expect(siblingTask.reason).toBe("scope_not_visible")
  })

  it("answers the lattice question through the frozen record helper", () => {
    expect(isRecordVisibleToReader(sessionScope(), projectScope())).toBe(true)
    expect(isRecordVisibleToReader(projectScope(), sessionScope())).toBe(true)
    expect(isRecordVisibleToReader(runScope("run-2"), runScope("run-1"))).toBe(false)
    // A v1 view scope, which has no `dispatchId`, is still a lattice member. Its
    // chain stops at the task, because inventing a dispatch id would put the
    // record in an attempt it was never observed in — so it is visible to a task
    // or broader reader, and withheld from a session reader whose chain carries
    // a dispatch the record cannot confirm. The record has to be a real v1 one:
    // a v2 record cannot be built with that scope at all.
    const v1Session = toMemoryRecordView(
      memoryRecordSchemaV1.parse({
        schemaVersion: 1,
        memoryId: "memory.2222222222222222222222222222222222222222",
        projectId: PROJECT_A,
        kind: "finding",
        content: "A finding from a version-1 record.",
        contentDigest: digestJson("A finding from a version-1 record."),
        scope: { kind: "session", runId: "run-1", taskId: "task-1", sessionId: "session-1" },
        author: { kind: "user", userId: "user-alice" },
        createdAt: T_INSTANT,
        sourceReferences: [],
        trustState: "accepted",
        sensitivity: "internal",
        retention: "run",
      }),
    )
    expect(v1Session.sourceVersion).toBe(1)
    expect(isRecordVisibleToReader(v1Session.scope, taskScope())).toBe(true)
    expect(isRecordVisibleToReader(v1Session.scope, runScope("run-1"))).toBe(true)
    expect(isRecordVisibleToReader(v1Session.scope, runScope("run-2"))).toBe(false)
    expect(isRecordVisibleToReader(v1Session.scope, sessionScope())).toBe(false)
    expect(policyFor().decide(v1Session, reader({ scope: sessionScope() }), FIXED_NOW).reason).toBe("scope_not_visible")
  })

  it("withholds a record from a reader in a different run, whatever the depth", () => {
    for (const recordScope of ["run", "task", "dispatch", "session"] as const) {
      const other = { ...scopeOf(recordScope) } as Record<string, string> & { kind: MemoryScopeKind }
      const decision = policyFor().decide(
        viewOf({ scope: { ...other, runId: "run-other" } as never }),
        reader({ scope: sessionScope() }),
        FIXED_NOW,
      )
      expect([recordScope, decision.reason]).toEqual([recordScope, "scope_not_visible"])
    }
  })
})

describe("ScopeLatticeAccessPolicy: expiry", () => {
  it("treats expiry as an inclusive boundary and only when the record has one", () => {
    expect(isExpired(viewOf({}), FIXED_NOW)).toBe(false)
    expect(isExpired(viewOf({ expiresAt: T_PLUS_TWO }), T_INSTANT)).toBe(false)
    expect(isExpired(viewOf({ expiresAt: T_PLUS_TWO }), T_PLUS_TWO)).toBe(true)
    expect(isExpired(viewOf({ expiresAt: T_PLUS_TWO }), T_PLUS_THREE)).toBe(true)
  })

  it("reads the reference time from its argument, never from the machine", () => {
    const view = viewOf({ expiresAt: T_PLUS_TWO })

    expect(policyFor().decide(view, reader(), T_INSTANT).allowed).toBe(true)
    expect(policyFor().decide(view, reader(), T_PLUS_TWO).reason).toBe("expired")
    expect(policyFor({ }, { includeExpired: true }).decide(view, reader(), T_PLUS_THREE).allowed).toBe(true)
  })
})

describe("ScopeLatticeAccessPolicy: the view switches", () => {
  it("defaults both switches to off, so the active view is the default", () => {
    const state: MemoryAccessState = { ...EMPTY_MEMORY_ACCESS_STATE, isSuperseded: () => true }
    const view = viewOf({ expiresAt: T_PLUS_TWO })

    const policy = new ScopeLatticeAccessPolicy({ state })

    expect(policy.decide(view, reader(), T_PLUS_THREE).reason).toBe("superseded")
  })

  it("carries the store's state into a per-query copy", () => {
    const base = policyFor({ isTombstoned: () => true })

    expect(base.forQuery({ includeSuperseded: true }).decide(viewOf({}), reader(), FIXED_NOW).reason).toBe("tombstoned")
  })
})

describe("ScopeLatticeAccessPolicy: the decision order is stable", () => {
  it("reports isolation before anything the record says about itself", () => {
    // A record that is prohibited, untrusted, node-restricted, and out of scope
    // must be reported as the foreign-project case, because every other answer
    // is a fact about a record this reader has no business learning.
    const view = viewOf({
      content: PROHIBITED_CONTENT,
      sensitivity: "prohibited",
      redaction: { status: "prohibited" },
      visibleToNodeIds: ["node-alpha"],
      scope: projectScope(),
      trust: "proposed",
    } as never)

    expect(policyFor().decide(view, reader({ projectId: "project-beta", scope: sessionScope(), clearance: "public_to_project" }), FIXED_NOW)).toEqual({
      allowed: false,
      reason: "project_mismatch",
      revealsKind: false,
    })
  })

  it("reports deletion and prohibition before scope, clearance, and trust", () => {
    const view = viewOf({
      content: PROHIBITED_CONTENT,
      sensitivity: "prohibited",
      redaction: { status: "prohibited" },
      scope: projectScope(),
      trust: "proposed",
    } as never)

    expect(policyFor().decide(view, reader({ scope: sessionScope(), clearance: "public_to_project" }), FIXED_NOW).reason).toBe("prohibited_content")
    expect(policyFor({ isTombstoned: () => true }).decide(view, reader({ scope: sessionScope() }), FIXED_NOW).reason).toBe("tombstoned")
  })

  it("reports the view reasons last, so a denial never over-claims", () => {
    // Superseded and expired mean "fine, wrong view". Reporting them ahead of a
    // real restriction would be a lie about why.
    const view = viewOf({ scope: projectScope(), visibleToNodeIds: ["node-alpha"] })

    expect(policyFor({ isSuperseded: () => true }).decide(view, reader({ nodeId: "node-bravo" }), FIXED_NOW).reason).toBe("node_restricted")
  })

  it("accepts a user-authored decision record as ordinary trusted content", () => {
    const view = viewOf({ trust: "accepted", trustDecision: { decidedBy: userActor(), decidedAt: T_INSTANT } })

    expect(policyFor().decide(view, reader(), FIXED_NOW).allowed).toBe(true)
  })
})
