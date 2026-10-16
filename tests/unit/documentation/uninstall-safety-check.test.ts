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
      "> **Irreversible Action:** This will permanently delete all AIBridge profiles and configuration directories.",
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

  // ── Case C: Unrelated warning must not satisfy unsafe command ──────────────

  it("fails when caution warning is in an unrelated section earlier in the file", () => {
    const markdown = [
      "## 1. Security & Keys",
      "",
      "> [!CAUTION]",
      "> **Irreversible Action:** Rotating master keys will permanently delete all active sessions.",
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

  it("fails when warning in the SAME section addresses an unrelated operation", () => {
    const markdown = [
      "## Maintenance Operations",
      "",
      "> [!CAUTION]",
      "> **Network Notice:** Never expose bridge port 8787 to public networks without Tailscale encryption.",
      "",
      "Run the cleanup command below:",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("documents un-warned recursive deletion")
    expect(errors[0]).toContain("## Maintenance Operations")
  })

  it("fails when caution banner is placed AFTER the destructive command in the same section", () => {
    const markdown = [
      "## Clean Up",
      "",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
      "",
      "> [!CAUTION]",
      "> **Irreversible Action:** The above command permanently deleted all profile data.",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("documents un-warned recursive deletion")
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

  // ── Case E: Command syntax variants & edge cases ──────────────────────────

  it("detects double-dash options: rm --recursive --force ~/.config/aibridge", () => {
    const markdown = [
      "### Wipe",
      "",
      "```bash",
      "rm --recursive --force ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("documents un-warned recursive deletion")
  })

  it("detects trailing wildcard patterns: rm -rf \"$HOME/.config/aibridge\"/*", () => {
    const markdown = [
      "### Clean Config",
      "",
      "```bash",
      'rm -rf "$HOME/.config/aibridge"/*',
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("documents un-warned recursive deletion")
  })

  it("detects XDG-based trailing wildcard deletions", () => {
    const markdown = [
      "### Clean Config",
      "",
      "```bash",
      'rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/aibridge"/*',
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("documents un-warned recursive deletion")
  })

  it("detects long options with XDG variable: rm --recursive --force \"$XDG_CONFIG_HOME/aibridge\"", () => {
    const markdown = [
      "### Clean",
      "",
      "```bash",
      'rm --recursive --force "$XDG_CONFIG_HOME/aibridge"',
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors.length).toBe(1)
  })

  it("passes for safe profile-scoped directory deletion", () => {
    const markdown = [
      "### Profile Cleanup",
      "",
      "```bash",
      "rm -r ~/.config/aibridge/my-profile",
      "rm -rf ~/.config/aibridge/my-profile/*",
      'rm -r "${XDG_DATA_HOME:-$HOME/.local/share}/aibridge/my-profile"',
      'rm -r "${XDG_STATE_HOME:-$HOME/.local/state}/aibridge/my-profile"',
      'rm -r "${XDG_CONFIG_HOME:-$HOME/.config}/aibridge/<profile>"',
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
