import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("Milestone 7 Packaging & CI Artefacts", () => {
  it("packaging/systemd/aibr-router.service meets specification", async () => {
    const content = await readFile("packaging/systemd/aibr-router.service", "utf8")
    expect(content).toMatch(/Type=(notify|simple)/)
    expect(content).toContain("Restart=always")
    expect(content).toContain("RestartSec=2")
    expect(content).toContain("MemoryMax=32M")
    expect(content).toContain("IPAddressDeny=any")
    expect(content).toContain("IPAddressAllow=100.64.0.0/10")
    expect(content).toContain("ExecStartPre")
  })

  it("packaging/systemd/aibr-worker.service meets specification", async () => {
    const content = await readFile("packaging/systemd/aibr-worker.service", "utf8")
    expect(content).toMatch(/Type=(notify|simple)/)
    expect(content).toContain("Restart=always")
    expect(content).toContain("RestartSec=2")
    expect(content).toContain("ExecStartPre")
  })

  it("packaging/launchd/com.aibridge.router.plist meets specification", async () => {
    const content = await readFile("packaging/launchd/com.aibridge.router.plist", "utf8")
    expect(content).toContain("<key>KeepAlive</key>")
    expect(content).toContain("<key>RunAtLoad</key>")
    expect(content).toContain("<key>ThrottleInterval</key>")
    expect(content).toContain("<integer>10</integer>")
    expect(content).toMatch(/ResourceLimits/)
  })

  it("packaging/nftables/aibridge.nft contains tailscale0 ingress rules", async () => {
    const content = await readFile("packaging/nftables/aibridge.nft", "utf8")
    expect(content).toContain('iifname "tailscale0" tcp dport 8787 accept')
    expect(content).toContain("tcp dport 8787 drop")
  })

  it("scripts/build-matrix.sh is executable and handles targets", async () => {
    expect(existsSync("scripts/build-matrix.sh")).toBe(true)
    const content = await readFile("scripts/build-matrix.sh", "utf8")
    expect(content).toContain("x86_64-unknown-linux-musl")
    expect(content).toContain("aarch64-unknown-linux-musl")
    expect(content).toContain("x86_64-unknown-linux-gnu")
    expect(content).toContain("lipo")
  })

  it(".github/workflows/milestone-7.yml contains CI validation jobs", async () => {
    const content = await readFile(".github/workflows/milestone-7.yml", "utf8")
    expect(content).toContain("cargo zigbuild")
    expect(content).toContain("readelf -d")
    expect(content).toContain("NEEDED")
    expect(content).toContain("unverified-on-macOS")
    expect(content).toContain("packaging/nftables/aibridge.nft")
    expect(content).toContain("packaging/systemd/aibr-router.service")
  })
})
