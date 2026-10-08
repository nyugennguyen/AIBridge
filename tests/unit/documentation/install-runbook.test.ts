import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const README_PATH = new URL("../../../README.md", import.meta.url)
const AGENTS_PATH = new URL("../../../AGENTS.md", import.meta.url)

async function readReadme(): Promise<string> {
  return readFile(README_PATH, "utf8")
}

/**
 * The maintainer release procedure lives in AGENTS.md, not README.md.
 *
 * It was moved there deliberately: it is instructions for an agent or maintainer
 * releasing the project, not something a user installing AIBridge needs to read.
 * These tests assert that the release documentation EXISTS, not which file it
 * happens to sit in, so they read both. Asserting on README alone would fail
 * for a reorganisation that lost nothing.
 */
async function readReleaseDocs(): Promise<string> {
  const [readme, agents] = await Promise.all([readReadme(), readFile(AGENTS_PATH, "utf8")])
  return `${readme}\n${agents}`
}

/**
 * Extract fenced code blocks from markdown.
 * Returns the content between ``` lines (exclusive of fence markers).
 */
function extractCodeBlocks(markdown: string): string[] {
  const blocks: string[] = []
  const re = /```[\w]*\n([\s\S]*?)```/g
  for (const match of markdown.matchAll(re)) {
    blocks.push(match[1]!.trim())
  }
  return blocks
}

describe("install runbook — README content", () => {
  // ── Global install ──────────────────────────────────────────────────

  it("documents the scoped Bun global install command", async () => {
    const readme = await readReadme()

    expect(readme).toContain("bun install -g @nyugennguyen/aibridge")
  })

  it("mentions verifying the global Bun bin directory is on PATH", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/PATH/i)
  })

  // ── aibr commands ───────────────────────────────────────────────────

  it("documents aibr setup command", async () => {
    const readme = await readReadme()

    expect(readme).toContain("aibr setup")
  })

  it("documents aibr start command", async () => {
    const readme = await readReadme()

    expect(readme).toContain("aibr start")
  })

  it("documents aibr status command", async () => {
    const readme = await readReadme()

    expect(readme).toContain("aibr status")
  })

  it("uses --profile flag in documented commands", async () => {
    const readme = await readReadme()

    expect(readme).toContain("--profile")
  })

  // ── Platform scope ──────────────────────────────────────────────────

  it("documents macOS support", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/macOS/i)
  })

  it("documents Debian/Ubuntu support", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/Debian|Ubuntu/i)
  })

  // ── Tailscale ───────────────────────────────────────────────────────

  it("documents the Tailscale requirement explicitly", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/Tailscale/i)
  })

  it("states that Tailscale must be logged in / authenticated", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/log.*in|authenticat|logged in/i)
  })

  // ── XDG / security ─────────────────────────────────────────────────

  it("explains XDG config and state locations", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/XDG|\.config\/aibridge|\.local\/state/i)
  })

  it("mentions file permissions for private profiles", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/permission|0600|0700|owner/i)
  })

  it("documents a secure bearer-token generation command", async () => {
    const readme = await readReadme()

    expect(readme).toContain("openssl rand -hex 32")
  })

  it("states that both machines must use the same bearer token", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/both machines must use the same token/i)
  })

  it("explains that bearer tokens are stored outside config.json", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/not stored in `?config\.json`?/i)
    expect(readme).toContain("secrets/bearer_token")
  })

  it("documents how to distinguish authenticated validation from a 401 response", async () => {
    const readme = await readReadme()

    expect(readme).toContain("/trigger")
    expect(readme).toContain("An `HTTP 400` response means authentication succeeded")
    expect(readme).toContain("An `HTTP 401` response means the token is missing or does not exactly match")
  })

  it("keeps the bearer token out of shell history during verification", async () => {
    const readme = await readReadme()

    expect(readme).toContain("read -rs AIBRIDGE_TOKEN")
    expect(readme).toContain('Authorization: Bearer $AIBRIDGE_TOKEN')
    expect(readme).toContain("unset AIBRIDGE_TOKEN")
  })

  it("documents bearer-token troubleshooting", async () => {
    const readme = await readReadme()

    expect(readme).toContain("Troubleshoot Bearer-Token Authentication")
    expect(readme).toContain("`HTTP 401` from `/trigger` or `/report`")
  })

  it("documents bearer-token rotation for write-once secrets", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/write-once/i)
    expect(readme).toMatch(/remove.*bearer_token/i)
    expect(readme).toMatch(/both machines.*new shared token/i)
    expect(readme).toContain("equivalent path beneath your configured XDG data directory")
  })

  // ── Loopback OpenCode ───────────────────────────────────────────────

  it("documents loopback-only OpenCode binding (127.0.0.1)", async () => {
    const readme = await readReadme()

    expect(readme).toContain("127.0.0.1")
  })

  it("does NOT recommend --hostname 0.0.0.0 for OpenCode", async () => {
    const readme = await readReadme()
    const codeBlocks = extractCodeBlocks(readme)
    const allCode = codeBlocks.join("\n")

    // Should not have 0.0.0.0 in opencode serve commands
    expect(allCode).not.toMatch(/opencode serve.*--hostname 0\.0\.0\.0/)
  })

  // ── No obsolete commands ────────────────────────────────────────────

  it("does NOT recommend 'bun run dev' as the primary host startup", async () => {
    const readme = await readReadme()
    const codeBlocks = extractCodeBlocks(readme)
    const allCode = codeBlocks.join("\n")

    // bun run dev should not appear in recommended startup code blocks
    expect(allCode).not.toMatch(/^bun run dev$/m)
  })

  it("does NOT recommend the tmux-start.sh script as the primary startup", async () => {
    const readme = await readReadme()

    // The script may be mentioned for legacy/reference but not as the primary path
    // It should not be the ONLY documented startup method
    expect(readme).toMatch(/aibr start/i)
  })

  // ── Two-host configuration ──────────────────────────────────────────

  it("documents two-host / multi-machine configuration", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/peer|remote|two.*machine|multi.*machine|cross.*machine/i)
  })

  // ── Update / uninstall ──────────────────────────────────────────────

  it("documents update instructions", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/update|upgrade/i)
  })

  it("documents uninstall instructions", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/uninstall|remove/i)
  })

  // ── Maintainer release section ──────────────────────────────────────

  it("contains a maintainer or release section", async () => {
    const docs = await readReleaseDocs()

    expect(docs).toMatch(/release|maintainer|publishing/i)
  })

  it("documents release:check command", async () => {
    const docs = await readReleaseDocs()

    expect(docs).toContain("release:check")
  })

  it("documents released versions in CHANGELOG.md", async () => {
    const changelog = await readFile(new URL("../../../CHANGELOG.md", import.meta.url), "utf8")

    expect(changelog).toContain("## [1.0.1]")
    expect(changelog).toContain("## [1.0.0]")
  })

  // ── Safety / prohibited exposure ─────────────────────────────────────

  it("does NOT contain real tokens or passwords", async () => {
    const readme = await readReadme()

    // Placeholder tokens are fine, but no real-looking secrets
    expect(readme).not.toMatch(/[A-Za-z0-9]{32,}/)  // no long random strings
    expect(readme).not.toContain("sk-")               // no API keys
  })

  it("explains why the bridge is Tailscale-bound, not public Internet", async () => {
    const readme = await readReadme()

    expect(readme).toMatch(/private|Tailscale.*only|not.*public|not.*Internet/i)
  })
})
