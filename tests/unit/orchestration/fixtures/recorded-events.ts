/**
 * Recorded orchestration event fixtures for the TUI run/audit adapter.
 *
 * These are EVENT LOGS, not projections: each fixture is the exact event
 * sequence a controller would have appended, and every assertion in
 * `tui-adapter.test.ts` is made against what folding that log produces. A
 * hand-built projection could encode a state the event log cannot produce; a
 * recorded sequence cannot, which is the whole point of driving the reducer
 * from fixtures.
 *
 * Every event is built through `orchestrationEventSchema`, so a fixture that
 * drifts from the contract fails here rather than producing a quietly invalid
 * read model.
 */
import { digestDispatchEnvelope } from "../../../../src/orchestration/digest.js"
import { actorSchema, dispatchEnvelopeSchema, orchestrationEventSchema } from "../../../../src/orchestration/schemas.js"
import type { DispatchEnvelope, OrchestrationEvent } from "../../../../src/orchestration/types.js"

export const PROJECT_ID = "project-release"
export const RUN_ID = "run-release-1"
export const EPOCH = 3
const NODE_ID = "node-worker-1"
const INSTALLATION_ID = "install-opencode-1"
const RUNTIME_KIND = "opencode"
const CORRELATION_ID = "corr-release-1"

const CONTROLLER_ACTOR = actorSchema.parse({ kind: "node", nodeId: "node-worker-1" })
const USER_ACTOR = actorSchema.parse({ kind: "user", userId: "user-release-manager" })
const SYSTEM_ACTOR = actorSchema.parse({ kind: "system", name: "opencode-adapter" })

/** A fixed clock: event N is recorded at 2026-09-28T00:00:0N.000Z. */
function timestampAt(sequence: number): string {
  const seconds = String(sequence).padStart(2, "0")
  return `2026-09-28T00:00:${seconds}.000Z`
}

type Actor = OrchestrationEvent["actor"]

class EventRecorder {
  readonly events: OrchestrationEvent[] = []
  #sequence = 0

  /** The clock reading the NEXT emitted event will carry. */
  peekTimestamp(): string {
    return timestampAt(this.#sequence + 1)
  }

  emit(
    type: OrchestrationEvent["type"],
    payload: unknown,
    options: { readonly actor?: Actor; readonly commandId?: string; readonly at?: number } = {},
  ): OrchestrationEvent {
    this.#sequence += 1
    const event = orchestrationEventSchema.parse({
      schemaVersion: 1,
      eventId: `evt-${String(this.#sequence).padStart(3, "0")}`,
      sequence: this.#sequence,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      actor: options.actor ?? CONTROLLER_ACTOR,
      occurredAt: options.at === undefined ? timestampAt(this.#sequence) : timestampAt(options.at),
      correlationId: CORRELATION_ID,
      causation: null,
      controllerEpoch: EPOCH,
      ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
      type,
      payload,
    })
    this.events.push(event)
    return event
  }
}

export interface EnvelopeOptions {
  readonly dispatchId: string
  readonly taskId: string
  readonly attempt: number
  readonly prompt: string
  /** A capability the permission envelope denies, which makes policy `deny`. */
  readonly deniedCapability?: string
  readonly timeoutSeconds?: number
  readonly model?: string
  readonly roleVersion?: number
}

/** A dispatch envelope as the role/rule repository would have snapshotted it. */
export function makeEnvelope(options: EnvelopeOptions): DispatchEnvelope {
  const allowed = ["fs.read", "fs.write"]
  // A denied capability is requested but never allowed: that is what makes the
  // policy decision an outright `deny` rather than a narrowed `allow`.
  const denied = options.deniedCapability === undefined ? [] : [options.deniedCapability]
  const requested = options.deniedCapability === undefined
    ? allowed
    : [...allowed, options.deniedCapability]

  return dispatchEnvelopeSchema.parse({
    schemaVersion: 1,
    dispatchId: options.dispatchId,
    attempt: options.attempt,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    taskId: options.taskId,
    targetNodeId: NODE_ID,
    installationId: INSTALLATION_ID,
    runtimeKind: RUNTIME_KIND,
    projectPathId: "path-release-1",
    prompt: options.prompt,
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "role-release-engineer",
      templateVersion: options.roleVersion ?? 4,
      projectId: PROJECT_ID,
      name: "Release engineer",
      purpose: "Prepare and verify a release",
      instructions: "Follow the release runbook. Never publish without an approval.",
      requiredCapabilities: requested,
      preferredRuntimeKinds: [RUNTIME_KIND],
      contextSelectionPolicyReference: { namespace: "context", id: "release-runbook" },
      permissionRestrictions: {
        allowedCapabilities: allowed,
        deniedCapabilities: denied,
        approvalRequirements: {
          destructiveEffects: true,
          externalEffects: true,
          capabilities: [],
        },
      },
      author: USER_ACTOR,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    ruleSnapshots: [
      {
        schemaVersion: 1,
        ruleId: "rule-release-restrictions",
        templateVersion: 2,
        projectId: PROJECT_ID,
        enabled: true,
        match: { requestedCapabilitiesAny: requested },
        effect: {
          kind: "restrict",
          deniedCapabilities: denied,
          requireApprovalForDestructiveEffects: true,
          requireApprovalForExternalEffects: true,
        },
        author: USER_ACTOR,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ],
    contextManifest: {
      references: [],
      manifestDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    },
    requestedCapabilities: requested,
    permissionEnvelope: {
      allowedCapabilities: allowed,
      deniedCapabilities: denied,
      approvalRequirements: {
        destructiveEffects: true,
        externalEffects: true,
        capabilities: [],
      },
    },
    dependencies: [],
    timeoutSeconds: options.timeoutSeconds ?? 900,
    controllerEpoch: EPOCH,
    ...(options.model === undefined ? {} : { model: options.model }),
  })
}

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    projectId: PROJECT_ID,
    goal: "Ship release 4.2.0 with a verified changelog",
    state: "draft",
    paused: false,
    createdAt: "2026-09-28T00:00:01.000Z",
    updatedAt: "2026-09-28T00:00:01.000Z",
    externalReferences: [{ namespace: "ticket", id: "REL-4217" }],
    ...overrides,
  }
}

function makeTask(
  taskId: string,
  dependencies: readonly { taskId: string; failurePolicy: "block" | "fail" }[] = [],
  state = "pending",
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId,
    runId: RUN_ID,
    projectId: PROJECT_ID,
    title: `Task ${taskId}`,
    description: `Work item ${taskId}`,
    state,
    failurePolicy: "block",
    dependencies,
    externalReferences: [],
  }
}

function makeSession(
  options: {
    readonly sessionId: string
    readonly dispatchId: string
    readonly taskId: string
    readonly lifecycleState: string
    readonly observedState: string
    readonly terminalId?: string
  },
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionId: options.sessionId,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    taskId: options.taskId,
    dispatchId: options.dispatchId,
    nodeId: NODE_ID,
    installationId: INSTALLATION_ID,
    runtimeKind: RUNTIME_KIND,
    lifecycleState: options.lifecycleState,
    observedState: options.observedState,
    ...(options.terminalId === undefined ? {} : { terminalId: options.terminalId }),
  }
}

function makeArtifact(options: {
  readonly artifactId: string
  readonly dispatchId: string
  readonly sessionId: string
  readonly name: string
  readonly byteCount: number
  readonly digestSeed: string
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    artifactId: options.artifactId,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    dispatchId: options.dispatchId,
    sessionId: options.sessionId,
    name: options.name,
    mediaType: "text/markdown",
    digest: `sha256:${options.digestSeed}`,
    byteCount: options.byteCount,
    source: { kind: "session", sessionId: options.sessionId },
    location: { kind: "locator", locator: `file:///var/aibridge/artifacts/${options.name}` },
  }
}

function propose(
  recorder: EventRecorder,
  options: { readonly dispatchId: string; readonly taskId: string; readonly attempt: number; readonly prompt: string; readonly commandId: string; readonly createdAt?: string; readonly deniedCapability?: string },
): DispatchEnvelope {
  const envelope = makeEnvelope({
    dispatchId: options.dispatchId,
    taskId: options.taskId,
    attempt: options.attempt,
    prompt: options.prompt,
    ...(options.deniedCapability === undefined ? {} : { deniedCapability: options.deniedCapability }),
  })
  recorder.emit(
    "dispatch.proposed",
    {
      dispatch: {
        schemaVersion: 1,
        envelope,
        envelopeDigest: digestDispatchEnvelope(envelope),
        state: "proposed",
        createdAt: options.createdAt ?? recorder.peekTimestamp(),
        externalReferences: [],
      },
    },
    { commandId: options.commandId },
  )
  return envelope
}

function decide(
  recorder: EventRecorder,
  options: {
    readonly approvalId: string
    readonly envelope: DispatchEnvelope
    readonly decision: "approved" | "rejected"
    readonly commandId: string | null
    readonly at: number
  },
): void {
  recorder.emit(
    "approval.decided",
    {
      approval: {
        schemaVersion: 1,
        approvalId: options.approvalId,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        dispatchId: options.envelope.dispatchId,
        // The digest the coordinator verified before recording the decision.
        envelopeDigest: digestDispatchEnvelope(options.envelope),
        decision: options.decision,
        state: options.decision,
        basis: { kind: "user" },
        actor: USER_ACTOR,
        decidedAt: timestampAt(options.at),
      },
    },
    {
      actor: USER_ACTOR,
      at: options.at,
      ...(options.commandId === null ? {} : { commandId: options.commandId }),
    },
  )
}

function start(
  recorder: EventRecorder,
  options: { readonly sessionId: string; readonly dispatchId: string; readonly taskId: string; readonly commandId: string; readonly at: number },
): void {
  recorder.emit(
    "dispatch.started",
    {
      session: makeSession({
        sessionId: options.sessionId,
        dispatchId: options.dispatchId,
        taskId: options.taskId,
        lifecycleState: "launching",
        observedState: "starting",
      }),
    },
    { commandId: options.commandId, at: options.at },
  )
}

function observe(
  recorder: EventRecorder,
  options: {
    readonly sessionId: string
    readonly dispatchId: string
    readonly taskId: string
    readonly lifecycleState: string
    readonly observedState: string
    readonly at: number
  },
): void {
  recorder.emit(
    "session.observed",
    {
      session: makeSession({
        sessionId: options.sessionId,
        dispatchId: options.dispatchId,
        taskId: options.taskId,
        lifecycleState: options.lifecycleState,
        observedState: options.observedState,
        terminalId: "term-release-1",
      }),
    },
    { actor: SYSTEM_ACTOR, at: options.at },
  )
}

function finish(
  recorder: EventRecorder,
  options: {
    readonly dispatchId: string
    readonly sessionId: string
    readonly outcome: "completed" | "failed" | "timed_out" | "cancelled"
    readonly summary: string
    readonly at: number
  },
): void {
  recorder.emit(
    "dispatch.finished",
    {
      dispatchId: options.dispatchId,
      sessionId: options.sessionId,
      outcome: options.outcome,
      summary: options.summary,
    },
    { actor: SYSTEM_ACTOR, at: options.at },
  )
}

/**
 * A three-task release plan whose LAST task fails once, blocks on a permission
 * request, is retried, and registers an artifact on the retry.
 *
 * Exercises, in order: run/task creation, a dependency graph, a proposal, an
 * approval, a launch, provider observations, a failure, a RETRY that adds a
 * second attempt to the same task's history, an artifact placeholder, a blocked
 * session, and completion.
 */
export function shipReleaseWithRetry(): readonly OrchestrationEvent[] {
  const recorder = new EventRecorder()

  recorder.emit("run.created", { run: makeRun() }, { at: 1 })
  recorder.emit("task.created", { task: makeTask("task-a", [], "ready") }, { at: 2 })
  recorder.emit("task.created", { task: makeTask("task-b", [{ taskId: "task-a", failurePolicy: "block" }]) }, { at: 3 })
  recorder.emit(
    "task.created",
    {
      task: makeTask("task-c", [
        { taskId: "task-a", failurePolicy: "block" },
        { taskId: "task-b", failurePolicy: "block" },
      ]),
    },
    { at: 4 },
  )

  // task-a: the root of the graph, approved and completed first.
  const changelogAttempt = propose(recorder, {
    dispatchId: "disp-a-1",
    taskId: "task-a",
    attempt: 1,
    prompt: "Draft the 4.2.0 changelog",
    commandId: "cmd-propose-a-1",
  })
  decide(recorder, { approvalId: "appr-a-1", envelope: changelogAttempt, decision: "approved", commandId: "cmd-approve-a-1", at: 7 })
  start(recorder, { sessionId: "sess-a-1", dispatchId: "disp-a-1", taskId: "task-a", commandId: "cmd-execute-a-1", at: 8 })
  observe(recorder, {
    sessionId: "sess-a-1",
    dispatchId: "disp-a-1",
    taskId: "task-a",
    lifecycleState: "running",
    observedState: "working",
    at: 9,
  })
  finish(recorder, {
    dispatchId: "disp-a-1",
    sessionId: "sess-a-1",
    outcome: "completed",
    summary: "Changelog drafted and verified",
    at: 10,
  })

  // task-b, which was blocked by task-a and is now free to run.
  const tagAttempt = propose(recorder, {
    dispatchId: "disp-b-1",
    taskId: "task-b",
    attempt: 1,
    prompt: "Tag and sign the release",
    commandId: "cmd-propose-b-1",
  })
  decide(recorder, { approvalId: "appr-b-1", envelope: tagAttempt, decision: "approved", commandId: "cmd-approve-b-1", at: 12 })
  start(recorder, { sessionId: "sess-b-1", dispatchId: "disp-b-1", taskId: "task-b", commandId: "cmd-execute-b-1", at: 13 })
  finish(recorder, {
    dispatchId: "disp-b-1",
    sessionId: "sess-b-1",
    outcome: "completed",
    summary: "Release tagged and signed",
    at: 14,
  })

  // task-c, attempt 1: blocked on a permission request, then fails.
  const publishAttempt = propose(recorder, {
    dispatchId: "disp-c-1",
    taskId: "task-c",
    attempt: 1,
    prompt: "Publish the release notes",
    commandId: "cmd-propose-c-1",
  })
  decide(recorder, { approvalId: "appr-c-1", envelope: publishAttempt, decision: "approved", commandId: "cmd-approve-c-1", at: 16 })
  start(recorder, { sessionId: "sess-c-1", dispatchId: "disp-c-1", taskId: "task-c", commandId: "cmd-execute-c-1", at: 17 })
  observe(recorder, {
    sessionId: "sess-c-1",
    dispatchId: "disp-c-1",
    taskId: "task-c",
    lifecycleState: "idle",
    observedState: "blocked",
    at: 18,
  })
  finish(recorder, {
    dispatchId: "disp-c-1",
    sessionId: "sess-c-1",
    outcome: "failed",
    summary: "The provider refused to publish without a signed token",
    at: 19,
  })

  // Attempt 2 of task-c: a NEW dispatch id at a higher attempt number, which
  // must ADD to the history rather than replace the recorded failure.
  const retryAttempt = propose(recorder, {
    dispatchId: "disp-c-2",
    taskId: "task-c",
    attempt: 2,
    prompt: "Publish the release notes with the signed token",
    commandId: "cmd-propose-c-2",
  })
  decide(recorder, { approvalId: "appr-c-2", envelope: retryAttempt, decision: "approved", commandId: "cmd-approve-c-2", at: 21 })
  start(recorder, { sessionId: "sess-c-2", dispatchId: "disp-c-2", taskId: "task-c", commandId: "cmd-execute-c-2", at: 22 })
  observe(recorder, {
    sessionId: "sess-c-2",
    dispatchId: "disp-c-2",
    taskId: "task-c",
    lifecycleState: "running",
    observedState: "working",
    at: 23,
  })
  recorder.emit(
    "artifact.registered",
    {
      artifact: makeArtifact({
        artifactId: "art-changelog",
        dispatchId: "disp-c-2",
        sessionId: "sess-c-2",
        name: "RELEASE-NOTES-4.2.0.md",
        byteCount: 4_182,
        digestSeed: "a".repeat(64),
      }),
    },
    { actor: SYSTEM_ACTOR, at: 24 },
  )
  finish(recorder, {
    dispatchId: "disp-c-2",
    sessionId: "sess-c-2",
    outcome: "completed",
    summary: "Release notes published",
    at: 25,
  })

  return recorder.events
}

/**
 * A run cancelled while a dispatch is in flight: first a dispatch-level cancel
 * request with no observed outcome, then the run-level cancel decision.
 */
export function cancelledMidFlight(): readonly OrchestrationEvent[] {
  const recorder = new EventRecorder()

  recorder.emit("run.created", { run: makeRun({ goal: "Reproduce the flaky migration" }) }, { at: 1 })
  recorder.emit("task.created", { task: makeTask("task-a", [], "ready") }, { at: 2 })
  const migrationAttempt = propose(recorder, {
    dispatchId: "disp-x-1",
    taskId: "task-a",
    attempt: 1,
    prompt: "Run the migration",
    commandId: "cmd-propose-x-1",
  })
  decide(recorder, { approvalId: "appr-x-1", envelope: migrationAttempt, decision: "approved", commandId: "cmd-approve-x-1", at: 4 })
  start(recorder, { sessionId: "sess-x-1", dispatchId: "disp-x-1", taskId: "task-a", commandId: "cmd-execute-x-1", at: 5 })
  recorder.emit(
    "dispatch.cancel.requested",
    { runId: RUN_ID, dispatchId: "disp-x-1", sessionId: "sess-x-1", reason: "Operator stopped the migration" },
    { actor: USER_ACTOR, commandId: "cmd-cancel-x-1", at: 6 },
  )
  recorder.emit(
    "run.cancelled",
    { runId: RUN_ID, reason: "Migration is unsafe on production data" },
    { actor: USER_ACTOR, commandId: "cmd-cancel-run-1", at: 7 },
  )

  return recorder.events
}

/**
 * A dispatch-level cancel request that the runtime then answers, with no
 * run-level cancel decision. The outstanding-cancellation record must clear
 * once the outcome is observed.
 */
export function cancelRequestedThenAnswered(): readonly OrchestrationEvent[] {
  const recorder = new EventRecorder()

  recorder.emit("run.created", { run: makeRun({ goal: "Stop the long build" }) }, { at: 1 })
  recorder.emit("task.created", { task: makeTask("task-a", [], "ready") }, { at: 2 })
  const buildAttempt = propose(recorder, {
    dispatchId: "disp-s-1",
    taskId: "task-a",
    attempt: 1,
    prompt: "Run the long build",
    commandId: "cmd-propose-s-1",
  })
  decide(recorder, { approvalId: "appr-s-1", envelope: buildAttempt, decision: "approved", commandId: "cmd-approve-s-1", at: 4 })
  start(recorder, { sessionId: "sess-s-1", dispatchId: "disp-s-1", taskId: "task-a", commandId: "cmd-execute-s-1", at: 5 })
  recorder.emit(
    "dispatch.cancel.requested",
    { runId: RUN_ID, dispatchId: "disp-s-1", sessionId: "sess-s-1", reason: "The build is overrunning its window" },
    { actor: USER_ACTOR, commandId: "cmd-cancel-s-1", at: 6 },
  )
  finish(recorder, {
    dispatchId: "disp-s-1",
    sessionId: "sess-s-1",
    outcome: "cancelled",
    summary: "The runtime acknowledged the cancellation",
    at: 7,
  })

  return recorder.events
}

/**
 * Two tasks that depend on each other. Every individual `task.created` event is
 * valid, and only the graph as a whole is not, so this is the case the adapter
 * has to report rather than render.
 */
export function cyclicTaskGraph(): readonly OrchestrationEvent[] {
  const recorder = new EventRecorder()

  recorder.emit("run.created", { run: makeRun({ goal: "An impossible plan" }) }, { at: 1 })
  recorder.emit(
    "task.created",
    { task: makeTask("task-a", [{ taskId: "task-b", failurePolicy: "block" }], "ready") },
    { at: 2 },
  )
  recorder.emit(
    "task.created",
    { task: makeTask("task-b", [{ taskId: "task-a", failurePolicy: "block" }], "ready") },
    { at: 3 },
  )

  return recorder.events
}

/**
 * A proposal whose policy decision is an outright DENY: the envelope requests a
 * capability the permission envelope denies, so the dispatch can never be
 * approved into a launch and the audit view has to say why.
 */
export function deniedByPolicy(): readonly OrchestrationEvent[] {
  const recorder = new EventRecorder()

  recorder.emit("run.created", { run: makeRun({ goal: "Publish from an untrusted network" }) }, { at: 1 })
  recorder.emit("task.created", { task: makeTask("task-a", [], "ready") }, { at: 2 })

  const envelope = propose(recorder, {
    dispatchId: "disp-deny-1",
    taskId: "task-a",
    attempt: 1,
    prompt: "Publish the release from the build agent",
    commandId: "cmd-propose-deny-1",
    deniedCapability: "net.publish",
  })
  decide(recorder, { approvalId: "appr-deny-1", envelope, decision: "rejected", commandId: "cmd-approve-deny-1", at: 4 })

  return recorder.events
}

/**
 * A revision: the SAME dispatch id is proposed again at a higher attempt with a
 * different envelope. The coordinator records the invalidation first and the
 * proposal in the same transaction, and the event store's
 * `(runId, dispatchId, attempt)` tombstone allows it — so the prior attempt's
 * failure must still be readable afterwards.
 */
export function revisedSameDispatchId(): readonly OrchestrationEvent[] {
  const recorder = new EventRecorder()

  recorder.emit("run.created", { run: makeRun({ goal: "Repair the build" }) }, { at: 1 })
  recorder.emit("task.created", { task: makeTask("task-a", [], "ready") }, { at: 2 })

  const first = propose(recorder, {
    dispatchId: "disp-rev-1",
    taskId: "task-a",
    attempt: 1,
    prompt: "Repair the build",
    commandId: "cmd-propose-rev-1",
  })
  decide(recorder, { approvalId: "appr-rev-1", envelope: first, decision: "approved", commandId: "cmd-approve-rev-1", at: 4 })
  start(recorder, { sessionId: "sess-rev-1", dispatchId: "disp-rev-1", taskId: "task-a", commandId: "cmd-execute-rev-1", at: 5 })
  finish(recorder, {
    dispatchId: "disp-rev-1",
    sessionId: "sess-rev-1",
    outcome: "failed",
    summary: "The build could not be repaired under the first envelope",
    at: 6 },
  )

  // The coordinator's `dispatch.retry` emits the invalidation BEFORE the new
  // proposal, in one append transaction.
  recorder.emit(
    "approval.invalidated",
    {
      approvalId: "appr-rev-1",
      projectId: PROJECT_ID,
      runId: RUN_ID,
      dispatchId: "disp-rev-1",
      envelopeDigest: digestDispatchEnvelope(first),
      reason: "dispatch retried with a new envelope attempt",
    },
    { commandId: "cmd-retry-rev-1", at: 7 },
  )
  propose(recorder, {
    dispatchId: "disp-rev-1",
    taskId: "task-a",
    attempt: 2,
    prompt: "Repair the build with the toolchain pinned to 1.2.3",
    commandId: "cmd-retry-rev-1",
    createdAt: "2026-09-28T00:00:08.000Z",
  })

  return recorder.events
}

/**
 * A minimal log whose `approval.decided` and `dispatch.started` events carry no
 * `commandId`, which is the case the TUI's `LaunchAdmission` cannot represent
 * without inventing one.
 */
export function approvalWithoutCommandId(): readonly OrchestrationEvent[] {
  const recorder = new EventRecorder()

  recorder.emit("run.created", { run: makeRun({ goal: "Check the command id gap" }) }, { at: 1 })
  recorder.emit("task.created", { task: makeTask("task-a", [], "ready") }, { at: 2 })
  const envelope = propose(recorder, {
    dispatchId: "disp-noid-1",
    taskId: "task-a",
    attempt: 1,
    prompt: "Do the thing",
    commandId: "cmd-propose-noid-1",
  })
  decide(recorder, { approvalId: "appr-noid-1", envelope, decision: "approved", commandId: null, at: 4 })

  return recorder.events
}
