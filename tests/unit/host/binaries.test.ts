import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  detectIsMusl,
  findRouterBinary,
  findTuiBinary,
  getCandidatePlatformPackages,
  resolveNativeBinary,
  SUPPORTED_PLATFORM_PACKAGES,
} from "../../../src/host/binaries.js"

describe("Native binary discovery & platform packages", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `aibr-bin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  describe("Platform package resolution", () => {
    it("declares all six supported platform packages", () => {
      expect(SUPPORTED_PLATFORM_PACKAGES).toEqual([
        "@nyugennguyen/aibridge-darwin-arm64",
        "@nyugennguyen/aibridge-darwin-x64",
        "@nyugennguyen/aibridge-linux-arm64-gnu",
        "@nyugennguyen/aibridge-linux-arm64-musl",
        "@nyugennguyen/aibridge-linux-x64-gnu",
        "@nyugennguyen/aibridge-linux-x64-musl",
      ])
    })

    it("maps macOS arm64 to darwin-arm64", () => {
      const pkgs = getCandidatePlatformPackages("darwin", "arm64", false)
      expect(pkgs).toEqual(["@nyugennguyen/aibridge-darwin-arm64"])
    })

    it("maps macOS x64 to darwin-x64", () => {
      const pkgs = getCandidatePlatformPackages("darwin", "x64", false)
      expect(pkgs).toEqual(["@nyugennguyen/aibridge-darwin-x64"])
    })

    it("maps Linux x64 glibc with musl fallback", () => {
      const pkgs = getCandidatePlatformPackages("linux", "x64", false)
      expect(pkgs).toEqual([
        "@nyugennguyen/aibridge-linux-x64-gnu",
        "@nyugennguyen/aibridge-linux-x64-musl",
      ])
    })

    it("maps Linux x64 musl with gnu fallback", () => {
      const pkgs = getCandidatePlatformPackages("linux", "x64", true)
      expect(pkgs).toEqual([
        "@nyugennguyen/aibridge-linux-x64-musl",
        "@nyugennguyen/aibridge-linux-x64-gnu",
      ])
    })

    it("maps Linux arm64 glibc with musl fallback", () => {
      const pkgs = getCandidatePlatformPackages("linux", "arm64", false)
      expect(pkgs).toEqual([
        "@nyugennguyen/aibridge-linux-arm64-gnu",
        "@nyugennguyen/aibridge-linux-arm64-musl",
      ])
    })

    it("maps Linux arm64 musl with gnu fallback", () => {
      const pkgs = getCandidatePlatformPackages("linux", "arm64", true)
      expect(pkgs).toEqual([
        "@nyugennguyen/aibridge-linux-arm64-musl",
        "@nyugennguyen/aibridge-linux-arm64-gnu",
      ])
    })

    it("returns empty candidate list for unsupported OS", () => {
      expect(getCandidatePlatformPackages("win32", "x64", false)).toEqual([])
      expect(getCandidatePlatformPackages("freebsd", "x64", false)).toEqual([])
    })

    it("detectIsMusl honors AIBRIDGE_LIBC override", () => {
      const orig = process.env.AIBRIDGE_LIBC
      try {
        process.env.AIBRIDGE_LIBC = "musl"
        expect(detectIsMusl()).toBe(true)

        process.env.AIBRIDGE_LIBC = "glibc"
        expect(detectIsMusl()).toBe(false)
      } finally {
        if (orig !== undefined) {
          process.env.AIBRIDGE_LIBC = orig
        } else {
          delete process.env.AIBRIDGE_LIBC
        }
      }
    })
  })

  describe("resolveNativeBinary", () => {
    it("respects AIBRIDGE_TUI_BIN environment variable override", () => {
      const customBin = join(tempDir, "custom-tui")
      writeFileSync(customBin, "#!/bin/sh\nexit 0\n")
      chmodSync(customBin, 0o755)

      const result = resolveNativeBinary("aibr-tui", {
        env: { AIBRIDGE_TUI_BIN: customBin },
        roots: [tempDir],
      })

      expect(result).toBe(customBin)
    })

    it("respects AIBRIDGE_ROUTER_BIN environment variable override", () => {
      const customBin = join(tempDir, "custom-router")
      writeFileSync(customBin, "#!/bin/sh\nexit 0\n")
      chmodSync(customBin, 0o755)

      const result = resolveNativeBinary("aibr-router", {
        env: { AIBRIDGE_ROUTER_BIN: customBin },
        roots: [tempDir],
      })

      expect(result).toBe(customBin)
    })

    it("ignores non-executable or nonexistent environment variable path", () => {
      const missingBin = join(tempDir, "nonexistent")

      const result = resolveNativeBinary("aibr-tui", {
        env: { AIBRIDGE_TUI_BIN: missingBin, PATH: "" },
        roots: [tempDir],
        platform: "unsupported",
      })

      expect(result).toBeNull()
    })

    it("finds binary in optionalDependency platform package node_modules directory", () => {
      const pkgBinDir = join(tempDir, "node_modules", "@nyugennguyen", "aibridge-darwin-arm64", "bin")
      mkdirSync(pkgBinDir, { recursive: true })
      const binaryPath = join(pkgBinDir, "aibr-tui")
      writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n")
      chmodSync(binaryPath, 0o755)

      const result = resolveNativeBinary("aibr-tui", {
        env: {},
        roots: [tempDir],
        platform: "darwin",
        arch: "arm64",
      })

      expect(result).toBe(binaryPath)
    })

    it("finds binary in packages/ directory", () => {
      const pkgBinDir = join(tempDir, "packages", "aibridge-linux-x64-musl", "bin")
      mkdirSync(pkgBinDir, { recursive: true })
      const binaryPath = join(pkgBinDir, "aibr-router")
      writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n")
      chmodSync(binaryPath, 0o755)

      const result = resolveNativeBinary("aibr-router", {
        env: {},
        roots: [tempDir],
        platform: "linux",
        arch: "x64",
        isMusl: true,
      })

      expect(result).toBe(binaryPath)
    })

    it("finds binary in bundled bin/ directory", () => {
      const binDir = join(tempDir, "bin")
      mkdirSync(binDir, { recursive: true })
      const binaryPath = join(binDir, "aibr-tui")
      writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n")
      chmodSync(binaryPath, 0o755)

      const result = resolveNativeBinary("aibr-tui", {
        env: {},
        roots: [tempDir],
        platform: "darwin",
        arch: "arm64",
      })

      expect(result).toBe(binaryPath)
    })

    it("finds binary in development workspace target/release/ directory", () => {
      const targetDir = join(tempDir, "target", "release")
      mkdirSync(targetDir, { recursive: true })
      const binaryPath = join(targetDir, "aibr-tui")
      writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n")
      chmodSync(binaryPath, 0o755)

      const result = resolveNativeBinary("aibr-tui", {
        env: {},
        roots: [tempDir],
        platform: "darwin",
        arch: "arm64",
      })

      expect(result).toBe(binaryPath)
    })

    it("returns null when binary cannot be located", () => {
      const result = resolveNativeBinary("aibr-tui", {
        env: { PATH: "" },
        roots: [tempDir],
        platform: "unknown",
      })

      expect(result).toBeNull()
    })
  })

  describe("findTuiBinary and findRouterBinary helpers", () => {
    it("findTuiBinary respects AIBRIDGE_TUI_BIN", () => {
      const customBin = join(tempDir, "aibr-tui-helper")
      writeFileSync(customBin, "#!/bin/sh\nexit 0\n")
      chmodSync(customBin, 0o755)

      expect(findTuiBinary({ AIBRIDGE_TUI_BIN: customBin })).toBe(customBin)
    })

    it("findRouterBinary respects AIBRIDGE_ROUTER_BIN", () => {
      const customBin = join(tempDir, "aibr-router-helper")
      writeFileSync(customBin, "#!/bin/sh\nexit 0\n")
      chmodSync(customBin, 0o755)

      expect(findRouterBinary({ AIBRIDGE_ROUTER_BIN: customBin })).toBe(customBin)
    })
  })
})
