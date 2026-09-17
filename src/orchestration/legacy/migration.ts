import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { ZodError } from "zod"
import { digestDispatchEnvelope, digestJson } from "../digest.js"
import { capabilitySchema } from "../identifiers.js"
import {
  dispatchSchema,
  memoryRecordSchema,
  runSchema,
  taskSchema,
} from "../schemas.js"
import {
  legacyMigrationContextSchema,
  legacyMigrationDryRunSchema,
  legacyMigrationSourceSchema,
  legacyTasksSchema,
} from "./schemas.js"
import type {
  LegacyBridgeConfig,
  LegacyJobRecord,
  LegacyJobStatus,
  LegacyMigrationContext,
  LegacyMigrationDryRun,
  LegacyTaskEntry,
  MigrationDiagnostic,
} from "./types.js"

const TASK_HEADING_RE =
  /^## #(\d+)\s+(.+?)(?:\s+\[agent:([^\]]+)\])?(?:\s+\[status:([^\]]+)\])?(?:\s+\[needs:\s*([^\]]+)\])?\s*$/

interface ParsedTasks {
  tasks: LegacyTaskEntry[]
  diagnostics: MigrationDiagnostic[]
}

function diagnostic(
  severity: "warning" | "error",
  code: string,
  message: string,
  source?: { namespace: string; id: string },
): MigrationDiagnostic {
  return source === undefined ? { severity, code, message } : { severity, code, message, source }
}

function parseLegacyTasks(markdown: string): ParsedTasks {
  const candidates: unknown[] = []
  const diagnostics: MigrationDiagnostic[] = []
  let current: {
    id: string
    title: string
    agent?: string
    status: string
    depends_on: string[]
    metadata: Record<string, string>
  } | undefined

  const flush = (): void => {
    if (current !== undefined) candidates.push(current)
    current = undefined
  }

  markdown.split("\n").forEach((line, lineIndex) => {
    const match = TASK_HEADING_RE.exec(line)
    if (match) {
      flush()
      const [, number, title, agent, status = "pending", needs] = match
      current = {
        id: `#${number}`,
        title: title.trim(),
        ...(agent === undefined ? {} : { agent }),
        status,
        depends_on: needs === undefined ? [] : needs.split(",").map((value) => value.trim()).filter(Boolean),
        metadata: {},
      }
      return
    }

    if (/^##\s+#/.test(line)) {
      diagnostics.push(diagnostic("error", "tasks.invalid_heading", `Task heading on line ${lineIndex + 1} is unsupported or malformed.`))
      flush()
      return
    }

    if (current !== undefined && line.startsWith("- ")) {
      const [key, ...valueParts] = line.slice(2).split(":")
      if (key !== undefined && valueParts.length > 0) current.metadata[key.trim()] = valueParts.join(":").trim()
    }
  })
  flush()

  const parsed = legacyTasksSchema.safeParse(candidates)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(diagnostic("error", "tasks.invalid_record", `Task document validation failed at ${issue.path.join(".") || "root"}: ${issue.message}`))
    }
    return { tasks: [], diagnostics }
  }
  return { tasks: parsed.data, diagnostics }
}

function deterministicId(kind: "run" | "task" | "dispatch" | "role" | "memory", sourceKey: string): string {
  const hash = createHash("sha256").update(`aibridge-legacy-v1\0${kind}\0${sourceKey}`, "utf8").digest("hex")
  return `legacy.${kind}.${hash.slice(0, 40)}`
}

function sourceScopeKey(sourceProfileId: string, legacyNodeId: string, legacyProjectId: string): string {
  return digestJson({ sourceProfileId, legacyNodeId, legacyProjectId })
}

function jobImportKey(scopeKey: string, jobId: string): string {
  return `legacy.job:${scopeKey.slice("sha256:".length, "sha256:".length + 40)}:${jobId}`
}

function materialMappingFingerprint(
  context: LegacyMigrationContext,
  config: LegacyBridgeConfig,
): ReturnType<typeof digestJson> {
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
  const agentMappings = [...context.agentMappings].sort((left, right) => compare(left.legacyAgentId, right.legacyAgentId))
  const projectMappings = [...context.projectMappings].sort((left, right) => compare(left.legacyProjectId, right.legacyProjectId))
  return digestJson({
    schemaVersion: context.schemaVersion,
    sourceProfileId: context.sourceProfileId,
    meshId: context.meshId,
    controllerNodeId: context.controllerNodeId,
    controllerEpoch: context.controllerEpoch,
    pathResolutionBase: resolve(context.pathResolutionBase),
    legacyConfigurationDigest: digestJson(config),
    agentMappings,
    projectMappings,
  })
}

function emptyResult(diagnostics: MigrationDiagnostic[]): LegacyMigrationDryRun {
  return legacyMigrationDryRunSchema.parse({
    schemaVersion: 1,
    mode: "dry-run",
    canCommit: false,
    jobs: [],
    tasks: [],
    memory: [],
    diagnostics,
  })
}

function formatIssues(prefix: string, issues: readonly { path: PropertyKey[]; message: string }[]): MigrationDiagnostic[] {
  return issues.map((issue) =>
    diagnostic("error", `${prefix}.invalid`, `${prefix} validation failed at ${issue.path.join(".") || "root"}: ${issue.message}`),
  )
}

function stateFor(status: LegacyJobStatus): {
  run: "paused" | "completed" | "failed"
  task: "pending" | "blocked" | "ready" | "running" | "completed" | "failed"
  dispatch: "proposed" | "running" | "completed" | "failed" | "timed_out"
  disposition: "historical" | "paused"
  reconcile: boolean
} {
  switch (status) {
    case "completed":
      return { run: "completed", task: "completed", dispatch: "completed", disposition: "historical", reconcile: false }
    case "failed":
      return { run: "failed", task: "failed", dispatch: "failed", disposition: "historical", reconcile: false }
    case "timed_out":
      return { run: "failed", task: "failed", dispatch: "timed_out", disposition: "historical", reconcile: false }
    case "received":
      return { run: "paused", task: "pending", dispatch: "proposed", disposition: "paused", reconcile: true }
    case "accepted":
      return { run: "paused", task: "ready", dispatch: "proposed", disposition: "paused", reconcile: true }
    case "blocked":
      return { run: "paused", task: "blocked", dispatch: "proposed", disposition: "paused", reconcile: true }
    case "session_created":
    case "running":
    case "reporting":
      return { run: "paused", task: "running", dispatch: "running", disposition: "paused", reconcile: true }
    case "callback_failed":
      return { run: "paused", task: "blocked", dispatch: "proposed", disposition: "paused", reconcile: true }
  }
}

function jobTaskCandidates(job: LegacyJobRecord, tasks: readonly LegacyTaskEntry[]): LegacyTaskEntry[] {
  return tasks.filter((task) => {
    const metadataJob = task.metadata.Job ?? task.metadata.job ?? task.metadata.job_id
    return task.id === job.trigger.task_id || metadataJob === job.id || task.id === `#${job.id}`
  })
}

function validateMappings(config: LegacyBridgeConfig, context: LegacyMigrationContext): MigrationDiagnostic[] {
  const diagnostics: MigrationDiagnostic[] = []
  const requiredAgents = new Set([
    config.agent_id,
    ...config.security.allowed_sources.map((source) => source.source_agent_id),
    ...config.agents.map((agent) => agent.id),
  ])
  for (const legacyAgentId of requiredAgents) {
    if (!context.agentMappings.some((mapping) => mapping.legacyAgentId === legacyAgentId)) {
      diagnostics.push(diagnostic("error", "mapping.agent_missing", `No explicit node mapping exists for legacy agent '${legacyAgentId}'.`))
    }
  }

  const localNode = context.agentMappings.find((mapping) => mapping.legacyAgentId === config.agent_id)
  if (localNode !== undefined && localNode.nodeId !== context.controllerNodeId) {
    diagnostics.push(diagnostic("warning", "mapping.controller_differs", "The import controller differs from the legacy local node; imported records remain inert."))
  }

  for (const project of config.projects) {
    const mapping = context.projectMappings.find((candidate) => candidate.legacyProjectId === project.id)
    if (mapping === undefined) {
      diagnostics.push(diagnostic("error", "mapping.project_missing", `No explicit canonical mapping exists for legacy project '${project.id}'.`))
      continue
    }
    if (resolve(context.pathResolutionBase, mapping.configuredPath) !== resolve(context.pathResolutionBase, project.path)) {
      diagnostics.push(diagnostic("error", "mapping.project_path_mismatch", `Canonical mapping for legacy project '${project.id}' does not preserve its resolved path.`))
    }
    if (localNode !== undefined && mapping.targetNodeId !== localNode.nodeId) {
      diagnostics.push(diagnostic("error", "mapping.project_node_mismatch", `Canonical mapping for legacy project '${project.id}' targets a different node.`))
    }
  }
  return diagnostics
}

function validateLegacySemantics(
  config: LegacyBridgeConfig,
  jobs: readonly LegacyJobRecord[],
  memory: { decisions: readonly { id: string }[]; handoffs: readonly { id: string }[] },
  pathResolutionBase: string,
): MigrationDiagnostic[] {
  const diagnostics: MigrationDiagnostic[] = []
  const checkUnique = (values: readonly string[], code: string, label: string): void => {
    const seen = new Set<string>()
    for (const value of values) {
      if (seen.has(value)) diagnostics.push(diagnostic("error", code, `${label} '${value}' is duplicated and cannot be mapped unambiguously.`))
      seen.add(value)
    }
  }

  checkUnique(config.security.allowed_sources.map((source) => source.source_agent_id), "config.duplicate_allowed_source", "Allowed source")
  checkUnique(config.agents.map((agent) => agent.id), "config.duplicate_agent", "Legacy agent")
  checkUnique(config.projects.map((project) => project.id), "config.duplicate_project", "Legacy project")
  checkUnique(
    config.projects.map((project) => resolve(pathResolutionBase, project.path)),
    "config.duplicate_project_path",
    "Resolved project path",
  )
  checkUnique(memory.decisions.map((decision) => decision.id), "memory.duplicate_decision", "Legacy decision")
  checkUnique(memory.handoffs.map((handoff) => handoff.id), "memory.duplicate_handoff", "Legacy handoff")

  const declaredCapabilities = [
    ...config.security.allowed_sources.flatMap((source) => [...source.capabilities, ...source.requires_plan_approval]),
    ...config.projects.flatMap((project) => project.capabilities),
    ...config.agents.flatMap((agent) => agent.capabilities),
    ...config.planning.require_approval_for,
    ...jobs.map((job) => job.trigger.capability),
  ]
  for (const capability of new Set(declaredCapabilities)) {
    if (!capabilitySchema.safeParse(capability).success) {
      diagnostics.push(diagnostic("error", "config.unsupported_capability", `Legacy capability '${capability}' cannot be represented by the canonical capability contract.`))
    }
  }


  const sensitiveQueryKeys = new Set([
    "access_token",
    "api_key",
    "apikey",
    "auth",
    "authorization",
    "client_secret",
    "credential",
    "credentials",
    "key",
    "password",
    "secret",
    "sig",
    "signature",
    "token",
    "x-amz-credential",
    "x-amz-signature",
  ])
  const credentialBearingUrl = (value: string): boolean => {
    const parsed = new URL(value)
    if (parsed.username !== "" || parsed.password !== "") return true
    if ([...parsed.searchParams.keys()].some((key) => sensitiveQueryKeys.has(key.toLowerCase()))) return true
    return /(?:^|[&#?])(access_token|api_key|apikey|auth|authorization|client_secret|credential|credentials|key|password|secret|sig|signature|token|x-amz-credential|x-amz-signature)=/i.test(parsed.hash)
  }
  const checkUrl = (label: string, value: string): void => {
    if (credentialBearingUrl(value)) {
      diagnostics.push(diagnostic("error", "security.credential_url", `Legacy URL field '${label}' contains embedded credential material.`))
    }
  }
  checkUrl("bridge.public_url", config.bridge.public_url)
  checkUrl("opencode.base_url", config.opencode.base_url)
  config.agents.forEach((agent, index) => checkUrl(`agents[${index}].url`, agent.url))
  jobs.forEach((job, index) => checkUrl(`jobs[${index}].trigger.callback_url`, job.trigger.callback_url))
  return diagnostics
}

function validateJobRepresentability(
  config: LegacyBridgeConfig,
  jobs: readonly LegacyJobRecord[],
  context: LegacyMigrationContext,
): MigrationDiagnostic[] {
  const diagnostics: MigrationDiagnostic[] = []
  const jobIds = new Set(jobs.map((job) => job.id))
  for (const job of jobs) {
    const reference = { namespace: "legacy.job", id: job.id }
    if (job.trigger.target_agent_id !== config.agent_id) {
      diagnostics.push(diagnostic("error", "authorization.target_mismatch", "Legacy job target does not match the profile's local agent.", reference))
    }
    if (!context.agentMappings.some((mapping) => mapping.legacyAgentId === job.trigger.target_agent_id)) {
      diagnostics.push(diagnostic("error", "mapping.job_target_missing", "Legacy job target has no explicit node and installation mapping.", reference))
    }
    const allowedProject = config.projects.find(
      (project) => resolve(context.pathResolutionBase, project.path) === resolve(context.pathResolutionBase, job.trigger.project_dir),
    )
    if (allowedProject === undefined) {
      diagnostics.push(diagnostic("error", "authorization.project_path_denied", "Legacy job project path is not an exact resolved match for the preserved allowlist.", reference))
    } else if (!context.projectMappings.some((mapping) => mapping.legacyProjectId === allowedProject.id)) {
      diagnostics.push(diagnostic("error", "mapping.job_project_missing", "Legacy job's allowlisted project has no explicit canonical mapping.", reference))
    }

    const localDependencies = new Set<string>(job.depends_on ?? [])
    for (const dependency of job.trigger.depends_on ?? []) {
      if (typeof dependency === "string") localDependencies.add(dependency)
    }
    for (const dependencyId of localDependencies) {
      if (dependencyId === job.id) {
        diagnostics.push(diagnostic("error", "dependency.self_reference", "Legacy job contains a self-dependency and cannot be represented safely.", reference))
      } else if (!jobIds.has(dependencyId)) {
        diagnostics.push(diagnostic("error", "dependency.local_missing", `Legacy local dependency '${dependencyId}' is absent from the import set.`, reference))
      }
    }
  }
  return diagnostics
}

/**
 * Produces a deterministic, side-effect-free migration plan. It never reads or
 * writes profile, job, task, memory, or target-store files.
 */
function buildLegacyMigrationDryRun(sourceInput: unknown, contextInput: unknown): LegacyMigrationDryRun {
  const sourceResult = legacyMigrationSourceSchema.safeParse(sourceInput)
  if (!sourceResult.success) return emptyResult(formatIssues("source", sourceResult.error.issues))

  const contextResult = legacyMigrationContextSchema.safeParse(contextInput)
  if (!contextResult.success) return emptyResult(formatIssues("context", contextResult.error.issues))

  const source = sourceResult.data
  const context = contextResult.data
  const taskParsing = parseLegacyTasks(source.tasksMarkdown)
  const diagnostics = [
    ...taskParsing.diagnostics,
    ...validateLegacySemantics(source.config, source.jobs, source.memory, context.pathResolutionBase),
    ...validateMappings(source.config, context),
    ...validateJobRepresentability(source.config, source.jobs, context),
  ]
  if (diagnostics.some((entry) => entry.severity === "error")) return emptyResult(diagnostics)

  const localNode = context.agentMappings.find((mapping) => mapping.legacyAgentId === source.config.agent_id)!
  const mappingFingerprint = materialMappingFingerprint(context, source.config)
  const jobsById = new Map(source.jobs.map((job) => [job.id, job]))
  const taskToJob = new Map<string, string>()
  const linkedTaskByJob = new Map<string, LegacyTaskEntry>()

  for (const job of source.jobs) {
    const candidates = jobTaskCandidates(job, taskParsing.tasks)
    if (candidates.length > 1) {
      diagnostics.push(diagnostic("error", "tasks.ambiguous_job_link", `More than one legacy task links to job '${job.id}'.`, { namespace: "legacy.job", id: job.id }))
      continue
    }
    const linked = candidates[0]
    if (linked === undefined) continue
    const priorJob = taskToJob.get(linked.id)
    if (priorJob !== undefined && priorJob !== job.id) {
      diagnostics.push(diagnostic("error", "tasks.duplicate_job_link", `Legacy task '${linked.id}' links to more than one job.`, { namespace: "legacy.task", id: linked.id }))
      continue
    }
    taskToJob.set(linked.id, job.id)
    linkedTaskByJob.set(job.id, linked)
  }

  const jobMigrations = source.jobs.map((job) => {
    const jobReference = { namespace: "legacy.job" as const, id: job.id }
    const sourceAuthorization = source.config.security.allowed_sources.find(
      (candidate) => candidate.source_agent_id === job.trigger.source_agent_id,
    )
    const sourceCapabilityAllowed = sourceAuthorization?.capabilities.includes(job.trigger.capability) ?? false
    const targetMatchesLocalAgent = job.trigger.target_agent_id === source.config.agent_id
    const resolvedRequestedPath = resolve(context.pathResolutionBase, job.trigger.project_dir)
    const legacyProject = source.config.projects.find(
      (candidate) => resolve(context.pathResolutionBase, candidate.path) === resolvedRequestedPath,
    )
    const projectPathAllowed = legacyProject !== undefined
    const planApprovalRequired = source.config.planning.require_approval_for.includes(job.trigger.capability)
    const legacyPlanAnnotationApproved = job.trigger.metadata?.plan_status === "approved"
    const historicalChecksPass =
      targetMatchesLocalAgent &&
      sourceCapabilityAllowed &&
      projectPathAllowed &&
      (!planApprovalRequired || legacyPlanAnnotationApproved)

    if (!sourceCapabilityAllowed) diagnostics.push(diagnostic("error", "authorization.source_capability_denied", "Legacy job source/capability is not present in the preserved allowed-source policy.", jobReference))
    if (planApprovalRequired && !legacyPlanAnnotationApproved) diagnostics.push(diagnostic("error", "authorization.legacy_plan_not_approved", "Legacy job lacks the plan annotation required by the current compatibility policy.", jobReference))

    const localDependencies = new Set<string>(job.depends_on ?? [])
    const remoteDependencies: Array<{ agent_id: string; job_id: string; status?: "completed" | "failed" | "timed_out" | "callback_failed"; reportedAt?: string }> = [
      ...(job.remoteDependencies ?? []),
    ]
    for (const dependency of job.trigger.depends_on ?? []) {
      if (typeof dependency === "string") localDependencies.add(dependency)
      else if (!remoteDependencies.some((candidate) => candidate.agent_id === dependency.agent_id && candidate.job_id === dependency.job_id)) {
        remoteDependencies.push(dependency)
      }
    }

    for (const dependencyId of localDependencies) {
      if (jobsById.has(dependencyId)) {
        diagnostics.push(diagnostic("warning", "dependency.local_cross_run_reference", "Legacy local dependency is preserved as compatibility evidence and is not converted into a canonical Task edge across Runs.", jobReference))
      }
    }

    const projectMapping = context.projectMappings.find((mapping) => mapping.legacyProjectId === legacyProject?.id)
    if (projectMapping === undefined) {
      throw new Error("Validated project mapping unexpectedly missing")
    }
    const targetMapping = context.agentMappings.find((mapping) => mapping.legacyAgentId === job.trigger.target_agent_id)
    if (targetMapping === undefined) {
      throw new Error("Validated target mapping unexpectedly missing")
    }

    const scopeKey = sourceScopeKey(context.sourceProfileId, source.config.agent_id, legacyProject!.id)
    const scopedJobKey = `${scopeKey}\0${job.id}`
    const runId = deterministicId("run", scopedJobKey)
    const taskId = deterministicId("task", scopedJobKey)
    const dispatchId = deterministicId("dispatch", scopedJobKey)
    const linkedTask = linkedTaskByJob.get(job.id)
    const state = stateFor(job.status)
    const references = linkedTask === undefined
      ? [jobReference]
      : [jobReference, { namespace: "legacy.task", id: linkedTask.id }]

    const run = runSchema.parse({
      schemaVersion: 1,
      runId,
      projectId: projectMapping.projectId,
      goal: job.trigger.prompt,
      state: historicalChecksPass ? state.run : "paused",
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      externalReferences: [jobReference],
    })
    const task = taskSchema.parse({
      schemaVersion: 1,
      taskId,
      runId,
      projectId: projectMapping.projectId,
      title: linkedTask?.title ?? `Legacy job ${job.id}`.slice(0, 256),
      description: job.trigger.prompt,
      state: historicalChecksPass ? state.task : "blocked",
      dependencies: [],
      externalReferences: references,
    })

    const allowed = historicalChecksPass ? [job.trigger.capability] : []
    const denied = historicalChecksPass ? [] : [job.trigger.capability]
    const approvalCapabilities = historicalChecksPass && (planApprovalRequired || sourceAuthorization?.requires_plan_approval.includes(job.trigger.capability))
      ? [job.trigger.capability]
      : []
    const permissionEnvelope = {
      allowedCapabilities: allowed,
      deniedCapabilities: denied,
      approvalRequirements: {
        destructiveEffects: true,
        externalEffects: true,
        capabilities: approvalCapabilities,
      },
    }
    const roleSnapshot = {
      schemaVersion: 1 as const,
      roleId: deterministicId("role", scopedJobKey),
      templateVersion: 1,
      projectId: projectMapping.projectId,
      name: "Legacy compatibility import",
      purpose: "Preserve one legacy job as inert migration evidence.",
      instructions: "Do not execute without reconciliation, current authorization, a current lease, and any required fresh approval.",
      requiredCapabilities: [job.trigger.capability],
      preferredRuntimeKinds: [targetMapping.runtimeKind],
      contextSelectionPolicyReference: { namespace: "aibridge.migration-policy", id: "legacy-v1-inert" },
      permissionRestrictions: permissionEnvelope,
      author: { kind: "system" as const, name: "legacy-migration" },
      createdAt: context.importedAt,
    }
    const contextManifest = {
      references: [],
      manifestDigest: digestJson({ references: [] }),
    }
    const envelope = {
      schemaVersion: 1 as const,
      dispatchId,
      attempt: 1,
      projectId: projectMapping.projectId,
      runId,
      taskId,
      targetNodeId: targetMapping.nodeId,
      installationId: targetMapping.installationId,
      runtimeKind: targetMapping.runtimeKind,
      projectPathId: projectMapping.projectPathId,
      prompt: job.trigger.prompt,
      roleSnapshot,
      ruleSnapshots: [],
      contextManifest,
      requestedCapabilities: [job.trigger.capability],
      permissionEnvelope,
      dependencies: [],
      timeoutSeconds: job.trigger.timeout_seconds,
      controllerEpoch: context.controllerEpoch,
    }
    const dispatch = dispatchSchema.parse({
      schemaVersion: 1,
      envelope,
      envelopeDigest: digestDispatchEnvelope(envelope),
      state: historicalChecksPass ? state.dispatch : "proposed",
      createdAt: job.createdAt,
      externalReferences: [jobReference],
    })

    if (job.status === "callback_failed") {
      diagnostics.push(diagnostic("warning", "status.callback_outcome_ambiguous", "Callback failure is preserved separately and is not translated into task or dispatch failure.", jobReference))
    }
    if (job.trigger.metadata?.plan_status === "approved") {
      diagnostics.push(diagnostic("warning", "approval.annotation_not_authority", "Legacy plan approval text is retained as evidence but no canonical approval is created.", jobReference))
    }

    return {
      importKey: jobImportKey(scopeKey, job.id),
      sourceDigest: digestJson(job),
      mappingFingerprint,
      legacyRecord: job,
      disposition: historicalChecksPass ? state.disposition : "rejected" as const,
      executionPolicy: "inert" as const,
      requiresReconciliation: state.reconcile || !historicalChecksPass,
      authorization: {
        bearerAuthentication: "required_not_persisted" as const,
        targetMatchesLocalAgent,
        sourceCapabilityAllowed,
        projectPathAllowed,
        planApprovalRequired,
        legacyPlanAnnotationApproved,
        canonicalApprovalCreated: false as const,
        historicalChecksPass,
      },
      legacyStatus: job.status,
      ...(job.callbackDelivery === undefined ? {} : { callbackDelivery: job.callbackDelivery }),
      localDependencyReferences: [...localDependencies].map((id) => ({ namespace: "legacy.job" as const, id })),
      remoteDependencyReferences: remoteDependencies.map((dependency) => ({
        namespace: "legacy.remote-job" as const,
        id: `${dependency.agent_id}/${dependency.job_id}`,
        ...(dependency.status === undefined ? {} : { status: dependency.status }),
        ...(dependency.reportedAt === undefined ? {} : { reportedAt: dependency.reportedAt }),
      })),
      ...(job.opencodeSessionId === undefined
        ? {}
        : { providerSessionReference: { namespace: "opencode.session" as const, id: job.opencodeSessionId } }),
      run,
      task,
      dispatch,
    }
  })

  const taskMigrations = taskParsing.tasks.map((task) => {
    const linkedJob = taskToJob.get(task.id)
    if (linkedJob === undefined) {
      diagnostics.push(diagnostic("error", "tasks.unmatched", `Legacy task '${task.id}' cannot be scoped to a canonical run without inventing ownership.`, { namespace: "legacy.task", id: task.id }))
    }
    return {
      reference: { namespace: "legacy.task" as const, id: task.id },
      disposition: linkedJob === undefined ? "rejected" as const : "linked" as const,
      ...(linkedJob === undefined
        ? {}
        : {
            canonicalTaskId: deterministicId(
              "task",
              `${sourceScopeKey(context.sourceProfileId, source.config.agent_id, source.config.projects.find((project) =>
                resolve(context.pathResolutionBase, project.path) === resolve(context.pathResolutionBase, jobsById.get(linkedJob)!.trigger.project_dir),
              )!.id)}\0${linkedJob}`,
            ),
          }),
      legacyStatus: task.status,
      legacyRecord: task,
    }
  })

  const memoryProject = source.config.projects.find((project) => project.id === source.memory.projectId)
  const memoryProjectMapping = context.projectMappings.find((mapping) => mapping.legacyProjectId === source.memory.projectId)
  if (memoryProject === undefined || memoryProjectMapping === undefined) {
    diagnostics.push(diagnostic("error", "memory.project_unmapped", "Legacy memory project does not have an exact profile and canonical project mapping."))
  }
  const canonicalMemory = memoryProjectMapping === undefined ? [] : [
    ...source.memory.decisions.map((decision) => memoryRecordSchema.parse({
      schemaVersion: 1,
      memoryId: deterministicId("memory", `${sourceScopeKey(context.sourceProfileId, source.config.agent_id, source.memory.projectId)}\0decision:${decision.id}`),
      projectId: memoryProjectMapping.projectId,
      kind: "decision",
      content: decision.content,
      contentDigest: digestJson(decision.content),
      scope: { kind: "project" },
      author: { kind: "system", name: "legacy-migration" },
      createdAt: decision.timestamp,
      sourceReferences: [
        { namespace: "legacy.memory.decision", id: decision.id },
        { namespace: "legacy.agent-label", id: decision.agent },
      ],
      trustState: "proposed",
      sensitivity: "internal",
      retention: "project",
    })),
    ...source.memory.constraints.map((constraint, index) => memoryRecordSchema.parse({
      schemaVersion: 1,
      memoryId: deterministicId("memory", `${sourceScopeKey(context.sourceProfileId, source.config.agent_id, source.memory.projectId)}\0constraint:${index}`),
      projectId: memoryProjectMapping.projectId,
      kind: "constraint",
      content: constraint,
      contentDigest: digestJson(constraint),
      scope: { kind: "project" },
      author: { kind: "system", name: "legacy-migration" },
      createdAt: context.importedAt,
      sourceReferences: [{ namespace: "legacy.memory.constraint", id: String(index) }],
      trustState: "proposed",
      sensitivity: "internal",
      retention: "project",
    })),
    ...source.memory.handoffs.map((handoff) => {
      const content = handoff.context
      return memoryRecordSchema.parse({
        schemaVersion: 1,
        memoryId: deterministicId("memory", `${sourceScopeKey(context.sourceProfileId, source.config.agent_id, source.memory.projectId)}\0handoff:${handoff.id}`),
        projectId: memoryProjectMapping.projectId,
        kind: "handoff",
        content,
        contentDigest: digestJson(content),
        scope: { kind: "project" },
        author: { kind: "system", name: "legacy-migration" },
        createdAt: handoff.createdAt,
        sourceReferences: [
          { namespace: "legacy.memory.handoff", id: handoff.id },
          { namespace: "legacy.agent-label", id: handoff.from },
          { namespace: "legacy.agent-label", id: handoff.to },
          { namespace: "legacy.handoff-status", id: handoff.status },
        ],
        trustState: "proposed",
        sensitivity: "internal",
        retention: "project",
      })
    }),
  ]

  const configuration = {
    sourceDigest: digestJson(source.config),
    mappingFingerprint,
    sourceProfileId: context.sourceProfileId,
    legacyRecord: source.config,
    authentication: {
      mode: "bearer-token" as const,
      disposition: "compatibility_only" as const,
      tokenMaterial: "not_imported" as const,
    },
    localAgentId: source.config.agent_id,
    allowedSources: source.config.security.allowed_sources,
    projects: source.config.projects.map((project) => {
      const mapping = context.projectMappings.find((candidate) => candidate.legacyProjectId === project.id)
      return {
        legacyProjectId: project.id,
        configuredPath: project.path,
        resolvedPath: resolve(context.pathResolutionBase, project.path),
        capabilities: project.capabilities,
        ...(mapping === undefined ? {} : {
          canonicalProjectId: mapping.projectId,
          canonicalProjectPathId: mapping.projectPathId,
        }),
      }
    }),
  }

  const result = {
    schemaVersion: 1 as const,
    mode: "dry-run" as const,
    canCommit: !diagnostics.some((entry) => entry.severity === "error"),
    sourceDigest: digestJson({
      config: source.config,
      jobs: source.jobs,
      tasksMarkdown: source.tasksMarkdown,
      memory: source.memory,
    }),
    mappingFingerprint,
    configuration,
    jobs: jobMigrations,
    tasks: taskMigrations,
    memory: canonicalMemory,
    diagnostics,
  }
  return legacyMigrationDryRunSchema.parse(result)
}

/**
 * Fail-closed public boundary for untrusted legacy data. Legacy schemas are
 * intentionally broader than canonical v1 contracts, so representability
 * failures must become non-committable diagnostics rather than exceptions.
 */
export function dryRunLegacyMigration(sourceInput: unknown, contextInput: unknown): LegacyMigrationDryRun {
  try {
    return buildLegacyMigrationDryRun(sourceInput, contextInput)
  } catch (error) {
    if (error instanceof ZodError) {
      return emptyResult([
        diagnostic(
          "error",
          "conversion.canonical_validation_failed",
          "Legacy input cannot be represented by the canonical version-one contracts.",
        ),
      ])
    }
    throw error
  }
}
