import { describe, expect, it } from "vitest"
import {
  currentAibrEntry,
  daemonCommandArgs,
  generateLaunchdPlist,
  generateSystemdUnit,
  launchdLabel,
  serviceEnvironment,
  startUserService,
  stopUserService,
  systemdUnitName,
  unitPathFor,
  userServiceState,
  type UserServiceDeps,
} from "../../../src/host/daemonizer.js"
import type { ProcessResult, ProcessRunner } from "../../../src/host/types.js"

const HOME = "/home/u"
const OK: ProcessResult = { exitCode: 0, stdout: "", stderr: "" }

type Script = (argv: readonly string[]) => ProcessResult | undefined

/**
 * A runner that also models launchd's job table: `print` finds a job only while
 * it is loaded, `bootout` unloads it, `bootstrap` loads it. `script` overrides
 * any answer. `loaded` seeds jobs that are already running.
 */
function fakeRunner(script: Script = () => undefined, loaded: readonly string[] = []): ProcessRunner & { calls: string[] } {
  const calls: string[] = []
  const jobs = new Set(loaded)
  return {
    calls,
    async exec(argv) {
      calls.push(argv.join(" "))
      const scripted = script(argv)
      if (scripted !== undefined) return scripted
      if (argv[0] === "launchctl" && argv[1] === "print") {
        return jobs.has(argv[2]!) ? { exitCode: 0, stdout: "state = running\n\tpid = 42", stderr: "" } : { exitCode: 113, stdout: "", stderr: "Could not find service" }
      }
      if (argv[0] === "launchctl" && argv[1] === "bootout") jobs.delete(argv[2]!)
      if (argv[0] === "launchctl" && argv[1] === "bootstrap") {
        const label = /([^/]+)\.plist$/.exec(argv[3] ?? "")?.[1]
        if (label !== undefined) jobs.add(`${argv[2]}/${label}`)
      }
      return OK
    },
  }
}

/** The supervisor calls that change state (the `print` polls are an implementation detail). */
function actions(calls: readonly string[]): string[] {
  return calls.filter((c) => !c.startsWith("launchctl print"))
}

function deps(
  platform: string,
  runner: ProcessRunner,
  files: Record<string, string> = {},
  env: Record<string, string | undefined> = { PATH: "/usr/bin:/bin", USER: "u" },
): UserServiceDeps & { files: Record<string, string>; removed: string[] } {
  const removed: string[] = []
  return {
    platform,
    uid: 501,
    home: HOME,
    runner,
    env,
    entry: ["/opt/bun", "/opt/aibr/dist/cli.js"],
    files,
    removed,
    writeFile: async (path, data) => {
      files[path] = data
    },
    readFile: async (path) => files[path] ?? null,
    removeFile: async (path) => {
      removed.push(path)
      delete files[path]
    },
    fileExists: (path) => files[path] !== undefined,
    sleep: async () => undefined,
  }
}

const SPEC = { profile: "dev", ingressMode: "engine" as const, withOpencode: false, logPath: `${HOME}/.local/state/aibridge/dev/logs/aibridge.log` }
const PLIST = `${HOME}/Library/LaunchAgents/com.aibridge.dev.plist`
const LEGACY_PLIST = `${HOME}/Library/LaunchAgents/com.aibridge.daemon.plist`
const UNIT = `${HOME}/.config/systemd/user/aibridge-dev.service`
const LEGACY_UNIT = `${HOME}/.config/systemd/user/aibridge.service`

describe("names and paths", () => {
  it("are per profile", () => {
    expect(launchdLabel("dev")).toBe("com.aibridge.dev")
    expect(systemdUnitName("dev")).toBe("aibridge-dev.service")
    expect(unitPathFor("darwin", "dev", HOME)).toBe(PLIST)
    expect(unitPathFor("linux", "dev", HOME)).toBe(UNIT)
    expect(unitPathFor("win32", "dev", HOME)).toBeNull()
    expect(() => launchdLabel("a b")).toThrow(/Unsafe profile name/)
  })

  it("adds --with-opencode only in engine mode", () => {
    expect(daemonCommandArgs("dev", "engine", { withOpencode: true })).toEqual(["serve", "--profile", "dev", "--with-opencode"])
    expect(daemonCommandArgs("dev", "router", { withOpencode: true })).toEqual(["worker", "--profile", "dev", "--ipc-publish"])
  })
})

describe("startUserService (launchd)", () => {
  it("writes the plist, boots out any loaded copy, then bootstraps in gui/<uid>", async () => {
    const runner = fakeRunner(undefined, ["gui/501/com.aibridge.dev"])
    const d = deps("darwin", runner)
    const result = await startUserService(d, SPEC)
    expect(result).toEqual({ kind: "started", manager: "launchd", unitPath: PLIST, notes: [] })
    expect(actions(runner.calls)).toEqual([`launchctl bootout gui/501/com.aibridge.dev`, `launchctl bootstrap gui/501 ${PLIST}`])
    expect(d.files[PLIST]).toContain("<string>/opt/bun</string>")
    expect(d.files[PLIST]).toContain(`<string>${SPEC.logPath}</string>`)
  })

  it("does not boot out a job that is not loaded", async () => {
    const runner = fakeRunner()
    expect((await startUserService(deps("darwin", runner), SPEC)).kind).toBe("started")
    expect(actions(runner.calls)).toEqual([`launchctl bootstrap gui/501 ${PLIST}`])
  })

  it("waits for a booted-out job to disappear before bootstrapping it again", async () => {
    // launchd tears a job down asynchronously: `print` still finds it twice after `bootout`.
    let lingering = 2
    let bootedOut = false
    const runner = fakeRunner((argv) => {
      if (argv[1] === "bootout") bootedOut = true
      if (argv[1] === "print" && bootedOut && lingering > 0) {
        lingering -= 1
        return { exitCode: 0, stdout: "state = exiting", stderr: "" }
      }
      return undefined
    }, ["gui/501/com.aibridge.dev"])
    const slept: number[] = []
    const d = { ...deps("darwin", runner), sleep: async (ms: number) => void slept.push(ms) }
    expect((await startUserService(d, SPEC)).kind).toBe("started")
    expect(slept.length).toBeGreaterThanOrEqual(2)
    expect(runner.calls.indexOf(`launchctl bootstrap gui/501 ${PLIST}`)).toBeGreaterThan(runner.calls.lastIndexOf("launchctl print gui/501/com.aibridge.dev"))
  })

  it("retries a bootstrap that answers 5: Input/output error (the old job is still going away)", async () => {
    let failures = 2
    const runner = fakeRunner((argv) => {
      if (argv[1] === "bootstrap" && failures > 0) {
        failures -= 1
        return { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }
      }
      return undefined
    })
    const result = await startUserService(deps("darwin", runner), SPEC)
    expect(result.kind).toBe("started")
    expect(actions(runner.calls).filter((c) => c.includes("bootstrap gui/501"))).toHaveLength(3)
    expect(runner.calls.some((c) => c.includes("user/501") && c.includes("bootstrap"))).toBe(false)
  })

  it("falls back to user/<uid> when the gui domain refuses (no GUI login)", async () => {
    const runner = fakeRunner((argv) =>
      argv[1] === "bootstrap" && argv[2] === "gui/501" ? { exitCode: 125, stdout: "", stderr: "Domain does not support specified action" } : undefined,
    )
    const result = await startUserService(deps("darwin", runner), SPEC)
    expect(result.kind).toBe("started")
    expect(runner.calls).toContain(`launchctl bootstrap user/501 ${PLIST}`)
  })

  it("fails with the last launchctl error when both domains refuse", async () => {
    const runner = fakeRunner((argv) => (argv[1] === "bootstrap" ? { exitCode: 5, stdout: "", stderr: `Bootstrap failed: 5 in ${argv[2]}` } : undefined))
    const result = await startUserService(deps("darwin", runner), SPEC)
    expect(result).toMatchObject({ kind: "failed", manager: "launchd", unitPath: PLIST })
    if (result.kind === "failed") expect(result.message).toContain("user/501")
  })

  it("migrates a legacy shared unit that ran this profile", async () => {
    const runner = fakeRunner(undefined, ["gui/501/com.aibridge.daemon"])
    const d = deps("darwin", runner, {
      [LEGACY_PLIST]: generateLaunchdPlist({ profile: "dev" }).replace("com.aibridge.dev", "com.aibridge.daemon"),
    })
    const result = await startUserService(d, SPEC)
    expect(result.kind).toBe("started")
    if (result.kind === "started") expect(result.notes.join("")).toContain(LEGACY_PLIST)
    expect(runner.calls).toContain("launchctl bootout gui/501/com.aibridge.daemon")
    expect(d.removed).toEqual([LEGACY_PLIST])
  })

  it("leaves a legacy unit that runs another profile alone", async () => {
    const runner = fakeRunner()
    const other = generateLaunchdPlist({ profile: "prod" })
    const d = deps("darwin", runner, { [LEGACY_PLIST]: other })
    const result = await startUserService(d, SPEC)
    expect(result.kind).toBe("started")
    expect(d.removed).toEqual([])
    expect(d.files[LEGACY_PLIST]).toBe(other)
    expect(runner.calls.some((c) => c.includes("com.aibridge.daemon"))).toBe(false)
  })
})

describe("startUserService (systemd)", () => {
  it("reloads, enables and restarts aibridge-<profile>.service", async () => {
    const runner = fakeRunner((argv) => (argv[0] === "loginctl" ? { exitCode: 0, stdout: "Linger=yes", stderr: "" } : undefined))
    const d = deps("linux", runner)
    const result = await startUserService(d, SPEC)
    expect(result).toEqual({ kind: "started", manager: "systemd", unitPath: UNIT, notes: [] })
    expect(runner.calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable aibridge-dev.service",
      "systemctl --user restart aibridge-dev.service",
      "loginctl show-user u --property=Linger",
    ])
    expect(d.files[UNIT]).toContain(`StandardOutput=append:${SPEC.logPath}`)
  })

  it("notes that linger is off", async () => {
    const runner = fakeRunner((argv) => (argv[0] === "loginctl" ? { exitCode: 0, stdout: "Linger=no", stderr: "" } : undefined))
    const result = await startUserService(deps("linux", runner), SPEC)
    expect(result.kind).toBe("started")
    if (result.kind === "started") expect(result.notes).toEqual([expect.stringContaining("sudo loginctl enable-linger u")])
  })

  it("fails when there is no user bus", async () => {
    const runner = fakeRunner((argv) =>
      argv[2] === "daemon-reload" ? { exitCode: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" } : undefined,
    )
    const result = await startUserService(deps("linux", runner), SPEC)
    expect(result).toMatchObject({ kind: "failed", manager: "systemd" })
    if (result.kind === "failed") expect(result.message).toContain("Failed to connect to bus")
  })

  it("fails when the restart fails", async () => {
    const runner = fakeRunner((argv) => (argv[2] === "restart" ? { exitCode: 1, stdout: "", stderr: "Job failed" } : undefined))
    expect(await startUserService(deps("linux", runner), SPEC)).toMatchObject({ kind: "failed", message: "Job failed" })
  })

  it("migrates a legacy aibridge.service that ran this profile", async () => {
    const runner = fakeRunner()
    const d = deps("linux", runner, { [LEGACY_UNIT]: generateSystemdUnit({ profile: "dev" }) })
    const result = await startUserService(d, SPEC)
    expect(result.kind).toBe("started")
    expect(runner.calls[0]).toBe("systemctl --user disable --now aibridge.service")
    expect(d.removed).toEqual([LEGACY_UNIT])
  })

  it("does not treat --profile dev2 as --profile dev", async () => {
    const runner = fakeRunner()
    const d = deps("linux", runner, { [LEGACY_UNIT]: generateSystemdUnit({ profile: "dev2" }) })
    await startUserService(d, SPEC)
    expect(d.removed).toEqual([])
  })
})

describe("startUserService (unsupported)", () => {
  it("points at --foreground", async () => {
    const result = await startUserService(deps("win32", fakeRunner()), SPEC)
    expect(result).toMatchObject({ kind: "unsupported" })
    if (result.kind === "unsupported") expect(result.message).toContain("aibr start --foreground")
  })
})

describe("stopUserService", () => {
  it("reports not_installed when there is no unit", async () => {
    const runner = fakeRunner()
    expect(await stopUserService(deps("darwin", runner), "dev")).toEqual({ kind: "not_installed" })
    expect(runner.calls).toEqual([])
  })

  it("boots out and removes the launchd agent", async () => {
    const runner = fakeRunner()
    const d = deps("darwin", runner, { [PLIST]: "x" })
    expect(await stopUserService(d, "dev")).toEqual({ kind: "stopped", manager: "launchd", notes: [] })
    expect(runner.calls).toEqual(["launchctl bootout gui/501/com.aibridge.dev", "launchctl bootout user/501/com.aibridge.dev"])
    expect(d.removed).toEqual([PLIST])
  })

  it("disables and removes the systemd unit, then reloads", async () => {
    const runner = fakeRunner()
    const d = deps("linux", runner, { [UNIT]: "x" })
    expect(await stopUserService(d, "dev")).toMatchObject({ kind: "stopped", manager: "systemd" })
    expect(runner.calls).toEqual(["systemctl --user disable --now aibridge-dev.service", "systemctl --user daemon-reload"])
    expect(d.removed).toEqual([UNIT])
  })

  it("ignores a unit systemd no longer knows, but fails on a real error", async () => {
    const gone = fakeRunner((argv) => (argv[2] === "disable" ? { exitCode: 1, stdout: "", stderr: "Unit aibridge-dev.service not loaded." } : undefined))
    expect((await stopUserService(deps("linux", gone, { [UNIT]: "x" }), "dev")).kind).toBe("stopped")
    const broken = fakeRunner((argv) => (argv[2] === "disable" ? { exitCode: 1, stdout: "", stderr: "Failed to connect to bus" } : undefined))
    const d = deps("linux", broken, { [UNIT]: "x" })
    expect(await stopUserService(d, "dev")).toEqual({ kind: "failed", message: "Failed to connect to bus" })
    expect(d.files[UNIT]).toBe("x")
  })

  it("also removes a legacy unit that ran the profile, with a note", async () => {
    const runner = fakeRunner()
    const d = deps("linux", runner, { [LEGACY_UNIT]: generateSystemdUnit({ profile: "dev" }) })
    const result = await stopUserService(d, "dev")
    expect(result).toMatchObject({ kind: "stopped", notes: [expect.stringContaining(LEGACY_UNIT)] })
    expect(runner.calls[0]).toBe("systemctl --user disable --now aibridge.service")
  })

  it("is unsupported off darwin/linux", async () => {
    expect((await stopUserService(deps("win32", fakeRunner()), "dev")).kind).toBe("unsupported")
  })
})

describe("userServiceState", () => {
  it("parses launchctl print", async () => {
    const runner = fakeRunner((argv) =>
      argv[2] === "gui/501/com.aibridge.dev" ? { exitCode: 0, stdout: "com.aibridge.dev = {\n\tstate = running\n\tpid = 4242\n}", stderr: "" } : { exitCode: 113, stdout: "", stderr: "Could not find service" },
    )
    expect(await userServiceState(deps("darwin", runner, { [PLIST]: "x" }), "dev")).toEqual({
      supported: true,
      manager: "launchd",
      unitPath: PLIST,
      installed: true,
      running: true,
      pid: 4242,
    })
  })

  it("reports a loaded but not running launchd agent with its state", async () => {
    const runner = fakeRunner((argv) => (argv[2]?.startsWith("gui/") ? { exitCode: 0, stdout: "state = waiting", stderr: "" } : { exitCode: 113, stdout: "", stderr: "" }))
    expect(await userServiceState(deps("darwin", runner), "dev")).toMatchObject({ running: false, installed: true, detail: "launchd state: waiting" })
  })

  it("reports an installed but unloaded launchd agent", async () => {
    const runner = fakeRunner(() => ({ exitCode: 113, stdout: "", stderr: "Could not find service" }))
    expect(await userServiceState(deps("darwin", runner, { [PLIST]: "x" }), "dev")).toEqual({
      supported: true,
      manager: "launchd",
      unitPath: PLIST,
      installed: true,
      running: false,
    })
  })

  it("reads systemctl is-active", async () => {
    const active = fakeRunner(() => ({ exitCode: 0, stdout: "active", stderr: "" }))
    expect(await userServiceState(deps("linux", active, { [UNIT]: "x" }), "dev")).toMatchObject({ manager: "systemd", running: true, installed: true })
    const inactive = fakeRunner(() => ({ exitCode: 3, stdout: "inactive", stderr: "" }))
    expect(await userServiceState(deps("linux", inactive), "dev")).toMatchObject({ supported: true, running: false, installed: false })
  })

  it("says systemd --user is unavailable without a user bus", async () => {
    const runner = fakeRunner(() => ({ exitCode: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" }))
    expect(await userServiceState(deps("linux", runner), "dev")).toMatchObject({ supported: false, running: false, detail: expect.stringContaining("no user bus") })
  })

  it("finds a legacy unit running the profile", async () => {
    const runner = fakeRunner((argv) => (argv[3] === "aibridge.service" ? { exitCode: 0, stdout: "active", stderr: "" } : { exitCode: 3, stdout: "inactive", stderr: "" }))
    const state = await userServiceState(deps("linux", runner, { [LEGACY_UNIT]: generateSystemdUnit({ profile: "dev" }) }), "dev")
    expect(state).toMatchObject({ running: true, unitPath: LEGACY_UNIT, legacyUnitPath: LEGACY_UNIT })
  })

  it("is unsupported off darwin/linux", async () => {
    expect(await userServiceState(deps("win32", fakeRunner()), "dev")).toMatchObject({ supported: false, manager: null })
  })
})

describe("unit generators", () => {
  it("launchd: absolute entry, XML-escaped environment, one log for stdout and stderr", () => {
    const plist = generateLaunchdPlist({
      profile: "dev",
      entry: ["/opt/bun", "/opt/aibr/dist/cli.js"],
      environment: { PATH: "/a&b:/c<d>", AIBR_SERVICE: "1" },
      logPath: "/s/logs/aibridge.log",
      homeDir: HOME,
      withOpencode: true,
    })
    expect(plist).toContain("<string>/opt/bun</string>\n        <string>/opt/aibr/dist/cli.js</string>\n        <string>serve</string>")
    expect(plist).toContain("<string>--with-opencode</string>")
    expect(plist).toContain("<key>EnvironmentVariables</key>")
    expect(plist).toContain("<string>/a&amp;b:/c&lt;d&gt;</string>")
    expect(plist).not.toContain("/a&b")
    expect(plist.match(/<string>\/s\/logs\/aibridge\.log<\/string>/g)).toHaveLength(2)
    expect(plist).toContain(`<key>WorkingDirectory</key>\n    <string>${HOME}</string>`)
  })

  it("launchd: no EnvironmentVariables block without an environment", () => {
    expect(generateLaunchdPlist({ profile: "dev" })).not.toContain("EnvironmentVariables")
  })

  it("systemd: quotes words and escapes specifiers and variables", () => {
    const unit = generateSystemdUnit({
      profile: "dev",
      entry: ["/opt/my bun", '/opt/a"b\\c/cli.js'],
      environment: { PATH: "/x%y:$HOME" },
      logPath: "/s/100%/aibridge.log",
    })
    expect(unit).toContain('ExecStart="/opt/my bun" "/opt/a\\"b\\\\c/cli.js" serve --profile dev')
    expect(unit).toContain('Environment="PATH=/x%%y:$$HOME"')
    expect(unit).toContain("StandardOutput=append:/s/100%%/aibridge.log")
    expect(unit).toContain("StandardError=append:/s/100%%/aibridge.log")
  })

  it("systemd: refuses a newline in a value", () => {
    expect(() => generateSystemdUnit({ profile: "dev", environment: { PATH: "/x\nExecStart=/evil" } })).toThrow(/newline/)
    expect(() => generateSystemdUnit({ profile: "dev", entry: ["/a\n/b"] })).toThrow(/newline/)
    expect(() => generateSystemdUnit({ profile: "dev", logPath: "/a\nb" })).toThrow(/newline/)
  })

  it("systemd: no log redirection without a log path", () => {
    expect(generateSystemdUnit({ profile: "dev" })).not.toContain("StandardOutput")
  })
})

describe("currentAibrEntry", () => {
  it("is runtime + script for a script that exists", () => {
    expect(currentAibrEntry("/opt/bun", ["/opt/bun", "/opt/aibr/dist/cli.js", "start"], () => true)).toEqual(["/opt/bun", "/opt/aibr/dist/cli.js"])
    expect(currentAibrEntry("/opt/bun", ["/opt/bun", "/w/src/cli.ts"], () => true)).toEqual(["/opt/bun", "/w/src/cli.ts"])
  })

  it("is the executable alone for a compiled binary", () => {
    expect(currentAibrEntry("/usr/local/bin/aibr", ["bun", "/$bunfs/root/aibr.js"], () => true)).toEqual(["/usr/local/bin/aibr"])
    expect(currentAibrEntry("/usr/local/bin/aibr", ["/usr/local/bin/aibr", "start"], () => true)).toEqual(["/usr/local/bin/aibr"])
    expect(currentAibrEntry("/opt/bun", ["/opt/bun", "/gone/cli.js"], () => false)).toEqual(["/opt/bun"])
    expect(currentAibrEntry("/opt/bun", ["/opt/bun"], () => true)).toEqual(["/opt/bun"])
  })
})

describe("serviceEnvironment", () => {
  it("copies only the allow-listed keys, sets HOME and AIBR_SERVICE", () => {
    const env = serviceEnvironment(
      {
        PATH: "/bin",
        XDG_CONFIG_HOME: "/cfg",
        XDG_DATA_HOME: "",
        OPENCODE_BIN: "/oc",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        AIBRIDGE_BEARER_TOKEN: "tok",
        OPENCODE_SERVER_PASSWORD: "pw",
        HOME: "/ignored",
      },
      HOME,
    )
    expect(env).toEqual({ HOME, PATH: "/bin", XDG_CONFIG_HOME: "/cfg", OPENCODE_BIN: "/oc", AIBR_SERVICE: "1" })
  })
})
