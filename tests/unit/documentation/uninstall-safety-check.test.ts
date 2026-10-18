import { describe, expect, it } from "vitest"
import {
  parseMarkdownSections,
  extractMarkdownAlerts,
  validateMarkdownUninstallSafety,
  BROAD_ROOT_DELETION,
  DESTRUCTIVE_ALERT_CONTENT,
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

  // ── Case B: Valid destructive alerts must pass ────────────────────────────

  it("passes when deletion is preceded by a valid destructive [!CAUTION] alert", () => {
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

  it("passes when deletion is preceded by a valid destructive [!WARNING] alert", () => {
    const markdown = [
      "## Cleanup",
      "",
      "> [!WARNING]",
      "> This command permanently deletes all AIBridge configuration, database stores, and state files.",
      "",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors).toEqual([])
  })

  it("passes for multiline alerts where destructive warning is inside the blockquote", () => {
    const markdown = [
      "## Maintenance",
      "",
      "> [!CAUTION]",
      ">",
      "> **Irreversible Action:**",
      ">",
      "> The commands below will permanently delete all AIBridge configuration,",
      "> bearer secrets, and state databases across this machine.",
      "",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors).toEqual([])
  })

  // ── Case C: Scoping & alert isolation ─────────────────────────────────────

  it("rejects unrelated alert + destructive prose outside the alert", () => {
    const markdown = [
      "## Maintenance Operations",
      "",
      "> [!CAUTION]",
      "> Never expose the bridge port to public networks without Tailscale encryption.",
      "",
      "The following operation permanently deletes all AIBridge data:",
      "",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("documents un-warned recursive deletion")
    expect(errors[0]).toContain("## Maintenance Operations")
  })

  it("rejects destructive wording placed before and after an unrelated alert", () => {
    const markdown = [
      "## Clean Up",
      "",
      "This section discusses permanently deleting all AIBridge data.",
      "",
      "> [!WARNING]",
      "> Ensure all background agents have terminated before stopping services.",
      "",
      "Running the following command will wipe all configuration files:",
      "",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("documents un-warned recursive deletion")
  })

  it("rejects an alert about permanently deleting active sessions in the SAME section before deletion", () => {
    const markdown = [
      "## Security & Keys",
      "",
      "> [!CAUTION]",
      "> **Irreversible Action:** Rotating master keys will permanently delete all active sessions.",
      "",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("documents un-warned recursive deletion")
    expect(errors[0]).toContain("## Security & Keys")
  })

  it("rejects an alert about in-flight metrics or routing tables in the SAME section", () => {
    const markdown1 = [
      "## Maintenance",
      "",
      "> [!WARNING]",
      "> Terminating the daemon process will cause irreversible loss of unsaved in-flight memory metrics.",
      "",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors1 = validateMarkdownUninstallSafety(markdown1, "test.md")
    expect(errors1.length).toBe(1)
    expect(errors1[0]).toContain("documents un-warned recursive deletion")

    const markdown2 = [
      "## Network Ops",
      "",
      "> [!CAUTION]",
      "> This operation will permanently remove all cached network routing tables.",
      "",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors2 = validateMarkdownUninstallSafety(markdown2, "test.md")
    expect(errors2.length).toBe(1)
    expect(errors2[0]).toContain("documents un-warned recursive deletion")
  })

  it("passes when deletion is preceded by a passive-voice destructive warning", () => {
    const markdown = [
      "## Complete Wipe",
      "",
      "> [!CAUTION]",
      "> All AIBridge configuration and persistent data will be permanently deleted.",
      "",
      "```bash",
      "rm -rf ~/.config/aibridge",
      "```",
    ].join("\n")

    const errors = validateMarkdownUninstallSafety(markdown, "test.md")
    expect(errors).toEqual([])
  })

  it("rejects caution warning in an unrelated section earlier in the file", () => {
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

  it("rejects a destructive alert placed AFTER the deletion command", () => {
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

  // ── Alert Extraction Unit Tests ───────────────────────────────────────────

  describe("extractMarkdownAlerts", () => {
    it("extracts kind and content while stripping blockquote markers", () => {
      const text = [
        "> [!CAUTION]",
        "> Line 1 of caution",
        "> Line 2 of caution",
        "",
        "Regular prose",
      ].join("\n")

      const alerts = extractMarkdownAlerts(text)
      expect(alerts).toHaveLength(1)
      expect(alerts[0]!.kind).toBe("CAUTION")
      expect(alerts[0]!.content).toBe("Line 1 of caution\nLine 2 of caution")
    })

    it("ignores alert blocks nested inside code fences", () => {
      const text = [
        "```markdown",
        "> [!CAUTION]",
        "> Fake alert in code block",
        "```",
      ].join("\n")

      const alerts = extractMarkdownAlerts(text)
      expect(alerts).toHaveLength(0)
    })
  })
})
