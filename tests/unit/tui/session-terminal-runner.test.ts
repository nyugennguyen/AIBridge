import { describe, expect, it, vi } from "vitest"
import { runSessionTerminal } from "../../../src/tui/session-terminal-runner.js"

describe("tmux-owned session terminal runner", () => {
  it("fails closed before spawning for invalid or non-loopback bindings", async () => {
    const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      await expect(runSessionTerminal(["https://example.com", "opencode", "PASSWORD_ENV", "provider-1", "/safe", "60"])).resolves.toBe(1)
      await expect(runSessionTerminal(["http://127.0.0.1:4096", "opencode", "PASSWORD_ENV", "bad session", "/safe", "60"])).resolves.toBe(1)
      expect(diagnostic).toHaveBeenCalledTimes(2)
    } finally {
      diagnostic.mockRestore()
    }
  })

  it("keeps the deadline in the tmux-owned process and aborts the exact provider session", async () => {
    vi.useFakeTimers()
    const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => { resolveExit = resolve })
    const aborts: string[] = []
    const kills: number[] = []
    try {
      const running = runSessionTerminal(
        ["http://127.0.0.1:4096", "opencode", "PASSWORD_ENV", "provider-1", "/safe", "60"],
        {
          spawnAttach: (argv, env) => {
            expect(argv).toEqual(["opencode", "attach", "http://127.0.0.1:4096", "--session", "provider-1", "--dir", "/safe", "--mini"])
            expect(env.OPENCODE_SERVER_USERNAME).toBe("opencode")
            return { exited, kill: () => { kills.push(1); resolveExit(1) } }
          },
          abortSession: async ({ providerSessionId }) => { aborts.push(providerSessionId) },
        },
      )
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()
      await Promise.resolve()
      await expect(running).resolves.toBe(1)
      expect(aborts).toEqual(["provider-1"])
      expect(kills).toHaveLength(1)
    } finally {
      diagnostic.mockRestore()
      vi.useRealTimers()
    }
  })

  it("passes configured credentials through the child environment and aborts when attachment exits", async () => {
    const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const previous = process.env.CUSTOM_OPENCODE_PASSWORD
    process.env.CUSTOM_OPENCODE_PASSWORD = "secret-value"
    const aborts: string[] = []
    try {
      await expect(runSessionTerminal(
        ["http://127.0.0.1:4096", "custom-user", "CUSTOM_OPENCODE_PASSWORD", "provider-2", "/safe", "60"],
        {
          spawnAttach: (_argv, env) => {
            expect(env.OPENCODE_SERVER_USERNAME).toBe("custom-user")
            expect(env.OPENCODE_SERVER_PASSWORD).toBe("secret-value")
            return { exited: Promise.resolve(0), kill: () => undefined }
          },
          abortSession: async ({ providerSessionId }) => { aborts.push(providerSessionId) },
        },
      )).resolves.toBe(0)
      expect(aborts).toEqual(["provider-2"])
    } finally {
      if (previous === undefined) delete process.env.CUSTOM_OPENCODE_PASSWORD
      else process.env.CUSTOM_OPENCODE_PASSWORD = previous
      diagnostic.mockRestore()
    }
  })
})
