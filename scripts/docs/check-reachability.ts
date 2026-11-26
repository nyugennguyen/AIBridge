/**
 * scripts/docs/check-reachability.ts
 *
 * Reachability report (`bun run docs:reachability`, also run by `docs:check`).
 * Walks every relative `import`, `export ... from` and `import()` starting at
 * the two runtime entry points (`src/cli.ts`, `src/index.ts`) and reports, per
 * `src/` directory, how many lines of TypeScript can never run.
 *
 * It WARNS and never fails (ADR 0016). A warning is raised when a directory has
 * at least 500 unreachable lines that no exemption covers, or when an exemption
 * is past its wire or delete deadline while its code is still unreachable.
 * Exemptions live in `reachability-exemptions.json`.
 *
 * Usage: bun scripts/docs/check-reachability.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const ENTRY_POINTS = ["src/cli.ts", "src/index.ts"] as const
export const WARN_THRESHOLD_LINES = 500

export interface Exemption {
  readonly path: string
  readonly reason: string
  readonly wireDeadline: string
  readonly deleteDeadline: string
  readonly adr: string
}

export interface DirectoryReport {
  readonly directory: string
  readonly totalLines: number
  readonly unreachableLines: number
  readonly exemptLines: number
  /** Unreachable lines that no exemption covers; this is what the threshold applies to. */
  readonly unexemptedLines: number
  readonly unreachableFiles: number
  readonly totalFiles: number
}

export interface ReachabilityResult {
  readonly directories: readonly DirectoryReport[]
  readonly warnings: readonly string[]
  readonly totalLines: number
  readonly unreachableLines: number
}

/** Remove comments so an import written inside one is not followed. Strings are left alone. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
}

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?[^"'`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s*from\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
]

/** Relative module specifiers (`./x.js`, `../y/index.js`) found in one source file. */
export function extractRelativeSpecifiers(source: string): string[] {
  const code = stripComments(source)
  const found = new Set<string>()
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined && specifier.startsWith(".")) found.add(specifier)
    }
  }
  return [...found]
}

/** Map a specifier written with a `.js` extension back to the file that exists. */
export function resolveSpecifier(fromFile: string, specifier: string, files: ReadonlySet<string>): string | undefined {
  const base = join(dirname(fromFile), specifier).split("\\").join("/")
  const stem = base.replace(/\.(?:js|mjs|cjs)$/, "")
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}/index.ts`, `${stem}/index.ts`]
  return candidates.find((candidate) => files.has(candidate))
}

/** Every file reachable from the entry points. `sources` maps a repo-relative path to its text. */
export function computeReachable(sources: ReadonlyMap<string, string>, entries: readonly string[]): Set<string> {
  const files = new Set(sources.keys())
  const reachable = new Set<string>()
  const queue = entries.filter((entry) => files.has(entry))
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (reachable.has(file)) continue
    reachable.add(file)
    for (const specifier of extractRelativeSpecifiers(sources.get(file) ?? "")) {
      const target = resolveSpecifier(file, specifier, files)
      if (target !== undefined && !reachable.has(target)) queue.push(target)
    }
  }
  return reachable
}

export function countLines(text: string): number {
  if (text.length === 0) return 0
  const newlines = text.split("\n").length - 1
  return text.endsWith("\n") ? newlines : newlines + 1
}

export function parseVersion(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = (version.split("-")[0] ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0)
  return [major, minor, patch]
}

/** True when `current` is the same release as `deadline` or later. */
export function isDeadlinePassed(current: string, deadline: string): boolean {
  const a = parseVersion(current)
  const b = parseVersion(deadline)
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

function isCovered(file: string, exemption: Exemption): boolean {
  return file === exemption.path || file.startsWith(`${exemption.path}/`)
}

export function analyze(
  sources: ReadonlyMap<string, string>,
  exemptions: readonly Exemption[],
  currentVersion: string,
  entries: readonly string[] = ENTRY_POINTS,
): ReachabilityResult {
  const reachable = computeReachable(sources, entries)
  const byDirectory = new Map<string, { total: number; dead: number; exempt: number; deadFiles: number; files: number }>()
  const exemptDead = new Map<string, number>()
  for (const [file, text] of sources) {
    const parts = file.split("/")
    const directory = parts.length > 2 ? `${parts[0]}/${parts[1]}` : `${parts[0]}/(root)`
    const row = byDirectory.get(directory) ?? { total: 0, dead: 0, exempt: 0, deadFiles: 0, files: 0 }
    const lines = countLines(text)
    row.total += lines
    row.files += 1
    if (!reachable.has(file)) {
      row.dead += lines
      row.deadFiles += 1
      const owner = exemptions.find((exemption) => isCovered(file, exemption))
      if (owner !== undefined) {
        row.exempt += lines
        exemptDead.set(owner.path, (exemptDead.get(owner.path) ?? 0) + lines)
      }
    }
    byDirectory.set(directory, row)
  }

  const directories: DirectoryReport[] = [...byDirectory.entries()]
    .map(([directory, row]) => ({
      directory,
      totalLines: row.total,
      unreachableLines: row.dead,
      exemptLines: row.exempt,
      unexemptedLines: row.dead - row.exempt,
      unreachableFiles: row.deadFiles,
      totalFiles: row.files,
    }))
    .sort((a, b) => b.unreachableLines - a.unreachableLines || a.directory.localeCompare(b.directory))

  const warnings: string[] = []
  for (const report of directories) {
    if (report.unexemptedLines >= WARN_THRESHOLD_LINES) {
      warnings.push(
        `${report.directory}: ${report.unexemptedLines} unreachable lines are not exempt (threshold ${WARN_THRESHOLD_LINES}). Wire it, add a dated entry to scripts/docs/reachability-exemptions.json, or delete it.`,
      )
    }
  }
  for (const exemption of exemptions) {
    const dead = exemptDead.get(exemption.path) ?? 0
    if (dead === 0) continue
    if (isDeadlinePassed(currentVersion, exemption.deleteDeadline)) {
      warnings.push(`${exemption.path}: delete deadline ${exemption.deleteDeadline} passed (current ${currentVersion}) and ${dead} lines are still unreachable (${exemption.adr}).`)
    } else if (isDeadlinePassed(currentVersion, exemption.wireDeadline)) {
      warnings.push(`${exemption.path}: wire deadline ${exemption.wireDeadline} passed (current ${currentVersion}) and ${dead} lines are still unreachable (${exemption.adr}).`)
    }
  }

  return {
    directories,
    warnings,
    totalLines: directories.reduce((sum, d) => sum + d.totalLines, 0),
    unreachableLines: directories.reduce((sum, d) => sum + d.unreachableLines, 0),
  }
}

function collectSources(root: string): Map<string, string> {
  const sources = new Map<string, string>()
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) sources.set(relative(root, full).split("\\").join("/"), readFileSync(full, "utf8"))
    }
  }
  walk(join(root, "src"))
  return sources
}

function main(): void {
  const sources = collectSources(REPOSITORY_ROOT)
  const exemptions = (JSON.parse(readFileSync(join(REPOSITORY_ROOT, "scripts/docs/reachability-exemptions.json"), "utf8")) as { exemptions: Exemption[] }).exemptions
  const versionText = readFileSync(join(REPOSITORY_ROOT, "src/version.ts"), "utf8")
  const version = /CLI_VERSION\s*=\s*"([^"]+)"/.exec(versionText)?.[1] ?? "0.0.0"
  for (const exemption of exemptions) {
    if (!existsSync(join(REPOSITORY_ROOT, exemption.path))) console.warn(`reachability: exemption path does not exist: ${exemption.path}`)
  }
  const result = analyze(sources, exemptions, version)
  console.log(`Reachability from ${ENTRY_POINTS.join(", ")} (version ${version})`)
  console.log(`${"directory".padEnd(24)} ${"total".padStart(7)} ${"dead".padStart(7)} ${"exempt".padStart(7)} ${"files".padStart(9)}`)
  for (const d of result.directories) {
    if (d.unreachableLines === 0) continue
    console.log(`${d.directory.padEnd(24)} ${String(d.totalLines).padStart(7)} ${String(d.unreachableLines).padStart(7)} ${String(d.exemptLines).padStart(7)} ${`${d.unreachableFiles}/${d.totalFiles}`.padStart(9)}`)
  }
  console.log(`total ${result.totalLines} lines, ${result.unreachableLines} unreachable`)
  for (const warning of result.warnings) console.warn(`warning: ${warning}`)
  if (result.warnings.length === 0) console.log("reachability: no warnings")
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
