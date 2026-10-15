/**
 * scripts/docs/sync-skills.ts
 *
 * Canonical skill mirrors. `.opencode/skills/` is the canonical source (the tree
 * AGENTS.md names as where repository skills live); `.claude/skills/` and
 * `.agents/skills/` are generated mirrors of it. Editing a mirror by hand is
 * drift, and `check-docs.ts` fails on drift.
 *
 * Usage:
 *   bun scripts/docs/sync-skills.ts           # copy canonical content into the mirrors
 *   bun scripts/docs/sync-skills.ts --check   # exit 1 and list drift, changing nothing
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const CANONICAL_SKILLS = join(REPOSITORY_ROOT, ".opencode", "skills")
export const SKILL_MIRRORS = [join(REPOSITORY_ROOT, ".claude", "skills"), join(REPOSITORY_ROOT, ".agents", "skills")]

export interface MirrorDrift {
  /** Path relative to the repository root, so output names a real file. */
  readonly file: string
  readonly kind: "missing" | "differs" | "extra"
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(path))
    else files.push(path)
  }
  return files
}

/** Byte-level drift between the canonical skill tree and each mirror. */
export function checkMirrors(): MirrorDrift[] {
  const drift: MirrorDrift[] = []
  const canonicalRelative = listFiles(CANONICAL_SKILLS).map((path) => relative(CANONICAL_SKILLS, path))

  for (const mirror of SKILL_MIRRORS) {
    const mirroredRelative = new Set(listFiles(mirror).map((path) => relative(mirror, path)))

    for (const rel of canonicalRelative) {
      const mirrored = join(mirror, rel)
      if (!mirroredRelative.has(rel)) {
        drift.push({ file: relative(REPOSITORY_ROOT, mirrored), kind: "missing" })
      } else if (!readFileSync(mirrored).equals(readFileSync(join(CANONICAL_SKILLS, rel)))) {
        drift.push({ file: relative(REPOSITORY_ROOT, mirrored), kind: "differs" })
      }
    }
    for (const rel of mirroredRelative) {
      if (!canonicalRelative.includes(rel)) {
        drift.push({ file: relative(REPOSITORY_ROOT, join(mirror, rel)), kind: "extra" })
      }
    }
  }
  return drift
}

/** Copy canonical content into every mirror. Returns the files written. */
export function syncMirrors(): string[] {
  const written: string[] = []
  for (const source of listFiles(CANONICAL_SKILLS)) {
    const rel = relative(CANONICAL_SKILLS, source)
    for (const mirror of SKILL_MIRRORS) {
      const destination = join(mirror, rel)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, readFileSync(source))
      written.push(relative(REPOSITORY_ROOT, destination))
    }
  }
  return written
}

// `import.meta.main` is Bun-only; the argv comparison keeps this runnable under
// tsx/node too (same pattern as scripts/package-binaries.ts).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const checkOnly = process.argv.includes("--check")
  if (checkOnly) {
    const drift = checkMirrors()
    if (drift.length > 0) {
      console.error("Skill mirrors have drifted from .opencode/skills/ (the canonical source):")
      for (const item of drift) console.error(`  ${item.kind}: ${item.file}`)
      console.error("Run `bun scripts/docs/sync-skills.ts` to regenerate the mirrors.")
      process.exit(1)
    }
    console.log(`Skill mirrors match .opencode/skills/ (${SKILL_MIRRORS.length} mirrors checked).`)
  } else {
    for (const file of syncMirrors()) console.log(`synced ${file}`)
  }
}
