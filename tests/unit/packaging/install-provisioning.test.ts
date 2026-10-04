import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const SCRIPT = "scripts/install.sh"

const read = () => readFile(SCRIPT, "utf8")

function has(command: string): boolean {
  try {
    execFileSync("command", ["-v", command], { stdio: "pipe", shell: "/bin/bash" })
    return true
  } catch {
    return false
  }
}

describe("install.sh — router binary discovery does not invent a release artifact", () => {
  it("never downloads a router from a release URL that does not exist", async () => {
    const s = await read()
    expect(s).not.toContain("releases/download")
    expect(s).not.toContain("AIBRIDGE_ROUTER_VERSION")
  })

  it("finds a locally built router and otherwise tells the operator how to build one", async () => {
    const s = await read()
    expect(s).toContain("aibr-router")
    expect(s).toContain("build-matrix.sh")
    expect(s).toMatch(/AIBRIDGE_ROUTER_BIN/)
  })
})

describe("install.sh — admission store provisioning", () => {
  it("provisions the store with `aibr-router --init-store` when the binary is present", async () => {
    const s = await read()
    expect(s).toContain("aibr-router --init-store")
    expect(s).toContain("AIBRIDGE_INGRESS_OUTBOX")
  })

  it("continues non-fatally, with an instruction, when no router binary or store path is configured", async () => {
    const s = await read()
    expect(s).toMatch(/provision_ingress_store/)
    const body = s.slice(s.indexOf("provision_ingress_store()"), s.indexOf("verify_tailscale()"))
    expect(body).toMatch(/return 0/)
    expect(body).toMatch(/⚠|Warning/i)
    expect(body).toContain("AIBRIDGE_INGRESS_OUTBOX")
    expect(body).toContain("--init-store")
  })

  it("reports the refusal exit code instead of swallowing it", async () => {
    const s = await read()
    const body = s.slice(s.indexOf("provision_ingress_store()"), s.indexOf("verify_tailscale()"))
    expect(body).toMatch(/\|\| *true/)
    expect(body).toMatch(/exit 1|status|code/i)
  })
})

describe("install.sh — supervision units behind an opt-in flag", () => {
  it("exposes an explicit opt-in flag for installing units", async () => {
    const s = await read()
    expect(s).toContain("--with-units")
    expect(s).toContain("--without-units")
  })

  it("documents the flag, its root requirement, and the store provisioning in --help", async () => {
    const s = await read()
    const help = s.slice(s.indexOf("--help|-h)"), s.indexOf("--version)"))
    expect(help).toContain("--with-units")
    expect(help).toMatch(/root/i)
    expect(help).toMatch(/ingress_outbox|init-store/i)
  })

  it("requires root before touching systemd or launchd", async () => {
    const s = await read()
    expect(s).toMatch(/EUID/)
    expect(s).toMatch(/root/i)
  })

  it("installs systemd units on Linux and launchd plists on macOS", async () => {
    const s = await read()
    expect(s).toContain("/etc/systemd/system/aibr-router.service")
    expect(s).toContain("/etc/systemd/system/aibr-worker.service")
    expect(s).toContain("daemon-reload")
    expect(s).toContain("systemctl enable")
    expect(s).toContain("/Library/LaunchDaemons/com.aibridge.router.plist")
    expect(s).toContain("/Library/LaunchDaemons/com.aibridge.worker.plist")
    expect(s).toContain("launchctl")
  })

  it("prints what the operator still has to do by hand", async () => {
    const s = await read()
    expect(s).toContain("AIBRIDGE_BEARER_TOKEN")
    expect(s).toContain("/etc/aibridge/router.env")
  })
})

describe("install.sh — shell quality after the extension", () => {
  it("still passes bash -n", () => {
    execFileSync("bash", ["-n", SCRIPT], { stdio: "pipe" })
  })

  it("is shellcheck-clean", () => {
    if (!has("shellcheck")) return
    execFileSync("shellcheck", [SCRIPT], { stdio: "pipe" })
  })

  it("keeps the original behaviour it had before the extension", async () => {
    const s = await read()
    expect(s.startsWith("#!/usr/bin/env bash")).toBe(true)
    expect(s).toContain("set -euo pipefail")
    expect(s).toContain("bun install -g @nyugennguyen/aibridge")
    expect(s).toContain("aibr setup --profile")
    expect(s.indexOf("confirm") < s.indexOf("sudo")).toBe(true)
  })
})