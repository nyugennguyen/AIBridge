import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { flagWithPlaceholder, listProfileNames, needsValue, profileMissing, unexpectedArgument, unknownFlag } from "../../../src/cli/arg-errors.js"
import { resolveProfilePaths } from "../../../src/host/paths.js"

describe("arg-errors", () => {
  it("shows each flag with a placeholder for its value", () => {
    expect(flagWithPlaceholder("--profile")).toBe("--profile <name>")
    expect(flagWithPlaceholder("--ttl")).toBe("--ttl <duration, e.g. 30m>")
    expect(flagWithPlaceholder("--json")).toBe("--json")
  })

  it("phrases a missing value as the command to type", () => {
    expect(needsValue("--profile", "status")).toBe("--profile needs a value: aibr status --profile <name>")
    expect(needsValue("--capabilities", "enroll")).toBe("--capabilities needs a value: aibr enroll --capabilities <capability,capability>")
    expect(needsValue("--profile")).toBe("--profile needs a value: aibr --profile <name>")
  })

  it("points unknown flags and arguments at the command's help", () => {
    expect(unknownFlag("--x", "logs")).toBe("unknown flag --x (see: aibr logs --help)")
    expect(unexpectedArgument("x", "logs")).toBe("unexpected argument x (see: aibr logs --help)")
  })

  it("suggests the only profile, lists several, and points at init when there is none", () => {
    expect(profileMissing("doctor", false, ["default"])).toBe(
      "aibr doctor needs a profile: aibr doctor --profile <name>\n  Profiles on this machine: default\n  Try: aibr doctor --profile default",
    )
    expect(profileMissing("status", true, ["a", "b"])).toBe(
      "--profile needs a value: aibr status --profile <name>\n  Profiles on this machine: a, b",
    )
    expect(profileMissing("stop", false, [], "or aibr stop --all-jobs")).toBe(
      "aibr stop needs a profile: aibr stop --profile <name> (or aibr stop --all-jobs)\n  No profile on this machine yet. Create one with: aibr init",
    )
  })

  it("lists only directories that hold a config.json, sorted", () => {
    const home = mkdtempSync(join(tmpdir(), "aibr-arg-errors-"))
    const env = { HOME: home }
    const root = join(resolveProfilePaths("default", env).configDir, "..")
    for (const name of ["zeta", "alpha", "empty"]) mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, "zeta", "config.json"), "{}")
    writeFileSync(join(root, "alpha", "config.json"), "{}")
    expect(listProfileNames(env)).toEqual(["alpha", "zeta"])
    expect(listProfileNames({ HOME: join(home, "nowhere") })).toEqual([])
  })
})
