/**
 * Structural tests for the notification module (ADR 0007 §17, §12).
 *
 * The orchestration consumer (`consumer.ts`) and its moment-by-moment tests
 * were removed with the kernel in 3.2.0 (block D5, ADR 0016). What stays:
 * the module is push-only (no timers) and keeps its import boundary in both
 * directions, until it is wired for V5 (3.5.0).
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const NOTIFICATIONS_DIR = join(REPOSITORY_ROOT, "src/notifications")

function sourceFiles(directory: string): readonly { path: string; text: string }[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const path = join(entry.parentPath ?? directory, entry.name)
      return { path, text: readFileSync(path, "utf8") }
    })
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

function importsOf(text: string): readonly string[] {
  return [...stripComments(text).matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!)
}

describe("Event-Driven Guarantee: No Polling Loops", () => {
  it("structurally contains NO setInterval, setTimeout, or setImmediate in src/notifications", () => {
    const files = sourceFiles(NOTIFICATIONS_DIR)
    const timerRegex = /\b(setInterval|setTimeout|setImmediate)\s*\(/
    for (const file of files) {
      const code = stripComments(file.text)
      expect(timerRegex.test(code), `${file.path} contains timer functions (violates event-driven rule)`).toBe(false)
    }
  })
})

describe("Structural Isolation: Boundary Discipline (M4/M5 Style)", () => {
  it("orchestration modules never import from notifications", () => {
    const orchestrationFiles = sourceFiles(join(REPOSITORY_ROOT, "src/orchestration"))
    const offenders = orchestrationFiles
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier.includes("/notifications/") || specifier.includes("notifications"))
    expect(offenders).toEqual([])
  })

  it("notification module imports NO orchestration command schemas or types", () => {
    const notificationFiles = sourceFiles(NOTIFICATIONS_DIR)
    for (const file of notificationFiles) {
      const code = stripComments(file.text)
      expect(code).not.toContain("orchestrationCommandSchema")
      expect(code).not.toContain("OrchestrationCommand")
    }
  })
})

