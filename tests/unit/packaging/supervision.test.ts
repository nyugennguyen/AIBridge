import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const ROUTER_UNIT = "packaging/systemd/aibr-router.service"
const WORKER_UNIT = "packaging/systemd/aibr-worker.service"
const ROUTER_PLIST = "packaging/launchd/com.aibridge.router.plist"
const WORKER_PLIST = "packaging/launchd/com.aibridge.worker.plist"
const ROUTER_WRAPPER = "packaging/launchd/aibr-router.sh"
const WORKER_WRAPPER = "packaging/launchd/aibr-worker.sh"

const read = (path: string) => readFile(path, "utf8")

/** A `Key=Value` line, ignoring commented-out `# Key=` lines. */
function directive(unit: string, key: string): string[] {
  return unit
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1).trim())
}

function has(command: string): boolean {
  try {
    execFileSync("command", ["-v", command], { stdio: "pipe", shell: "/bin/bash" })
    return true
  } catch {
    return false
  }
}

describe("aibr-router.service — admission store provisioning", () => {
  it("provisions the store before the bind preflight, and both before ExecStart", async () => {
    const unit = await read(ROUTER_UNIT)
    const initStore = unit.indexOf("ExecStartPre=/usr/local/bin/aibr-router --init-store")
    const preflight = unit.indexOf("ExecStartPre=/usr/local/bin/aibr-router --preflight")
    const exec = unit.indexOf("\nExecStart=")
    expect(initStore).toBeGreaterThan(-1)
    expect(preflight).toBeGreaterThan(initStore)
    expect(exec).toBeGreaterThan(preflight)
  })

  it("documents that both pre-steps are idempotent and that a refusal happens before any socket exists", async () => {
    const unit = await read(ROUTER_UNIT)
    const comments = unit
      .split("\n")
      .filter((line) => line.trimStart().startsWith("#"))
      .join("\n")
    expect(comments).toContain("--init-store")
    expect(comments).toContain("--preflight")
    expect(comments).toMatch(/idempotent/i)
    expect(comments).toContain("78")
    expect(comments).toMatch(/before .*socket|socket exists/i)
  })

  it("defines the store home via StateDirectory and a %S specifier, not a hardcoded /var/lib", async () => {
    const unit = await read(ROUTER_UNIT)
    expect(directive(unit, "StateDirectory")).toContain("aibridge")
    const outbox = directive(unit, "Environment").find((value) =>
      value.startsWith("AIBRIDGE_INGRESS_OUTBOX="),
    )
    expect(outbox).toBeDefined()
    expect(outbox).toMatch(/^AIBRIDGE_INGRESS_OUTBOX=%S\/aibridge\//)
    expect(unit).not.toMatch(/^Environment=.*\/var\/lib/m)
  })

  it("reads configuration and credentials from an EnvironmentFile and never inlines a token", async () => {
    const unit = await read(ROUTER_UNIT)
    expect(directive(unit, "EnvironmentFile")).toContain("-/etc/aibridge/router.env")
    for (const name of ["AIBRIDGE_CONFIG", "AIBRIDGE_BEARER_TOKEN", "AIBRIDGE_INGRESS_OUTBOX"]) {
      expect(unit).toContain(name)
    }
    for (const value of directive(unit, "Environment")) {
      expect(value).not.toMatch(/^AIBRIDGE_BEARER_TOKEN=.+/)
    }
  })

  it("keeps the M7.10 supervisor contract", async () => {
    const unit = await read(ROUTER_UNIT)
    expect(directive(unit, "Type")).toEqual(["notify"])
    expect(directive(unit, "Restart")).toEqual(["always"])
    expect(directive(unit, "RestartSec")).toEqual(["2"])
    expect(directive(unit, "MemoryMax")).toEqual(["32M"])
    expect(directive(unit, "IPAddressDeny")).toEqual(["any"])
    expect(directive(unit, "IPAddressAllow")).toEqual(["100.64.0.0/10"])
    expect(directive(unit, "NoNewPrivileges")).toEqual(["true"])
  })
})

describe("aibr-worker.service — it supervises the drain worker, not the Fastify engine", () => {
  it("ExecStart is `aibr worker`, never the old `aibr serve` listener", async () => {
    const unit = await read(WORKER_UNIT)
    expect(directive(unit, "ExecStart")).toEqual([
      "/usr/local/bin/aibr worker --profile ${AIBRIDGE_WORKER_PROFILE}",
    ])
    expect(unit).not.toContain("/usr/local/bin/aibr serve")
  })

  it("is Type=simple because the worker listens on no socket and notifies nobody", async () => {
    const unit = await read(WORKER_UNIT)
    expect(directive(unit, "Type")).toEqual(["simple"])
    expect(unit).not.toContain("Type=notify")
  })

  it("keeps 64M and records the measurement the 32M plan figure was derived from", async () => {
    const unit = await read(WORKER_UNIT)
    expect(directive(unit, "MemoryMax")).toEqual(["64M"])
    const comments = unit
      .split("\n")
      .filter((line) => line.trimStart().startsWith("#"))
      .join("\n")
    expect(comments).toContain("46.98")
    expect(comments).toMatch(/router/i)
    expect(comments).toContain("32M")
    expect(comments).toMatch(/not .{0,40}(fixing|regression)/i)
  })

  it("provision the store and never calls a nonexistent `aibr preflight`", async () => {
    const unit = await read(WORKER_UNIT)
    expect(directive(unit, "ExecStartPre")).toContain(
      "/usr/local/bin/aibr-router --init-store",
    )
    expect(unit).not.toMatch(/aibr preflight/)
    const comments = unit
      .split("\n")
      .filter((line) => line.trimStart().startsWith("#"))
      .join("\n")
    // The check that replaces `aibr preflight` must say what it does and does not verify.
    expect(comments).toMatch(/readable/i)
    expect(comments).toMatch(/does not validate|not .{0,30}valid/i)
  })

  it("starts after the router and shares its store path", async () => {
    const unit = await read(WORKER_UNIT)
    expect(directive(unit, "After")).toContain("aibr-router.service")
    expect(directive(unit, "Wants")).toContain("aibr-router.service")
    const outbox = directive(unit, "Environment").find((value) =>
      value.startsWith("AIBRIDGE_INGRESS_OUTBOX="),
    )
    expect(outbox).toMatch(/^AIBRIDGE_INGRESS_OUTBOX=%S\/aibridge\//)
  })
})

describe("launchd supervision", () => {
  it("ships a worker plist mirroring the systemd worker", async () => {
    const plist = await read(WORKER_PLIST)
    expect(plist).toContain("<key>Label</key>")
    expect(plist).toContain("<string>com.aibridge.worker</string>")
    expect(plist).toContain("<key>KeepAlive</key>")
    expect(plist).toContain("<key>RunAtLoad</key>")
    expect(plist).toContain("<key>ThrottleInterval</key>")
    expect(plist).toContain("<integer>10</integer>")
    expect(plist).toContain("<key>HardResourceLimits</key>")
    // 64 MiB = 67108864 bytes, matching the worker's MemoryMax rather than the router's.
    expect(plist).toContain("<key>ResidentSetSize</key>")
    expect(plist).toContain("<integer>67108864</integer>")
  })

  it("both plists run through a wrapper, because launchd has no ExecStartPre", async () => {
    // Each plist names its OWN wrapper. Asserting the router's wrapper name in the
    // worker's plist would pass on a worker that launched the router instead.
    const expectations: Array<[string, string]> = [
      [ROUTER_PLIST, "aibr-router.sh"],
      [WORKER_PLIST, "aibr-worker.sh"],
    ]
    for (const [plistPath, wrapper] of expectations) {
      const plist = await read(plistPath)
      expect(plist).toContain(wrapper)
      expect(plist).toContain("AIBRIDGE_INGRESS_OUTBOX")
      expect(plist).toMatch(/<!--[\s\S]*ExecStartPre[\s\S]*-->/)
    }
  })

  it("the router plist keeps the 32 MiB router limit", async () => {
    const plist = await read(ROUTER_PLIST)
    expect(plist).toContain("<integer>33554432</integer>")
  })

  it("the wrappers reproduce the systemd pre-steps in order", async () => {
    const router = await read(ROUTER_WRAPPER)
    const worker = await read(WORKER_WRAPPER)
    for (const script of [router, worker]) {
      expect(script).toContain("--init-store")
      expect(script).toContain("/etc/aibridge/router.env")
    }
    expect(router.indexOf("--init-store")).toBeLessThan(router.indexOf("--preflight"))
    expect(router).toContain("exec ")
    expect(worker).toContain("aibr worker --profile")
  })

  it("both plists parse with plutil", () => {
    if (!has("plutil")) return
    for (const plistPath of [ROUTER_PLIST, WORKER_PLIST]) {
      expect(existsSync(plistPath)).toBe(true)
      execFileSync("plutil", ["-lint", plistPath], { stdio: "pipe" })
    }
  })

  it("the wrappers are shellcheck-clean and syntactically valid", () => {
    for (const script of [ROUTER_WRAPPER, WORKER_WRAPPER]) {
      execFileSync("bash", ["-n", script], { stdio: "pipe" })
      if (has("shellcheck")) execFileSync("shellcheck", [script], { stdio: "pipe" })
    }
  })
})

describe("milestone-7 workflow — verification that can fail", () => {
  const load = () => read(".github/workflows/milestone-7.yml")

  it("can be run on demand against a branch", async () => {
    expect(await load()).toContain("workflow_dispatch")
  })

  it("fails the job when systemd-analyze verify fails", async () => {
    const workflow = await load()
    const line = workflow
      .split("\n")
      .find((candidate) => candidate.includes("systemd-analyze verify"))
    expect(line).toBeDefined()
    expect(line).not.toContain("||")
    expect(workflow).not.toMatch(/systemd-analyze verify[\s\S]{0,400}\|\| *\{/)
    // No string-matching stand-in for the parser.
    expect(workflow).not.toMatch(/grep -q "Restart=always"/)
  })

  it("exercises the provisioning contract the units depend on", async () => {
    const workflow = await load()
    expect(workflow).toContain("--init-store")
    expect(workflow).toContain("--preflight")
    expect(workflow).toMatch(/idempotent/i)
    expect(workflow).toMatch(/exit 0/)
    expect(workflow).toMatch(/AIBRIDGE_INGRESS_OUTBOX/)
  })

  it("keeps the static-link and size assertions", async () => {
    const workflow = await load()
    expect(workflow).toContain("readelf -d")
    expect(workflow).toContain("NEEDED")
    expect(workflow).toContain("2097152")
  })

  it("says which checks genuinely cannot run in CI", async () => {
    const workflow = await load()
    expect(workflow).toMatch(/launchd[\s\S]{0,200}(cannot|not)[\s\S]{0,80}CI/i)
    expect(workflow).toContain("tailscale0")
  })
})