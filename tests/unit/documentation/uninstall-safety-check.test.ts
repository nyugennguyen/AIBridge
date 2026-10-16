import { describe, expect, it } from "vitest"
import {
  parseMarkdownSections,
  validateMarkdownUninstallSafety,
  BROAD_ROOT_DELETION,
  DESTRUCTIVE_WARNING,
} from "../../../scripts/docs/check-docs.js"

describe("uninstall safety checker", () => {
  // ── Case A: Broad deletion without warning must fail ───────────────────────

  it("fails when a broad deletion command lacks a safety warning", () => {
    const markdown = [
      "# Uninstallation",
      "",
      "Run this command to remove AIBridge:",
      "",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toContain("documents un-warned recursive deletion")
    expect(errors[0]).toContain("test.md:1")
  })

  // ── Case B: Deletion in destructive section with warning must pass ─────────

  it("passes when deletion is inside a destructive section with caution banner", () => {
    const markdown = [
      "## Maintenance",
      "",
      "#### Destructive Complete Data Removal",
      "",
      "> [!CAUTION]",
      "> **Irreversible Action:** This will permanently delete all AIBridge data.",
      "",
      "```bash",
      'rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/aibridge"',
      'rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/aibridge"',
      'rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/aibridge"',
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors).toEqual([])
  })

  // ── Case C: Warning in unrelated section must not satisfy unsafe command ────

  it("fails when caution warning is in an unrelated section earlier in the file", () => {
    const markdown = [
      "## 1. Security & Keys",
      "",
      "> [!CAUTION]",
      "> **Irreversible Action:** Rotating master keys will invalidate all existing sessions.",
      "",
      "## 2. Quick Uninstall",
      "",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("documents un-warned recursive deletion")
    expect(errors[0]).toContain("## 2. Quick Uninstall")
  })

  // ── Case D: Package-only removal instructions must pass ────────────────────

  it("passes for standard package removal without user data deletion", () => {
    const markdown = [
      "### Uninstallation",
      "",
      "To remove the CLI package:",
      "",
      "```bash",
      "bun remove -g @nyugennguyen/aibridge",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors).toEqual([])
  })

  // ── Case E: Edge cases ────────────────────────────────────────────────────

  it("passes for profile-scoped directory deletion", () => {
    const markdown = [
      "### Profile Cleanup",
      "",
      "```bash",
      "rm -r ~/.config/aibridge/my-profile",
      'rm -r "${XDG_DATA_HOME:-$HOME/.local/share}/aibridge/my-profile"',
      'rm -r "${XDG_STATE_HOME:-$HOME/.local/state}/aibridge/my-profile"',
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors).toEqual([])
  })

  it("passes for specific secret file deletion (token rotation)", () => {
    const markdown = [
      "### Rotate Secret",
      "",
      "```bash",
      "rm ~/.local/share/aibridge/default/secrets/bearer_token",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors).toEqual([])
  })

  it("detects broad deletion with XDG parameter expansions", () => {
    const markdown = [
      "### Wipe",
      "",
      "```bash",
      'rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/aibridge"',
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("documents un-warned recursive deletion")
  })

  it("does not treat code fence comments as markdown headings", () => {
    const markdown = [
      "# Real Heading",
      "",
      "```bash",
      "# Comment inside code block that looks like a heading",
      "echo 'hello'",
      "```",
    ].join("\n")

    const sections = parseMarkdownSections(markdown)
    expect(sections.length).toBe(1)
    expect(sections[0]!.heading).toBe("# Real Heading")
  })

  it("bypasses documents marked with archived or historical status", () => {
    const markdown = [
      "# Historical Recovery Guide",
      "",
      "> **Status:** Archived",
      "",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "archive.md")
    expect(errors).toEqual([])
  })
})
