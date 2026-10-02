/**
 * The versioned store of run templates.
 *
 * ====================== THE HEADLINE INVARIANT, NAMED ======================
 *
 * > **INVARIANT TEMPLATE-EDIT-IMMUTABILITY.** A `RunTemplateSnapshot` obtained
 * > from version N of a template is unchanged, in every field and in its digest,
 * > by any number of subsequent `updateTemplate` calls on that template.
 *
 * WHY IT IS A PROPERTY OF THE VALUE AND NOT OF THE WRITE PATH. The obvious way to
 * satisfy "editing a template must not mutate an instantiated run" is to make
 * `updateTemplate` careful: write to a new map entry, copy the arrays, never
 * touch the stored object. That satisfies it until one of these happens — a caller
 * mutates an array it received from `getTemplate`, a snapshot shares a sub-object
 * with the template it was derived from, a future `updateTemplate` takes a
 * shortcut, or a snapshot is built by holding a reference rather than by
 * re-deriving. None of those is a bug anyone was looking for, and each of them
 * silently re-opens the hole.
 *
 * So the invariant is discharged structurally instead:
 *
 *   1. Stored templates are DEEP-FROZEN on the way in (`deepFreezeWorkflow`), so
 *      there is no mutable stored object for an edit to leak through.
 *   2. Every read returns a FRESH `structuredClone` of the stored value. This is
 *      the deliberate divergence from `RoleRepository`, which returns the stored
 *      object itself and relies on its frozenness.
 *
 * ====================== WHY CLONE-ON-READ AND NOT FREEZE-ON-READ ======================
 *
 * Both were available and the choice is argued rather than made.
 *
 * `RoleRepository` returns the frozen stored object. That is fine for a value
 * nobody can mutate and cheap, and the frozenness is genuine. But it makes the
 * stored object and the caller's object IDENTICAL, which means the only thing
 * standing between a caller and the repository's state is `Object.freeze`. Freeze
 * is a runtime invariant, not a type-level one: it holds until a `structuredClone`
 * of the caller's copy, or a library that returns a mutable wrapper, or a future
 * change to this module that decides freezing is expensive. `structuredClone` on
 * the way out means the repository can never hand out its own objects at all,
 * which makes the guarantee independent of every later change to this file.
 *
 * The cost is a real allocation per read, and it is named here as a cost rather
 * than hidden: templates are small (bounded at `MAX_TEMPLATE_STEPS` steps and
 * `MAX_TEMPLATE_PARAMETERS` parameters), read far less often than they are
 * written, and the hot path for an orchestrator is the snapshot, which this
 * module does not re-read.
 *
 * `structuredClone` and not a hand-written deep copy because it is the built-in,
 * it handles the cases a hand-written copy forgets (typed arrays, `Map`, `Set`,
 * null-prototype objects), and a hand-written copy of a value that is about to be
 * digested is a second canonicalisation with its own bugs. The stored values here
 * are plain JSON-shaped data by construction, so `structuredClone` cannot fail on
 * anything a `RunTemplate` may legally contain — `tests/unit/repository.test.ts`
 * asserts a template whose steps carry a budget round-trips identically.
 *
 * ====================== PERSISTENCE IS DEFERRED, NAMED ======================
 *
 * In-memory only, mirroring `RoleRepository` exactly, and deliberately so.
 *
 * The reason is that a persistence story for a template is a MIGRATION story, not
 * a storage story. `runTemplateSchema` is versioned by `schemaVersion` and
 * `templateVersion` independently: a template document's shape can move to
 * `schemaVersion` 2 while version 7 of the same template is still being read. A
 * store that landed now would have to either freeze the current shape forever or
 * ship a migration path in the same change that introduces the table — and ADR
 * 0007 section 1's whole argument is that M6 adds modules downward and edits
 * none of the existing surface, including `src/orchestration/event-store/`.
 * Inventing a second persistence mechanism here would be exactly the "second
 * representation" that ADR 0007 section 3 refuses for rules.
 *
 * What makes the deferral safe rather than merely postponed: nothing a caller
 * holds is invalidated by a restart, because a snapshot is self-contained and
 * digest-verifiable. A snapshot taken before a restart still verifies after one.
 * What it costs: templates do not survive a restart, so a restart reverts run
 * templates to the last persisted state. That is acceptable while the surface is
 * read by tests and the simulator, and it is the first thing to revisit when a
 * template becomes user-authored — recorded here so the cost is not discovered.
 *
 * ====================== VERSIONING ======================
 *
 * `updateTemplate` ALWAYS produces a new `templateVersion` and never mutates an
 * existing one. That is stricter than `RoleRepository.updateRole`, which will
 * return the existing version when the update is a no-op. The reason: "did this
 * edit change anything?" is not a question an audit log should have to answer,
 * and a `updateTemplate` that reported success while storing nothing would make
 * the version number a record of intent rather than of content. The cost is that
 * a redundant edit burns a version number; `listVersions` makes that visible
 * rather than silent.
 */

import { canonicalJson } from "../orchestration/digest.js"
import {
  WorkflowTemplateError,
  deepFreezeWorkflow,
  runTemplateSchema,
  sortedUniqueStrings,
  type RunTemplate,
  type RunTemplateInput,
} from "./types.js"

/**
 * A repository lookup for one template version.
 *
 * `templateVersion` omitted means "the latest". Expressed as its own type rather
 * than as two optional arguments so a call site cannot pass a `undefined` version
 * and a `version` flag by accident.
 */
export interface RunTemplateRef {
  readonly templateId: string
  /** Omit for the latest version. */
  readonly templateVersion?: number
}

/** Filter for `listTemplates`. Every field is an AND. */
export interface RunTemplateFilter {
  readonly templateId?: string
  readonly projectId?: string
  readonly name?: string
  /** Matched as a case-sensitive substring of the name or description. */
  readonly query?: string
  readonly latestOnly?: boolean
}

/** Version 1. The frozen domain records of M0 do not apply to an M6 template. */
const DEFAULT_TEMPLATE_SCHEMA_VERSION = 1

/**
 * Refuses a version that is not a positive safe integer, or that skips a step.
 *
 * A sibling of `InvalidRoleVersionError`, with the same three fields and the same
 * `toContractError()`. It is a separate class rather than a reused one because
 * `RoleRepository`'s error names roles in its message and its `roleId` field, and
 * an operator reading a refusal has to be able to tell which store refused.
 */
export class InvalidRunTemplateVersionError extends WorkflowTemplateError {
  readonly version: number

  constructor(templateId: string, version: number, message?: string) {
    super(
      "workflow.invalid_version",
      templateId,
      message ??
        `workflow.invalid_version: version ${version} is not a positive integer for template '${templateId}'; versions start at 1 and increment by one`,
    )
    this.name = "InvalidRunTemplateVersionError"
    this.version = version
  }
}

/**
 * A version number reused with different content.
 *
 * The refusal that makes append-only append-only. If the store accepted a second
 * definition of an existing version, then "the snapshot names version 3" would
 * stop naming anything: two different runs would both be able to claim to be
 * created from "version 3 of this template".
 */
export class RunTemplateVersionConflictError extends WorkflowTemplateError {
  readonly version: number

  constructor(templateId: string, version: number, message?: string) {
    super(
      "workflow.version_conflict",
      templateId,
      message ??
        `workflow.version_conflict: template '${templateId}' version ${version} already exists with different content; a version is immutable, so this edit must be written as a new version`,
      { category: "conflict" },
    )
    this.name = "RunTemplateVersionConflictError"
    this.version = version
  }
}

/** No such template, or no such version of it. */
export class RunTemplateNotFoundError extends WorkflowTemplateError {
  readonly templateVersion?: number

  constructor(templateId: string, templateVersion?: number, message?: string) {
    const detail = templateVersion === undefined ? "" : ` version ${templateVersion}`
    super(
      "workflow.template_not_found",
      templateId,
      message ?? `workflow.template_not_found: template '${templateId}'${detail} does not exist`,
    )
    this.name = "RunTemplateNotFoundError"
    this.templateVersion = templateVersion
  }
}

/** Normalizes and validates an authoring input into a full `RunTemplate`. */
function normalizeTemplateInput(input: RunTemplateInput, templateVersion: number): RunTemplate {
  if (!Number.isSafeInteger(templateVersion) || templateVersion < 1) {
    throw new InvalidRunTemplateVersionError(String(input.templateId), templateVersion)
  }

  const parsed = runTemplateSchema.safeParse({
    templateId: input.templateId,
    templateVersion,
    projectId: input.projectId,
    name: input.name,
    description: input.description ?? "",
    parameterDefinitions: input.parameterDefinitions ?? [],
    steps: input.steps,
    ruleSetDigest: input.ruleSetDigest ?? null,
    author: input.author,
    createdAt: input.createdAt,
    schemaVersion: input.schemaVersion ?? DEFAULT_TEMPLATE_SCHEMA_VERSION,
  })

  if (!parsed.success) {
    throw new WorkflowTemplateError(
      "workflow.invalid_template",
      String(input.templateId),
      `workflow.invalid_template: ${parsed.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    )
  }
  return parsed.data
}

/**
 * The behavioral comparison used to decide whether a re-registration is a
 * no-op or a conflict.
 *
 * `canonicalJson` over the whole document EXCEPT `createdAt`, because two
 * registrations of the same content at two different instants are the same
 * version. Including `createdAt` would make every idempotent re-write a conflict,
 * which is the same trade `RoleRepository.areTemplatesEqual` makes by comparing
 * field-by-field and skipping it.
 */
function templateBehaviorDigest(template: RunTemplate): string {
  const { createdAt: _createdAt, ...rest } = template
  return canonicalJson(rest)
}

/**
 * An in-memory, append-only, versioned store of run templates.
 *
 * Mirrors `RoleRepository`'s surface — `createTemplate`, `updateTemplate`,
 * `getTemplate`, `getLatestTemplate`, `listVersions`, `listTemplates`,
 * `requireTemplate`, `hasTemplate`, `count` — with the divergences documented in
 * the module docblock and at each method.
 */
export class RunTemplateRepository {
  /** templateId -> (templateVersion -> template). Two levels because a version is addressable. */
  readonly #templates = new Map<string, Map<number, RunTemplate>>()

  constructor(initialTemplates: readonly RunTemplateInput[] = []) {
    for (const input of initialTemplates) this.createTemplate(input)
  }

  /**
   * Registers a new template, or returns the existing one when the registration
   * is byte-identical in behaviour.
   *
   * `templateVersion` is taken from the input when supplied and assigned as
   * "latest + 1" otherwise, exactly as `RoleRepository.registerRole` does. A
   * requested version that is not exactly one above the current maximum is
   * refused: a gap means a version exists somewhere that this store cannot show
   * an operator, which is worse than refusing the write.
   */
  createTemplate(input: RunTemplateInput): RunTemplate {
    const templateId = input.templateId
    if (typeof templateId !== "string" || templateId.length === 0) {
      throw new WorkflowTemplateError("workflow.invalid_template", String(templateId), "workflow.invalid_template: templateId must be a non-empty string")
    }

    let versions = this.#templates.get(templateId)
    if (versions === undefined) {
      versions = new Map<number, RunTemplate>()
      this.#templates.set(templateId, versions)
    }

    const requested = input.templateVersion
    let targetVersion: number
    if (requested !== undefined) {
      if (!Number.isSafeInteger(requested) || requested < 1) {
        throw new InvalidRunTemplateVersionError(templateId, requested)
      }
      targetVersion = requested
    } else {
      targetVersion = versions.size === 0 ? 1 : Math.max(...versions.keys()) + 1
    }

    if (versions.size > 0) {
      const maximum = Math.max(...versions.keys())
      if (targetVersion > maximum + 1) {
        throw new InvalidRunTemplateVersionError(
          templateId,
          targetVersion,
          `workflow.invalid_version: version must increment sequentially without gaps; the latest is ${maximum} and ${targetVersion} was requested`,
        )
      }
    }

    const normalized = normalizeTemplateInput(input, targetVersion)

    const existing = versions.get(targetVersion)
    if (existing !== undefined) {
      if (templateBehaviorDigest(existing) === templateBehaviorDigest(normalized)) {
        return this.#clone(existing)
      }
      throw new RunTemplateVersionConflictError(templateId, targetVersion)
    }

    versions.set(targetVersion, deepFreezeWorkflow(normalized))
    return this.#clone(normalized)
  }

  /**
   * Creates the NEXT version from a partial edit. Never mutates an existing one.
   *
   * Fields absent from `updates` are inherited from the latest version, so an
   * edit that changes one step does not have to restate the other twelve — the
   * same merge semantics as `RoleRepository.updateRole`.
   *
   * `createdAt` is taken from `updates` and NEVER defaulted to a clock read. A
   * store that stamped its own time would make the stored value depend on when it
   * was written, which is precisely the property the digest and the determinism
   * tests depend on being absent. The caller passes the time it wants recorded.
   */
  updateTemplate(
    ref: RunTemplateRef,
    updates: Partial<Omit<RunTemplateInput, "templateId" | "steps">> & { readonly steps?: RunTemplateInput["steps"] },
  ): RunTemplate {
    const latest = this.getLatestTemplate(ref.templateId)
    if (latest === undefined) {
      throw new RunTemplateNotFoundError(ref.templateId, ref.templateVersion)
    }

    const nextVersion = latest.templateVersion + 1
    if (updates.templateVersion !== undefined && updates.templateVersion !== nextVersion) {
      throw new InvalidRunTemplateVersionError(
        ref.templateId,
        updates.templateVersion,
        `workflow.invalid_version: updating template '${ref.templateId}' must increment version from ${latest.templateVersion} to ${nextVersion}, got ${updates.templateVersion}`,
      )
    }

    return this.createTemplate({
      templateId: ref.templateId,
      templateVersion: nextVersion,
      projectId: updates.projectId ?? latest.projectId,
      name: updates.name ?? latest.name,
      description: updates.description ?? latest.description,
      parameterDefinitions: updates.parameterDefinitions ?? latest.parameterDefinitions,
      steps: updates.steps ?? latest.steps,
      ruleSetDigest: updates.ruleSetDigest !== undefined ? updates.ruleSetDigest : latest.ruleSetDigest,
      author: updates.author ?? latest.author,
      createdAt: updates.createdAt ?? latest.createdAt,
      schemaVersion: updates.schemaVersion ?? latest.schemaVersion,
    })
  }

  /** One version, or the latest when `templateVersion` is omitted. `undefined` when absent. */
  getTemplate(ref: RunTemplateRef): RunTemplate | undefined {
    const versions = this.#templates.get(ref.templateId)
    if (versions === undefined || versions.size === 0) return undefined

    if (ref.templateVersion !== undefined) {
      const exact = versions.get(ref.templateVersion)
      return exact === undefined ? undefined : this.#clone(exact)
    }
    return this.#clone(versions.get(Math.max(...versions.keys()))!)
  }

  /** The newest version of a template. A named alias of `getTemplate`, mirroring `RoleRepository`. */
  getLatestTemplate(templateId: string): RunTemplate | undefined {
    return this.getTemplate({ templateId })
  }

  /** One version, or a named refusal. The throwing counterpart of `getTemplate`. */
  requireTemplate(ref: RunTemplateRef): RunTemplate {
    const template = this.getTemplate(ref)
    if (template === undefined) {
      throw new RunTemplateNotFoundError(ref.templateId, ref.templateVersion)
    }
    return template
  }

  /** Whether a template, or a specific version of one, exists. */
  hasTemplate(ref: RunTemplateRef): boolean {
    const versions = this.#templates.get(ref.templateId)
    if (versions === undefined) return false
    return ref.templateVersion === undefined ? versions.size > 0 : versions.has(ref.templateVersion)
  }

  /** Every version of one template, ascending. Empty for an unknown template. */
  listVersions(templateId: string): readonly RunTemplate[] {
    const versions = this.#templates.get(templateId)
    if (versions === undefined) return Object.freeze([])
    return Object.freeze([...versions.keys()].sort((left, right) => left - right).map((version) => this.#clone(versions.get(version)!)))
  }

  /** Every template id, sorted. */
  listTemplateIds(): readonly string[] {
    return Object.freeze(sortedUniqueStrings(this.#templates.keys()))
  }

  /**
   * Templates matching a filter.
   *
   * Ordering is (templateId, templateVersion) ascending by code unit, which is
   * total and independent of insertion order. `latestOnly` takes the highest
   * version per template id, so a filtered list has one row per template.
   */
  listTemplates(filter: RunTemplateFilter = {}): readonly RunTemplate[] {
    const rows: RunTemplate[] = []
    for (const templateId of this.listTemplateIds()) {
      if (filter.templateId !== undefined && templateId !== filter.templateId) continue
      const versions = this.listVersions(templateId)
      const candidates = filter.latestOnly === true ? versions.slice(-1) : versions
      for (const template of candidates) {
        if (filter.projectId !== undefined && template.projectId !== filter.projectId) continue
        if (filter.name !== undefined && template.name !== filter.name) continue
        if (filter.query !== undefined) {
          const inName = template.name.includes(filter.query)
          const inDescription = template.description.includes(filter.query)
          if (!inName && !inDescription) continue
        }
        rows.push(template)
      }
    }
    return Object.freeze(rows)
  }

  /** Total number of stored VERSIONS, matching `RoleRepository.count`. */
  count(): number {
    let total = 0
    for (const versions of this.#templates.values()) total += versions.size
    return total
  }

  /** Number of distinct template ids. */
  templateCount(): number {
    return this.#templates.size
  }

  /** Drops everything. Present for parity with `RoleRepository.clear`; not used in production. */
  clear(): void {
    this.#templates.clear()
  }

  /**
   * A fresh, MUTABLE copy of a stored template.
   *
   * Private, because every read path goes through it and that is the point: no
   * caller, and no future method, can obtain the stored object itself. The
   * returned copy is not frozen — a caller that wants to derive something from a
   * template should be able to — and cannot affect the repository, because it
   * shares no object with it.
   */
  #clone(template: RunTemplate): RunTemplate {
    return structuredClone(template)
  }
}
