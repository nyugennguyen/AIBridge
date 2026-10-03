/**
 * Write the cross-language parity vector.
 *
 * Run by `bun run generate:parity-vector`. It validates each of the 15 fixtures
 * in `tests/contracts/examples/` against the committed JSON Schema in
 * `contracts/v1/` with `ajv`, and records the accept/reject verdict per fixture
 * into `router/tests/parity-vector.json`.
 *
 * ## Why this is a SEPARATE module from the parity test
 *
 * A test that rewrites the expectation it asserts against is not a test. If the
 * writer ran inside `bun test`, a parity failure would "resolve" by regenerating
 * the vector to whatever the broken side now claims — and both languages would
 * then agree, which is precisely the false green
 * `tests/contracts/ingress-parity.test.ts` exists to make impossible.
 *
 * So this is the only thing that writes the file. The test module only compares.
 *
 * ## Why the vector is committed
 *
 * `cargo test` reads it, and `cargo test` has no Bun. A vector generated at test
 * time would be unavailable to exactly the half of the check that needs it.
 */
import { readFile, readdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
// `ajv/dist/2020.js` is CommonJS, so under NodeNext ESM the namespace object
// arrives with `default` holding the class. Importing the bare default yields the
// MODULE, which has no construct signature; the type error names the module
// rather than anything schema-shaped, which is why it is worth a comment.
import Ajv2020Module from "ajv/dist/2020.js"
import type { ValidateFunction } from "ajv"

const Ajv2020 = Ajv2020Module.default

const EXAMPLES_DIRECTORY = fileURLToPath(new URL("../tests/contracts/examples/", import.meta.url))
const CONTRACTS_DIRECTORY = fileURLToPath(new URL("../contracts/v1/", import.meta.url))
const VECTOR_PATH = fileURLToPath(new URL("../router/tests/parity-vector.json", import.meta.url))

/** fixture file name -> whether the JSON Schema accepts it */
type ParityVector = Record<string, boolean>

/**
 * `strict` and the two disabled coercions are load-bearing, not defaults chosen
 * for convenience. `coerceTypes` would turn a rejected `"5"` into an accepted
 * `5`; `useDefaults` would fill in a `required` field and accept a payload that
 * omits it. Either one manufactures agreement between the two languages over
 * payloads they actually disagree on, which is the only failure this file cannot
 * be allowed to have.
 */
function compileValidator(schema: object): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false })
  return ajv.compile(schema)
}

async function computeVector(): Promise<ParityVector> {
  const names = (await readdir(EXAMPLES_DIRECTORY)).filter((name) => name.endsWith(".v1.json")).sort()
  const validators = new Map<string, ValidateFunction>()
  const vector: ParityVector = {}

  for (const name of names) {
    const contract = name.replace(/\.v1\.json$/, "")
    let validate = validators.get(contract)
    if (validate === undefined) {
      const schema = JSON.parse(await readFile(`${CONTRACTS_DIRECTORY}${contract}.schema.json`, "utf8")) as object
      validate = compileValidator(schema)
      validators.set(contract, validate)
    }
    const document = JSON.parse(await readFile(`${EXAMPLES_DIRECTORY}${name}`, "utf8")) as unknown
    vector[name] = validate(document) as boolean
  }

  return vector
}

const vector = await computeVector()
await writeFile(VECTOR_PATH, `${JSON.stringify(vector, null, 2)}\n`)
const accepted = Object.values(vector).filter(Boolean).length
console.log(`generate:parity-vector: ${accepted}/${Object.keys(vector).length} fixtures accepted -> ${VECTOR_PATH}`)

if (accepted !== Object.keys(vector).length) {
  const rejected = Object.entries(vector)
    .filter(([, isAccepted]) => !isAccepted)
    .map(([name]) => name)
  console.error(`REJECTED, which is unexpected: every fixture is a canonical example of its own contract.\n  ${rejected.join("\n  ")}`)
  process.exit(1)
}