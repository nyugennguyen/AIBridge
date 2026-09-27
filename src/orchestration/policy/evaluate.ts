import { digestDispatchEnvelope, digestJson } from "../digest.js"
import { createContractError, type ContractError, type Result } from "../errors.js"
import type { Rule } from "../types.js"
import {
  SAFETY_FLOOR_NARROWING,
  dispatchNarrowing,
  narrowPolicyState,
  seedPolicyState,
  sortedUnique,
} from "./floor.js"
import {
  POLICY_PRECEDENCE,
  PolicyProjectScopeError,
  type EffectivePolicyState,
  type NarrowingOutcome,
  type PermissionNarrowing,
  type PolicyDecision,
  type PolicyDenial,
  type PolicyEvaluation,
  type PolicyEvaluationInput,
  type PolicyExplanationNode,
  type PolicyLayerId,
  type PreApprovalBasis,
  type ProjectPolicy,
  type RuleMatchContext,
  type RuleMatchOutcome,
} from "./types.js"
import { policyEvaluationInputSchema } from "./types.js"

const INDENT = "  "

/** A layer that declares nothing: used for the placeholder nodes of absent layers. */
function noNarrowing(): PermissionNarrowing {
  return { deniedCapabilities: [], requireApprovalForCapabilities: [] }
}

// --- Rule matching ---

/**
 * Deterministic rule matching. Every declared criterion must hold (logical AND);
 * omitted criteria are not evaluated. A malformed `taskTitlePattern` never
 * matches, which fails closed for both `restrict` and `pre_approve` effects.
 */
export function matchRule(rule: Rule, context: RuleMatchContext): RuleMatchOutcome {
  if (!rule.enabled) {
    return { matched: false, reason: `rule ${rule.ruleId}@${rule.templateVersion} is disabled` }
  }

  const match = rule.match

  if (match.taskTitlePattern !== undefined) {
    if (context.taskTitle === null) {
      return { matched: false, reason: `rule ${rule.ruleId}@${rule.templateVersion} requires a task title but none was supplied` }
    }
    let pattern: RegExp
    try {
      pattern = new RegExp(match.taskTitlePattern)
    } catch {
      return {
        matched: false,
        reason: `rule ${rule.ruleId}@${rule.templateVersion} has an invalid taskTitlePattern and never matches`,
      }
    }
    if (!pattern.test(context.taskTitle)) {
      return {
        matched: false,
        reason: `rule ${rule.ruleId}@${rule.templateVersion} taskTitlePattern did not match the task title`,
      }
    }
  }

  if (match.requestedCapabilitiesAny !== undefined) {
    const requested = new Set(context.requestedCapabilities)
    const hit = match.requestedCapabilitiesAny.some((capability) => requested.has(capability))
    if (!hit) {
      return {
        matched: false,
        reason: `rule ${rule.ruleId}@${rule.templateVersion} requestedCapabilitiesAny did not intersect the requested capabilities`,
      }
    }
  }

  if (match.runtimeKinds !== undefined && !match.runtimeKinds.includes(context.runtimeKind)) {
    return {
      matched: false,
      reason: `rule ${rule.ruleId}@${rule.templateVersion} runtimeKinds did not include the dispatch runtime kind`,
    }
  }

  return { matched: true, reason: `rule ${rule.ruleId}@${rule.templateVersion} matched` }
}

// --- Rule ordering and supersession ---

interface OrderedRule {
  readonly rule: Rule
  readonly superseded: boolean
}

/**
 * Rule versions are append-only, so when several versions of the same `ruleId`
 * are snapshotted onto one envelope only the highest version is effective; the
 * lower versions are recorded as `superseded` in the explanation tree. The
 * resulting order (ruleId ascending, then version ascending) makes the
 * evaluation independent of the snapshot array order.
 */
export function orderRuleSnapshots(rules: readonly Rule[]): OrderedRule[] {
  const highest = new Map<string, number>()
  for (const rule of rules) {
    highest.set(rule.ruleId, Math.max(highest.get(rule.ruleId) ?? 0, rule.templateVersion))
  }
  return [...rules]
    .sort((a, b) => (a.ruleId === b.ruleId ? a.templateVersion - b.templateVersion : a.ruleId.localeCompare(b.ruleId)))
    .map((rule) => ({ rule, superseded: rule.templateVersion !== highest.get(rule.ruleId) }))
}

// --- Explanation tree rendering ---

function renderNode(node: PolicyExplanationNode, depth: number, lines: string[]): void {
  const subject = node.subject === undefined ? "" : ` ${node.subject}@${node.ruleVersion ?? 1}`
  const detail = detailFor(node)
  lines.push(`${INDENT.repeat(depth)}${node.layer}${subject}: ${node.outcome} — ${node.reason}${detail}`)
  for (const child of node.children) {
    renderNode(child, depth + 1, lines)
  }
}

function detailFor(node: PolicyExplanationNode): string {
  const parts: string[] = []
  if (node.removedCapabilities.length > 0) parts.push(`removed=[${node.removedCapabilities.join(",")}]`)
  if (node.deniedCapabilities.length > 0) parts.push(`denied=[${node.deniedCapabilities.join(",")}]`)
  if (node.grantedPreApprovals.length > 0) parts.push(`preApproved=[${node.grantedPreApprovals.join(",")}]`)
  if (node.rejectedPreApprovals.length > 0) parts.push(`rejected=[${node.rejectedPreApprovals.join(",")}]`)
  if (node.wideningAttempts.length > 0) parts.push(`ignoredWidening=[${node.wideningAttempts.join("; ")}]`)
  return parts.length === 0 ? "" : ` (${parts.join(" ")})`
}

/**
 * Renders the explanation tree as human-readable text.
 *
 * The rendering is intentionally free of prompt text, role instructions and
 * terminal bytes: only identifiers, capability names, flags and rule metadata
 * are emitted, so the result is safe to store and to show in an audit view.
 */
export function renderPolicyExplanation(evaluation: {
  readonly decision: PolicyDecision
  readonly explanation: PolicyExplanationNode
  readonly outstandingApprovals: readonly string[]
  readonly denials: readonly PolicyDenial[]
  readonly grantedPreApprovals: readonly string[]
  readonly preApprovalBasis: PreApprovalBasis | null
  readonly effectiveTimeoutSeconds: number
}): string {
  const lines: string[] = []
  renderNode(evaluation.explanation, 0, lines)
  lines.push(`decision: ${evaluation.decision}`)
  lines.push(`effectiveTimeoutSeconds: ${evaluation.effectiveTimeoutSeconds}`)
  if (evaluation.preApprovalBasis === null) {
    lines.push("preApprovalBasis: none")
  } else {
    lines.push(`preApprovalBasis: ${evaluation.preApprovalBasis.ruleId}@${evaluation.preApprovalBasis.ruleVersion}`)
  }
  if (evaluation.grantedPreApprovals.length > 0) {
    lines.push(`grantedPreApprovals: ${evaluation.grantedPreApprovals.join(",")}`)
  }
  if (evaluation.outstandingApprovals.length === 0) {
    lines.push("outstandingApprovals: none")
  } else {
    lines.push("outstandingApprovals:")
    for (const item of evaluation.outstandingApprovals) lines.push(`${INDENT}- ${item}`)
  }
  if (evaluation.denials.length === 0) {
    lines.push("denials: none")
  } else {
    lines.push("denials:")
    for (const denial of evaluation.denials) {
      const where = denial.subject === undefined ? "" : ` (${denial.layer ?? "policy"}:${denial.subject})`
      lines.push(`${INDENT}- ${denial.code}${where}: ${denial.message}`)
    }
  }
  return lines.join("\n")
}

// --- Evaluation ---

/**
 * Classifies what a narrowing layer actually did.
 *
 * `widening_rejected` is the outcome whenever the layer recorded at least one
 * widening attempt, and it takes precedence over `narrowed`: a layer that tried
 * to escalate is an audit event whether or not it also narrowed something, and
 * burying the attempt under `narrowed` is the same under-reporting that made
 * `unchanged` wrong. Nothing is lost by the precedence — `wideningAttempts`,
 * `removedCapabilities` and `deniedCapabilities` are all still on the node.
 *
 * The more specific rule-node outcomes (`skipped`, `superseded`,
 * `pre_approved`, `pre_approval_rejected`) are chosen by their own call sites
 * and are not routed through here, because they already say something strictly
 * more precise than "a widening was rejected".
 */
function narrowingOutcome(outcomeDetail: NarrowingOutcome): PolicyExplanationNode["outcome"] {
  if (outcomeDetail.wideningAttempts.length > 0) return "widening_rejected"
  return outcomeDetail.changed ? "narrowed" : "unchanged"
}

/**
 * Appends the rejection of any widening attempt to a layer's reason, so the
 * rendered line explains *why* the node has no effect instead of leaving the
 * reader to infer it from a bare `unchanged`.
 */
function narrowingReason(base: string, attempts: readonly string[]): string {
  if (attempts.length === 0) return base
  return `${base}; ${attempts.length} widening attempt(s) were rejected and had no effect`
}

/**
 * Collects every widening attempt recorded anywhere in a set of explanation
 * nodes and all of their descendants.
 *
 * The result is `sortedUnique`, so it is independent of the traversal order and
 * of how many parents happen to re-report the same attempt: the `rule` layer
 * node re-states its children's attempts, so a naive recursive concatenation
 * would count each of them twice. De-duplication is therefore what makes the
 * root aggregate a faithful set of *distinct* escalation attempts.
 *
 * The root node uses this so that a reader of the top of the tree — an audit
 * view, a log line, a human reviewer — sees every attempted privilege escalation
 * rather than only the ones made during the pre-approval pass.
 */
export function collectWideningAttempts(nodes: readonly PolicyExplanationNode[]): string[] {
  const collected: string[] = []
  for (const node of nodes) {
    collected.push(...node.wideningAttempts)
    collected.push(...collectWideningAttempts(node.children))
  }
  return sortedUnique(collected)
}

function layerNode(
  nodeId: string,
  layer: PolicyLayerId,
  applied: boolean,
  outcome: PolicyExplanationNode["outcome"],
  reason: string,
  outcomeDetail: NarrowingOutcome,
  state: EffectivePolicyState,
  children: readonly PolicyExplanationNode[] = [],
): PolicyExplanationNode {
  return {
    nodeId,
    layer,
    applied,
    outcome,
    reason,
    removedCapabilities: outcomeDetail.removedCapabilities,
    deniedCapabilities: outcomeDetail.deniedCapabilities,
    grantedPreApprovals: [],
    rejectedPreApprovals: [],
    wideningAttempts: outcomeDetail.wideningAttempts,
    effective: state,
    children,
  }
}

function ruleNode(
  rule: Rule,
  outcome: PolicyExplanationNode["outcome"],
  reason: string,
  state: EffectivePolicyState,
  extras: {
    readonly removedCapabilities?: readonly string[]
    readonly deniedCapabilities?: readonly string[]
    readonly grantedPreApprovals?: readonly string[]
    readonly rejectedPreApprovals?: readonly string[]
    readonly wideningAttempts?: readonly string[]
  } = {},
): PolicyExplanationNode {
  return {
    nodeId: `rule.${rule.ruleId}@${rule.templateVersion}`,
    layer: "rule",
    subject: rule.ruleId,
    ruleVersion: rule.templateVersion,
    applied:
      outcome === "narrowed" ||
      outcome === "widening_rejected" ||
      outcome === "pre_approved" ||
      outcome === "pre_approval_rejected",
    outcome,
    reason,
    removedCapabilities: extras.removedCapabilities ?? [],
    deniedCapabilities: extras.deniedCapabilities ?? [],
    grantedPreApprovals: extras.grantedPreApprovals ?? [],
    rejectedPreApprovals: extras.rejectedPreApprovals ?? [],
    wideningAttempts: extras.wideningAttempts ?? [],
    effective: state,
    children: [],
  }
}

function restrictNarrowing(rule: Rule): PermissionNarrowing {
  const effect = rule.effect
  if (effect.kind !== "restrict") {
    throw new Error(`Rule '${rule.ruleId}@${rule.templateVersion}' does not carry a restrict effect`)
  }
  return {
    allowedCapabilities: undefined,
    deniedCapabilities: [...effect.deniedCapabilities],
    requireApprovalForDispatch: undefined,
    requireApprovalForDestructiveEffects: effect.requireApprovalForDestructiveEffects,
    requireApprovalForExternalEffects: effect.requireApprovalForExternalEffects,
    requireApprovalForCapabilities: [],
    allowDestructiveEffects: undefined,
    allowExternalEffects: undefined,
    maximumTimeoutSeconds: undefined,
  }
}

function projectNarrowing(policy: ProjectPolicy): PermissionNarrowing {
  return {
    allowedCapabilities: policy.narrowing.allowedCapabilities,
    deniedCapabilities: [...policy.narrowing.deniedCapabilities],
    requireApprovalForDispatch: policy.narrowing.requireApprovalForDispatch,
    requireApprovalForDestructiveEffects: policy.narrowing.requireApprovalForDestructiveEffects,
    requireApprovalForExternalEffects: policy.narrowing.requireApprovalForExternalEffects,
    requireApprovalForCapabilities: [...policy.narrowing.requireApprovalForCapabilities],
    allowDestructiveEffects: policy.narrowing.allowDestructiveEffects,
    allowExternalEffects: policy.narrowing.allowExternalEffects,
    maximumTimeoutSeconds: policy.narrowing.maximumTimeoutSeconds,
  }
}

function roleNarrowing(envelope: PolicyEvaluationInput["envelope"]): PermissionNarrowing {
  const restrictions = envelope.roleSnapshot.permissionRestrictions
  return {
    allowedCapabilities: [...restrictions.allowedCapabilities],
    deniedCapabilities: [...restrictions.deniedCapabilities],
    requireApprovalForDispatch: undefined,
    requireApprovalForDestructiveEffects: restrictions.approvalRequirements.destructiveEffects,
    requireApprovalForExternalEffects: restrictions.approvalRequirements.externalEffects,
    requireApprovalForCapabilities: [...restrictions.approvalRequirements.capabilities],
    allowDestructiveEffects: undefined,
    allowExternalEffects: undefined,
    maximumTimeoutSeconds: undefined,
  }
}

/**
 * Deterministic policy evaluation.
 *
 * Layering (widest first, each layer narrowing-only):
 *   safety_floor -> project -> role -> rule -> dispatch
 *
 * Pre-approval is evaluated in a second, separate pass over the matched
 * `pre_approve` rules once every narrowing layer has been applied, so a
 * pre-approval can only ever grant approval *within* what the floor and the
 * narrower layers still permit. It may only satisfy the safety floor's blanket
 * "approval required for every dispatch" demand; it can never clear an explicit
 * approval requirement set by a narrowing layer, and it can never enable
 * destructive or external effects the floor denies.
 *
 * The function is pure: identical input yields a byte-identical decision and
 * explanation tree. It performs no runtime or network effects.
 */
export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluation {
  const parsed = policyEvaluationInputSchema.parse(input)
  const { envelope, taskTitle, projectPolicy } = parsed

  if (projectPolicy !== undefined && projectPolicy.projectId !== envelope.projectId) {
    throw new PolicyProjectScopeError(projectPolicy.projectId, envelope.projectId)
  }

  const context: RuleMatchContext = {
    taskTitle: taskTitle ?? null,
    requestedCapabilities: [...envelope.requestedCapabilities],
    runtimeKind: envelope.runtimeKind,
  }

  const ordered = orderRuleSnapshots(envelope.ruleSnapshots)
  const children: PolicyExplanationNode[] = []
  let state = seedPolicyState(envelope)

  // Layer 1 - safety floor (unconditional, non-overridable).
  const floorOutcome = narrowPolicyState(state, "safety_floor", SAFETY_FLOOR_NARROWING, { baseline: true })
  state = floorOutcome.state
  children.push(
    layerNode(
      "layer.safety_floor",
      "safety_floor",
      true,
      narrowingOutcome(floorOutcome),
      narrowingReason(
        "unconditional baseline: approval required for every dispatch; destructive and external effects are not pre-approvable; timeout ceiling applies",
        floorOutcome.wideningAttempts,
      ),
      floorOutcome,
      state,
    ),
  )

  // Layer 2 - project policy.
  if (projectPolicy === undefined) {
    children.push(
      layerNode(
        "layer.project",
        "project",
        false,
        "skipped",
        "no project policy snapshot was supplied for this evaluation",
        narrowPolicyState(state, "project", noNarrowing()),
        state,
      ),
    )
  } else {
    const outcome = narrowPolicyState(state, "project", projectNarrowing(projectPolicy))
    state = outcome.state
    children.push(
      layerNode(
        "layer.project",
        "project",
        true,
        narrowingOutcome(outcome),
        narrowingReason(`project policy '${projectPolicy.label}' applied as a narrowing layer`, outcome.wideningAttempts),
        outcome,
        state,
      ),
    )
  }

  // Layer 3 - role template restrictions.
  {
    const outcome = narrowPolicyState(state, "role", roleNarrowing(envelope))
    state = outcome.state
    children.push(
      layerNode(
        "layer.role",
        "role",
        true,
        narrowingOutcome(outcome),
        narrowingReason(
          `role template '${envelope.roleSnapshot.roleId}@${envelope.roleSnapshot.templateVersion}' permissionRestrictions applied as a narrowing layer`,
          outcome.wideningAttempts,
        ),
        outcome,
        state,
      ),
    )
  }

  // Layer 4 - rules. `restrict` effects narrow first, then `pre_approve`
  // effects are collected for the second pass.
  const ruleChildren: PolicyExplanationNode[] = []
  const preApprovalRules: Rule[] = []
  let restrictChanged = false

  for (const entry of ordered) {
    const rule = entry.rule
    if (entry.superseded) {
      ruleChildren.push(
        ruleNode(
          rule,
          "superseded",
          `rule version ${rule.templateVersion} is superseded by a newer snapshot of '${rule.ruleId}' and was not evaluated`,
          state,
        ),
      )
      continue
    }
    const match = matchRule(rule, context)
    if (!match.matched) {
      ruleChildren.push(ruleNode(rule, "skipped", match.reason, state))
      continue
    }
    if (rule.effect.kind === "restrict") {
      const outcome = narrowPolicyState(state, "rule", restrictNarrowing(rule))
      state = outcome.state
      restrictChanged = restrictChanged || outcome.changed
      ruleChildren.push(
        ruleNode(rule, narrowingOutcome(outcome), match.reason, state, {
          removedCapabilities: outcome.removedCapabilities,
          deniedCapabilities: outcome.deniedCapabilities,
          wideningAttempts: outcome.wideningAttempts,
        }),
      )
      continue
    }
    preApprovalRules.push(rule)
  }

  // Snapshot of the effective state as of the end of the rule layer, so the rule
  // layer node reports the state that layer actually produced rather than the
  // state after the later dispatch layer.
  const stateAfterRules = state

  // Layer 5 - dispatch envelope's own permission envelope.
  const dispatchOutcome = narrowPolicyState(state, "dispatch", dispatchNarrowing(envelope))
  state = dispatchOutcome.state

  // Denials are computed from the fully narrowed state, before pre-approval, so
  // that a pre-approval can never clear the floor's default for a dispatch that
  // is denied outright.
  const denials: PolicyDenial[] = []
  const allowedSet = new Set(state.allowedCapabilities)
  const deniedSet = new Set(state.deniedCapabilities)
  for (const capability of sortedUnique(envelope.requestedCapabilities)) {
    if (deniedSet.has(capability)) {
      denials.push({
        code: "policy.capability_denied",
        message: `Requested capability '${capability}' is denied by the effective policy and cannot be granted by any layer or pre-approval`,
        capabilities: [capability],
      })
    } else if (!allowedSet.has(capability)) {
      denials.push({
        code: "policy.capability_not_allowed",
        message: `Requested capability '${capability}' is not in the effective allowed capability set`,
        capabilities: [capability],
      })
    }
  }

  // Pre-approval pass. Runs after every narrowing layer. Each rule's widening
  // attempts are recorded on its own explanation node and reach the root via
  // `collectWideningAttempts`.
  const grantedPreApprovals: string[] = []
  let preApprovalBasis: PreApprovalBasis | null = null
  let defaultCleared = false

  for (const rule of preApprovalRules) {
    const effect = rule.effect
    if (effect.kind !== "pre_approve") continue

    // The rule already matched in the narrowing pass; re-derive the reason once
    // for reuse across every branch below.
    const matched = matchRule(rule, context).reason
    const attempts: string[] = []
    const rejections: string[] = []

    const floorBlocksDestructive = effect.allowDestructiveEffects && !state.allowDestructiveEffects
    if (floorBlocksDestructive) {
      attempts.push(
        `allowDestructiveEffects: rule '${rule.ruleId}@${rule.templateVersion}' requested a pre-approval the safety floor denies; ignored`,
      )
    }
    const floorBlocksExternal = effect.allowExternalEffects && !state.allowExternalEffects
    if (floorBlocksExternal) {
      attempts.push(
        `allowExternalEffects: rule '${rule.ruleId}@${rule.templateVersion}' requested a pre-approval the safety floor denies; ignored`,
      )
    }
    if (effect.maximumTimeoutSeconds > state.maximumTimeoutSeconds) {
      attempts.push(
        `maximumTimeoutSeconds: rule '${rule.ruleId}@${rule.templateVersion}' raised the ceiling ${state.maximumTimeoutSeconds} -> ${effect.maximumTimeoutSeconds}; ignored`,
      )
    }

    const allowedSet = new Set(state.allowedCapabilities)
    const deniedSet = new Set(state.deniedCapabilities)
    const granted: string[] = []
    for (const capability of sortedUnique(effect.approvedCapabilities)) {
      if (deniedSet.has(capability)) {
        rejections.push(capability)
      } else if (!allowedSet.has(capability)) {
        rejections.push(capability)
      } else if (!granted.includes(capability)) {
        granted.push(capability)
      }
    }

    const withinTimeout = envelope.timeoutSeconds <= Math.min(state.maximumTimeoutSeconds, effect.maximumTimeoutSeconds)
    const coversEverything =
      granted.length > 0 && state.allowedCapabilities.every((capability) => granted.includes(capability))
    const onlyFloorDemands = state.dispatchApprovalDemands.every((layer) => layer === "safety_floor")
    const mayClearDefault = onlyFloorDemands && state.dispatchApprovalDemands.length > 0 && denials.length === 0

    let outcome: PolicyExplanationNode["outcome"]
    let reason: string
    if (defaultCleared) {
      outcome = "pre_approved"
      reason = `${matched}; the safety floor's default approval was already satisfied by an earlier pre-approval rule`
    } else if (attempts.length > 0) {
      outcome = "pre_approval_rejected"
      reason = `${matched}; the pre-approval was rejected because it attempted to widen the safety floor`
    } else if (!withinTimeout) {
      outcome = "pre_approval_rejected"
      reason = `${matched}; the declared timeout ${envelope.timeoutSeconds}s exceeds the rule maximum ${effect.maximumTimeoutSeconds}s`
    } else if (!coversEverything) {
      outcome = "pre_approval_rejected"
      reason = `${matched}; the rule does not cover every effectively allowed capability`
    } else if (denials.length > 0) {
      outcome = "pre_approval_rejected"
      reason = `${matched}; the dispatch is denied by policy [${
        denials.map((denial) => denial.code).join(",")
      }], which a pre-approval may not clear`
    } else if (!mayClearDefault) {
      outcome = "pre_approval_rejected"
      reason = `${matched}; dispatch approval is demanded by a narrowing layer [${
        state.dispatchApprovalDemands.join(",")
      }] that a pre-approval may not clear`
    } else {
      outcome = "pre_approved"
      defaultCleared = true
      preApprovalBasis = { ruleId: rule.ruleId, ruleVersion: rule.templateVersion }
      reason = `${matched}; pre-approval satisfies the safety floor's default dispatch approval`
    }

    if (outcome === "pre_approved") {
      for (const capability of granted) {
        if (!grantedPreApprovals.includes(capability)) grantedPreApprovals.push(capability)
      }
    }

    ruleChildren.push(
      ruleNode(rule, outcome, reason, state, {
        grantedPreApprovals: outcome === "pre_approved" ? granted : [],
        rejectedPreApprovals: outcome === "pre_approved" ? [] : sortedUnique(rejections),
        wideningAttempts: attempts,
      }),
    )
  }

  ruleChildren.sort(compareRuleNodes)
  // The rule layer re-states its children's attempts on its own node; keep that
  // list de-duplicated so the node is a faithful set, and let the root
  // aggregation dedupe across parents too.
  const ruleOutcomeDetail: NarrowingOutcome = {
    state,
    removedCapabilities: sortedUnique(ruleChildren.flatMap((child) => [...child.removedCapabilities])),
    deniedCapabilities: sortedUnique(ruleChildren.flatMap((child) => [...child.deniedCapabilities])),
    wideningAttempts: sortedUnique(ruleChildren.flatMap((child) => [...child.wideningAttempts])),
    changed: restrictChanged || preApprovalRules.length > 0,
  }
  children.push(
    layerNode(
      "layer.rule",
      "rule",
      ruleChildren.length > 0,
      narrowingOutcome(ruleOutcomeDetail),
      narrowingReason(
        `${ordered.length} rule snapshot(s) evaluated in deterministic (ruleId, templateVersion) order`,
        ruleOutcomeDetail.wideningAttempts,
      ),
      ruleOutcomeDetail,
      stateAfterRules,
      ruleChildren,
    ),
  )
  children.push(
    layerNode(
      "layer.dispatch",
      "dispatch",
      true,
      narrowingOutcome(dispatchOutcome),
      narrowingReason(
        "dispatch envelope permissionEnvelope and timeout applied as the final narrowing layer",
        dispatchOutcome.wideningAttempts,
      ),
      dispatchOutcome,
      state,
    ),
  )

  const outstandingApprovals: string[] = []
  for (const capability of state.approvalRequiredCapabilities) {
    outstandingApprovals.push(`capability:${capability}`)
  }
  if (state.destructiveEffectsRequested && state.requireApprovalForDestructiveEffects) {
    outstandingApprovals.push("destructive_effects")
  }
  if (state.externalEffectsRequested && state.requireApprovalForExternalEffects) {
    outstandingApprovals.push("external_effects")
  }
  if (state.dispatchApprovalDemands.length > 0 && !defaultCleared) {
    outstandingApprovals.push("dispatch_approval")
  }
  outstandingApprovals.sort()

  const decision: PolicyDecision =
    denials.length > 0 ? "deny" : outstandingApprovals.length === 0 ? "allow" : "require_approval"

  // F1: the root aggregates every widening attempt recorded anywhere in the
  // subtree — safety floor, project, role, rule children and the pre-approval
  // pass — sorted and de-duplicated. The pre-approval pass alone would leave a
  // reader of the root node believing no tampering was attempted whenever an
  // ordinary narrowing layer escalated.
  const rootWidening = collectWideningAttempts(children)

  const explanation: PolicyExplanationNode = {
    nodeId: "policy",
    layer: "policy",
    // The root node's own `outcome` reports the *decision* axis (allow/deny/
    // require-approval), not the narrowing axis, so a rejected escalation shows
    // up on the root line as `ignoredWidening` rather than as its outcome.
    applied: true,
    outcome: decision === "allow" ? "pre_approved" : decision === "deny" ? "narrowed" : "unchanged",
    reason: narrowingReason(
      `policy evaluation over layers [${POLICY_PRECEDENCE.join(" > ")}]`,
      rootWidening,
    ),
    removedCapabilities: sortedUnique(envelope.requestedCapabilities.filter((capability) => !allowedSet.has(capability))),
    deniedCapabilities: state.deniedCapabilities,
    grantedPreApprovals: sortedUnique(grantedPreApprovals),
    rejectedPreApprovals: [],
    wideningAttempts: rootWidening,
    effective: state,
    children,
  }

  const evaluationBase = {
    dispatchId: envelope.dispatchId,
    projectId: envelope.projectId,
    runId: envelope.runId,
    taskId: envelope.taskId,
    roleId: envelope.roleSnapshot.roleId,
    envelopeDigest: digestDispatchEnvelope(envelope),
    decision,
    allowed: decision === "allow",
    effective: state,
    declaredTimeoutSeconds: envelope.timeoutSeconds,
    effectiveTimeoutSeconds: Math.min(envelope.timeoutSeconds, state.maximumTimeoutSeconds),
    preApprovalClearedDefault: defaultCleared,
    grantedPreApprovals: sortedUnique(grantedPreApprovals),
    preApprovalBasis,
    outstandingApprovals,
    denials,
    explanation,
  }

  const explanationText = renderPolicyExplanation({
    decision,
    explanation,
    outstandingApprovals,
    denials,
    grantedPreApprovals: sortedUnique(grantedPreApprovals),
    preApprovalBasis,
    effectiveTimeoutSeconds: Math.min(envelope.timeoutSeconds, state.maximumTimeoutSeconds),
  })

  return {
    ...evaluationBase,
    explanationText,
    decisionDigest: digestJson(evaluationBase),
  }
}

function compareRuleNodes(a: PolicyExplanationNode, b: PolicyExplanationNode): number {
  const left = `${a.subject ?? ""}@${a.ruleVersion ?? 0}`
  const right = `${b.subject ?? ""}@${b.ruleVersion ?? 0}`
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Result-shaped wrapper around {@link evaluatePolicy}. Succeeds only when the
 * policy allows the dispatch without a human approval.
 */
export function authorizeDispatch(input: PolicyEvaluationInput): Result<PolicyEvaluation> {
  let evaluation: PolicyEvaluation
  try {
    evaluation = evaluatePolicy(input)
  } catch (error) {
    if (error instanceof PolicyProjectScopeError) {
      return { ok: false, error: error.toContractError() }
    }
    throw error
  }

  if (evaluation.decision === "allow") {
    return { ok: true, value: evaluation }
  }

  const error: ContractError =
    evaluation.decision === "deny"
      ? createContractError(
          "policy_denied",
          "policy.denied",
          `Dispatch '${evaluation.dispatchId}' is denied by policy: ${evaluation.denials
            .map((denial) => denial.code)
            .join(", ")}`,
        )
      : createContractError(
          "approval_required",
          "policy.approval_required",
          `Dispatch '${evaluation.dispatchId}' requires approval: ${evaluation.outstandingApprovals.join(", ")}`,
        )

  return { ok: false, error }
}
