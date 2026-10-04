import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile, chmod, lstat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  ensureProfileDirs,
  readConfig,
  writeConfig,
  readSecret,
  writeSecret,
} from "../../../src/host/profile-store.js"
import type { ProfilePaths } from "../../../src/host/paths.js"
import type { BridgeConfig } from "../../../src/config/types.js"

let tmpDir: string

function makePaths(overrides?: Partial<ProfilePaths>): ProfilePaths {
  return {
    configDir: join(tmpDir, "config"),
    dataDir: join(tmpDir, "data"),
    secretsDir: join(tmpDir, "data", "secrets"),
    stateDir: join(tmpDir, "state"),
    ...overrides,
  }
}

function validBridgeConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
  return {
    agent_id: "test-vps",
    bridge: { host: "0.0.0.0", port: 8787, public_url: "http://localhost:8787", ingress_mode: "engine" },
    opencode: {
      base_url: "http://localhost:4096",
      server_port: 4096,
      username: "opencode",
      password_env: "OPENCODE_SERVER_PASSWORD",
    },
      security: { auth_mode: "bearer-token", allowed_sources: [] },
    permissions: {
      default_response: "reject",
      allow_tools: [],
      require_plan_approval_for_tools: [],
    },
    projects: [],
    agents: [],
    timeouts: { default_job_seconds: 1800, callback_retry_attempts: 3 },
    planning: { plan_annotator_enabled: false, require_approval_for: [] },
    ...overrides,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "aibridge-test-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ── ensureProfileDirs ──────────────────────────────────────────────────

describe("ensureProfileDirs", () => {
  it("creates all profile directories", async () => {
    const paths = makePaths()

    await ensureProfileDirs(paths)

    const { stat } = await import("node:fs/promises")
    for (const dir of [paths.configDir, paths.dataDir, paths.secretsDir, paths.stateDir]) {
      const s = await stat(dir)
      expect(s.isDirectory()).toBe(true)
    }
  })

  it("sets 0700 permissions on created directories", async () => {
    const paths = makePaths()

    await ensureProfileDirs(paths)

    for (const dir of [paths.configDir, paths.dataDir, paths.secretsDir, paths.stateDir]) {
      const s = await lstat(dir)
      const mode = (s.mode & 0o777).toString(8)
      expect(mode).toBe("700")
    }
  })

  it("succeeds when directories already exist", async () => {
    const paths = makePaths()
    await ensureProfileDirs(paths)
    await ensureProfileDirs(paths)
  })

  it("rejects if a path component is a symlink", async () => {
    const realDir = join(tmpDir, "real-config")
    await mkdir(realDir)
    const linkPath = join(tmpDir, "config")
    await symlink(realDir, linkPath)

    const paths = makePaths({ configDir: linkPath })

    await expect(ensureProfileDirs(paths)).rejects.toThrow("symlink")
  })

  it("rejects traversal in paths", async () => {
    const paths = makePaths({ configDir: tmpDir + "/../escape" })

    await expect(ensureProfileDirs(paths)).rejects.toThrow("traversal")
  })
})

// ── writeConfig / readConfig ───────────────────────────────────────────

describe("writeConfig", () => {
  it("writes JSON with 0600 permissions", async () => {
    const configDir = join(tmpDir, "config")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const configPath = join(configDir, "config.json")

    const data = validBridgeConfig()
    await writeConfig(configPath, data)

    const content = JSON.parse(await readFile(configPath, "utf8"))
    expect(content).toEqual(data)

    const s = await lstat(configPath)
    const mode = (s.mode & 0o777).toString(8)
    expect(mode).toBe("600")
  })

  it("uses atomic write (no partial file on failure)", async () => {
    const configDir = join(tmpDir, "config")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const configPath = join(configDir, "config.json")

    await writeConfig(configPath, validBridgeConfig())

    const content = JSON.parse(await readFile(configPath, "utf8"))
    expect(content.agent_id).toBe("test-vps")
  })

  it("overwrites existing config file", async () => {
    const configDir = join(tmpDir, "config")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const configPath = join(configDir, "config.json")

    await writeConfig(configPath, validBridgeConfig({ agent_id: "v1" }))
    await writeConfig(configPath, validBridgeConfig({ agent_id: "v2" }))

    const content = JSON.parse(await readFile(configPath, "utf8"))
    expect(content.agent_id).toBe("v2")
  })

  it("rejects write to a symlink path", async () => {
    const configDir = join(tmpDir, "config")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const realFile = join(configDir, "real.json")
    await writeFile(realFile, "{}", { mode: 0o600 })
    const linkPath = join(configDir, "config.json")
    await symlink(realFile, linkPath)

    await expect(writeConfig(linkPath, validBridgeConfig())).rejects.toThrow("symlink")
  })

  it("creates parent directory if it does not exist", async () => {
    const configDir = join(tmpDir, "nested", "deep", "config")
    const configPath = join(configDir, "config.json")

    await writeConfig(configPath, validBridgeConfig())

    const content = JSON.parse(await readFile(configPath, "utf8"))
    expect(content.agent_id).toBe("test-vps")
  })
})

describe("readConfig", () => {
  it("reads and parses valid JSON", async () => {
    const configDir = join(tmpDir, "config")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const configPath = join(configDir, "config.json")
    await writeFile(configPath, JSON.stringify({ agent_id: "test" }), { mode: 0o600 })

    const data = await readConfig(configPath)
    expect(data).toEqual({ agent_id: "test" })
  })

  it("rejects if file is a symlink", async () => {
    const configDir = join(tmpDir, "config")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const realFile = join(configDir, "real.json")
    await writeFile(realFile, "{}", { mode: 0o600 })
    const linkPath = join(configDir, "config.json")
    await symlink(realFile, linkPath)

    await expect(readConfig(linkPath)).rejects.toThrow("symlink")
  })

  it("rejects invalid JSON", async () => {
    const configDir = join(tmpDir, "config")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const configPath = join(configDir, "config.json")
    await writeFile(configPath, "not-json", { mode: 0o600 })

    await expect(readConfig(configPath)).rejects.toThrow()
  })

  it("rejects when file has too-permissive mode", async () => {
    const configDir = join(tmpDir, "config")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const configPath = join(configDir, "config.json")
    await writeFile(configPath, '{"ok":true}', { mode: 0o644 })
    await chmod(configPath, 0o644)

    await expect(readConfig(configPath)).rejects.toThrow("more permissive")
  })

  it("returns null when file does not exist", async () => {
    const configPath = join(tmpDir, "nonexistent.json")
    const result = await readConfig(configPath)
    expect(result).toBeNull()
  })
})

// ── writeSecret / readSecret ───────────────────────────────────────────

describe("writeSecret", () => {
  it("writes secret with 0600 permissions", async () => {
    const secretsDir = join(tmpDir, "secrets")
    await mkdir(secretsDir, { recursive: true, mode: 0o700 })
    const secretPath = join(secretsDir, "bearer-token")

    await writeSecret(secretPath, "super-secret-value")

    const content = await readFile(secretPath, "utf8")
    expect(content).toBe("super-secret-value")

    const s = await lstat(secretPath)
    const mode = (s.mode & 0o777).toString(8)
    expect(mode).toBe("600")
  })

  it("rejects overwrite of existing secret", async () => {
    const secretsDir = join(tmpDir, "secrets")
    await mkdir(secretsDir, { recursive: true, mode: 0o700 })
    const secretPath = join(secretsDir, "bearer-token")

    await writeSecret(secretPath, "first-value")

    await expect(writeSecret(secretPath, "second-value")).rejects.toThrow("already exists")
  })

  it("rejects write to a symlink path", async () => {
    const secretsDir = join(tmpDir, "secrets")
    await mkdir(secretsDir, { recursive: true, mode: 0o700 })
    const realFile = join(secretsDir, "real-secret")
    await writeFile(realFile, "old", { mode: 0o600 })
    const linkPath = join(secretsDir, "secret")
    await symlink(realFile, linkPath)

    await expect(writeSecret(linkPath, "new")).rejects.toThrow("symlink")
  })

  it("rejects empty secret value", async () => {
    const secretsDir = join(tmpDir, "secrets")
    await mkdir(secretsDir, { recursive: true, mode: 0o700 })
    const secretPath = join(secretsDir, "empty-secret")

    await expect(writeSecret(secretPath, "")).rejects.toThrow("empty")
  })

  it("creates parent directory if missing", async () => {
    const secretsDir = join(tmpDir, "nested", "secrets")
    const secretPath = join(secretsDir, "token")

    await writeSecret(secretPath, "value")

    const content = await readFile(secretPath, "utf8")
    expect(content).toBe("value")
  })
})

describe("readSecret", () => {
  it("reads secret content", async () => {
    const secretsDir = join(tmpDir, "secrets")
    await mkdir(secretsDir, { recursive: true, mode: 0o700 })
    const secretPath = join(secretsDir, "token")
    await writeFile(secretPath, "my-token", { mode: 0o600 })

    const value = await readSecret(secretPath)
    expect(value).toBe("my-token")
  })

  it("rejects if file is a symlink", async () => {
    const secretsDir = join(tmpDir, "secrets")
    await mkdir(secretsDir, { recursive: true, mode: 0o700 })
    const realFile = join(secretsDir, "real")
    await writeFile(realFile, "val", { mode: 0o600 })
    const linkPath = join(secretsDir, "token")
    await symlink(realFile, linkPath)

    await expect(readSecret(linkPath)).rejects.toThrow("symlink")
  })

  it("rejects when file has too-permissive mode", async () => {
    const secretsDir = join(tmpDir, "secrets")
    await mkdir(secretsDir, { recursive: true, mode: 0o700 })
    const secretPath = join(secretsDir, "token")
    await writeFile(secretPath, "val", { mode: 0o644 })
    await chmod(secretPath, 0o644)

    await expect(readSecret(secretPath)).rejects.toThrow("more permissive")
  })

  it("throws when file does not exist", async () => {
    const secretPath = join(tmpDir, "nonexistent")
    await expect(readSecret(secretPath)).rejects.toThrow()
  })
})

// ── bridgeConfigSchema boundary validation ─────────────────────────────

describe("schema validation", () => {
  it("writeConfig rejects data that fails bridgeConfigSchema", async () => {
    const configDir = join(tmpDir, "config")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const configPath = join(configDir, "config.json")

    await expect(writeConfig(configPath, { invalid: true })).rejects.toThrow()
  })

  it("writeConfig accepts valid bridgeConfig data", async () => {
    const configDir = join(tmpDir, "config")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const configPath = join(configDir, "config.json")

    await writeConfig(configPath, validBridgeConfig())

    const content = JSON.parse(await readFile(configPath, "utf8"))
    expect(content.agent_id).toBe("test-vps")
  })
})
