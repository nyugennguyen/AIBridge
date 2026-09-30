/**
 * M5.2 test fixtures: one place that knows how to spell a legal memory record,
 * a legal reader, and a legal clock.
 *
 * The reason these are helpers and not literals in each test file is that
 * almost every interesting assertion in this milestone is *comparative* — "this
 * reader sees what that reader does not" — and a comparative test is only as
 * good as the difference between its two inputs. If a test file hand-wrote its
 * own actors and its own timestamps, two tests would differ in two variables at
 * once and a failure would say "isolation is broken" when it means "these two
 * fixtures had different scopes". Every helper here takes an override and
 * changes exactly one thing.
 *
 * Two conventions the tests rely on:
 *
 * - `FIXED_NOW` is a constant, and no fixture reads the wall clock. A test that
 *   needs a different "now" advances `createClock`, which is a *value*, so a
 *   failure can never be "it expired while the suite was running".
 * - actors go through `actorSchema.parse`, not through an object literal, so a
 *   branded id in a fixture is branded by the same schema that will reject it
 *   later. A fixture that hand-casts would let an illegal id into a test that
 *   claims to be about authorization.
 */

import { actorSchema } from "../../../src/orchestration/schemas.js"
import type { Actor } from "../../../src/orchestration/types.js"
import type { ContractError, Result } from "../../../src/orchestration/errors.js"
import type {
  AppendMemoryInput,
  MemoryQuery,
  MemoryQueryScope,
  MemoryTombstone,
  TombstoneRequest,
} from "../../../src/memory/ports.js"
import type { MemoryKind, MemoryScopeKind, Sensitivity, TrustState } from "../../../src/memory/ontology.js"
import {
  memoryScopeSchemaV2,
  type MemoryRecordV2,
  type MemoryScope,
  type MemoryViewScope,
} from "../../../src/memory/record.js"
import { InMemoryMemoryRepository, InMemoryMemoryStorage } from "../../../src/memory/in-memory-repository.js"

/** The instant every fixture considers "now" unless it says otherwise. */
export const FIXED_NOW = "2026-09-01T00:00:00.000Z"

/** Timestamps used to make ordering explicit rather than incidental. */
export const T_INSTANT = "2026-09-01T00:00:00.000Z"
export const T_PLUS_ONE = "2026-09-01T00:00:01.000Z"
export const T_PLUS_TWO = "2026-09-01T00:00:02.000Z"
export const T_PLUS_THREE = "2026-09-01T00:00:03.000Z"

export const PROJECT_A = "project-alpha"
export const PROJECT_B = "project-beta"

export function userActor(userId = "user-alice"): Actor {
  return actorSchema.parse({ kind: "user", userId })
}

export function nodeActor(nodeId = "node-controller"): Actor {
  return actorSchema.parse({ kind: "node", nodeId })
}

export function sessionActor(sessionId = "session-1"): Actor {
  return actorSchema.parse({ kind: "session", sessionId })
}

export function systemActor(name = "aibridge"): Actor {
  return actorSchema.parse({ kind: "system", name })
}

export function projectScope(): MemoryScope {
  return memoryScopeSchemaV2.parse({ kind: "project" })
}

export function runScope(runId = "run-1"): MemoryScope {
  return memoryScopeSchemaV2.parse({ kind: "run", runId })
}

export function taskScope(runId = "run-1", taskId = "task-1"): MemoryScope {
  return memoryScopeSchemaV2.parse({ kind: "task", runId, taskId })
}

export function dispatchScope(runId = "run-1", taskId = "task-1", dispatchId = "dispatch-1"): MemoryScope {
  return memoryScopeSchemaV2.parse({ kind: "dispatch", runId, taskId, dispatchId })
}

export function sessionScope(
  runId = "run-1",
  taskId = "task-1",
  dispatchId = "dispatch-1",
  sessionId = "session-1",
): MemoryScope {
  return memoryScopeSchemaV2.parse({ kind: "session", runId, taskId, dispatchId, sessionId })
}

export function scopeOf(kind: MemoryScopeKind): MemoryScope {
  switch (kind) {
    case "project":
      return projectScope()
    case "run":
      return runScope()
    case "task":
      return taskScope()
    case "dispatch":
      return dispatchScope()
    case "session":
      return sessionScope()
  }
}

/** A reader at a named depth of the default run/task/dispatch/session chain. */
export function readerAt(kind: MemoryScopeKind, options: Omit<ReaderOptions, "scope"> = {}): MemoryQueryScope {
  return reader({ ...options, scope: scopeOf(kind) })
}

export interface ReaderOptions {
  readonly projectId?: string
  /** A *full* scope, because a kind cannot tell run-1 from run-2. */
  readonly scope?: MemoryViewScope
  readonly nodeId?: string
  readonly roleId?: string
  readonly clearance?: Sensitivity
  readonly actor?: Actor
}

/**
 * A reader. Every field has a *permissive* default on purpose: a test that
 * wants to prove a restriction is the only one that has to name a restriction,
 * and a test that forgets will see everything and fail loudly rather than pass
 * by accident.
 */
export function reader(options: ReaderOptions = {}): MemoryQueryScope {
  return {
    projectId: options.projectId ?? PROJECT_A,
    scope: options.scope ?? projectScope(),
    nodeId: options.nodeId ?? "node-controller",
    ...(options.roleId === undefined ? {} : { roleId: options.roleId }),
    clearance: options.clearance ?? "prohibited",
    actor: options.actor ?? userActor(),
  }
}

export interface AppendOptions {
  readonly projectId?: string
  readonly kind?: MemoryKind
  readonly scope?: MemoryScope
  readonly author?: Actor
  readonly createdAt?: string
  readonly content?: string
  readonly sensitivity?: Sensitivity
  readonly expiresAt?: string
  readonly visibleToNodeIds?: readonly string[]
  readonly visibleToRoleIds?: readonly string[]
  readonly supersedesMemoryId?: string
  readonly retention?: MemoryRecordV2["retention"]
  readonly redaction?: AppendMemoryInput["redaction"]
  readonly detail?: Record<string, unknown>
  readonly secretReferences?: AppendMemoryInput["secretReferences"]
  readonly trust?: TrustState
  readonly trustDecision?: MemoryRecordV2["trustDecision"]
  readonly correlationId?: string
}

/**
 * An append input.
 *
 * The defaults describe the *most* permissive legal record a non-user can
 * write: a proposed project-scope finding, sensitive no higher than
 * public-to-project, with no node or role restriction. Every restriction test
 * therefore names the restriction explicitly.
 */
export function appendInput(options: AppendOptions = {}): AppendMemoryInput {
  return {
    projectId: options.projectId ?? PROJECT_A,
    kind: options.kind ?? "finding",
    scope: options.scope ?? projectScope(),
    author: options.author ?? nodeActor(),
    createdAt: options.createdAt ?? T_INSTANT,
    content: options.content ?? "The retry loop is idempotent.",
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.secretReferences === undefined ? {} : { secretReferences: options.secretReferences }),
    ...(options.sensitivity === undefined ? {} : { sensitivity: options.sensitivity }),
    ...(options.retention === undefined ? {} : { retention: options.retention }),
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    ...(options.visibleToNodeIds === undefined ? {} : { visibleToNodeIds: options.visibleToNodeIds }),
    ...(options.visibleToRoleIds === undefined ? {} : { visibleToRoleIds: options.visibleToRoleIds }),
    ...(options.supersedesMemoryId === undefined ? {} : { supersedesMemoryId: options.supersedesMemoryId }),
    ...(options.redaction === undefined ? {} : { redaction: options.redaction }),
    ...(options.trust === undefined ? {} : { trust: options.trust }),
    ...(options.trustDecision === undefined ? {} : { trustDecision: options.trustDecision }),
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
  }
}

/** An append input that is born `accepted`, i.e. a fact a user stands behind. */
export function acceptedInput(options: AppendOptions = {}): AppendMemoryInput {
  return appendInput({
    kind: "decision",
    author: userActor(),
    trust: "accepted",
    trustDecision: { decidedBy: userActor(), decidedAt: T_INSTANT, reason: "Recorded as a standing decision" },
    ...options,
  })
}

/** A clock the test moves by hand. Returns the function and a setter. */
export function createClock(initial: string = FIXED_NOW): { now: () => string; set: (value: string) => void } {
  let current = initial
  return { now: () => current, set: (value: string) => void (current = value) }
}

export interface RepositoryHarness {
  readonly repository: InMemoryMemoryRepository
  readonly storage: InMemoryMemoryStorage
  readonly clock: { now: () => string; set: (value: string) => void }
}

export function createRepository(initialNow: string = FIXED_NOW): RepositoryHarness {
  const clock = createClock(initialNow)
  const storage = new InMemoryMemoryStorage()
  return { repository: new InMemoryMemoryRepository({ now: clock.now }, storage), storage, clock }
}

/** Append and unwrap, so a test that is not about failure handling stays short. */
export async function appendAccepted(
  repository: InMemoryMemoryRepository,
  options: AppendOptions = {},
): Promise<MemoryRecordV2> {
  const result = await repository.append(acceptedInput(options))
  if (!result.ok) throw new Error(`fixture append failed: ${result.error.code} ${result.error.message}`)
  return result.value.record
}

export function queryFor(projectId: string, overrides: Partial<MemoryQuery> = {}): MemoryQuery {
  return { projectId, ...overrides }
}

/**
 * Unwrap a `Result` that the test expects to succeed, failing with the contract
 * error's own code and message if it does not.
 *
 * The code is in the message on purpose: a test that says "expected ok" and gets
 * `memory.duplicate_id` should not have to open the repository to find out why.
 */
export function expectOk<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected a successful result, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

/** Unwrap the error of a `Result` the test expects to be refused. */
export function expectError<T>(result: Result<T>): ContractError {
  if (result.ok) throw new Error("expected a refused result, but it succeeded")
  return result.error
}

export function tombstoneRequest(overrides: Partial<TombstoneRequest> & Pick<TombstoneRequest, "memoryId">): TombstoneRequest {
  return {
    projectId: PROJECT_A,
    requestedBy: userActor(),
    requestedAt: T_PLUS_THREE,
    reason: "Retention policy: the run ended and this finding is no longer true.",
    authorized: true,
    ...overrides,
  }
}

/** The tombstone a test expects to be left behind, so it can assert on the hash. */
export function expectedTombstone(record: MemoryRecordV2, overrides: Partial<MemoryTombstone> = {}): MemoryTombstone {
  return {
    schemaVersion: 1,
    memoryId: record.memoryId,
    projectId: record.projectId,
    kind: record.kind,
    contentHash: record.contentHash,
    deletedAt: T_PLUS_THREE,
    deletedBy: userActor(),
    reason: "Retention policy: the run ended and this finding is no longer true.",
    nonSensitive: true,
    ...overrides,
  }
}
