import { resolve } from "node:path"
import { z } from "zod"
import { digestDispatchEnvelope, digestJson } from "../digest.js"
import {
  commandIdSchema,
  correlationIdSchema,
  epochSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  runIdSchema,
  schemaVersionSchema,
  taskIdSchema,
  timestampSchema,
  type CommandId,
  type CorrelationId,
  type Digest,
  type Epoch,
  type LeaseId,
  type NodeId,
  type ProjectId,
  type ProjectPathId,
  type RunId,
  type TaskId,
  type Timestamp,
} from "../identifiers.js"
import { dispatchSchema, orchestrationCommandSchema, runSchema, taskSchema } from "../schemas.js"
import type { Actor, Dispatch, OrchestrationCommand, Run, Task } from "../types.js"
import {
  buildLegacyDispatchEnvelope,
  legacyCanonicalId,
  legacyImportKey,
  legacyLifecycleForStatus,
  legacyScopeKey,
} from "./migration.js"
import { legacyAgentMappingSchema, legacyJobRecordSchema, legacyProjectMappingSchema } from "./schemas.js"
import type { LegacyJobRecord } from "./types.js"

/**
 * The legacy API's compatibility surface for the orchestration kernel.
 *
 * The plan's M3.8 row asks for "`/trigger`, `/report`, and job query
 * translation/compatibility policy", and the guardrail is explicit: "Do not
 * remove the legacy JSON state reader until migration support is released and
 * tested." So this module never replaces the JSON store. It runs ALONGSIDE it
 * and answers one question the legacy API cannot: which canonical run, task,
 * and dispatch does this legacy job correspond to.
 *
 * Three invariants hold here and are proven by `tests/integration/
 * legacy-compatibility.test.ts`:
 *
 *  1. DETERMINISM. The mapping reads no clock and no global state. The same
 *     legacy record plus the same context always yields byte-identical
 *     canonical records and the same `mappingDigest`. An approval binds to an
 *     envelope digest, so a non-deterministic envelope would silently
 *     invalidate it.
 *  2. EXPLICIT PROVENANCE. Derived ids are content hashes and say nothing
 *     about their origin, so every mapping carries a `legacy.job` reference
 *     rather than leaving the link to be inferred.
 *  3. NO EFFECT INSIDE THE TRANSACTION. Mapping is pure; the intent is
 *     recorded by one coordinator append; the runtime launch is a NAMED,
 *     separately delivered outbox effect.
 */

// --- Compatibility policy -------------------------------------------------

/**
 * Whether the kernel is attached to the legacy API.
 *
 * `absent` is the released behaviour, not a degraded one: the JSON store is the
 * only state, the runtime is launched inline, and nothing reaches the event
 * log. A bridge that has not been migrated must keep serving `/trigger`, which
 * is why the guardrail forbids removing the reader.
 *
 * `present` records the accepted intent through the coordinator. The HTTP
 * contract is identical in both modes; only the durability of the intent
 * differs. Compatibility is proven, not asserted, by running the same legacy
 * scenarios through an app built with each mode.
 */
export const legacyKernelPresenceSchema = z.enum(["absent", "present"])

export type LegacyKernelPresence = z.infer<typeof legacyKernelPresenceSchema>

/**
 * The outcome of translating one legacy record.
 *
 * - `translated`: mapped to canonical run/task/dispatch.
 * - `absent`: the kernel is not attached; nothing was translated. Not an error.
 * - `unrepresentable`: well-formed legacy data with no canonical equivalent
 *   under the current mapping.
 * - `malformed`: the record does not satisfy even the legacy schema, so its
 *   meaning is unknown.
 *
 * There is deliberately no "skip": a job that cannot be represented must
 * surface as a diagnosable error rather than be accepted into the JSON store
 * and then silently never run.
 */
export const legacyTranslationDispositionSchema = z.enum(["translated", "unrepresentable", "malformed", "absent"])

export type LegacyTranslationDisposition = z.infer<typeof legacyTranslationDispositionSchema>

const digestPattern = /^sha256:[0-9a-f]{64}$/

const correlationReferenceSchema = z
  .object({ namespace: z.literal("legacy.job"), id: z.string().min(1).max(4_096) })
  .strict()

/**
 * The explicit, durable link from a legacy job id to its canonical records.
 */
export const legacyCorrelationSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    legacyJobId: z.string().min(1).max(256),
    reference: correlationReferenceSchema,
    importKey: z.string().min(1).max(4_096),
    projectId: projectIdSchema,
    runId: runIdSchema,
    taskId: taskIdSchema,
    dispatchId: z.string().min(1).max(128),
    envelopeDigest: z.string().regex(digestPattern),
    /** Digest over the whole mapping: equal digests mean equal canonical records. */
    mappingDigest: z.string().regex(digestPattern),
    /** The legacy status the mapping was derived from. */
    legacyStatus: z.string().min(1).max(32),
    disposition: legacyTranslationDispositionSchema,
  })
  .strict()

export type LegacyCorrelation = z.infer<typeof legacyCorrelationSchema>

/**
 * The translation context: every identity input, all of it material and
 * injected. There is no clock field — `now` is a separate dependency — so the
 * context alone determines the mapping.
 */
export const legacyTranslationContextSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    /** Scopes every derived id; changing it deliberately re-derives identities. */
    sourceProfileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    controllerNodeId: nodeIdSchema,
    controllerEpoch: epochSchema,
    leaseId: leaseIdSchema,
    pathResolutionBase: z.string().min(1).max(4_096),
    agentMappings: z.array(legacyAgentMappingSchema).max(128),
    projectMappings: z.array(legacyProjectMappingSchema).max(128),
    /** The local legacy agent id, i.e. the node this bridge runs as. */
    localAgentId: z.string().min(1).max(256),
  })
  .strict()

export type LegacyTranslationContext = z.infer<typeof legacyTranslationContextSchema>

export const legacyTranslationErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    message: z.string().min(1).max(4_096),
    disposition: z.enum(["unrepresentable", "malformed"]),
    diagnostics: z
      .array(z.object({ code: z.string().min(1).max(128), message: z.string().min(1).max(4_096) }).strict())
      .max(64),
  })
  .strict()

export type LegacyTranslationError = z.infer<typeof legacyTranslationErrorSchema>

export type LegacyTranslationResult =
  | {
      readonly ok: true
      readonly correlation: LegacyCorrelation
      readonly run: Run
      readonly task: Task
      readonly dispatch: Dispatch
    }
  | { readonly ok: false; readonly error: LegacyTranslationError }

/** The canonical records a legacy job maps to, before any command is submitted. */
export interface LegacyJobMapping {
  readonly correlation: LegacyCorrelation
  readonly run: Run
  readonly task: Task
  readonly dispatch: Dispatch
}

function fail(
  disposition: "unrepresentable" | "malformed",
  code: string,
  message: string,
  diagnostics: readonly { code: string; message: string }[] = [],
): { ok: false; error: LegacyTranslationError } {
  return { ok: false, error: legacyTranslationErrorSchema.parse({ code, message, disposition, diagnostics: [...diagnostics] }) }
}

// --- Mapping --------------------------------------------------------------

/**
 * Maps one legacy job to its canonical run, task, and dispatch.
 *
 * Pure: no I/O, no clock, no global state. The offline import in
 * `./migration.js` derives identity from the same primitives, so `/jobs/:id`
 * and a later import of the same file agree on identity by construction.
 */
export function translateLegacyJob(jobInput: unknown, contextInput: unknown): LegacyTranslationResult {
  const record = legacyJobRecordSchema.safeParse(jobInput)
  if (!record.success) {
    return fail(
      "malformed",
      "legacy.malformed_record",
      "The legacy job does not satisfy the legacy job schema, so its canonical meaning is unknown.",
      record.error.issues.slice(0, 64).map((issue) => ({
        code: `legacy.schema.${issue.path.join(".") || "root"}`,
        message: issue.message,
      })),
    )
  }

  const context = legacyTranslationContextSchema.safeParse(contextInput)
  if (!context.success) {
    return fail(
      "unrepresentable",
      "legacy.context_invalid",
      "The translation context is not a valid legacy mapping context, so no canonical identity can be derived.",
      context.error.issues.map((issue) => ({ code: `context.${issue.path.join(".") || "root"}`, message: issue.message })),
    )
  }

  return mapParsedJob(record.data, context.data)
}

function mapParsedJob(job: LegacyJobRecord, context: LegacyTranslationContext): LegacyTranslationResult {
  const target = context.agentMappings.find((mapping) => mapping.legacyAgentId === job.trigger.target_agent_id)
  if (target === undefined) {
    return fail(
      "unrepresentable",
      "legacy.target_unmapped",
      `Legacy job target '${job.trigger.target_agent_id}' has no explicit node, installation, and runtime mapping.`,
    )
  }

  const requestedPath = resolve(context.pathResolutionBase, job.trigger.project_dir)
  const project = context.projectMappings.find(
    (mapping) => resolve(context.pathResolutionBase, mapping.configuredPath) === requestedPath,
  )
  if (project === undefined) {
    return fail(
      "unrepresentable",
      "legacy.project_unmapped",
      `Legacy job project path '${job.trigger.project_dir}' has no exact canonical project mapping.`,
    )
  }

  const scopeKey = legacyScopeKey(context.sourceProfileId, context.localAgentId, project.legacyProjectId)
  const scopedJobKey = `${scopeKey}\0${job.id}`
  const runId = runIdSchema.parse(legacyCanonicalId("run", scopedJobKey))
  const taskId = taskIdSchema.parse(legacyCanonicalId("task", scopedJobKey))
  const dispatchId = legacyCanonicalId("dispatch", scopedJobKey)
  const importKey = legacyImportKey(scopeKey, job.id)
  const reference = { namespace: "legacy.job" as const, id: job.id }
  const lifecycle = legacyLifecycleForStatus(job.status)

  // A live `/trigger` is a CURRENT authorization: the route has already checked
  // the bearer token, the source/capability pair, the project allowlist, and
  // plan approval before the job was created. So the capability is granted
  // rather than denied, unlike an inert historical import. A fresh canonical
  // approval is still required before the dispatch may start, which is what the
  // `approvalRequirements` entry below demands.
  const envelope = buildLegacyDispatchEnvelope({
    dispatchId,
    projectId: project.projectId,
    runId,
    taskId,
    projectPathId: project.projectPathId,
    targetNodeId: target.nodeId,
    installationId: target.installationId,
    runtimeKind: target.runtimeKind,
    roleId: legacyCanonicalId("role", scopedJobKey),
    capability: job.trigger.capability,
    prompt: job.trigger.prompt,
    timeoutSeconds: job.trigger.timeout_seconds,
    controllerEpoch: context.controllerEpoch,
    createdAt: job.createdAt,
    permissionEnvelope: {
      allowedCapabilities: [job.trigger.capability],
      deniedCapabilities: [],
      approvalRequirements: {
        destructiveEffects: true,
        externalEffects: true,
        capabilities: [job.trigger.capability],
      },
    },
  })
  const envelopeDigest = digestDispatchEnvelope(envelope)

  // A live trigger maps to a DRAFT, PAUSED run. The plan makes a run active only
  // after its first approved dispatch, and legacy work has no canonical
  // approval, so writing `active` here would fabricate one. The task stays
  // `pending` because readiness is a scheduler decision made once the run is
  // unpaused. A legacy job that already reached a terminal state keeps that
  // terminal state, because the outcome is a fact, not a permission.
  const terminalTask = lifecycle.task === "completed" || lifecycle.task === "failed"
  const run = runSchema.parse({
    schemaVersion: 1,
    runId,
    projectId: project.projectId,
    goal: job.trigger.prompt,
    state: "draft",
    paused: true,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    externalReferences: [reference],
  })
  const task = taskSchema.parse({
    schemaVersion: 1,
    taskId,
    runId,
    projectId: project.projectId,
    title: `Legacy job ${job.id}`.slice(0, 256),
    description: job.trigger.prompt,
    state: terminalTask ? lifecycle.task : "pending",
    failurePolicy: "block",
    dependencies: [],
    externalReferences: [reference],
  })
  const dispatch = dispatchSchema.parse({
    schemaVersion: 1,
    envelope,
    envelopeDigest,
    state: "proposed",
    createdAt: job.createdAt,
    externalReferences: [reference],
  })

  return {
    ok: true,
    correlation: legacyCorrelationSchema.parse({
      schemaVersion: 1,
      legacyJobId: job.id,
      reference,
      importKey,
      projectId: project.projectId,
      runId,
      taskId,
      dispatchId,
      envelopeDigest,
      mappingDigest: digestJson({ reference, importKey, run, task, dispatch: { dispatchId, envelopeDigest } }),
      legacyStatus: job.status,
      disposition: "translated",
    }),
    run,
    task,
    dispatch,
  }
}

// --- Commands -------------------------------------------------------------

/** Formats an instant as the canonical UTC timestamp form, without reading a clock. */
function timestampAfter(millis: number): Timestamp {
  const iso = new Date(millis).toISOString()
  return timestampSchema.parse(`${iso.slice(0, 19)}Z`)
}

/**
 * The command that records a legacy trigger's accepted intent.
 *
 * `run.create` is the only command that mints canonical aggregates, and it
 * emits `run.created` + `task.created` in ONE append transaction. Its command
 * id is derived from the canonical run, so a retried `/trigger` for the same
 * job is recognised by the store's semantic fingerprint as a duplicate instead
 * of creating a second run.
 */
export function legacyRunCreateCommand(
  mapping: LegacyJobMapping,
  options: {
    readonly now: Timestamp
    readonly actor: Actor
    readonly context: LegacyTranslationContext
    readonly correlationId: CorrelationId
    readonly ttlSeconds?: number
  },
): OrchestrationCommand {
  const ttlSeconds = options.ttlSeconds ?? 86_400
  return orchestrationCommandSchema.parse({
    schemaVersion: 1,
    commandId: commandIdSchema.parse(`legacy-run-create-${mapping.correlation.runId}`),
    type: "run.create",
    projectId: mapping.run.projectId,
    runId: mapping.run.runId,
    actor: options.actor,
    controllerNodeId: options.context.controllerNodeId,
    controllerEpoch: options.context.controllerEpoch,
    leaseId: options.context.leaseId,
    issuedAt: options.now,
    // Derived from the INJECTED clock, never the wall clock, so replaying the
    // same legacy record under the same clock yields an identical command.
    expiresAt: timestampAfter(Date.parse(options.now) + ttlSeconds * 1000),
    correlationId: options.correlationId,
    causation: null,
    payload: { run: mapping.run, tasks: [mapping.task] },
  })
}

/** The correlation id for one legacy job, derived rather than random. */
export function legacyCorrelationIdFor(mapping: LegacyJobMapping): CorrelationId {
  return correlationIdSchema.parse(`legacy-${mapping.correlation.legacyJobId}`)
}

// --- Launch outbox --------------------------------------------------------

/**
 * The named runtime effect a legacy launch owes.
 *
 * The kernel's `dispatch.execute` cannot carry this effect: it requires an
 * approved dispatch bound to a live approval, and legacy work deliberately has
 * neither (the plan's approval criteria treat a legacy plan annotation as
 * evidence, not authority). So the legacy launch is expressed as its OWN
 * outbox record instead, keyed by the canonical dispatch id. The outbox id is
 * stable, so a redelivery after a crash is recognisable as the same effect
 * rather than a second session — the plan's "stop if retry can reach a runtime
 * without a stable command/dispatch idempotency key" guard, satisfied for the
 * legacy path too.
 */
/**
 * What the route actually checked before the job was created, recorded so the
 * launch can be re-verified at the effect boundary.
 */
export const legacyLaunchAuthorizationSchema = z
  .object({
    sourceAgentId: z.string().min(1).max(256),
    capability: z.string().min(1).max(128),
    projectDir: z.string().min(1).max(4_096),
    promptDigest: z.string().regex(digestPattern),
    /** The authenticated principal the route admitted. */
    authorizedBy: z.string().min(1).max(256),
    /** Binds the authorization to the exact canonical mapping it was made for. */
    mappingDigest: z.string().regex(digestPattern),
  })
  .strict()

export type LegacyLaunchAuthorization = z.infer<typeof legacyLaunchAuthorizationSchema>

export const legacyLaunchIntentSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    outboxId: z.string().min(1).max(256),
    destination: z.literal("legacy.runtime.launch"),
    correlation: legacyCorrelationSchema,
    projectDir: z.string().min(1).max(4_096),
    prompt: z.string().min(1).max(65_536),
    /**
     * The exact facts the route authorized, and a digest over them.
     *
     * `legacy.runtime.launch` deliberately does not go through
     * `dispatch.execute`, because legacy work has no canonical approval. That
     * makes the ROUTE's authorization the only thing standing between this
     * intent and a runtime, so the intent carries what was checked rather than
     * trusting the record alone. The digest binds `projectDir` and `prompt` to
     * the identity, capability and source that were authorized: a delivery step
     * that receives a tampered payload (a different directory or prompt) can
     * detect it before crossing the effect boundary, which is the same
     * "recheck at the effect boundary" discipline ADR 0003 requires of a worker.
     */
    authorization: legacyLaunchAuthorizationSchema,
    status: z.enum(["pending", "delivered"]),
  })
  .strict()

export type LegacyLaunchIntent = z.infer<typeof legacyLaunchIntentSchema>

/** The destination every legacy runtime launch is delivered to. */
export const LEGACY_LAUNCH_DESTINATION = "legacy.runtime.launch"

/**
 * Builds the launch intent for a mapped legacy job.
 *
 * Named, not performed: the caller records the intent in the same transaction
 * as the aggregate, and a separate delivery step performs it afterwards. That
 * ordering is what keeps the runtime effect out of the event transaction.
 */
export function legacyLaunchIntent(
  mapping: LegacyJobMapping,
  job: {
    readonly trigger: {
      readonly project_dir: string
      readonly prompt: string
      readonly capability: string
      readonly source_agent_id: string
    }
  },
  options: { readonly authorizedBy: string },
): LegacyLaunchIntent {
  const projectDir = job.trigger.project_dir
  const prompt = job.trigger.prompt
  const authorization = legacyLaunchAuthorizationSchema.parse({
    sourceAgentId: job.trigger.source_agent_id,
    capability: job.trigger.capability,
    projectDir,
    promptDigest: digestJson(prompt),
    authorizedBy: options.authorizedBy,
    mappingDigest: mapping.correlation.mappingDigest,
  })
  return legacyLaunchIntentSchema.parse({
    schemaVersion: 1,
    outboxId: `obx-legacy-launch-${mapping.correlation.dispatchId}`,
    destination: LEGACY_LAUNCH_DESTINATION,
    correlation: mapping.correlation,
    projectDir,
    prompt,
    authorization,
    status: "pending",
  })
}

/**
 * Re-checks a launch intent at the effect boundary.
 *
 * The legacy path has no canonical approval, so the route's authorization is the
 * whole authorization story; this makes that checkable by whoever actually
 * performs the launch instead of being an unrecorded claim in the route. A
 * payload whose `projectDir`/`prompt` no longer match the digest that was
 * authorized must not be delivered.
 */
export function verifyLegacyLaunchIntent(
  intent: LegacyLaunchIntent,
): { ok: true; value: LegacyLaunchIntent } | { ok: false; error: LegacyTranslationError } {
  if (digestJson(intent.prompt) !== intent.authorization.promptDigest) {
    return fail(
      "unrepresentable",
      "legacy.launch_payload_tampered",
      `Legacy launch '${intent.outboxId}' carries a prompt that does not match the digest authorized at intake.`,
    )
  }
  if (intent.projectDir !== intent.authorization.projectDir) {
    return fail(
      "unrepresentable",
      "legacy.launch_payload_tampered",
      `Legacy launch '${intent.outboxId}' targets '${intent.projectDir}', which is not the authorized '${intent.authorization.projectDir}'.`,
    )
  }
  if (intent.correlation.mappingDigest !== intent.authorization.mappingDigest) {
    return fail(
      "unrepresentable",
      "legacy.launch_mapping_tampered",
      `Legacy launch '${intent.outboxId}' names mapping '${intent.correlation.mappingDigest}', which is not the authorized '${intent.authorization.mappingDigest}'.`,
    )
  }
  if (intent.authorization.authorizedBy.length === 0) {
    return fail(
      "unrepresentable",
      "legacy.launch_unattributed",
      `Legacy launch '${intent.outboxId}' names no authorizing principal.`,
    )
  }
  return { ok: true, value: intent }
}

/**
 * A durable, idempotent outbox for legacy launch effects.
 *
 * At-least-once by construction: `record` is keyed by `outboxId`, so a retry
 * of the same legacy job is recognisable and cannot launch twice. Delivery is
 * the caller's effect (the opencode client), because an external effect must
 * not be performed by this module.
 */
export class LegacyLaunchOutbox {
  readonly #records = new Map<string, LegacyLaunchIntent>()

  /**
   * Records an intent. Returns the stored record; re-recording the same
   * `outboxId` is a no-op, which is what makes a retried trigger safe.
   */
  record(intent: LegacyLaunchIntent): LegacyLaunchIntent {
    const existing = this.#records.get(intent.outboxId)
    if (existing !== undefined) return existing
    this.#records.set(intent.outboxId, intent)
    return intent
  }

  /** Marks an intent delivered; the identity survives so redelivery is visible. */
  acknowledge(outboxId: string): LegacyLaunchIntent | undefined {
    const existing = this.#records.get(outboxId)
    if (existing === undefined) return undefined
    const acknowledged = legacyLaunchIntentSchema.parse({ ...existing, status: "delivered" })
    this.#records.set(outboxId, acknowledged)
    return acknowledged
  }

  get(outboxId: string): LegacyLaunchIntent | undefined {
    return this.#records.get(outboxId)
  }

  list(): readonly LegacyLaunchIntent[] {
    return [...this.#records.values()]
  }
}

// --- Adapter --------------------------------------------------------------

/**
 * The minimal command boundary the adapter needs.
 *
 * The kernel's `DispatchCoordinator` satisfies this structurally, and so does a
 * recording fake, so the compatibility policy can be tested without a
 * database. Declared here rather than imported from the coordinator so the
 * legacy layer depends on the *command seam*, not on the kernel's internals.
 */
export interface LegacyCommandSink {
  submit(command: OrchestrationCommand): { ok: true; value: { events: readonly string[]; duplicate: boolean } } | { ok: false; error: { code: string; message: string } }
}

export const legacyTranslationModeSchema = z.enum(["absent", "present"])

export type LegacyTranslationMode = z.infer<typeof legacyTranslationModeSchema>

/**
 * What the legacy route should do after asking the kernel to record a trigger.
 *
 * `effect` is the NAMED runtime launch, never a performed one. The route
 * performs it after the append has committed, which is what keeps the runtime
 * effect outside the event transaction.
 */
export type LegacyTriggerAcceptance =
  | {
      readonly ok: true
      readonly mode: LegacyTranslationMode
      readonly correlation?: LegacyCorrelation
      readonly effect?: LegacyLaunchIntent
      readonly events: readonly string[]
    }
  | { readonly ok: false; readonly mode: LegacyTranslationMode; readonly error: LegacyTranslationError }

export interface LegacyTranslationDependencies {
  readonly mode: LegacyTranslationMode
  readonly context: LegacyTranslationContext
  /** Injected clock. The mapping itself never reads it. */
  readonly now: () => Timestamp
  /** Required in `present` mode; absent in `absent` mode. */
  readonly commands?: LegacyCommandSink
  readonly outbox?: LegacyLaunchOutbox
}

/**
 * The seam the legacy routes talk to.
 *
 * In `absent` mode every method is a no-op that reports `mode: "absent"`, so a
 * bridge running the released behaviour takes exactly the same code path as one
 * running with the kernel attached. That is what makes compatibility a
 * property of the code rather than of a deployment flag.
 */
export class LegacyTranslation {
  readonly mode: LegacyTranslationMode
  readonly #context: LegacyTranslationContext
  readonly #now: () => Timestamp
  readonly #commands: LegacyCommandSink | undefined
  readonly #outbox: LegacyLaunchOutbox

  constructor(dependencies: LegacyTranslationDependencies) {
    this.mode = legacyTranslationModeSchema.parse(dependencies.mode)
    this.#context = legacyTranslationContextSchema.parse(dependencies.context)
    this.#now = dependencies.now
    this.#commands = this.mode === "present" ? dependencies.commands : undefined
    this.#outbox = dependencies.outbox ?? new LegacyLaunchOutbox()
  }

  /**
   * Records a legacy trigger's accepted intent and names its runtime launch.
   *
   * Fails closed: an unrepresentable or malformed job returns a diagnosable
   * error rather than being accepted and quietly ignored. The route turns that
   * into a 5xx instead of a 202, so no caller is told work started when the
   * kernel cannot account for it.
   */
  acceptTrigger(jobInput: unknown, options?: { readonly authorizedBy?: string }): LegacyTriggerAcceptance {
    if (this.mode === "absent") return { ok: true, mode: "absent", events: [] }

    const translated = translateLegacyJob(jobInput, this.#context)
    if (!translated.ok) return { ok: false, mode: "present", error: translated.error }

    // Record the OUTCOME first. A kernel that cannot account for the job must
    // not then launch it, so the append happens before the effect is named.
    const submitted = this.#commands!.submit(
      legacyRunCreateCommand(
        { correlation: translated.correlation, run: translated.run, task: translated.task, dispatch: translated.dispatch },
        {
          now: this.#now(),
          actor: { kind: "node", nodeId: this.#context.controllerNodeId },
          context: this.#context,
          correlationId: legacyCorrelationIdFor({
            correlation: translated.correlation,
            run: translated.run,
            task: translated.task,
            dispatch: translated.dispatch,
          }),
        },
      ),
    )
    if (!submitted.ok) {
      return {
        ok: false,
        mode: "present",
        error: legacyTranslationErrorSchema.parse({
          code: "legacy.append_rejected",
          message: `The kernel refused to record legacy job '${translated.correlation.legacyJobId}': ${submitted.error.message}`,
          disposition: "unrepresentable",
          diagnostics: [{ code: submitted.error.code, message: submitted.error.message }],
        }),
      }
    }

    const record = jobInput as LegacyJobRecord
    const effect = this.#outbox.record(
      legacyLaunchIntent(
        { correlation: translated.correlation, run: translated.run, task: translated.task, dispatch: translated.dispatch },
        {
          trigger: {
            project_dir: record.trigger.project_dir,
            prompt: record.trigger.prompt,
            capability: record.trigger.capability,
            source_agent_id: record.trigger.source_agent_id,
          },
        },
        // The route has authenticated the caller, the source/capability pair and
        // the project allowlist by this point. Naming the principal makes the
        // legacy authorization auditable at the effect boundary instead of being
        // an implicit claim.
        { authorizedBy: options?.authorizedBy ?? `legacy-bridge:${this.#context.localAgentId}` },
      ),
    )
    return { ok: true, mode: "present", correlation: translated.correlation, effect, events: submitted.value.events }
  }

  /**
   * The correlation for an already-stored legacy job, for `/jobs/:id`.
   *
   * Derived, not looked up: the same legacy record always yields the same
   * canonical ids, so a query answers without the record having been translated
   * in this process. That is what makes the mapping stable across restarts.
   */
  correlate(jobInput: unknown): LegacyTranslationResult {
    return translateLegacyJob(jobInput, this.#context)
  }

  /**
   * Records a `/report` callback's effect on a blocked legacy job.
   *
   * A report is an OBSERVATION, not a command: it unblocks the legacy read
   * model, and any canonical state change it implies is a separate decision
   * requiring its own approval. So this names the launch if one is owed and
   * never fabricates lifecycle events.
   */
  recordReport(jobInput: unknown): LegacyTriggerAcceptance {
    if (this.mode === "absent") return { ok: true, mode: "absent", events: [] }
    const correlated = this.correlate(jobInput)
    if (!correlated.ok) return { ok: false, mode: "present", error: correlated.error }
    return { ok: true, mode: "present", correlation: correlated.correlation, events: [] }
  }

  /** Acknowledges a delivered launch effect, making redelivery recognisable. */
  acknowledgeLaunch(outboxId: string): LegacyLaunchIntent | undefined {
    return this.#outbox.acknowledge(outboxId)
  }

  launchIntents(): readonly LegacyLaunchIntent[] {
    return this.#outbox.list()
  }
}

/** A translation that is explicitly not attached to a kernel. */
export function absentLegacyTranslation(context: LegacyTranslationContext, now: () => Timestamp): LegacyTranslation {
  return new LegacyTranslation({ mode: "absent", context, now })
}

export {
  legacyAgentMappingSchema,
  legacyJobRecordSchema,
  legacyProjectMappingSchema,
  legacyTranslationContextSchema as translationContextSchema,
}

export type {
  Actor,
  CommandId,
  CorrelationId,
  Digest,
  Dispatch,
  Epoch,
  LeaseId,
  LegacyJobRecord,
  NodeId,
  ProjectId,
  ProjectPathId,
  Run,
  RunId,
  Task,
  TaskId,
  Timestamp,
}
