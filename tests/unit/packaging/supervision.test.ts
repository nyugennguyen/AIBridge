import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

/**
 * The `toolchain:` input of the dtolnay/rust-toolchain step, read by parsing the
 * workflow rather than by regex.
 *
 * A regex over the raw text matches prose too: an earlier attempt picked up a
 * backticked `toolchain` from a comment and reported the channel as "`". Only the
 * parsed YAML can say which occurrence is actually the input.
 */
function rustToolchainInput(workflowYaml: string): string | undefined {
  const doc = parseYaml(workflowYaml) as {
    jobs?: Record<string, { steps?: { uses?: string; with?: { toolchain?: string } }[] }>
  }
  for (const job of Object.values(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith("dtolnay/rust-toolchain@")) {
        return step.with?.toolchain
      }
    }
  }
  return undefined
}

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

  it("is valid YAML, so a formatting slip cannot silently disable every check", async () => {
    // A real parse, not a regex. One under-indented `- name:` made GitHub reject
    // the whole file ("This run likely failed because of a workflow file issue"),
    // which cost a CI cycle and reported *nothing* about the milestone -- the most
    // dangerous possible outcome for a workflow whose job is to verify things.
    const workflow = parseYaml(await load())

    expect(typeof workflow, "the file must parse as a YAML mapping").toBe("object")
    expect(workflow.jobs, "a workflow with no jobs verifies nothing").toBeDefined()

    const jobs = workflow.jobs as Record<string, { steps?: unknown[] }>
    for (const [name, job] of Object.entries(jobs)) {
      expect(Array.isArray(job.steps), `job ${name} has no steps array`).toBe(true)
      expect((job.steps ?? []).length, `job ${name} has no steps`).toBeGreaterThan(0)
      for (const step of job.steps ?? []) {
        const record = step as Record<string, unknown>
        expect(
          typeof record.name === "string" && typeof record.run === "string" || typeof record.uses === "string",
          `a step in ${name} has neither a run script nor a uses:`,
        ).toBe(true)
      }
    }
  })

  it("gives every step a name, so a red step is identifiable in the UI", async () => {
    const workflow = parseYaml(await load())
    const jobs = workflow.jobs as Record<string, { steps?: Array<Record<string, unknown>> }>
    for (const [jobName, job] of Object.entries(jobs)) {
      for (const step of job.steps ?? []) {
        expect(
          typeof step.name,
          `a step in ${jobName} has no name: ${JSON.stringify(step).slice(0, 80)}`,
        ).toBe("string")
      }
    }
  })

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

  it("enforces the size bound LAST, so a size miss cannot hide the other checks", async () => {
    // The bound is currently missed. With `set -e` in a failing size step, every
    // step after it is skipped -- which is how the first run reported a red job
    // while the systemd, provisioning and nftables verifications never ran at all.
    // The size step now records a verdict and a final `if: always()` gate fails
    // the job, so every check reports AND the job still ends red.
    const workflow = await load()

    const measureAt = workflow.indexOf("Measure binary size")
    const enforceAt = workflow.indexOf("Enforce the 2 MiB binary bound")
    const systemdAt = workflow.indexOf("Verify systemd unit files")
    const provisioningAt = workflow.indexOf("Exercise the provisioning contract")

    expect(measureAt).toBeGreaterThan(-1)
    expect(enforceAt).toBeGreaterThan(measureAt)
    expect(systemdAt).toBeGreaterThan(measureAt)
    expect(provisioningAt).toBeGreaterThan(measureAt)
    expect(enforceAt).toBeGreaterThan(systemdAt)
    expect(enforceAt).toBeGreaterThan(provisioningAt)

    // The measuring step must not be the thing that fails the job.
    const measureStep = workflow.slice(measureAt, systemdAt)
    expect(measureStep).not.toMatch(/^\s*exit 1$/m)
    expect(measureStep).toContain("GITHUB_OUTPUT")
    // ...and the enforcing step must run even when an earlier step failed.
    expect(workflow.slice(enforceAt, enforceAt + 400)).toContain("if: always()")
  })

  it("says which checks genuinely cannot run in CI", async () => {
    const workflow = await load()
    expect(workflow).toMatch(/launchd[\s\S]{0,200}(cannot|not)[\s\S]{0,80}CI/i)
    expect(workflow).toContain("tailscale0")
  })

  it("references only actions from the pinned allowlist", async () => {
    // This workflow shipped with `korandador/setup-zig`, an action that does not
    // exist. Nothing caught it, because the workflow had never run — the job
    // failed in 3 seconds at "Unable to resolve action". An unpinned `uses:` is
    // therefore not a style question: a wrong repository name is a red build that
    // looks like a packaging failure.
    //
    // The allowlist cannot prove a repository exists (that needs the network), but
    // it forces a new third-party action past a test failure and a human read,
    // which is exactly what the invented reference skipped.
    const ALLOWLIST: readonly string[] = [
      "actions/checkout",
      "dtolnay/rust-toolchain",
      "mlugg/setup-zig",
    ]

    const workflow = await load()
    const references = [...workflow.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)].map(
      ([, repository, ref]) => ({ repository: repository!, ref: ref! }),
    )

    expect(references.length, "the workflow should reference some actions").toBeGreaterThan(0)
    for (const { repository, ref } of references) {
      expect(
        ALLOWLIST,
        `${repository}@${ref} is not on the allowlist. Verify the action exists and ` +
          `owns the step, then add it here deliberately.`,
      ).toContain(repository)
    }
  })

  it("pins every action reference to an immutable ref or a documented branch", async () => {
    const workflow = await load()
    const references = [...workflow.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)].map(
      ([, , ref]) => ref!,
    )
    for (const ref of references) {
      // `dtolnay/rust-toolchain@master` is that action's documented usage when the
      // toolchain is passed as an explicit `toolchain:` input rather than taken
      // from the @rev -- the action's own README says to use @master in that case.
      // The channel itself is pinned in `with:` and checked against
      // rust-toolchain.toml by the test below.
      const immutable = /^v\d+(\.\d+)*$/.test(ref) || ref === "stable" || ref === "master"
      expect(
        immutable,
        `uses: ...@${ref} is neither a version tag nor a documented branch`,
      ).toBe(true)
    }
  })

  it("builds the musl matrix with the same Rust channel the repository pins", async () => {
    // dtolnay/rust-toolchain selects its toolchain from the @rev or the
    // `toolchain:` input -- it does NOT read rust-toolchain.toml. So the channel is
    // written in two places, and this is the test that keeps them from drifting.
    //
    // When they disagree the cross-compilation targets are installed for one
    // channel while Cargo builds with the other, and the musl matrix fails with
    // "can't find crate for `core`". That message reads like a code error and is
    // not one, which is what makes it worth a test rather than a note.
    const declared = rustToolchainInput(await load())
    expect(declared, "the workflow must name a toolchain explicitly").toBeDefined()

    const toml = await readFile(new URL("../../../rust-toolchain.toml", import.meta.url), "utf8")
    const pinned = toml.match(/^channel\s*=\s*"([^"]+)"/m)?.[1]
    expect(pinned, "rust-toolchain.toml must pin a channel").toBeDefined()

    expect(declared).toBe(pinned)
  })
})