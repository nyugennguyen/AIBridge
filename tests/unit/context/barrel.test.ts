/**
 * M5 barrels — the "is the milestone's public surface actually reachable through
 * its barrel" check, and a guard on the dependency direction.
 *
 * The repo's convention is that tests import through the barrel
 * (`src/tui/index.js`, `src/mesh/tui/index.js`). This file follows it, and it
 * earns its place twice over:
 *
 * 1. **Reachability.** A module reachable only by deep path import is a module
 *    nobody wired up, and the tests that use it prove nothing about the shipped
 *    surface.
 * 2. **Direction.** The dependency edge must be `src/memory` -> nothing in
 *    `src/context`, and `src/context` -> `src/memory`. An import in the wrong
 *    direction would make the determinism guarantee unfalsifiable, because the
 *    assembler would be able to reach a repository. The check is a source scan,
 *    because an import cycle is exactly the kind of thing a type-checker will
 *    happily accept.
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as memory from "../../../src/memory/index.js"
import * as context from "../../../src/context/index.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const MEMORY_DIRECTORY = join(REPOSITORY_ROOT, "src/memory")
const CONTEXT_DIRECTORY = join(REPOSITORY_ROOT, "src/context")

function sourceFiles(directory: string): readonly { path: string; text: string }[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const path = join(entry.parentPath ?? directory, entry.name)
      return { path, text: readFileSync(path, "utf8") }
    })
}

/** Import specifiers in a source file, ignoring the ones inside a docblock. */
function importsOf(text: string): readonly string[] {
  return [...text.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]!)
}

describe("M5 the milestone surface is reachable through its barrels", () => {
  it("the memory barrel exports the ontology, the record, and the ports", () => {
    // The three things a caller must be able to reach without a deep path.
    // Zod v4 schemas are objects, not constructors, so the check is "has a
    // parse method" rather than `typeof === "function"` — the latter would pass
    // for a function that is not a schema at all.
    expect(typeof memory.memoryRecordSchemaV2).toBe("object")
    expect(typeof memory.memoryRecordSchemaV2.parse).toBe("function")
    expect(typeof memory.memoryRecordSchemaV1).toBe("object")
    expect(typeof memory.memoryRecordSchemaV1.parse).toBe("function")
    expect(typeof memory.proposeMemoryRecord).toBe("function")
    expect(typeof memory.SCOPE_DEPTH).toBe("object")
    expect(typeof memory.ACCEPTING_ACTOR_KINDS).toBe("object")
    expect(typeof memory.scopeContains).toBe("function")
    // The egress-path list deliberately lives in `src/context/`, not here: it
    // describes what leaves the *system*, which is the assembler's problem, and
    // putting it in `memory` would make the audit depend on the store it audits.
    expect((memory as Record<string, unknown>)["MEMORY_EGRESS_PATHS"]).toBeUndefined()
  })

  it("the memory barrel exports both repositories and the workflow", () => {
    expect(typeof memory.InMemoryMemoryRepository).toBe("function")
    expect(typeof memory.FileMemoryRepository).toBe("function")
    expect(typeof memory.RepositoryMemoryWorkflow).toBe("function")
    expect(typeof memory.ScopeLatticeAccessPolicy).toBe("function")
  })

  it("the memory barrel exports the migration, the redaction, and the summarization", () => {
    expect(typeof memory.planLegacyMemoryDataMigration).toBe("function")
    expect(typeof memory.planV1MemoryMigration).toBe("function")
    expect(typeof memory.applyLegacyMemoryMigration).toBe("function")
    expect(typeof memory.DeterministicRedactionPipeline).toBe("function")
    expect(typeof memory.defaultRedactionPolicy).toBe("function")
    expect(typeof memory.handoffToMemoryRecord).toBe("function")
    expect(typeof memory.buildRunSummary).toBe("function")
  })

  it("the context barrel exports the assembler, the manifest schema, and the audit", () => {
    expect(typeof context.assembleContext).toBe("function")
    expect(typeof context.renderContextWithContent).toBe("function")
    expect(typeof context.contextManifestV2Schema).toBe("object")
    expect(typeof context.contextManifestV2Schema.parse).toBe("function")
    expect(typeof context.auditMemoryContext).toBe("function")
    expect(Array.isArray(context.MEMORY_EGRESS_PATHS)).toBe(true)
    expect(Array.isArray(context.ISOLATION_CASES)).toBe(true)
  })

  it("the context barrel exports the TUI view model and the reducer", () => {
    expect(typeof context.buildMemoryTuiView).toBe("function")
    expect(typeof context.reduceMemoryTui).toBe("function")
    expect(typeof context.initialMemoryTuiState).toBe("function")
    expect(typeof context.verifyPreviewMatchesManifest).toBe("function")
  })

  it("no name is exported by both barrels, so a star-import of both is unambiguous", () => {
    const memoryNames = Object.keys(memory).filter((name) => name !== "default")
    const contextNames = new Set(Object.keys(context))
    const collisions = memoryNames.filter((name) => contextNames.has(name))
    expect(collisions).toEqual([])
  })
})

describe("M5 the dependency edge runs one way", () => {
  it("src/memory never imports from src/context", () => {
    // The assembler reads memory through ports and returns a manifest. If
    // memory could reach the assembler, an assembly could read a repository
    // transitively, and "the same inputs produce the same manifest" would stop
    // being checkable by anyone.
    const offenders = sourceFiles(MEMORY_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier.includes("/context/") || specifier.endsWith("/context.js") || specifier === "../context/index.js")
      .map(({ file }) => file.replace(`${process.cwd()}/`, ""))
    expect(offenders).toEqual([])
  })

  it("src/context may import src/memory, and does", () => {
    const specifiers = sourceFiles(CONTEXT_DIRECTORY).flatMap((file) => importsOf(file.text))
    expect(specifiers.some((specifier) => specifier.includes("/memory/"))).toBe(true)
  })

  it("no module in either directory imports the other through the CLI or the server", () => {
    // A memory read that went through an HTTP route would have a transport
    // between it and the record, and the isolation audit's "seven egress paths"
    // would be missing one.
    const forbidden = ["/server/", "/cli.js", "/bridge.js", "/index.js"]
    const offenders = [...sourceFiles(MEMORY_DIRECTORY), ...sourceFiles(CONTEXT_DIRECTORY)]
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => forbidden.some((needle) => specifier.includes(needle)))
      .map(({ file, specifier }) => `${file.replace(`${process.cwd()}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])
  })

  it("the frozen M0 contract file is imported, never edited, by the memory subsystem", () => {
    // `src/orchestration/schemas.ts` is inside the signed digest. Importing it
    // is correct; a *local restatement* of a shape it owns would be drift, which
    // is why `memoryRecordSchemaV1` is asserted against it in the record-contract
    // test rather than trusted.
    const specifiers = sourceFiles(MEMORY_DIRECTORY).flatMap((file) => importsOf(file.text))
    const m0Imports = specifiers.filter((specifier) => specifier.includes("orchestration/schemas.js"))
    expect(m0Imports.length).toBeGreaterThan(0)
    // Every one of them is a sibling-directory hop out of `src/memory`, i.e. a
    // read of the frozen file. A bare `"../schemas.js"` would be a *different*
    // file with a similar name, and a local `schema.ts` would not appear at all.
    for (const specifier of m0Imports) {
      expect(specifier.startsWith("../orchestration/")).toBe(true)
    }
  })
})
