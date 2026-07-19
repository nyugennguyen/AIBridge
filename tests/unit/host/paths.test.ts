import { describe, expect, it } from "vitest"
import {
  validateProfileName,
  resolveProfilePaths,
} from "../../../src/host/paths.js"

// ── validateProfileName ────────────────────────────────────────────────

describe("validateProfileName", () => {
  it("accepts a simple lowercase name", () => {
    expect(validateProfileName("dev-main")).toBe("dev-main")
  })

  it("accepts alphanumeric with hyphens", () => {
    expect(validateProfileName("test-vps-01")).toBe("test-vps-01")
  })

  it("accepts single character", () => {
    expect(validateProfileName("a")).toBe("a")
  })

  it("accepts max 64 characters", () => {
    const name = "a".repeat(64)
    expect(validateProfileName(name)).toBe(name)
  })

  it("rejects empty string", () => {
    expect(() => validateProfileName("")).toThrow("non-empty")
  })

  it("rejects names longer than 64 characters", () => {
    const name = "a".repeat(65)
    expect(() => validateProfileName(name)).toThrow("64")
  })

  it("rejects path traversal with ..", () => {
    expect(() => validateProfileName("../etc/passwd")).toThrow("traversal")
  })

  it("rejects path traversal with leading ..", () => {
    expect(() => validateProfileName("..")).toThrow("traversal")
  })

  it("rejects path with forward slash", () => {
    expect(() => validateProfileName("foo/bar")).toThrow("invalid")
  })

  it("rejects path with backslash", () => {
    expect(() => validateProfileName("foo\\bar")).toThrow("invalid")
  })

  it("rejects names with spaces", () => {
    expect(() => validateProfileName("foo bar")).toThrow("invalid")
  })

  it("rejects names with special characters", () => {
    expect(() => validateProfileName("foo@bar")).toThrow("invalid")
    expect(() => validateProfileName("foo.bar")).toThrow("invalid")
    expect(() => validateProfileName("foo_bar")).toThrow("invalid")
    expect(() => validateProfileName("foo!bar")).toThrow("invalid")
  })

  it("rejects names starting with hyphen", () => {
    expect(() => validateProfileName("-foo")).toThrow("invalid")
  })

  it("rejects names ending with hyphen", () => {
    expect(() => validateProfileName("foo-")).toThrow("invalid")
  })

  it("rejects null input", () => {
    expect(() => validateProfileName(null as unknown as string)).toThrow()
  })

  it("rejects undefined input", () => {
    expect(() => validateProfileName(undefined as unknown as string)).toThrow()
  })
})

// ── resolveProfilePaths ────────────────────────────────────────────────

describe("resolveProfilePaths", () => {
  it("resolves config dir from XDG_CONFIG_HOME", () => {
    const paths = resolveProfilePaths("dev-main", {
      HOME: "/home/user",
      XDG_CONFIG_HOME: "/custom/config",
    })

    expect(paths.configDir).toBe("/custom/config/aibridge/dev-main")
  })

  it("resolves config dir from HOME fallback", () => {
    const paths = resolveProfilePaths("dev-main", {
      HOME: "/home/user",
    })

    expect(paths.configDir).toBe("/home/user/.config/aibridge/dev-main")
  })

  it("resolves data dir from XDG_DATA_HOME", () => {
    const paths = resolveProfilePaths("dev-main", {
      HOME: "/home/user",
      XDG_DATA_HOME: "/custom/data",
    })

    expect(paths.dataDir).toBe("/custom/data/aibridge/dev-main")
  })

  it("resolves data dir from HOME fallback", () => {
    const paths = resolveProfilePaths("dev-main", {
      HOME: "/home/user",
    })

    expect(paths.dataDir).toBe("/home/user/.local/share/aibridge/dev-main")
  })

  it("resolves secrets dir under data dir", () => {
    const paths = resolveProfilePaths("dev-main", {
      HOME: "/home/user",
    })

    expect(paths.secretsDir).toBe("/home/user/.local/share/aibridge/dev-main/secrets")
  })

  it("resolves state dir from XDG_STATE_HOME", () => {
    const paths = resolveProfilePaths("dev-main", {
      HOME: "/home/user",
      XDG_STATE_HOME: "/custom/state",
    })

    expect(paths.stateDir).toBe("/custom/state/aibridge/dev-main")
  })

  it("resolves state dir from HOME fallback", () => {
    const paths = resolveProfilePaths("dev-main", {
      HOME: "/home/user",
    })

    expect(paths.stateDir).toBe("/home/user/.local/state/aibridge/dev-main")
  })

  it("uses process.env when env is not provided", () => {
    // This test verifies the function works without explicit env
    const paths = resolveProfilePaths("test-profile")
    // Should not throw — uses process.env
    expect(paths.configDir).toContain("aibridge")
    expect(paths.configDir).toContain("test-profile")
  })

  it("throws when HOME is missing and no XDG override", () => {
    expect(() =>
      resolveProfilePaths("dev-main", {}),
    ).toThrow("HOME")
  })

  it("rejects invalid profile name", () => {
    expect(() =>
      resolveProfilePaths("../escape", { HOME: "/home/user" }),
    ).toThrow("traversal")
  })

  it("produces paths that do not depend on CWD", () => {
    const paths = resolveProfilePaths("dev-main", {
      HOME: "/home/user",
    })

    // No relative segments — all paths are absolute
    expect(paths.configDir.startsWith("/")).toBe(true)
    expect(paths.dataDir.startsWith("/")).toBe(true)
    expect(paths.secretsDir.startsWith("/")).toBe(true)
    expect(paths.stateDir.startsWith("/")).toBe(true)
  })

  it("all paths include the profile name", () => {
    const paths = resolveProfilePaths("my-profile", {
      HOME: "/home/user",
    })

    for (const dir of [paths.configDir, paths.dataDir, paths.secretsDir, paths.stateDir]) {
      expect(dir).toContain("my-profile")
    }
  })

  it("returns frozen object", () => {
    const paths = resolveProfilePaths("dev-main", { HOME: "/home/user" })
    expect(Object.isFrozen(paths)).toBe(true)
  })
})

// ── Type-level checks ──────────────────────────────────────────────────

describe("ProfilePaths shape", () => {
  it("has all four directory properties", () => {
    const paths = resolveProfilePaths("dev-main", { HOME: "/home/user" })

    expect(paths).toHaveProperty("configDir")
    expect(paths).toHaveProperty("dataDir")
    expect(paths).toHaveProperty("secretsDir")
    expect(paths).toHaveProperty("stateDir")
  })
})
