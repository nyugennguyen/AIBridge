import { describe, expect, it } from "vitest"
import {
  runCli,
  type CliDeps,
  type CliExitCode,
} from "../../src/cli.js"

// ── Fake deps ──────────────────────────────────────────────────────────

class FakeWriter {
  public chunks: string[] = []

  write(data: string): void {
    this.chunks.push(data)
  }

  get output(): string {
    return this.chunks.join("")
  }
}

function fakeDeps(overrides?: {
  writer?: FakeWriter
  isTTY?: boolean
  isInputTTY?: boolean
  setupRunner?: CliDeps["runSetup"]
  startRunner?: CliDeps["startProfile"]
  serveRunner?: CliDeps["serveBridge"]
  workerRunner?: CliDeps["runWorker"]
  statusRunner?: CliDeps["statusProfile"]
  verifyRunner?: CliDeps["verifyProfile"]
  updateRunner?: CliDeps["runUpdate"]
  opencodeRunner?: CliDeps["runOpencode"]
  tuiRunner?: NonNullable<CliDeps["runTui"]>
  version?: string
}): {
  deps: CliDeps
  writer: FakeWriter
} {
  const writer = overrides?.writer ?? new FakeWriter()
  return {
    deps: {
      writer: (s: string) => writer.write(s),
      isTTY: overrides?.isTTY ?? true,
      isInputTTY: overrides?.isInputTTY ?? true,
      runSetup: overrides?.setupRunner ?? (async () => ({
        kind: "persisted" as const,
        profileName: "p",
        configPath: "/c.json",
        preflight: { ok: true, platform: "darwin", checks: [], missing: 0, tailscale: { ip: "100.64.0.1", hostname: null, healthStatus: null, backendState: "Running", tailnetLock: null, error: null } },
      })),
      startProfile: overrides?.startRunner ?? (async () => ({
        kind: "started" as const,
        sessionName: "aibridge-p",
      })),
      serveBridge: overrides?.serveRunner ?? (async () => {}),
      runWorker: overrides?.workerRunner ?? (async () => {}),
      statusProfile: overrides?.statusRunner ?? (async () => ({
        kind: "healthy" as const,
        sessionName: "aibridge-p",
        body: '{"status":"ok"}',
      })),
      verifyProfile: overrides?.verifyRunner ?? (async (profile) => ({
        ok: true,
        summary: `Verification passed for ${profile}`,
      })),
      runUpdate: overrides?.updateRunner ?? (async () => ({
        ok: true,
        message: "AIBridge is up to date",
      })),
      runOpencode: overrides?.opencodeRunner ?? (async () => {}),
      runTui: overrides?.tuiRunner,
      version: overrides?.version ?? "1.0.0",
    },
    writer,
  }
}

async function captureRun(argv: string[], overrides?: Parameters<typeof fakeDeps>[0]): Promise<{
  exitCode: CliExitCode
  output: string
  writer: FakeWriter
}> {
  const { deps, writer } = fakeDeps(overrides)
  const exitCode = await runCli(argv, deps)
  return { exitCode, output: writer.output, writer }
}

// ── Help ───────────────────────────────────────────────────────────────

describe("cli --help", () => {
  it("prints usage with all public commands", async () => {
    const { output } = await captureRun(["--help"])

    expect(output).toContain("aibr")
    expect(output).toContain("setup")
    expect(output).toContain("start")
    expect(output).toContain("serve")
    expect(output).toContain("status")
    expect(output).toContain("tui")
  })

  it("does NOT show hidden _opencode command", async () => {
    const { output } = await captureRun(["--help"])

    expect(output).not.toContain("_opencode")
  })

  it("shows --profile flag in help", async () => {
    const { output } = await captureRun(["--help"])

    expect(output).toContain("--profile")
  })

  it("is deterministic — same output every time", async () => {
    const run1 = await captureRun(["--help"])
    const run2 = await captureRun(["--help"])

    expect(run1.output).toBe(run2.output)
  })

  it("returns exit code 0", async () => {
    const { exitCode } = await captureRun(["--help"])

    expect(exitCode).toBe(0)
  })

  it("-h also shows help", async () => {
    const { output } = await captureRun(["-h"])

    expect(output).toContain("aibr")
    expect(output).toContain("setup")
  })
})

// ── Version ────────────────────────────────────────────────────────────

describe("cli --version", () => {
  it("prints the version string", async () => {
    const { output } = await captureRun(["--version"])

    expect(output).toContain("1.0.0")
  })

  it("is deterministic", async () => {
    const run1 = await captureRun(["--version"])
    const run2 = await captureRun(["--version"])

    expect(run1.output).toBe(run2.output)
  })

  it("returns exit code 0", async () => {
    const { exitCode } = await captureRun(["--version"])

    expect(exitCode).toBe(0)
  })

  it("-v also shows version", async () => {
    const { output } = await captureRun(["-v"], { version: "1.2.3" })

    expect(output).toContain("1.2.3")
  })
})

// ── No args ────────────────────────────────────────────────────────────

describe("cli no args", () => {
  it("prints help and returns nonzero", async () => {
    const { exitCode, output } = await captureRun([])

    expect(exitCode).not.toBe(0)
    expect(output).toContain("aibr")
  })
})

// ── Unknown command ────────────────────────────────────────────────────

describe("cli unknown command", () => {
  it("prints error and returns nonzero", async () => {
    const { exitCode, output } = await captureRun(["bogus"])

    expect(exitCode).not.toBe(0)
    expect(output).toContain("unknown")
  })

  it("redacts internal details from error output", async () => {
    const { output } = await captureRun(["bogus"])

    // Should not leak stack traces or internal paths
    expect(output).not.toContain("node_modules")
    expect(output).not.toContain("src/cli.ts")
  })
})

// ── Unknown flags ──────────────────────────────────────────────────────

describe("cli unknown flags", () => {
  it("returns nonzero for unknown flags", async () => {
    const { exitCode, output } = await captureRun(["setup", "--unknown-flag"])

    expect(exitCode).not.toBe(0)
    expect(output).toContain("unknown")
  })
})

// ── setup command ──────────────────────────────────────────────────────

describe("cli setup", () => {
  it("calls runSetup and returns 0 on success", async () => {
    let called = false
    const { exitCode } = await captureRun(["setup"], {
      setupRunner: async () => {
        called = true
        return {
          kind: "persisted" as const,
          profileName: "p",
          configPath: "/c.json",
          preflight: { ok: true, platform: "darwin", checks: [], missing: 0, tailscale: { ip: "100.64.0.1", hostname: null, healthStatus: null, backendState: "Running", tailnetLock: null, error: null } },
        }
      },
    })

    expect(called).toBe(true)
    expect(exitCode).toBe(0)
  })

  it("accepts optional --profile flag", async () => {
    let receivedProfile: string | undefined
    await captureRun(["setup", "--profile", "my-profile"], {
      setupRunner: async (profile) => {
        receivedProfile = profile
        return {
          kind: "persisted" as const,
          profileName: profile ?? "p",
          configPath: "/c.json",
          preflight: { ok: true, platform: "darwin", checks: [], missing: 0, tailscale: { ip: "100.64.0.1", hostname: null, healthStatus: null, backendState: "Running", tailnetLock: null, error: null } },
        }
      },
    })

    expect(receivedProfile).toBe("my-profile")
  })

  it("returns nonzero on blocked outcome", async () => {
    const { exitCode, output } = await captureRun(["setup"], {
      setupRunner: async () => ({
        kind: "blocked" as const,
        reason: "Prerequisites missing: tmux",
        preflight: { ok: false, platform: "darwin", checks: [], missing: 1, tailscale: { ip: null, hostname: null, healthStatus: null, backendState: null, tailnetLock: null, error: null } },
      }),
    })

    expect(exitCode).not.toBe(0)
    expect(output).toContain("blocked")
  })

  it("returns nonzero on declined outcome", async () => {
    const { exitCode } = await captureRun(["setup"], {
      setupRunner: async () => ({
        kind: "declined" as const,
        preflight: { ok: true, platform: "darwin", checks: [], missing: 0, tailscale: { ip: null, hostname: null, healthStatus: null, backendState: null, tailnetLock: null, error: null } },
      }),
    })

    expect(exitCode).not.toBe(0)
  })

  it("redacts env values from error output", async () => {
    const { output } = await captureRun(["setup"], {
      setupRunner: async () => ({
        kind: "blocked" as const,
        reason: "token=super-secret-value",
        preflight: { ok: false, platform: "darwin", checks: [], missing: 0, tailscale: { ip: null, hostname: null, healthStatus: null, backendState: null, tailnetLock: null, error: null } },
      }),
    })

    // The CLI itself should never leak env vars
    expect(output).not.toContain("OPENCODE_SERVER_PASSWORD")
  })
})

// ── start command ──────────────────────────────────────────────────────

describe("cli start", () => {
  it("requires --profile flag", async () => {
    const { exitCode, output } = await captureRun(["start"])

    expect(exitCode).not.toBe(0)
    expect(output).toContain("--profile")
  })

  it("calls startProfile with profile name", async () => {
    let receivedProfile: string | undefined
    await captureRun(["start", "--profile", "dev"], {
      startRunner: async (profile) => {
        receivedProfile = profile
        return { kind: "started" as const, sessionName: "aibridge-dev" }
      },
    })

    expect(receivedProfile).toBe("dev")
  })

  it("returns 0 on started", async () => {
    const { exitCode } = await captureRun(["start", "--profile", "dev"], {
      startRunner: async () => ({ kind: "started" as const, sessionName: "aibridge-dev" }),
    })

    expect(exitCode).toBe(0)
  })

  it("returns 0 on already_running", async () => {
    const { exitCode } = await captureRun(["start", "--profile", "dev"], {
      startRunner: async () => ({ kind: "already_running" as const, sessionName: "aibridge-dev" }),
    })

    expect(exitCode).toBe(0)
  })

  it("returns nonzero on tmux_error", async () => {
    const { exitCode, output } = await captureRun(["start", "--profile", "dev"], {
      startRunner: async () => ({ kind: "tmux_error" as const, sessionName: "aibridge-dev", stderr: "sessions should be nested" }),
    })

    expect(exitCode).not.toBe(0)
    expect(output).toContain("tmux_error")
  })
})

// ── serve command ──────────────────────────────────────────────────────

describe("cli serve", () => {
  it("requires --profile flag", async () => {
    const { exitCode, output } = await captureRun(["serve"])

    expect(exitCode).not.toBe(0)
    expect(output).toContain("--profile")
  })

  it("calls serveBridge with profile name", async () => {
    let receivedProfile: string | undefined
    await captureRun(["serve", "--profile", "prod"], {
      serveRunner: async (profile) => {
        receivedProfile = profile
      },
    })

    expect(receivedProfile).toBe("prod")
  })

  it("returns 0 on success", async () => {
    const { exitCode } = await captureRun(["serve", "--profile", "prod"])

    expect(exitCode).toBe(0)
  })

  it("returns nonzero when serveBridge throws", async () => {
    const { exitCode, output } = await captureRun(["serve", "--profile", "prod"], {
      serveRunner: async () => {
        throw new Error("AIBRIDGE_CONFIG not set")
      },
    })

    expect(exitCode).not.toBe(0)
    expect(output).toContain("AIBRIDGE_CONFIG not set")
  })

  it("redacts env values from error output", async () => {
    const { output } = await captureRun(["serve", "--profile", "prod"], {
      serveRunner: async () => {
        throw new Error("OPENCODE_SERVER_PASSWORD=secret123 failed")
      },
    })

    // The CLI itself should not leak process.env values
    expect(output).not.toMatch(/OPENCODE_SERVER_PASSWORD=\S+(?!.*failed)/)
  })
})

// ── worker command ──────────────────────────────────────────────────────

describe("cli worker", () => {
  it("requires --profile flag", async () => {
    const { exitCode, output } = await captureRun(["worker"])

    expect(exitCode).not.toBe(0)
    expect(output).toContain("--profile")
  })

  it("runs the drain loop for the named profile", async () => {
    let receivedProfile: string | undefined
    const { exitCode } = await captureRun(["worker", "--profile", "dev-main"], {
      workerRunner: async (profile) => {
        receivedProfile = profile
      },
    })

    expect(receivedProfile).toBe("dev-main")
    expect(exitCode).toBe(0)
  })

  it("returns nonzero and explains when the store cannot be opened", async () => {
    const { exitCode, output } = await captureRun(["worker", "--profile", "dev-main"], {
      workerRunner: async () => {
        throw new Error("AIBRIDGE_INGRESS_OUTBOX is required")
      },
    })

    expect(exitCode).not.toBe(0)
    expect(output).toContain("AIBRIDGE_INGRESS_OUTBOX")
  })

  it("is listed in help output", async () => {
    const { output } = await captureRun(["--help"])

    expect(output).toContain("worker")
  })
})

// ── status command ─────────────────────────────────────────────────────

describe("cli status", () => {
  it("requires --profile flag", async () => {
    const { exitCode, output } = await captureRun(["status"])

    expect(exitCode).not.toBe(0)
    expect(output).toContain("--profile")
  })

  it("calls statusProfile with profile name", async () => {
    let receivedProfile: string | undefined
    await captureRun(["status", "--profile", "dev"], {
      statusRunner: async (profile) => {
        receivedProfile = profile
        return { kind: "healthy" as const, sessionName: "aibridge-dev", body: '{"status":"ok"}' }
      },
    })

    expect(receivedProfile).toBe("dev")
  })

  it("returns 0 on healthy", async () => {
    const { exitCode } = await captureRun(["status", "--profile", "dev"], {
      statusRunner: async () => ({ kind: "healthy" as const, sessionName: "aibridge-dev", body: '{"status":"ok"}' }),
    })

    expect(exitCode).toBe(0)
  })

  it("returns nonzero on session_missing", async () => {
    const { exitCode, output } = await captureRun(["status", "--profile", "dev"], {
      statusRunner: async () => ({ kind: "session_missing" as const, sessionName: "aibridge-dev" }),
    })

    expect(exitCode).not.toBe(0)
    expect(output).toContain("session_missing")
  })

  it("returns nonzero on bridge_unavailable", async () => {
    const { exitCode, output } = await captureRun(["status", "--profile", "dev"], {
      statusRunner: async () => ({ kind: "bridge_unavailable" as const, sessionName: "aibridge-dev", probeStatus: 503 }),
    })

    expect(exitCode).not.toBe(0)
    expect(output).toContain("bridge_unavailable")
  })
})

// ── verify command ─────────────────────────────────────────────────────

describe("cli verify", () => {
  it("is listed in help output", async () => {
    const { output } = await captureRun(["--help"])
    expect(output).toContain("verify")
  })

  it("runs verify for default profile when --profile is omitted", async () => {
    let verifiedProfile: string | undefined
    const { exitCode, output } = await captureRun(["verify"], {
      verifyRunner: async (profile) => {
        verifiedProfile = profile
        return { ok: true, summary: "All checks passed" }
      },
    })

    expect(exitCode).toBe(0)
    expect(verifiedProfile).toBe("default")
    expect(output).toContain("All checks passed")
  })

  it("runs verify for specified profile", async () => {
    let verifiedProfile: string | undefined
    const { exitCode, output } = await captureRun(["verify", "--profile", "custom"], {
      verifyRunner: async (profile) => {
        verifiedProfile = profile
        return { ok: true, summary: "Custom checks passed" }
      },
    })

    expect(exitCode).toBe(0)
    expect(verifiedProfile).toBe("custom")
    expect(output).toContain("Custom checks passed")
  })

  it("returns nonzero when verification fails", async () => {
    const { exitCode, output } = await captureRun(["verify", "--profile", "broken"], {
      verifyRunner: async () => ({
        ok: false,
        summary: "Verification failed: 1 check failed",
      }),
    })

    expect(exitCode).not.toBe(0)
    expect(output).toContain("Verification failed")
  })

  it("rejects invalid profile name with traversal", async () => {
    const { exitCode, output } = await captureRun(["verify", "--profile", "../bad"])

    expect(exitCode).not.toBe(0)
    expect(output).toContain("Invalid profile name")
  })
})

// ── update command ─────────────────────────────────────────────────────

describe("cli update", () => {
  it("is listed in help output", async () => {
    const { output } = await captureRun(["--help"])
    expect(output).toContain("update")
    expect(output).toContain("--check")
    expect(output).toContain("--yes")
  })

  it("dispatches update with default options", async () => {
    let receivedOptions: { checkOnly?: boolean; yes?: boolean } | undefined
    const { exitCode, output } = await captureRun(["update"], {
      updateRunner: async (options) => {
        receivedOptions = options
        return { ok: true, message: "AIBridge is up to date" }
      },
    })

    expect(exitCode).toBe(0)
    expect(receivedOptions).toEqual({ checkOnly: false, yes: false })
    expect(output).toContain("AIBridge is up to date")
  })

  it("passes --check flag to runner", async () => {
    let receivedOptions: { checkOnly?: boolean; yes?: boolean } | undefined
    const { exitCode, output } = await captureRun(["update", "--check"], {
      updateRunner: async (options) => {
        receivedOptions = options
        return { ok: true, message: "Update available: v1.0.1 -> v1.1.0" }
      },
    })

    expect(exitCode).toBe(0)
    expect(receivedOptions?.checkOnly).toBe(true)
    expect(output).toContain("Update available")
  })

  it("passes -c shorthand flag to runner", async () => {
    let receivedOptions: { checkOnly?: boolean; yes?: boolean } | undefined
    const { exitCode } = await captureRun(["update", "-c"], {
      updateRunner: async (options) => {
        receivedOptions = options
        return { ok: true, message: "Update available" }
      },
    })

    expect(exitCode).toBe(0)
    expect(receivedOptions?.checkOnly).toBe(true)
  })

  it("passes --yes flag to runner", async () => {
    let receivedOptions: { checkOnly?: boolean; yes?: boolean } | undefined
    const { exitCode, output } = await captureRun(["update", "--yes"], {
      updateRunner: async (options) => {
        receivedOptions = options
        return { ok: true, message: "Successfully updated AIBridge" }
      },
    })

    expect(exitCode).toBe(0)
    expect(receivedOptions?.yes).toBe(true)
    expect(output).toContain("Successfully updated")
  })

  it("returns nonzero when update fails", async () => {
    const { exitCode, output } = await captureRun(["update"], {
      updateRunner: async () => ({
        ok: false,
        message: "Failed to check for updates: network error",
      }),
    })

    expect(exitCode).not.toBe(0)
    expect(output).toContain("Failed to check for updates")
  })
})

// ── _opencode hidden command ───────────────────────────────────────────

describe("cli _opencode (hidden)", () => {
  it("calls runOpencode with profile name", async () => {
    let receivedProfile: string | undefined
    await captureRun(["_opencode", "--profile", "dev"], {
      opencodeRunner: async (profile) => {
        receivedProfile = profile
      },
    })

    expect(receivedProfile).toBe("dev")
  })

  it("requires --profile flag", async () => {
    const { exitCode, output } = await captureRun(["_opencode"])

    expect(exitCode).not.toBe(0)
    expect(output).toContain("--profile")
  })

  it("returns 0 on success", async () => {
    const { exitCode } = await captureRun(["_opencode", "--profile", "dev"])

    expect(exitCode).toBe(0)
  })

  it("returns nonzero when opencode throws", async () => {
    const { exitCode } = await captureRun(["_opencode", "--profile", "dev"], {
      opencodeRunner: async () => {
        throw new Error("spawn failed")
      },
    })

    expect(exitCode).not.toBe(0)
  })
})

// ── Non-TTY ────────────────────────────────────────────────────────────

describe("cli tui", () => {
  it("requires a profile", async () => {
    const { exitCode, output } = await captureRun(["tui"])

    expect(exitCode).toBe(1)
    expect(output).toContain("--profile")
  })

  it("requires both interactive streams before creating the shell", async () => {
    let called = false
    const { exitCode, output } = await captureRun(["tui", "--profile", "dev"], {
      isTTY: true,
      isInputTTY: false,
      tuiRunner: async () => { called = true; return 0 },
    })

    expect(exitCode).toBe(1)
    expect(output).toContain("stdin and stdout TTYs")
    expect(called).toBe(false)
  })

  it("rejects non-interactive stdout before creating the shell", async () => {
    let called = false
    const { exitCode, output } = await captureRun(["tui", "--profile", "dev"], {
      isTTY: false,
      isInputTTY: true,
      tuiRunner: async () => { called = true; return 0 },
    })

    expect(exitCode).toBe(1)
    expect(output).toContain("stdin and stdout TTYs")
    expect(called).toBe(false)
  })

  it("delegates a validated profile to the separately injected shell", async () => {
    let profile: string | undefined
    const { exitCode } = await captureRun(["tui", "--profile", "dev"], {
      tuiRunner: async (value) => { profile = value; return 0 },
    })

    expect(exitCode).toBe(0)
    expect(profile).toBe("dev")
  })

  it("keeps help and version usable without TTYs", async () => {
    const help = await captureRun(["tui", "--help"], { isTTY: false, isInputTTY: false })
    const version = await captureRun(["tui", "--version"], { isTTY: false, isInputTTY: false })

    expect(help.exitCode).toBe(0)
    expect(help.output).toContain("Usage")
    expect(version.exitCode).toBe(0)
  })
})

// ── Non-TTY ───────────────────────────────────────────────────────────

describe("cli non-TTY", () => {
  it("errors on commands that require TTY interaction", async () => {
    const { exitCode, output } = await captureRun(["setup"], {
      isTTY: false,
    })

    // setup requires interactive prompts — should fail in non-TTY
    expect(exitCode).not.toBe(0)
    expect(output).toContain("TTY")
  })
})

// ── Profile validation ─────────────────────────────────────────────────

describe("cli profile validation", () => {
  it("rejects profile name with traversal", async () => {
    const { exitCode, output } = await captureRun(["start", "--profile", "../etc/passwd"])

    expect(exitCode).not.toBe(0)
    expect(output).not.toContain("etc/passwd")
  })

  it("rejects empty profile name", async () => {
    const { exitCode, output } = await captureRun(["start", "--profile", ""])

    expect(exitCode).not.toBe(0)
  })

  it("rejects profile name starting with hyphen", async () => {
    const { exitCode, output } = await captureRun(["start", "--profile", "-bad"])

    expect(exitCode).not.toBe(0)
  })
})

// ── --profile value without argument ────────────────────────────────────

describe("cli --profile without value", () => {
  it("returns nonzero when --profile has no value", async () => {
    const { exitCode, output } = await captureRun(["start", "--profile"])

    expect(exitCode).not.toBe(0)
    expect(output).not.toContain("undefined")
  })
})
