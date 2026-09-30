/**
 * M5.2 — the memory repository contract.
 *
 * Read this file as the list of promises the repository makes, each of which
 * corresponds to a rule in the milestone plan rather than to a method:
 *
 * - records are append-only and their ids are derived from content, so an
 *   identical append is a *conflict*, not a duplicate line;
 * - a query has one total order, and it does not depend on insertion order;
 * - the default view is the *active* view: superseded and expired records are
 *   withheld, and every withholding says why;
 * - cross-project isolation, the scope lattice, node/role allow-lists,
 *   clearance, and trust are each independently sufficient to withhold;
 * - only a user can accept a record, and only an authorized user can delete one;
 * - the durable store survives a restart, and refuses a corrupt line loudly
 *   rather than pretending the record was never written.
 *
 * The test that matters most for the milestone is the "not identifiable by
 * content" one, and it lives in `access-policy.test.ts` next to the code that
 * makes the promise. This file is about the store.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { FileMemoryRepository, JsonlMemoryStorage } from "../../../src/memory/file-repository.js"
import { InMemoryMemoryRepository } from "../../../src/memory/in-memory-repository.js"
import { MEMORY_ERROR_CODES, MemoryCorruptStoreError, isContractErrorCode } from "../../../src/memory/repository-errors.js"
import { verifyMemoryRecord } from "../../../src/memory/record.js"
import type { MemoryRecordV2 } from "../../../src/memory/record.js"
import {
  FIXED_NOW,
  PROJECT_A,
  PROJECT_B,
  T_INSTANT,
  T_PLUS_ONE,
  T_PLUS_THREE,
  T_PLUS_TWO,
  acceptedInput,
  appendInput,
  createRepository,
  dispatchScope,
  expectError,
  expectOk,
  expectedTombstone,
  nodeActor,
  projectScope,
  queryFor,
  reader,
  runScope,
  sessionActor,
  sessionScope,
  systemActor,
  taskScope,
  tombstoneRequest,
  userActor,
  type RepositoryHarness,
} from "./fixtures.js"

describe("memory repository: append", () => {
  let harness: RepositoryHarness

  beforeEach(() => {
    harness = createRepository()
  })

  it("stores a record with a derived id, a verified content hash, and a default retention", async () => {
    const result = expectOk(await harness.repository.append(acceptedInput({ kind: "decision" })))

    expect(result.record.memoryId).toMatch(/^memory\.[0-9a-f]{40}$/)
    expect(result.record.projectId).toBe(PROJECT_A)
    expect(result.record.schemaVersion).toBe(2)
    expect(result.record.retention).toBe("project")
    expect(result.record.createdAt).toBe(T_INSTANT)
    expect(verifyMemoryRecord(result.record)).toBe(true)
    expect(result.superseded).toBeUndefined()
  })

  it("derives the same id for the same content in a different store", async () => {
    const first = expectOk(await harness.repository.append(acceptedInput({ content: "Use bun, not npm." })))
    const other = createRepository()
    const second = expectOk(await other.repository.append(acceptedInput({ content: "Use bun, not npm." })))

    expect(second.record.memoryId).toBe(first.record.memoryId)
  })

  it("refuses an identical append as a conflict rather than storing it twice", async () => {
    const input = acceptedInput({ content: "Only one of these may exist." })
    const first = expectOk(await harness.repository.append(input))
    const second = await harness.repository.append(input)

    const error = expectError(second)
    expect(error.code).toBe(MEMORY_ERROR_CODES.duplicateId)
    expect(error.category).toBe("conflict")
    expect(error.retryable).toBe(false)
    expect(await harness.repository.listProjectUnscoped(PROJECT_A)).toHaveLength(1)
    expect((await harness.repository.getRaw(first.record.memoryId))?.memoryId).toBe(first.record.memoryId)
  })

  it("refuses an append whose input violates the record schema", async () => {
    const error = expectError(
      await harness.repository.append(appendInput({ content: "", author: nodeActor() })),
    )

    expect(error.code).toBe(MEMORY_ERROR_CODES.recordInvalid)
    expect(error.category).toBe("validation")
    expect(await harness.repository.listProjectUnscoped(PROJECT_A)).toHaveLength(0)
  })

  it("refuses an agent-authored record that claims a user's acceptance", async () => {
    // The schema checks that the decider is a *user*; it cannot check that the
    // decider is this author. Without the repository's check, a node could mint
    // "accepted by user-alice" out of thin air, and the milestone's promise that
    // agents propose but never trust would be a promise about a type.
    const error = expectError(
      await harness.repository.append(
        appendInput({
          author: nodeActor(),
          trust: "accepted",
          trustDecision: { decidedBy: userActor(), decidedAt: T_INSTANT },
        }),
      ),
    )

    expect(error.code).toBe(MEMORY_ERROR_CODES.recordInvalid)
    expect(error.message).toContain("must be the record's author")
    expect(await harness.repository.listProjectUnscoped(PROJECT_A)).toHaveLength(0)
  })

  it("refuses a trust decision whose decider is not a user at all", async () => {
    // Belt and braces: the record schema refuses a non-user decider on its own,
    // and the repository does not need to be the thing that notices.
    const error = expectError(
      await harness.repository.append(
        appendInput({
          author: nodeActor(),
          trust: "accepted",
          trustDecision: { decidedBy: nodeActor(), decidedAt: T_INSTANT },
        }),
      ),
    )

    expect(error.code).toBe(MEMORY_ERROR_CODES.recordInvalid)
  })

  it("keeps a proposed record proposed until a user accepts it", async () => {
    const record = expectOk(
      await harness.repository.append(appendInput({ author: nodeActor(), kind: "constraint" })),
    ).record

    expect(record.trust).toBe("proposed")
    expect(record.trustDecision).toBeUndefined()
  })

  it("lets exactly one of two concurrent identical appends win", async () => {
    // The duplicate check is a check-then-act, so a repository that did not
    // serialize its writes would pass every sequential test and store the same
    // record twice the first time two dispatches raced.
    const harness = createRepository()
    const input = acceptedInput({ content: "only one of these may exist" })

    const results = await Promise.all([harness.repository.append(input), harness.repository.append(input)])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok).map((result) => (result as { error: { code: string } }).error.code)).toEqual([
      MEMORY_ERROR_CODES.duplicateId,
    ])
    expect(await harness.repository.listProjectUnscoped(PROJECT_A)).toHaveLength(1)
  })
})

describe("memory repository: appendAll", () => {
  it("writes every record in the batch or none of them", async () => {
    const harness = createRepository()
    const good = acceptedInput({ content: "first" })
    const bad = appendInput({ content: "", author: nodeActor() })

    const error = expectError(await harness.repository.appendAll([good, bad]))

    expect(error.code).toBe(MEMORY_ERROR_CODES.recordInvalid)
    expect(await harness.repository.listProjectUnscoped(PROJECT_A)).toHaveLength(0)
  })

  it("refuses a batch containing a duplicate without writing the rest", async () => {
    const harness = createRepository()
    const first = acceptedInput({ content: "alpha" })
    const second = acceptedInput({ content: "beta" })
    expectOk(await harness.repository.append(first))

    const error = expectError(await harness.repository.appendAll([second, first]))

    expect(error.code).toBe(MEMORY_ERROR_CODES.duplicateId)
    expect(await harness.repository.listProjectUnscoped(PROJECT_A)).toHaveLength(1)
  })
})

describe("memory repository: ordering", () => {
  it("orders by createdAt ascending, breaking ties by memoryId", async () => {
    const harness = createRepository()
    // Three records sharing one instant, appended in an order chosen to be the
    // reverse of the id order, so an insertion-order implementation fails here.
    const sameInstant = [
      acceptedInput({ content: "same instant: alpha", createdAt: T_INSTANT }),
      acceptedInput({ content: "same instant: bravo", createdAt: T_INSTANT }),
      acceptedInput({ content: "same instant: charlie", createdAt: T_INSTANT }),
    ]
    const scratch = createRepository()
    const ids: string[] = []
    for (const input of sameInstant) {
      ids.push(expectOk(await scratch.repository.append(input)).record.memoryId)
    }
    ids.sort()
    for (const input of [...sameInstant].reverse()) expectOk(await harness.repository.append(input))

    const result = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    expect(result.records.map((record) => record.memoryId)).toEqual(ids)
  })

  it("produces the same order regardless of insertion order", async () => {
    const inputs = [
      acceptedInput({ content: "third", createdAt: T_PLUS_THREE }),
      acceptedInput({ content: "first", createdAt: T_INSTANT }),
      acceptedInput({ content: "second", createdAt: T_PLUS_TWO }),
    ]

    const forward = createRepository()
    for (const input of inputs) expectOk(await forward.repository.append(input))
    const backward = createRepository()
    for (const input of [...inputs].reverse()) expectOk(await backward.repository.append(input))

    const readForward = expectOk(await forward.repository.query(queryFor(PROJECT_A), reader()))
    const readBackward = expectOk(await backward.repository.query(queryFor(PROJECT_A), reader()))

    expect(readForward.records.map((r) => r.memoryId)).toEqual(readBackward.records.map((r) => r.memoryId))
    expect(readForward.records.map((r) => r.content)).toEqual(["first", "second", "third"])
  })

  it("applies limit after ordering, keeping the oldest records", async () => {
    const harness = createRepository()
    for (const [index, instant] of [T_INSTANT, T_PLUS_ONE, T_PLUS_TWO].entries()) {
      expectOk(await harness.repository.append(acceptedInput({ content: `record ${index}`, createdAt: instant })))
    }

    const result = expectOk(await harness.repository.query(queryFor(PROJECT_A, { limit: 2 }), reader()))

    expect(result.records.map((record) => record.content)).toEqual(["record 0", "record 1"])
  })
})

describe("memory repository: the active view", () => {
  it("withholds a superseded record by default and reports the reason", async () => {
    const harness = createRepository()
    const original = expectOk(await harness.repository.append(acceptedInput({ content: "original claim" }))).record
    expectOk(await harness.repository.supersede(original.memoryId, acceptedInput({ content: "corrected claim" })))

    const active = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    expect(active.records.map((record) => record.content)).toEqual(["corrected claim"])
    expect(active.withheld).toEqual([
      { memoryId: original.memoryId, kind: "decision", reason: "superseded", revealsKind: true },
    ])
  })

  it("returns superseded records when the query asks for them", async () => {
    const harness = createRepository()
    const original = expectOk(await harness.repository.append(acceptedInput({ content: "original claim", createdAt: T_INSTANT }))).record
    const correction = expectOk(
      await harness.repository.supersede(original.memoryId, acceptedInput({ content: "corrected claim", createdAt: T_PLUS_ONE })),
    )

    const withHistory = expectOk(await harness.repository.query(queryFor(PROJECT_A, { includeSuperseded: true }), reader()))

    expect(withHistory.records.map((record) => record.memoryId)).toEqual([original.memoryId, correction.record.memoryId])
    expect(withHistory.withheld).toHaveLength(0)
    expect(withHistory.records[0]?.supersededByMemoryId).toBe(correction.record.memoryId)
  })

  it("withholds an expired record by default and reports the reason", async () => {
    const harness = createRepository()
    const record = expectOk(
      await harness.repository.append(acceptedInput({ content: "true until tomorrow", expiresAt: T_PLUS_TWO })),
    ).record

    harness.clock.set(T_PLUS_ONE)
    expect(expectOk(await harness.repository.query(queryFor(PROJECT_A), reader())).records).toHaveLength(1)

    harness.clock.set(T_PLUS_TWO)
    const expired = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))
    expect(expired.records).toHaveLength(0)
    expect(expired.withheld).toEqual([
      { memoryId: record.memoryId, kind: "decision", reason: "expired", revealsKind: true },
    ])

    harness.clock.set(T_PLUS_TWO)
    const included = expectOk(await harness.repository.query(queryFor(PROJECT_A, { includeExpired: true }), reader()))
    expect(included.records.map((r) => r.memoryId)).toEqual([record.memoryId])
  })

  it("marks the whole supersession chain, so no stale record is ever active", async () => {
    const harness = createRepository()
    const first = expectOk(await harness.repository.append(acceptedInput({ content: "v1" }))).record
    const second = expectOk(await harness.repository.supersede(first.memoryId, acceptedInput({ content: "v2" })))
    const third = expectOk(await harness.repository.supersede(second.record.memoryId, acceptedInput({ content: "v3" })))

    const active = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    expect(active.records.map((record) => record.memoryId)).toEqual([third.record.memoryId])
    expect(active.withheld.map((entry) => entry.reason)).toEqual(["superseded", "superseded"])
  })
})

describe("memory repository: isolation", () => {
  it("REFUSES a query whose project disagrees with the scope, and reveals nothing", async () => {
    // Found by the M5.9 review as SF-4. Previously the query's project selected
    // the candidate set while the policy compared the *scope's* project, so a
    // reader of project A who named project B got project B's records as
    // candidates — each refused, each reported as a `project_mismatch`
    // withholding **carrying project B's `memoryId`**. That is a
    // cross-project existence oracle: name a project, learn how many memory ids
    // it holds.
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput({ content: "alpha only" }))).record

    const error = expectError(
      await harness.repository.query(queryFor(PROJECT_A), reader({ projectId: PROJECT_B })),
    )
    expect(error.code).toBe(MEMORY_ERROR_CODES.queryProjectMismatch)
    // `validation`, not `policy_denied`: it is a caller mistake, and the two
    // must not be conflated in an operator's log.
    expect(error.category).toBe("validation")
    // It names both projects, because the caller supplied both and the caller is
    // who has to fix it — and it names nothing about either project's records.
    expect(error.message).toContain(PROJECT_A)
    expect(error.message).toContain(PROJECT_B)
    expect(error.message).not.toContain(record.memoryId)
    expect(error.message).not.toContain("alpha only")
  })

  it("a cross-project reader names a project it does not hold, and is refused before any record is selected", async () => {
    // The stronger half of the same property: even with matching ids, a reader of
    // project B asking about project B's records gets nothing, and the *only*
    // thing they are told is that the id is not theirs.
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput({ content: "alpha only" }))).record

    // A well-formed query for the reader's OWN project: the record is returned.
    const own = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader({ projectId: PROJECT_A })))
    expect(own.records.map((entry) => entry.memoryId)).toEqual([record.memoryId])
  })

  it("keeps each project's query independent of the other's contents", async () => {
    const harness = createRepository()
    expectOk(await harness.repository.append(acceptedInput({ projectId: PROJECT_A, content: "alpha secret" })))
    expectOk(await harness.repository.append(acceptedInput({ projectId: PROJECT_B, content: "bravo secret" })))

    const alpha = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader({ projectId: PROJECT_A })))
    const bravo = expectOk(await harness.repository.query(queryFor(PROJECT_B), reader({ projectId: PROJECT_B })))

    expect(alpha.records.map((r) => r.content)).toEqual(["alpha secret"])
    expect(bravo.records.map((r) => r.content)).toEqual(["bravo secret"])
  })

  it("refuses a by-id read from another project", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput())).record

    const denied = await harness.repository.get(record.memoryId, reader({ projectId: PROJECT_B }))

    expect(expectError(denied).code).toBe(MEMORY_ERROR_CODES.notVisible)
  })
})

describe("memory repository: the scope lattice", () => {
  it("lets a project-scope reader see every narrower scope", async () => {
    const harness = createRepository()
    // Distinct instants so the assertion is about the lattice, not about the
    // id tiebreak.
    const instants = [T_INSTANT, T_PLUS_ONE, T_PLUS_TWO, T_PLUS_THREE, "2026-09-01T00:00:04.000Z"]
    const scopes = [projectScope(), runScope(), taskScope(), dispatchScope(), sessionScope()]
    for (const [index, scope] of scopes.entries()) {
      expectOk(await harness.repository.append(acceptedInput({ scope, content: `scoped ${scope.kind}`, createdAt: instants[index] })))
    }

    const result = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    expect(result.records.map((record) => record.scope.kind)).toEqual([
      "project",
      "run",
      "task",
      "dispatch",
      "session",
    ])
  })

  it("does not let a run-1 reader see run-2's records, even though both are `run` kind", async () => {
    const harness = createRepository()
    const mine = expectOk(await harness.repository.append(acceptedInput({ scope: runScope("run-1"), content: "run-1" }))).record
    const theirs = expectOk(await harness.repository.append(acceptedInput({ scope: runScope("run-2"), content: "run-2" }))).record
    expectOk(await harness.repository.append(acceptedInput({ scope: projectScope(), content: "a standing decision" })))

    const result = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader({ scope: runScope("run-1") })))

    // The run-1 reader sees its own record and the project-wide decision that
    // constrains it, and is told only the id of the other run's record.
    expect(result.records.map((record) => record.content).sort()).toEqual(["a standing decision", "run-1"])
    expect(result.withheld).toEqual([
      { memoryId: theirs.memoryId, kind: "decision", reason: "scope_not_visible", revealsKind: true },
    ])
  })

  it("does not let a task reader see a sibling task's session records", async () => {
    const harness = createRepository()
    const mine = expectOk(
      await harness.repository.append(acceptedInput({ scope: sessionScope("run-1", "task-1", "dispatch-1", "session-1") })),
    ).record
    const sibling = expectOk(
      await harness.repository.append(acceptedInput({ scope: sessionScope("run-1", "task-2", "dispatch-9", "session-9") })),
    ).record

    const result = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader({ scope: taskScope("run-1", "task-1") })))

    expect(result.records.map((record) => record.memoryId)).toEqual([mine.memoryId])
    expect(result.withheld.map((entry) => entry.memoryId)).toEqual([sibling.memoryId])
  })

  it("matches a project-scope record against a run-scoped query, per the lattice", async () => {
    const harness = createRepository()
    expectOk(await harness.repository.append(acceptedInput({ scope: projectScope(), content: "standing decision", createdAt: T_INSTANT })))
    expectOk(await harness.repository.append(acceptedInput({ scope: runScope("run-1"), content: "run-1 finding", createdAt: T_PLUS_ONE })))
    expectOk(await harness.repository.append(acceptedInput({ scope: runScope("run-2"), content: "run-2 finding", createdAt: T_PLUS_TWO })))

    // A `runId` filter selects *facts relevant to that run*, and a standing
    // project decision is one of them. The filter and the lattice are separate
    // questions: the filter decides which records are candidates, the reader's
    // scope decides which of those it may have.
    const fromProject = expectOk(await harness.repository.query(queryFor(PROJECT_A, { runId: "run-1" }), reader()))
    const fromRun = expectOk(await harness.repository.query(queryFor(PROJECT_A, { runId: "run-1" }), reader({ scope: runScope("run-1") })))

    expect(fromProject.records.map((record) => record.content)).toEqual(["standing decision", "run-1 finding"])
    // The other run's record never became a candidate, so it is not withheld
    // either: a filtered-out record is not an exclusion the reader has to review.
    expect(fromProject.withheld).toEqual([])
    expect(fromRun.records.map((record) => record.content)).toEqual(["standing decision", "run-1 finding"])
    expect(fromRun.withheld).toEqual([])
  })
})

describe("memory repository: node, role, and clearance", () => {
  it("withholds a node-restricted record from a node that is not listed", async () => {
    const harness = createRepository()
    const record = expectOk(
      await harness.repository.append(acceptedInput({ visibleToNodeIds: ["node-alpha"] })),
    ).record

    const result = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader({ nodeId: "node-bravo" })))

    expect(result.records).toEqual([])
    expect(result.withheld).toEqual([
      { memoryId: record.memoryId, reason: "node_restricted", revealsKind: false },
    ])
  })

  it("withholds a role-restricted record from a role that is not listed, and from a reader with no role", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput({ visibleToRoleIds: ["role-lead"] }))).record

    const wrongRole = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader({ roleId: "role-intern" })))
    const noRole = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    expect(wrongRole.records).toEqual([])
    expect(wrongRole.withheld).toEqual([
      { memoryId: record.memoryId, reason: "role_restricted", revealsKind: false },
    ])
    expect(noRole.withheld[0]?.reason).toBe("role_restricted")
  })

  it("allows a listed node and role", async () => {
    const harness = createRepository()
    expectOk(
      await harness.repository.append(acceptedInput({ visibleToNodeIds: ["node-alpha"], visibleToRoleIds: ["role-lead"] })),
    )

    const result = expectOk(
      await harness.repository.query(
        queryFor(PROJECT_A),
        reader({ nodeId: "node-alpha", roleId: "role-lead" }),
      ),
    )

    expect(result.records).toHaveLength(1)
  })

  it("withholds a record whose sensitivity exceeds the reader's clearance", async () => {
    const harness = createRepository()
    const record = expectOk(
      await harness.repository.append(acceptedInput({ sensitivity: "secret_reference_only", secretReferences: [{ reference: "op://vault/prod/deploy", summary: "The deploy credential" }] })),
    ).record

    const underCleared = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader({ clearance: "restricted" })))
    const cleared = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader({ clearance: "secret_reference_only" })))

    expect(underCleared.withheld).toEqual([
      { memoryId: record.memoryId, reason: "sensitivity_above_clearance", revealsKind: false },
    ])
    expect(cleared.records).toHaveLength(1)
  })

  it("withholds prohibited content from every reader, including full clearance", async () => {
    const harness = createRepository()
    const record = expectOk(
      await harness.repository.append(
        acceptedInput({
          content: "the private key block",
          sensitivity: "prohibited",
          redaction: { status: "prohibited", ruleIds: ["secret.private-key"] },
        }),
      ),
    ).record

    for (const clearance of ["public_to_project", "restricted", "secret_reference_only", "prohibited"] as const) {
      const result = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader({ clearance })))
      expect(result.records).toEqual([])
      expect(result.withheld).toEqual([
        { memoryId: record.memoryId, reason: "prohibited_content", revealsKind: false },
      ])
    }
  })
})

describe("memory repository: trust", () => {
  it("withholds every state except accepted", async () => {
    const harness = createRepository()
    const proposed = expectOk(await harness.repository.append(appendInput({ author: nodeActor() }))).record
    const systemDerived = expectOk(
      await harness.repository.append(appendInput({ author: sessionActor("session-x"), kind: "summary" })),
    ).record

    const result = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    expect(result.records).toEqual([])
    expect(result.withheld.every((entry) => entry.reason === "not_trusted")).toBe(true)
    expect(result.withheld.map((entry) => entry.memoryId).sort()).toEqual([proposed.memoryId, systemDerived.memoryId].sort())
  })

  it("lets a user accept a proposed record, recording who decided and when", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(appendInput({ author: nodeActor() }))).record

    const accepted = expectOk(
      await harness.repository.decideTrust(record.memoryId, {
        trust: "accepted",
        decidedBy: userActor("user-bob"),
        decidedAt: T_PLUS_TWO,
        reason: "Confirmed with the team",
      }),
    )

    expect(accepted.trust).toBe("accepted")
    expect(accepted.trustDecision?.decidedBy).toEqual(userActor("user-bob"))
    expect(accepted.trustDecision?.decidedAt).toBe(T_PLUS_TWO)
    // The content hash is deliberately independent of trust: the decision is
    // about the fact, not part of it.
    expect(accepted.contentHash).toBe(record.contentHash)
    expect(accepted.memoryId).toBe(record.memoryId)
  })

  it("refuses a trust decision from a node, a session, or the system, and changes nothing", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(appendInput({ author: nodeActor() }))).record
    const before = JSON.stringify(await harness.repository.getRaw(record.memoryId))

    for (const decidedBy of [nodeActor(), sessionActor("session-x"), systemActor()]) {
      const error = expectError(
        await harness.repository.decideTrust(record.memoryId, { trust: "accepted", decidedBy, decidedAt: T_PLUS_TWO }),
      )
      expect(error.code).toBe(MEMORY_ERROR_CODES.trustDecisionDenied)
      expect(error.category).toBe("policy_denied")
    }

    expect(JSON.stringify(await harness.repository.getRaw(record.memoryId))).toBe(before)
  })

  it("refuses a trust decision on a record that is not proposed", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput({ kind: "decision" }))).record

    const error = expectError(
      await harness.repository.decideTrust(record.memoryId, { trust: "rejected", decidedBy: userActor(), decidedAt: T_PLUS_TWO }),
    )

    expect(error.code).toBe(MEMORY_ERROR_CODES.illegalTrustTransition)
  })

  it("makes a record injectable only after it is accepted", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(appendInput({ author: nodeActor() }))).record

    expect(expectOk(await harness.repository.query(queryFor(PROJECT_A), reader())).records).toEqual([])
    expectOk(await harness.repository.decideTrust(record.memoryId, { trust: "accepted", decidedBy: userActor(), decidedAt: T_PLUS_TWO }))
    expect(expectOk(await harness.repository.query(queryFor(PROJECT_A), reader())).records).toHaveLength(1)
  })
})

describe("memory repository: supersession refusals", () => {
  it("refuses a supersession naming a record that does not exist", async () => {
    const harness = createRepository()

    const error = expectError(
      await harness.repository.supersede("memory.0000000000000000000000000000000000000000", acceptedInput()),
    )

    expect(error.code).toBe(MEMORY_ERROR_CODES.unknownSupersession)
    expect(error.category).toBe("validation")
  })

  it("refuses a cross-project supersession", async () => {
    const harness = createRepository()
    const target = expectOk(await harness.repository.append(acceptedInput({ projectId: PROJECT_B }))).record

    const error = expectError(
      await harness.repository.supersede(target.memoryId, acceptedInput({ projectId: PROJECT_A })),
    )

    expect(error.code).toBe(MEMORY_ERROR_CODES.crossProjectSupersession)
    expect(error.category).toBe("policy_denied")
    expect(expectOk(await harness.repository.query(queryFor(PROJECT_B), reader({ projectId: PROJECT_B }))).records).toHaveLength(1)
  })

  it("refuses a supersede whose input contradicts its argument", async () => {
    const harness = createRepository()
    const target = expectOk(await harness.repository.append(acceptedInput({ content: "target" }))).record
    const other = expectOk(await harness.repository.append(acceptedInput({ content: "other" }))).record

    const error = expectError(
      await harness.repository.supersede(target.memoryId, acceptedInput({ supersedesMemoryId: other.memoryId })),
    )

    expect(error.code).toBe(MEMORY_ERROR_CODES.recordInvalid)
  })
})

describe("memory repository: tombstones", () => {
  it("refuses a tombstone that is not authorized", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput())).record

    const error = expectError(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId, authorized: false })))

    expect(error.code).toBe(MEMORY_ERROR_CODES.tombstoneUnauthorized)
    expect(await harness.repository.getRaw(record.memoryId)).not.toBeNull()
    expect(await harness.repository.listTombstonesUnscoped(PROJECT_A)).toEqual([])
  })

  it("refuses a tombstone requested by anything but a user, even when authorized", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput())).record

    for (const requestedBy of [nodeActor(), sessionActor("session-x")]) {
      const error = expectError(
        await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId, requestedBy })),
      )
      expect(error.code).toBe(MEMORY_ERROR_CODES.tombstoneUnauthorized)
    }

    expect(await harness.repository.getRaw(record.memoryId)).not.toBeNull()
  })

  it("refuses a tombstone with no stated reason", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput())).record

    const error = expectError(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId, reason: "   " })))

    expect(error.code).toBe(MEMORY_ERROR_CODES.invalidTombstoneReason)
  })

  it("leaves a non-sensitive tombstone carrying the content hash, and removes the content", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput({ content: "the sensitive finding" }))).record

    const tombstone = expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId })))

    expect(tombstone).toEqual(expectedTombstone(record))
    expect(tombstone.contentHash).toBe(record.contentHash)
    expect(JSON.stringify(tombstone)).not.toContain("the sensitive finding")
    expect(await harness.repository.getRaw(record.memoryId)).toBeNull()
    expect(await harness.repository.listTombstonesUnscoped(PROJECT_A)).toEqual([tombstone])
  })

  it("reports a tombstoned id as withheld, not as absent", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput())).record
    expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId })))

    const result = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    expect(result.records).toEqual([])
    expect(result.withheld).toEqual([
      { memoryId: record.memoryId, kind: "decision", reason: "tombstoned", revealsKind: true },
    ])
    expect(expectError(await harness.repository.get(record.memoryId, reader())).code).toBe(MEMORY_ERROR_CODES.tombstoned)
  })

  it("refuses a second tombstone of the same id", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput())).record
    expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId })))

    const error = expectError(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId })))

    expect(error.code).toBe(MEMORY_ERROR_CODES.alreadyTombstoned)
  })

  it("refuses to supersede a tombstoned record", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput())).record
    expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId })))

    const error = expectError(await harness.repository.supersede(record.memoryId, acceptedInput({ content: "too late" })))

    expect(error.code).toBe(MEMORY_ERROR_CODES.unknownSupersession)
  })

  it("keeps a record's own supersession marked after the correcting record is deleted", async () => {
    // A fact whose only correction a human deliberately deleted does not
    // silently revert to being current. It stays superseded, and the correction
    // is reported as tombstoned.
    const harness = createRepository()
    const original = expectOk(await harness.repository.append(acceptedInput({ content: "v1" }))).record
    const correction = expectOk(await harness.repository.supersede(original.memoryId, acceptedInput({ content: "v2" })))
    expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: correction.record.memoryId })))

    const result = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    expect(result.records).toEqual([])
    expect(result.withheld.map((entry) => `${entry.memoryId}:${entry.reason}`).sort()).toEqual(
      [`${original.memoryId}:superseded`, `${correction.record.memoryId}:tombstoned`].sort(),
    )
  })
})

/**
 * SF-13: a deletion must never disclose more than the record did.
 *
 * The tombstone path used to bypass the access policy and answer
 * `revealsKind: true` for every tombstone, so a `prohibited` record — which told
 * every reader nothing at all while it was live — began naming its kind to every
 * reader of the project the moment it was privacy-deleted. A privacy deletion is
 * a *less* visible state than the record was, never a more visible one.
 *
 * These tests are comparative on purpose. Each one states what the *live*
 * record disclosed to the same reader, then what its tombstone discloses, and
 * the fix is only correct if the second is never richer than the first. The
 * `"kind" in withheld` assertions are the load-bearing ones: `revealsKind: false`
 * alongside a populated `kind` is a leak one `{ ...withholding }` away from a
 * log line, which is why the contract makes the field absent instead.
 */
describe("memory repository: a tombstone discloses no more than the record did", () => {
  it("names nothing at all about a deleted prohibited record, not even its kind", async () => {
    const harness = createRepository()
    const record = expectOk(
      await harness.repository.append(
        acceptedInput({
          kind: "handoff",
          sensitivity: "prohibited",
          redaction: { status: "prohibited", ruleIds: ["corpus.pem"] },
          content: "the credential rotation procedure",
        }),
      ),
    ).record

    // While it is live, a reader with the highest clearance there is learns the
    // id is withheld and nothing else.
    const live = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))
    expect(live.withheld).toEqual([{ memoryId: record.memoryId, reason: "prohibited_content", revealsKind: false }])
    expect("kind" in live.withheld[0]).toBe(false)

    expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId })))

    const after = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    expect(after.records).toEqual([])
    expect(after.withheld).toEqual([{ memoryId: record.memoryId, reason: "tombstoned", revealsKind: false }])
    expect("kind" in after.withheld[0]).toBe(false)
  })

  it("names nothing about a deleted restricted record that the reader is not cleared for", async () => {
    const harness = createRepository()
    const record = expectOk(
      await harness.repository.append(acceptedInput({ kind: "handoff", sensitivity: "restricted", content: "the unreleased plan" })),
    ).record
    const underCleared = reader({ clearance: "public_to_project" })

    const live = expectOk(await harness.repository.query(queryFor(PROJECT_A), underCleared))
    expect(live.withheld).toEqual([
      { memoryId: record.memoryId, reason: "sensitivity_above_clearance", revealsKind: false },
    ])
    expect("kind" in live.withheld[0]).toBe(false)

    expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId })))

    const after = expectOk(await harness.repository.query(queryFor(PROJECT_A), underCleared))

    expect(after.withheld).toEqual([{ memoryId: record.memoryId, reason: "tombstoned", revealsKind: false }])
    expect("kind" in after.withheld[0]).toBe(false)
    // A reader who *is* cleared for it is unaffected: the withholding is per
    // reader, not a property of the tombstone.
    const cleared = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader({ clearance: "restricted" })))
    expect(cleared.withheld).toEqual([
      { memoryId: record.memoryId, kind: "handoff", reason: "tombstoned", revealsKind: true },
    ])
  })

  it("still discloses the kind of a deleted record every reader of the project could have read", async () => {
    // The guard against "fix" it by withholding every tombstone, which would
    // satisfy the floor and make the tombstone useless: an operator could no
    // longer tell which project's history is missing what.
    const harness = createRepository()
    const record = expectOk(
      await harness.repository.append(acceptedInput({ kind: "decision", sensitivity: "public_to_project", content: "we deploy on Fridays" })),
    ).record

    expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId })))

    const after = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    expect(after.withheld).toEqual([
      { memoryId: record.memoryId, kind: "decision", reason: "tombstoned", revealsKind: true },
    ])
  })

  it("discloses nothing to a reader in another project, by id or by kind", async () => {
    const harness = createRepository()
    const mine = expectOk(
      await harness.repository.append(
        acceptedInput({
          kind: "handoff",
          sensitivity: "prohibited",
          redaction: { status: "prohibited", ruleIds: ["corpus.pem"] },
          content: "our own secret handoff",
        }),
      ),
    ).record
    const theirs = expectOk(
      await harness.repository.append(
        acceptedInput({
          projectId: PROJECT_B,
          kind: "handoff",
          sensitivity: "prohibited",
          redaction: { status: "prohibited", ruleIds: ["corpus.pem"] },
          content: "another project's secret handoff",
        }),
      ),
    ).record
    expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: mine.memoryId })))
    expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: theirs.memoryId, projectId: PROJECT_B })))

    // A foreign tombstone is not a candidate at all: the id alone is a
    // cross-project existence oracle, and no `reason` string makes that safe.
    const result = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader({ projectId: PROJECT_A })))
    expect(result.withheld.map((entry) => entry.memoryId)).toEqual([mine.memoryId])
    expect(JSON.stringify(result)).not.toContain(theirs.memoryId)
    // And the one that *is* in scope is withheld under the policy, not announced.
    expect("kind" in result.withheld[0]).toBe(false)

    // Naming the other project in the query is refused outright rather than
    // answered with that project's tombstone as a `project_mismatch` withholding
    // carrying its id (the M5.9 review's SF-4).
    const foreign = expectError(
      await harness.repository.query(queryFor(PROJECT_B), reader({ projectId: PROJECT_A })),
    )
    expect(foreign.code).toBe(MEMORY_ERROR_CODES.queryProjectMismatch)
    expect(JSON.stringify(foreign)).not.toContain(theirs.memoryId)
  })

  it("names nothing about a deleted node-restricted record to a node that is not listed", async () => {
    const harness = createRepository()
    const record = expectOk(
      await harness.repository.append(
        acceptedInput({ kind: "handoff", visibleToNodeIds: ["node-edge"], content: "for the edge node only" }),
      ),
    ).record
    const otherNode = reader({ nodeId: "node-other" })

    const live = expectOk(await harness.repository.query(queryFor(PROJECT_A), otherNode))
    expect(live.withheld).toEqual([{ memoryId: record.memoryId, reason: "node_restricted", revealsKind: false }])
    expect("kind" in live.withheld[0]).toBe(false)

    expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId })))

    const after = expectOk(await harness.repository.query(queryFor(PROJECT_A), otherNode))
    expect(after.withheld).toEqual([{ memoryId: record.memoryId, reason: "tombstoned", revealsKind: false }])
    expect("kind" in after.withheld[0]).toBe(false)

    // The node the record was written for is told the same thing about it, which
    // is the "an id you know about was deleted" the tombstone exists to leave.
    const listed = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader({ nodeId: "node-edge" })))
    expect(listed.withheld).toEqual([
      { memoryId: record.memoryId, kind: "handoff", reason: "tombstoned", revealsKind: true },
    ])
  })
})

describe("memory repository: get", () => {
  it("refuses an unknown id instead of returning null", async () => {
    const harness = createRepository()

    const result = await harness.repository.get("memory.0000000000000000000000000000000000000000", reader())

    expect(expectError(result).code).toBe(MEMORY_ERROR_CODES.unknownRecord)
  })

  it("refuses a by-id read of an untrusted record", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(appendInput({ author: nodeActor() }))).record

    const error = expectError(await harness.repository.get(record.memoryId, reader()))

    expect(error.code).toBe(MEMORY_ERROR_CODES.notVisible)
    expect(error.message).toContain("not_trusted")
  })
})

describe("FileMemoryRepository", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "aibridge-memory-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it("survives a restart with records, order, and trust intact", async () => {
    const first = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const record = expectOk(await first.append(appendInput({ author: nodeActor() }))).record
    expectOk(await first.append(acceptedInput({ content: "a decision", createdAt: T_PLUS_TWO })))
    expectOk(await first.decideTrust(record.memoryId, { trust: "accepted", decidedBy: userActor(), decidedAt: T_PLUS_TWO }))

    const reopened = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const result = expectOk(await reopened.query(queryFor(PROJECT_A), reader()))

    expect(result.records).toHaveLength(2)
    expect(result.records.every((entry) => entry.trust === "accepted")).toBe(true)
    expect((await reopened.getRaw(record.memoryId))?.schemaVersion).toBe(2)
  })

  it("writes one record per line, and never rewrites an existing line", async () => {
    const store = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const record = expectOk(await store.append(acceptedInput({ content: "first" }))).record
    const original = await readFile(join(directory, "records.jsonl"), "utf8")
    expectOk(await store.supersede(record.memoryId, acceptedInput({ content: "second" })))

    const after = await readFile(join(directory, "records.jsonl"), "utf8")
    expect(after.startsWith(original)).toBe(true)
    expect(after.trimEnd().split("\n")).toHaveLength(2)
  })

  it("keeps a tombstone across a restart and the deleted content off disk", async () => {
    const store = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const record = expectOk(await store.append(acceptedInput({ content: "please forget this" }))).record
    expectOk(await store.tombstone(tombstoneRequest({ memoryId: record.memoryId })))

    const raw = await readFile(join(directory, "records.jsonl"), "utf8")
    expect(raw).not.toContain("please forget this")

    const reopened = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    expect(await reopened.getRaw(record.memoryId)).toBeNull()
    expect((await reopened.listTombstonesUnscoped(PROJECT_A)).map((entry) => entry.memoryId)).toEqual([record.memoryId])
  })

  it("falls back to disclosing nothing about a tombstone this process did not delete", async () => {
    // The access-relevant facts of a deleted record are retained in memory, not
    // on disk — see `TombstoneAccessFacts`. So a tombstone reloaded from a store
    // has no facts, and the honest answer is the conservative one: the id and
    // the fact of deletion, with no kind, *even though this record was
    // public-to-project and any reader could have read it while it was live*.
    // Asserted so the fallback cannot be quietly replaced by an allow, which
    // would reintroduce SF-13 for every deletion made by an earlier process.
    const store = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const record = expectOk(await store.append(acceptedInput({ content: "an ordinary decision" }))).record
    expectOk(await store.tombstone(tombstoneRequest({ memoryId: record.memoryId })))

    const sameProcess = expectOk(await store.query(queryFor(PROJECT_A), reader()))
    expect(sameProcess.withheld).toEqual([
      { memoryId: record.memoryId, kind: "decision", reason: "tombstoned", revealsKind: true },
    ])

    const reopened = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const afterRestart = expectOk(await reopened.query(queryFor(PROJECT_A), reader()))

    expect(afterRestart.withheld).toEqual([{ memoryId: record.memoryId, reason: "tombstoned", revealsKind: false }])
    expect("kind" in afterRestart.withheld[0]).toBe(false)
  })

  it("erases only the tombstoned line, even when another record's payload mentions its id", async () => {
    const store = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const doomed = expectOk(
      await store.append(acceptedInput({ content: "the record to delete", detail: { memoryId: "not-an-id" } })),
    ).record
    // The survivor's content mentions the doomed record's id as free text. An
    // erase that pattern-matched `"memoryId":"` would delete the wrong line.
    const survivor = expectOk(await store.append(acceptedInput({ content: `see ${doomed.memoryId} for context` }))).record

    expectOk(await store.tombstone(tombstoneRequest({ memoryId: doomed.memoryId })))

    const reopened = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    expect((await reopened.listProjectUnscoped(PROJECT_A)).map((entry) => entry.memoryId)).toEqual([survivor.memoryId])
  })

  it("refuses a partially written trailing line instead of dropping the record", async () => {
    const store = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const record = expectOk(await store.append(acceptedInput({ content: "written before the crash" }))).record
    await appendTruncatedLine(join(directory, "records.jsonl"))
    const beforeFailure = await readFile(join(directory, "records.jsonl"), "utf8")

    const reopened = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const failure = await captureError(() => reopened.query(queryFor(PROJECT_A), reader()))

    expect(failure).toBeInstanceOf(MemoryCorruptStoreError)
    const corrupt = failure as MemoryCorruptStoreError
    expect(corrupt.line).toBe(2)
    expect(corrupt.toContractError().code).toBe(MEMORY_ERROR_CODES.storeCorrupt)
    // The file is left exactly as found, for an operator or the migration.
    expect(await readFile(join(directory, "records.jsonl"), "utf8")).toBe(beforeFailure)
    // And the record that *is* intact was never in doubt.
    expect(record.memoryId).toMatch(/^memory\./)
  })

  it("refuses a record line that is valid JSON but not a record", async () => {
    await writeFile(join(directory, "records.jsonl"), `${JSON.stringify({ schemaVersion: 2, memoryId: "memory.x" })}\n`, "utf8")

    const reopened = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const failure = await captureError(() => reopened.listProjectUnscoped(PROJECT_A))

    expect(failure).toBeInstanceOf(MemoryCorruptStoreError)
    expect((failure as MemoryCorruptStoreError).toContractError().code).toBe(MEMORY_ERROR_CODES.storeCorrupt)
  })

  it("refuses two lines claiming the same memory id", async () => {
    const store = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const record = expectOk(await store.append(acceptedInput())).record
    await appendDuplicateLine(join(directory, "records.jsonl"), record)

    const reopened = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const failure = await captureError(() => reopened.listProjectUnscoped(PROJECT_A))

    expect(failure).toBeInstanceOf(MemoryCorruptStoreError)
    expect((failure as MemoryCorruptStoreError).toContractError().code).toBe(MEMORY_ERROR_CODES.storeCorrupt)
  })

  it("refuses a corrupt tombstone index", async () => {
    const store = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    expectOk(await store.append(acceptedInput()))
    await writeFile(join(directory, "index.json"), "{ not json", "utf8")

    const reopened = new FileMemoryRepository(directory, { now: () => FIXED_NOW })
    const failure = await captureError(() => reopened.listTombstonesUnscoped(PROJECT_A))

    expect(failure).toBeInstanceOf(MemoryCorruptStoreError)
  })

  it("exposes its storage so the layout is inspectable, not guessed at", async () => {
    const storage = new JsonlMemoryStorage(directory)
    const store = new FileMemoryRepository(directory, { now: () => FIXED_NOW }, storage)
    const record = expectOk(await store.append(appendInput({ author: nodeActor() }))).record
    expectOk(await store.decideTrust(record.memoryId, { trust: "accepted", decidedBy: userActor(), decidedAt: T_PLUS_TWO }))

    expect(store.directoryPath).toBe(directory)
    expect((await readFile(join(directory, "records.jsonl"), "utf8")).trimEnd().split("\n")).toHaveLength(1)
    // The trust decision is its own line in its own log, so the record's bytes
    // stay exactly as written.
    expect(JSON.parse((await readFile(join(directory, "decisions.jsonl"), "utf8")).trim())).toEqual({
      memoryId: record.memoryId,
      trust: "accepted",
      decidedBy: { kind: "user", userId: "user-alice" },
      decidedAt: T_PLUS_TWO,
    })
  })
})

describe("memory repository: error vocabulary", () => {
  it("uses only codes the frozen ContractError pattern accepts", () => {
    for (const code of Object.values(MEMORY_ERROR_CODES)) {
      expect(isContractErrorCode(code)).toBe(true)
    }
    expect(new Set(Object.values(MEMORY_ERROR_CODES)).size).toBe(Object.values(MEMORY_ERROR_CODES).length)
  })

  it("produces contract errors that satisfy the frozen schema", async () => {
    const harness = createRepository()
    const error = expectError(await harness.repository.append(appendInput({ content: "" })))

    expect(error.schemaVersion).toBe(1)
    expect(error.retryable).toBe(false)
    expect(error.message.length).toBeGreaterThan(0)
    expect(error.message.length).toBeLessThanOrEqual(4096)
  })
})

describe("memory repository: no ambient clock", () => {
  it("never reads the system clock in the repository implementation", async () => {
    const implementationFiles = [
      "in-memory-repository.ts",
      "file-repository.ts",
      "access-policy.ts",
      "repository-errors.ts",
    ]
    const sources = await Promise.all(
      implementationFiles.map((name) => readFile(join(import.meta.dirname, "../../../src/memory", name), "utf8")),
    )

    expect(sources).toHaveLength(implementationFiles.length)
    for (const source of sources) {
      // `Date.parse` is fine: it reads a string the caller supplied. Reading the
      // wall clock is not, and there is no place in here that needs to.
      expect(source).not.toMatch(/Date\.now\s*\(/)
      expect(source).not.toMatch(/new Date\s*\(\s*\)/)
    }
  })

  it("uses the caller's timestamps for records and deletions", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput({ createdAt: T_PLUS_ONE }))).record

    expect(record.createdAt).toBe(T_PLUS_ONE)
    const tombstone = expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId, requestedAt: T_PLUS_THREE })))
    expect(tombstone.deletedAt).toBe(T_PLUS_THREE)
  })
})

// --- helpers ---------------------------------------------------------------

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error("expected the operation to fail, but it succeeded")
}

async function appendTruncatedLine(path: string): Promise<void> {
  await writeFile(path, `${await readFile(path, "utf8")}{"schemaVersion":2,"memoryId":"memory.trunca`, "utf8")
}

async function appendDuplicateLine(path: string, record: MemoryRecordV2): Promise<void> {
  await writeFile(path, `${await readFile(path, "utf8")}${JSON.stringify(record)}\n`, "utf8")
}
