/**
 * Emit `contracts/v1/*.schema.json` from the Zod schemas that are the single
 * source of truth (Docs/implementation-plans/README.md:66).
 *
 * Chain: Zod -> `z.toJSONSchema()` -> committed JSON Schema -> `typify` ->
 * `router/src/contracts.rs`. This script is step one; `router/contract-gen` is
 * step two. See ADR 0008 §2.3.
 *
 * Both artefacts are COMMITTED rather than built into `target/`. A generated
 * file nobody reviews is worse than no file, and ADR 0008 §2.3 requires the
 * diff to be reviewable in a pull request. CI runs
 * `bun run generate:contracts && git diff --exit-code contracts/ router/src/contracts.rs`,
 * so a hand edit here is a build failure rather than a review comment.
 */
import { readFile, readdir, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import * as configSchemas from "../src/config/schemas.js"
import * as orchestrationSchemas from "../src/orchestration/schemas.js"

const CONTRACTS_DIRECTORY = fileURLToPath(new URL("../contracts/v1/", import.meta.url))

/**
 * The contract version. Carried in every `$id` so a consumer that holds a
 * `contracts/v1/*.schema.json` can name the shape it was built against without
 * reading the body. Bumping it means new files under a new directory, never a
 * rewrite in place: a version bump has to mean "the shape changed" (ADR 0002).
 */
const CONTRACT_VERSION = "v1"

interface ContractSpec {
  /** The Zod export name. Also the generated Rust type name, minus `Schema`. */
  readonly exportName: string
  readonly file: string
  /** `file:line` is resolved from source at generation time, never hand-written. */
  readonly sourceFile: string
  readonly source: z.ZodType
  /** Recorded into the artefact's `description` when the source is not a plain value shape. */
  readonly note?: string
}

/**
 * Closure A — the ingress schemas the router's four stateless routes consume,
 * plus their transitive dependencies. Curated by hand from
 * `src/config/schemas.ts`; this is not a re-export of the module, because a
 * contract file nothing consumes rots.
 */
const INGRESS_CLOSURE: readonly ContractSpec[] = [
  { exportName: "triggerRequestSchema", file: "trigger-request", sourceFile: "src/config/schemas.ts", source: configSchemas.triggerRequestSchema },
  { exportName: "triggerResponseSchema", file: "trigger-response", sourceFile: "src/config/schemas.ts", source: configSchemas.triggerResponseSchema },
  { exportName: "reportCallbackSchema", file: "report-callback", sourceFile: "src/config/schemas.ts", source: configSchemas.reportCallbackSchema },
  { exportName: "bridgeConfigSchema", file: "bridge-config", sourceFile: "src/config/schemas.ts", source: configSchemas.bridgeConfigSchema },
  { exportName: "allowedSourceSchema", file: "allowed-source", sourceFile: "src/config/schemas.ts", source: configSchemas.allowedSourceSchema },
  { exportName: "agentConfigSchema", file: "agent-config", sourceFile: "src/config/schemas.ts", source: configSchemas.agentConfigSchema },
  { exportName: "projectConfigSchema", file: "project-config", sourceFile: "src/config/schemas.ts", source: configSchemas.projectConfigSchema },
  {
    exportName: "dependencyReferenceSchema",
    file: "dependency-reference",
    sourceFile: "src/config/schemas.ts",
    source: configSchemas.dependencyReferenceSchema,
  },
  { exportName: "remoteDependencySchema", file: "remote-dependency", sourceFile: "src/config/schemas.ts", source: configSchemas.remoteDependencySchema },
  {
    exportName: "planMetadataSchema",
    file: "plan-metadata",
    sourceFile: "src/config/schemas.ts",
    source: configSchemas.planMetadataSchema,
    // The source is `.optional()`. `io: "input"` has no way to say "this object
    // may be absent" at the root of a standalone document, so this file
    // describes the object shape. Optionality lives in the PARENT: inside
    // `trigger-request.schema.json`, `metadata` is absent from `required`.
    note: "Source is z.optional(); optionality is expressed by the parent schema's `required` list, not here.",
  },
  { exportName: "permissionResponseSchema", file: "permission-response", sourceFile: "src/config/schemas.ts", source: configSchemas.permissionResponseSchema },
  { exportName: "planStatusSchema", file: "plan-status", sourceFile: "src/config/schemas.ts", source: configSchemas.planStatusSchema },
]

/**
 * Closure B — the orchestration record schemas, one per fixture in
 * `tests/contracts/examples/*.v1.json`.
 *
 * The fixtures bind HERE, not to closure A: measured in M7.2, all 15 exercise
 * `src/orchestration/schemas.ts` and none exercise `src/config/schemas.ts`
 * (ADR 0008 §2.3). The order matches `examples.test.ts` so a reader can map
 * one list onto the other.
 */
const ORCHESTRATION_CLOSURE: readonly ContractSpec[] = [
  { exportName: "meshSchema", file: "mesh", sourceFile: "src/orchestration/schemas.ts", source: orchestrationSchemas.meshSchema },
  { exportName: "nodeSchema", file: "node", sourceFile: "src/orchestration/schemas.ts", source: orchestrationSchemas.nodeSchema },
  { exportName: "projectSchema", file: "project", sourceFile: "src/orchestration/schemas.ts", source: orchestrationSchemas.projectSchema },
  { exportName: "runSchema", file: "run", sourceFile: "src/orchestration/schemas.ts", source: orchestrationSchemas.runSchema },
  { exportName: "taskSchema", file: "task", sourceFile: "src/orchestration/schemas.ts", source: orchestrationSchemas.taskSchema },
  { exportName: "dispatchSchema", file: "dispatch", sourceFile: "src/orchestration/schemas.ts", source: orchestrationSchemas.dispatchSchema },
  { exportName: "approvalSchema", file: "approval", sourceFile: "src/orchestration/schemas.ts", source: orchestrationSchemas.approvalSchema },
  { exportName: "sessionSchema", file: "session", sourceFile: "src/orchestration/schemas.ts", source: orchestrationSchemas.sessionSchema },
  { exportName: "roleTemplateSchema", file: "role", sourceFile: "src/orchestration/schemas.ts", source: orchestrationSchemas.roleTemplateSchema },
  { exportName: "ruleSchema", file: "rule", sourceFile: "src/orchestration/schemas.ts", source: orchestrationSchemas.ruleSchema },
  { exportName: "memoryRecordSchema", file: "memory", sourceFile: "src/orchestration/schemas.ts", source: orchestrationSchemas.memoryRecordSchema },
  { exportName: "artifactSchema", file: "artifact", sourceFile: "src/orchestration/schemas.ts", source: orchestrationSchemas.artifactSchema },
  {
    exportName: "controllerLeaseSchema",
    file: "controller-lease",
    sourceFile: "src/orchestration/schemas.ts",
    source: orchestrationSchemas.controllerLeaseSchema,
  },
  {
    exportName: "orchestrationEventSchema",
    file: "event",
    sourceFile: "src/orchestration/schemas.ts",
    source: orchestrationSchemas.orchestrationEventSchema,
  },
  {
    exportName: "orchestrationCommandSchema",
    file: "command",
    sourceFile: "src/orchestration/schemas.ts",
    source: orchestrationSchemas.orchestrationCommandSchema,
  },
]

const ALL_CONTRACTS: readonly ContractSpec[] = [...INGRESS_CLOSURE, ...ORCHESTRATION_CLOSURE]

/** `triggerRequestSchema` -> `TriggerRequest`: the generated Rust type name. */
export function rustTypeName(exportName: string): string {
  const base = exportName.replace(/Schema$/, "")
  return base.charAt(0).toUpperCase() + base.slice(1)
}

/**
 * Resolve `file:line` from the source rather than hard-coding it.
 *
 * A hand-maintained line number is exactly the fourth copy ADR 0008 §2.3
 * exists to prevent: adding a schema above it silently repoints the header at
 * the wrong declaration, and nothing fails.
 */
async function resolveSourceLine(spec: ContractSpec): Promise<number> {
  const source = await readFile(fileURLToPath(new URL(`../${spec.sourceFile}`, import.meta.url)), "utf8")
  const lines = source.split("\n")
  const declaration = new RegExp(`^export const ${spec.exportName}\\b`)
  const index = lines.findIndex((line) => declaration.test(line))
  if (index < 0) throw new Error(`${spec.exportName} is not exported from ${spec.sourceFile}`)
  return index + 1
}

/**
 * Close every object subschema that Zod left open.
 *
 * WHAT "CLOSED" MEANS HERE. A subschema is closed when it declares
 * `additionalProperties: false`. This post-pass sets that keyword on every
 * object subschema that does not already carry the keyword — it never
 * overrides an explicit value.
 *
 * WHY IT IS SAFE, I.E. WHY ABSENT NEVER MEANS "ARBITRARY KEYS". Zod 4 emits
 * `additionalProperties: false` for `z.strictObject`/`.strict()` and emits
 * NOTHING for `z.object` (which strips unknown keys) and nothing else. There
 * is no Zod constructor in either closure whose JSON Schema form carries an
 * explicit `additionalProperties: true`. So an absent keyword never records an
 * author's intent to accept extra keys; it only records `z.object`'s strip
 * behaviour, which JSON Schema's default (`true`, permit) approximates but does
 * not equal. Closing it therefore never contradicts a Zod declaration.
 *
 * WHY CLOSE AT ALL. This is what makes the router strictly stricter than the
 * engine, which is the intent and not an oversight (ADR 0008 §2.2 Tier 1
 * lists unknown-key rejection as the router's job, and ADR 0008 §2.3 records
 * the asymmetry so it is not later "fixed" into symmetry). In closure B the
 * pass is a no-op — every object there is already `.strict()`. It does real
 * work in closure A, where `src/config/schemas.ts` uses bare `z.object`
 * throughout and Zod therefore emits no keyword at all.
 *
 * WHAT THIS DOES NOT DO. It does not re-declare a single field, type, bound or
 * required list. Structure stays fully derived from Zod; this pass only adds
 * one boolean keyword. Re-declaring shapes here would create the hand-
 * maintained copy ADR 0008 §2.3 forbids.
 */
function closeObjectSchemas(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(closeObjectSchemas)
  if (node === null || typeof node !== "object") return node

  const schema = node as Record<string, unknown>
  const isObjectSchema = schema.type === "object" || schema.properties !== undefined
  const alreadyDecides = Object.hasOwn(schema, "additionalProperties")

  const closed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    closed[key] = closeObjectSchemas(value)
  }
  if (isObjectSchema && !alreadyDecides) {
    closed.additionalProperties = false
  }
  return closed
}

/**
 * Keywords that make typify synthesise a NAMED newtype rather than a bare
 * `String`/`Number`. Without a name typify panics: its `get_type_name` returns
 * `None` for `Name::Unknown` when no title is present, and `type_entry.rs`
 * unwraps that.
 */
const TYPIFY_NAMED_CONSTRAINTS = [
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "enum",
  "const",
  "format",
] as const

/** Characters that cannot appear in a Rust identifier typify would emit. */
function pascalSegment(segment: string): string {
  const words = segment
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("")
}

/**
 * Title every inline constrained subschema AND every union branch.
 *
 * WHY THIS EXISTS. Two independent typify 0.8 requirements, both satisfied by
 * `unwrap()` on a `None` name and both measured rather than assumed:
 *
 *   1. typify turns a constrained scalar into a NEWTYPE that ENFORCES the bound,
 *      which is how `minLength: 1` on `agent_id` reaches the router as a real
 *      check. But an INLINE subschema such as `{"type":"string","minLength":1}`
 *      has no name, and `get_type_name` returns `None` for `Name::Unknown`
 *      (`type_entry.rs:511`).
 *   2. typify names a union's VARIANTS from each branch's `title`
 *      (`type_entry.rs:277` and `:290`). An untitled `oneOf` branch aborts the
 *      same way. Only `command.schema.json` and `event.schema.json` carry a root
 *      `oneOf`, and they were the last two of 27 to fail.
 *
 * THE ALTERNATIVE, AND WHY NOT. typify's `x-rust-type: { "type": "string" }`
 * also stops panic (1), and it is simpler — but it tells typify to emit a plain
 * `String` and DISCARD the bound. Every `minLength` in closure A would silently
 * stop being enforced in Rust while the committed JSON Schema still claimed it.
 * That is precisely the silent divergence ADR 0008 §2.3 exists to prevent, and it
 * is the more dangerous failure because the artefact on disk still looks right.
 *
 * NAMING. The title is the root title plus the property path in PascalCase
 * (`TriggerRequest` + `source_agent_id` -> `TriggerRequestSourceAgentId`). It is
 * derived from the SCHEMA PATH, never from whatever title is already present, so
 * the pass is idempotent: a second run computes the identical string. Path
 * derivation also makes collisions impossible — two different paths cannot
 * produce the same name, whereas suffix counters would drift the moment a field
 * is inserted. Array indices are part of the path, which is what keeps two
 * branches of the same union distinct.
 *
 * This adds a `title` and nothing else. No bound, type, or required list is
 * re-declared here.
 */
function titleInlineConstrainedSchemas(
  node: unknown,
  prefix: string,
  path: readonly string[] = [],
  isUnionBranch = false,
): unknown {
  if (Array.isArray(node)) {
    return node.map((item, index) => titleInlineConstrainedSchemas(item, prefix, [...path, String(index)], isUnionBranch))
  }
  if (node === null || typeof node !== "object") return node

  const schema = node as Record<string, unknown>
  const titled: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    // `properties` and `$defs` contribute their KEY to the name; every other
    // keyword's value is descended into under the same path segment, so
    // `items` does not add a level of its own.
    if (key === "properties" || key === "$defs" || key === "patternProperties") {
      if (value !== null && typeof value === "object") {
        const nested: Record<string, unknown> = {}
        for (const [childKey, childValue] of Object.entries(value)) {
          nested[childKey] = titleInlineConstrainedSchemas(childValue, prefix, [...path, childKey])
        }
        titled[key] = nested
        continue
      }
    }
    // A member of `oneOf`/`anyOf` must be named whether or not it carries a
    // constraint, because typify derives the variant identifier from the title.
    titled[key] = titleInlineConstrainedSchemas(value, prefix, path, key === "oneOf" || key === "anyOf")
  }

  const isRoot = path.length === 0
  const carriesConstraint = TYPIFY_NAMED_CONSTRAINTS.some((keyword) => Object.hasOwn(schema, keyword))
  if (!isRoot && (carriesConstraint || isUnionBranch) && titled.title === undefined) {
    titled.title = [prefix, ...path.map(pascalSegment)].filter((part) => part.length > 0).join("")
  }
  return titled
}

async function main(): Promise<void> {
  const expected = new Set(ALL_CONTRACTS.map((spec) => `${spec.file}.schema.json`))

  // A schema deleted from the closures must take its artefact with it, or the
  // stale file would satisfy `git diff --exit-code` forever while documenting a
  // shape that no longer exists.
  for (const existing of await readdir(CONTRACTS_DIRECTORY).catch(() => [] as string[])) {
    if (!expected.has(existing)) await rm(`${CONTRACTS_DIRECTORY}${existing}`)
  }

  for (const spec of ALL_CONTRACTS) {
    const line = await resolveSourceLine(spec)
    const emitted = z.toJSONSchema(spec.source, {
      target: "draft-2020-12",
      io: "input",
      // Left at Zod's default ("throw"). Both closures convert cleanly under it.
      // If a future schema introduces a genuinely unrepresentable construct
      // (a transform, `z.date()`, a schema-level `z.custom()`), generation
      // fails loudly here rather than emitting a contract that cannot be
      // round-tripped. `refine`/`superRefine` are NOT such a construct — see
      // the note on invariants below.
    }) as Record<string, unknown>

    const provenance = [`@generated by scripts/generate-contracts.ts from ${spec.sourceFile}:${line} (export ${spec.exportName}). DO NOT EDIT.`]
    if (spec.note) provenance.push(spec.note)
    provenance.push(
      "Invariants from .refine()/.superRefine() are NOT representable in JSON Schema and are absent from this file; they remain enforced by the TypeScript engine, which is the sole authority for them (ADR 0008 §2.2 Tier 2).",
    )

    const rootTitle = rustTypeName(spec.exportName)
    const closed = closeObjectSchemas(withoutSchemaKeyword(emitted)) as Record<string, unknown>
    // Title before close, so the pass that decides names walks the tree the
    // engine will actually consume. Both passes are pure and order-independent
    // in effect; the order is fixed only to keep the output byte-stable.
    const titled = titleInlineConstrainedSchemas(closed, rootTitle) as Record<string, unknown>

    const document = {
      $schema: emitted.$schema,
      $id: `urn:aibridge:contracts:${CONTRACT_VERSION}:${spec.file}`,
      title: rootTitle,
      description: provenance.join(" "),
      ...titled,
    }

    await writeFile(`${CONTRACTS_DIRECTORY}${spec.file}.schema.json`, `${JSON.stringify(document, null, 2)}\n`)
  }

  console.log(`generate:contracts wrote ${ALL_CONTRACTS.length} schemas to contracts/${CONTRACT_VERSION}/`)
}

/** `$schema` is re-emitted first by hand; drop Zod's copy from the spread body. */
function withoutSchemaKeyword(emitted: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dropped, ...rest } = emitted
  return rest
}

await main()
