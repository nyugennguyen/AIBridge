/**
 * scripts/docs/generate-cli-reference.ts
 *
 * Generates `Docs/cli-reference.md` from the executable CLI help, so the
 * command list is never maintained in prose twice. `check-docs.ts` fails when
 * the committed reference and `aibr --help` disagree.
 *
 * Usage: bun scripts/docs/generate-cli-reference.ts
 */
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const CLI_REFERENCE_PATH = join(REPOSITORY_ROOT, "Docs", "cli-reference.md")

/** The exact `aibr --help` output. This is the executable truth. */
export function cliHelp(): string {
  return execFileSync("bun", ["src/cli.ts", "--help"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trimEnd()
}

export function renderCliReference(help: string = cliHelp()): string {
  return `# CLI reference

> **Status:** Current
> **Applies to:** the CLI built from this tree
> **Owner:** maintainers

## Purpose

Executable reference for the \`aibr\` command. The command table below is
generated from \`aibr --help\`; regenerate it with:

\`\`\`bash
bun scripts/docs/generate-cli-reference.ts
\`\`\`

If this file and the CLI disagree, the CLI wins and \`bun run docs:check\` fails.

## Commands and options

\`\`\`text
${help}
\`\`\`
`
}

// `import.meta.main` is Bun-only; the argv comparison keeps this runnable under
// tsx/node too (same pattern as scripts/package-binaries.ts).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  writeFileSync(CLI_REFERENCE_PATH, renderCliReference())
  console.log(`wrote ${CLI_REFERENCE_PATH}`)
}
