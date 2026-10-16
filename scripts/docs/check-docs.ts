/**
 * scripts/docs/check-docs.ts
 *
 * Deterministic documentation gate (`bun run docs:check`). Everything here is
 * checkable offline: no external link crawling, no network, no judgment calls.
 * It exists to stop the specific drift Phase 1 found — docs disagreeing with
 * the executable, mirrored skills edited separately, links to files that do not
 * exist, and publishing logic creeping back into the validation workflow.
 *
 * Checks:
 *   1. required documentation entry points exist
 *   2. internal Markdown links and anchors resolve
 *   3. mirrored skill trees match the canonical `.opencode/skills/`
 *   4. `ci.yml` stays validation-only (no publish commands or npm credentials)
 *   5. `Docs/reference/cli-reference.md` matches the executable `aibr --help`
 *   6. every `aibr <command>` documented in a fenced block exists in the CLI
 *   7. `config/*.example.json` parses with the application's config schema
 *   8. archived documents in `Docs/archive/` contain required status markers
 *
 * Usage: bun scripts/docs/check-docs.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { bridgeConfigSchema } from "../../src/config/schemas.js"
import { CLI_REFERENCE_PATH, cliHelp } from "./generate-cli-reference.js"
import { checkMirrors } from "./sync-skills.js"

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const REQUIRED_ENTRY_POINTS = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "Docs/README.md",
  "Docs/getting-started.md",
  "Docs/CONTRIBUTING.md",
  "Docs/architecture/current-state.md",
  "Docs/architecture/decisions/README.md",
  "Docs/adr/README.md",
  "Docs/guides/configuration.md",
  "Docs/guides/development.md",
  "Docs/guides/integrations.md",
  "Docs/operations/deployment.md",
  "Docs/operations/monitoring.md",
  "Docs/operations/troubleshooting.md",
  "Docs/security/security-model.md",
  "Docs/reference/cli-reference.md",
  "Docs/archive/README.md",
]

const SCAN_DIRECTORIES = ["Docs", ".opencode/skills", ".claude/skills", ".agents/skills"]
const SCAN_ROOT_FILES = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "CHANGELOG.md"]

/** A fenced code block, from opening fence to closing fence. */
const FENCE_BLOCK = /^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)\s*$/gm

/**
 * A document whose commands are explicitly NOT verified against the CLI:
 * historical records and design docs kept as evidence. The command check holds
 * current-state docs to the executable standard and leaves these to history.
 */
const UNVERIFIED_STATUS = />\s*\*\*Status:\*\*\s*(Historical|Superseded|Needs revalidation|Archived)/i

// ── helpers ──────────────────────────────────────────────────────────────

function markdownFiles(): string[] {
  const files = [...SCAN_ROOT_FILES]
  for (const directory of SCAN_DIRECTORIES) {
    const root = join(REPOSITORY_ROOT, directory)
    if (!existsSync(root)) continue
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith(".md")) files.push(path)
      }
    }
    walk(root)
  }
  return files.filter((file) => existsSync(file)).map((file) => relative(REPOSITORY_ROOT, file))
}

/** GitHub-style heading anchor slugs, with the duplicate-heading suffixes. */
function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>()
  let inFence = false
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) continue
    const heading = /^#{1,6}\s+(.*)$/.exec(line)?.[1]
    if (!heading) continue
    const base = heading
      .trim()
      .toLowerCase()
      .replace(/[^\w\- ]+/g, "")
      .replace(/ /g, "-")
    let slug = base
    for (let duplicate = 1; slugs.has(slug); duplicate += 1) slug = `${base}-${duplicate}`
    slugs.add(slug)
  }
  return slugs
}

function codeFences(markdown: string): string[] {
  const blocks: string[] = []
  for (const match of markdown.matchAll(/^(?:```|~~~)[^\n]*\n([\s\S]*?)^(?:```|~~~)\s*$/gm)) {
    blocks.push(match[1] ?? "")
  }
  return blocks
}

/** Command names the executable CLI actually offers. */
function cliCommands(help: string): Set<string> {
  const commands = new Set<string>()
  let inCommands = false
  for (const line of help.split("\n")) {
    if (line.startsWith("Commands:")) {
      inCommands = true
      continue
    }
    if (!inCommands) continue
    if (line.trim() === "") break
    const name = line.trim().split(/\s+/)[0]
    if (name) commands.add(name)
  }
  return commands
}

// ── checks ───────────────────────────────────────────────────────────────

function checkInternalLinks(): string[] {
  const errors: string[] = []
  const slugCache = new Map<string, Set<string>>()
  const slugsOf = (file: string): Set<string> => {
    let slugs = slugCache.get(file)
    if (!slugs) {
      slugs = headingSlugs(readFileSync(join(REPOSITORY_ROOT, file), "utf8"))
      slugCache.set(file, slugs)
    }
    return slugs
  }

  for (const file of markdownFiles()) {
    const text = readFileSync(join(REPOSITORY_ROOT, file), "utf8").replace(FENCE_BLOCK, "")
    for (const match of text.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
      // Markdown escapes (`https\://…`) survive into the captured target;
      // unescape before judging whether the target is an external scheme.
      const target = (match[1] ?? "").replace(/\\(.)/g, "$1")
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue // external scheme — not checked here
      const [pathPart, anchor] = target.split("#")
      const resolved = pathPart === "" ? file : resolve(dirname(join(REPOSITORY_ROOT, file)), pathPart)
      const relativeTarget = relative(REPOSITORY_ROOT, resolved)
      if (!existsSync(resolved)) {
        errors.push(`${file}: link to missing path '${target}'`)
        continue
      }
      if (anchor && resolved.endsWith(".md") && !slugsOf(relativeTarget).has(anchor.toLowerCase())) {
        errors.push(`${file}: link to missing anchor '${target}'`)
      }
    }
  }
  return errors
}

function checkCiValidationOnly(): string[] {
  const errors: string[] = []
  const workflows = join(REPOSITORY_ROOT, ".github", "workflows")
  const ci = readFileSync(join(workflows, "ci.yml"), "utf8")
  if (/npm publish/.test(ci)) errors.push(".github/workflows/ci.yml must not publish to npm")
  if (/NPM_TOKEN|NODE_AUTH_TOKEN/.test(ci)) errors.push(".github/workflows/ci.yml must not reference npm credentials")
  for (const file of readdirSync(workflows).sort()) {
    if (file === "ci.yml" || !(file.endsWith(".yml") || file.endsWith(".yaml"))) continue
    const content = readFileSync(join(workflows, file), "utf8")
    if (/npm publish/.test(content) && file !== "publish.yml") {
      errors.push(`.github/workflows/${file} publishes to npm; publish.yml is the sole publishing authority`)
    }
  }
  return errors
}

function checkCliReference(help: string): string[] {
  if (!existsSync(CLI_REFERENCE_PATH)) return [] // entry-point check already reports this
  const reference = readFileSync(CLI_REFERENCE_PATH, "utf8")
  const documented = /\`\`\`text\n([\s\S]*?)\`\`\`/.exec(reference)?.[1]?.trimEnd()
  const displayPath = relative(REPOSITORY_ROOT, CLI_REFERENCE_PATH)
  if (documented === undefined) return [`${displayPath} has no \`\`\`text block generated from aibr --help`]
  if (documented !== help.trimEnd()) {
    return [`${displayPath} is stale: run \`bun scripts/docs/generate-cli-reference.ts\` (aibr --help is the truth)`]
  }
  return []
}

function checkDocumentedCommands(help: string): string[] {
  const errors: string[] = []
  const commands = cliCommands(help)
  for (const file of markdownFiles()) {
    const content = readFileSync(join(REPOSITORY_ROOT, file), "utf8")
    if (UNVERIFIED_STATUS.test(content)) continue
    const fences = codeFences(content).join("\n")
    for (const match of fences.matchAll(/(?:^|\s)aibr\s+([a-z][a-z0-9-]*)/g)) {
      const command = match[1] ?? ""
      if (!commands.has(command)) {
        errors.push(`${file}: documents 'aibr ${command}', which the CLI does not implement`)
      }
    }
  }
  return errors
}

function checkConfigExamples(): string[] {
  const errors: string[] = []
  const configDirectory = join(REPOSITORY_ROOT, "config")
  for (const file of readdirSync(configDirectory).sort()) {
    if (!file.endsWith(".example.json")) continue
    const path = join(configDirectory, file)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
      errors.push(`config/${file}: invalid JSON (${(error as Error).message})`)
      continue
    }
    const result = bridgeConfigSchema.safeParse(parsed)
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`config/${file}: ${issue.path.join(".") || "<root>"} — ${issue.message}`)
      }
    }
  }
  return errors
}

function checkArchiveStatusMarkers(): string[] {
  const errors: string[] = []
  const archiveDir = join(REPOSITORY_ROOT, "Docs", "archive")
  if (!existsSync(archiveDir)) return errors
  for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    if (entry.name === "README.md") continue
    const content = readFileSync(join(archiveDir, entry.name), "utf8")
    if (!/>\s*\*\*Status:\*\*\s*(Archived|Superseded|Historical|Needs revalidation)/i.test(content)) {
      errors.push(`Docs/archive/${entry.name}: missing required archive status marker (> **Status:** Archived|Superseded|Historical)`)
    }
  }
  return errors
}

export interface MarkdownSection {
  heading: string
  content: string
  startLine: number
}

/**
 * Splits a Markdown document into heading-delimited sections, preserving line numbers
 * and ignoring headings nested inside fenced code blocks.
 */
export function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split("\n")
  const sections: MarkdownSection[] = []
  let currentHeading = ""
  let currentLines: string[] = []
  let currentStartLine = 1
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
    }
    if (!inFence && /^#{1,6}\s+(.*)$/.test(line)) {
      if (currentLines.length > 0 || currentHeading !== "") {
        sections.push({
          heading: currentHeading,
          content: currentLines.join("\n"),
          startLine: currentStartLine,
        })
      }
      currentHeading = line
      currentLines = [line]
      currentStartLine = i + 1
    } else {
      currentLines.push(line)
    }
  }
  if (currentLines.length > 0 || currentHeading !== "") {
    sections.push({
      heading: currentHeading,
      content: currentLines.join("\n"),
      startLine: currentStartLine,
    })
  }
  return sections
}

/**
 * Matches broad recursive deletion commands targeting root AIBridge directories without profile scoping:
 * e.g. rm -rf ~/.config/aibridge, rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/aibridge", rm -rf "$XDG_DATA_HOME/aibridge"
 */
export const BROAD_ROOT_DELETION =
  /rm\s+(?:-[a-zA-Z]*\s+)*(?:~|\$HOME|\$\{HOME\}|\/home\/[\w.-]+|\/Users\/[\w.-]+|["']?\$\{?(?:XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_STATE_HOME)[^}"]*\}?)(?:\/(?:\.config|\.local\/share|\.local\/state))?\/aibridge\/?["']?(?:\s|$|`|\n)/

export const DESTRUCTIVE_WARNING =
  />\s*\[!(?:CAUTION|WARNING)\][\s\S]*?(?:destructive|irreversible|permanently delete|wipe)/i

/**
 * Validates that any destructive root deletion command is strictly enclosed within a section
 * that contains an explicit caution or warning banner ([!CAUTION] or [!WARNING]).
 */
export function validateMarkdownUninstallSafety(
  content: string,
  filePath = "document.md",
): string[] {
  if (UNVERIFIED_STATUS.test(content)) return []

  const errors: string[] = []
  const sections = parseMarkdownSections(content)

  for (const section of sections) {
    if (BROAD_ROOT_DELETION.test(section.content)) {
      const hasWarning = DESTRUCTIVE_WARNING.test(section.content)

      if (!hasWarning) {
        errors.push(
          `${filePath}:${section.startLine}: documents un-warned recursive deletion of root ~/.config/aibridge or ~/.local/{share,state}/aibridge in section '${section.heading || "<preamble>"}'. Root data removal must be isolated in an explicitly marked destructive section with a caution/warning banner.`,
        )
      }
    }
  }

  return errors
}

export function checkSafeUninstallation(): string[] {
  const errors: string[] = []
  for (const file of markdownFiles()) {
    const content = readFileSync(join(REPOSITORY_ROOT, file), "utf8")
    const fileErrors = validateMarkdownUninstallSafety(content, file)
    errors.push(...fileErrors)
  }
  return errors
}

// ── main ─────────────────────────────────────────────────────────────────

function main(): void {
  const help = cliHelp()
  const checks: Record<string, string[]> = {
    "documentation entry points": REQUIRED_ENTRY_POINTS.filter((file) => !existsSync(join(REPOSITORY_ROOT, file))).map(
      (file) => `missing required documentation entry point: ${file}`,
    ),
    "internal links": checkInternalLinks(),
    "skill mirrors": checkMirrors().map(
      (item) => `skill mirror ${item.kind}: ${item.file} (canonical source is .opencode/skills/)`,
    ),
    "release authority": checkCiValidationOnly(),
    "CLI reference": checkCliReference(help),
    "documented commands": checkDocumentedCommands(help),
    "config examples": checkConfigExamples(),
    "archive status markers": checkArchiveStatusMarkers(),
    "safe uninstallation guidance": checkSafeUninstallation(),
  }

  let failed = false
  for (const [name, errors] of Object.entries(checks)) {
    if (errors.length === 0) {
      console.log(`ok      ${name}`)
    } else {
      failed = true
      console.error(`FAILED  ${name}`)
      for (const error of errors) console.error(`        ${error}`)
    }
  }
  if (failed) process.exit(1)
  console.log("docs:check passed")
}

// `import.meta.main` is Bun-only; the argv comparison keeps this runnable under
// tsx/node too (same pattern as scripts/package-binaries.ts).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
