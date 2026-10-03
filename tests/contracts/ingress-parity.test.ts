/**
 * Cross-language contract parity: does the TypeScript side accept and reject
 * exactly what the generated Rust types accept and reject?
 *
 * ## The shape of the check
 *
 * ADR 0008 §9 requires that all 15 fixtures in `tests/contracts/examples/` parse
 * identically in both languages. "Identically" is the operative word and the hard
 * part. Printing two lists and asking a reader to spot the difference is a check
 * that passes when both sides are wrong the same way, and fails to be a check at
 * all when nobody is looking.
 *
 * So this file and `router/tests/fixtures.rs` both read and write ONE committed
 * vector, `router/tests/parity-vector.json`. This side produces it by validating
 * each fixture against the committed JSON Schema with `ajv`; the Rust side
 * re-derives it by deserializing into the generated type and asserts equality.
 * A disagreement is a test failure with a name attached, not a diff for a human.
 *
 * ## Regenerating the vector
 *
 * `bun run generate:parity-vector`, which this file also runs on demand. The
 * vector is committed rather than generated at test time because the Rust side
 * reads it from disk during `cargo test`, which has no Bun and therefore cannot
 * regenerate it.
 *
 * ## What these types do NOT enforce
 *
 * `.refine()` / `.superRefine()` invariants from the Zod source are not
 * representable in JSON Schema and are absent from `contracts/v1/`. The engine
 * remains their sole authority (ADR 0008 §2.2 Tier 2). A fixture can therefore
 * pass both sides while a semantic invariant is violated -- that is the designed
 * asymmetry, not a gap in this test.
 */
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
// `ajv/dist/2020.js` is CommonJS, so under this package's NodeNext ESM
// resolution the namespace object arrives with `default` holding the class.
// Importing it as a bare default gives the MODULE, which has no construct
// signature -- and the type error says exactly that rather than something about
// schemas. `Ajv2020.default` is the class.
import Ajv2020Module from "ajv/dist/2020.js"

const Ajv2020 = Ajv2020Module.default
import type { ErrorObject, ValidateFunction } from "ajv"

const EXAMPLES_DIRECTORY = fileURLToPath(new URL("./examples/", import.meta.url))
const CONTRACTS_DIRECTORY = fileURLToPath(new URL("../../contracts/v1/", import.meta.url))
const VECTOR_PATH = fileURLToPath(new URL("../../router/tests/parity-vector.json", import.meta.url))

/** fixture file name -> whether the JSON Schema accepts it */
export type ParityVector = Record<string, boolean>

interface Fixture {
  readonly name: string
  readonly contract: string
  readonly text: string
  readonly document: unknown
}

/**
 * The fixture stem names the contract file: `node.v1.json` is validated by
 * `contracts/v1/node.schema.json`.
 *
 * This is the same rule `router/tests/fixtures.rs` follows, and it is derived
 * from the file names rather than from a table. A table would be a fourth copy
 * of the contract registry -- the failure ADR 0008 §2.3 exists to prevent.
 */
async function loadFixtures(): Promise<readonly Fixture[]> {
  const names = (await readdir(EXAMPLES_DIRECTORY))
    .filter((name) => name.endsWith(".v1.json"))
    .sort()
  return Promise.all(
    names.map(async (name) => {
      const text = await readFile(`${EXAMPLES_DIRECTORY}${name}`, "utf8")
      return {
        name,
        contract: name.replace(/\.v1\.json$/, ""),
        text,
        document: JSON.parse(text) as unknown,
      }
    }),
  )
}

/**
 * Compile one contract file's validator.
 *
 * `strict` matters more than it looks. Without it ajv applies defaults that
 * differ from what typify generated — in particular `coerceTypes` and
 * `useDefaults` would silently change a rejection into an acceptance, which is
 * precisely the divergence this test exists to catch. `allErrors` so a failure
 * can be reported with all of its causes rather than the first.
 */
async function compile(contract: string): Promise<ValidateFunction> {
  const schema = JSON.parse(await readFile(`${CONTRACTS_DIRECTORY}${contract}.schema.json`, "utf8")) as object
  const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false })
  return ajv.compile(schema)
}

/** Validate every fixture and produce the vector. */
async function computeVector(): Promise<ParityVector> {
  const validators = new Map<string, ValidateFunction>()
  const vector: ParityVector = {}
  for (const fixture of await loadFixtures()) {
    let validate = validators.get(fixture.contract)
    if (validate === undefined) {
      validate = await compile(fixture.contract)
      validators.set(fixture.contract, validate)
    }
    vector[fixture.name] = validate(fixture.document) as boolean
  }
  return vector
}

/**
 * ajv's `errors` is `ErrorObject[] | null`, and a single `assert.ok` cannot
 * distinguish "rejected because the payload is wrong" from "rejected because the
 * validator threw on a malformed schema". The first is a contract disagreement
 * worth failing on; the second is a broken artefact, and conflating them means a
 * regenerated-but-invalid schema looks like a payload mismatch.
 */
function firstError(validate: ValidateFunction, document: unknown): string {
  const errors = validate.errors as ErrorObject[] | null
  if (errors === null || errors.length === 0) return "(no errors reported)"
  return errors.map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`.trim()).join("; ")
}

describe("contract parity, TypeScript half", () => {
  it("has the fifteen fixtures the plan and ADR 0008 section 9 name", async () => {
    const fixtures = await loadFixtures()
    expect(fixtures).toHaveLength(15)
    expect(fixtures.map((fixture) => fixture.contract)).toEqual([
      "approval",
      "artifact",
      "command",
      "controller-lease",
      "dispatch",
      "event",
      "memory",
      "mesh",
      "node",
      "project",
      "role",
      "rule",
      "run",
      "session",
      "task",
    ])
  })

  it("produces a vector whose committed form matches", async () => {
    const computed = await computeVector()
    const committed = JSON.parse(await readFile(VECTOR_PATH, "utf8")) as ParityVector

    // Compare by fixture NAME with the verdict attached, so a mismatch message
    // says which fixture disagreed rather than dumping two object diffs.
    const disagreements = Object.keys(computed)
      .filter((name) => committed[name] !== computed[name])
      .map((name) => `${name}: vector says ${String(committed[name])}, this side computed ${String(computed[name])}`)

    expect(
      disagreements,
      `the committed parity vector disagrees with a fresh validation:\n  ${disagreements.join("\n  ")}\n` +
        "Regenerate with `bun run generate:parity-vector`, then find out why before doing so.",
    ).toEqual([])
  })

  it("accepts every fixture", async () => {
    // Each fixture under tests/contracts/examples/ is a canonical, valid example,
    // so all 15 must validate. A rejection means the generated schema and the
    // committed example have drifted, and it is a real finding rather than a
    // judgement call about how permissive the schema should be.
    const rejected: string[] = []
    for (const fixture of await loadFixtures()) {
      const validate = await compile(fixture.contract)
      if (!validate(fixture.document)) {
        rejected.push(`${fixture.name}: ${firstError(validate, fixture.document)}`)
      }
    }
    expect(rejected, `fixtures rejected by their own contract:\n  ${rejected.join("\n  ")}`).toEqual([])
  })

  it("rejects an unknown key rather than stripping it", async () => {
    // The asymmetry ADR 0008 §2.3 records on purpose: the engine's `z.object`
    // schemas strip unknown keys, the router rejects them. Asserting the strict
    // half is the point -- a lost `additionalProperties: false` still validates
    // everything it should, so nothing else would notice it was gone.
    const validate = await compile("node")
    const fixture = (await loadFixtures()).find((candidate) => candidate.contract === "node")
    expect(fixture, "node.v1.json must exist").toBeDefined()

    const document = { ...(fixture?.document as Record<string, unknown>), __aibr_unknown_key__: true }
    expect(
      validate(document),
      `an unknown key was accepted. ${firstError(validate, document) === "(no errors reported)" ? "" : ""}`,
    ).toBe(false)
  })

  it("refuses an unknown schemaVersion rather than coercing it", async () => {
    // `SF-14`: unknown or missing version produces explicit failure, never an
    // empty state, a silent downgrade, or a coerced read. This asserts the
    // refusal direction; ADR 0002 §versioning is the reasoning.
    const validate = await compile("node")
    const fixture = (await loadFixtures()).find((candidate) => candidate.contract === "node")
    const document = { ...(fixture?.document as Record<string, unknown>) } as Record<string, unknown>
    document.schemaVersion = 9999

    expect(validate(document), "schemaVersion 9999 must be refused, not coerced").toBe(false)
  })
})
