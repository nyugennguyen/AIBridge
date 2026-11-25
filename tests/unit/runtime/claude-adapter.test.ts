import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import {
  buildClaudeLaunchArgs,
  ClaudeCodeRuntimeAdapter,
  encodeClaudeUserTurn,
  validateClaudeLaunchProfile,
  type ClaudeCodeRuntimeAdapterOptions,
  type ClaudeLaunchProfile,
  type ProcessHandle,
} from "../../../src/runtime/claude-adapter.js"
import { nodeContextSchema, type AgentRuntimeEvent, type RuntimeSession } from "../../../src/runtime/schemas.js"
import { describeAdapterConformance } from "../../contracts/runtime/conformance-suite.js"
import {
  createTestLaunchRequest,
  createTestOperationContext,
  createTestPromptRequest,
} from "../../contracts/runtime/conformance-helpers.js"

class MockProcess extends EventEmitter implements ProcessHandle {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 12345
  signalsSent: string[] = []
  readonly stdinLines: string[] = []
  stdinEnded = false

  constructor() {
    super()
    let buffer = ""
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      let index: number
      while ((index = buffer.indexOf("\n")) !== -1) {
        this.stdinLines.push(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
    })
    this.stdin.on("finish", () => {
      this.stdinEnded = true
    })
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signalsSent.push(String(signal))
    this.emit("exit", null, signal)
    return true
  }

  emitEvent(event: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(event) + "\n")
  }

  /** Mirrors a real child: stdout reaches EOF, then the process exits. */
  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end()
    this.emit("exit", code, signal)
  }
}

interface SpawnCall {
  readonly command: string
  readonly args: string[]
  readonly env?: Record<string, string>
  readonly cwd?: string
  readonly proc: MockProcess
}

const PROVIDER_SESSION = "11111111-2222-4333-8444-555555555555"

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

function createMockAdapter(
  options: { version?: string; probeTimeout?: boolean; emitInit?: boolean } & Partial<ClaudeCodeRuntimeAdapterOptions> = {},
) {
  const processes: MockProcess[] = []
  const calls: SpawnCall[] = []
  const { version, probeTimeout, emitInit, ...adapterOptions } = options
  const adapter = new ClaudeCodeRuntimeAdapter({
    executablePath: "claude-mock",
    nodeId: "node-contract",
    installationId: "installation-contract",
    probeTimeoutMs: probeTimeout ? 50 : undefined,
    exitDrainGraceMs: 20,
    projects: {
      async resolve(scope) {
        if (scope.projectId !== "project-contract") {
          return {
            ok: false,
            error: {
              schemaVersion: 1,
              category: "policy_denied",
              code: "project.scope",
              message: "Foreign project rejected",
              retryable: false,
            },
          }
        }
        return { ok: true, value: "/workspace/contract" }
      },
    },
    spawn: (command, args, spawnOptions) => {
      const proc = new MockProcess()
      processes.push(proc)
      calls.push({ command, args, env: spawnOptions.env, cwd: spawnOptions.cwd, proc })
      if (args.includes("--version")) {
        if (!probeTimeout) {
          setTimeout(() => {
            proc.stdout.write((version ?? "2.1.332 (Claude Code)") + "\n")
            proc.emit("exit", 0, null)
          }, 5)
        }
      } else if (emitInit !== false) {
        const sessionIndex = args.indexOf("--session-id")
        setTimeout(() => {
          proc.emitEvent({
            type: "system",
            subtype: "init",
            session_id: sessionIndex >= 0 ? args[sessionIndex + 1] : PROVIDER_SESSION,
            model: "claude-haiku-4-5",
            tools: ["Read", "Grep", "Glob"],
            permissionMode: "dontAsk",
          })
        }, 1)
      }
      return proc
    },
    ...adapterOptions,
  })

  return { adapter, processes, calls }
}

async function launch(adapter: ClaudeCodeRuntimeAdapter, commandId: string, overrides: { prompt?: string; model?: string } = {}) {
  const request = await createTestLaunchRequest({ commandId, runtimeKind: "claude", dispatchId: `dispatch-${commandId}`, ...overrides })
  const launched = await adapter.launch(request)
  if (!launched.ok) throw new Error(`launch failed: ${launched.error.code}`)
  return { request, session: launched.value }
}

async function drain(adapter: ClaudeCodeRuntimeAdapter, session: RuntimeSession): Promise<AgentRuntimeEvent[]> {
  const op = createTestOperationContext("observe-op", {
    projectId: session.projectId,
    nodeId: session.nodeId,
    dispatchId: session.dispatchId,
    runId: session.runId,
  })
  const events: AgentRuntimeEvent[] = []
  for await (const item of adapter.observe(session, op)) {
    if (!item.ok) throw new Error(item.error.code)
    events.push(item.value)
  }
  return events
}

function lastLifecycle(events: AgentRuntimeEvent[]) {
  const lifecycle = events.filter((e) => e.type === "lifecycle")
  const last = lifecycle[lifecycle.length - 1]
  if (!last || last.type !== "lifecycle") throw new Error("no lifecycle event")
  return last
}

const successResult = (overrides: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "PONG",
  total_cost_usd: 0.0123,
  usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 100 },
  num_turns: 2,
  duration_ms: 1500,
  session_id: PROVIDER_SESSION,
  permission_denials: [],
  ...overrides,
})

describe("ClaudeCodeRuntimeAdapter", () => {
  describe("Detection & Version Probe", () => {
    it("detects installed binary and reports honest capabilities", async () => {
      const { adapter } = createMockAdapter({ version: "2.1.332 (Claude Code)" })
      const node = nodeContextSchema.parse({
        schemaVersion: 1,
        nodeId: "node-contract",
        meshId: "mesh-contract",
        platform: "darwin",
        architecture: "arm64",
      })

      const detected = await adapter.detect(node)
      expect(detected.ok).toBe(true)
      if (detected.ok) {
        expect(detected.value.length).toBe(1)
        expect(detected.value[0].version).toBe("2.1.332 (Claude Code)")
        expect(detected.value[0].runtimeKind).toBe("claude")
        expect(detected.value[0].capabilities.structuredPermissions).toBe(false)
        expect(detected.value[0].capabilities.nativeSessionRestore).toBe(false)
        expect(detected.value[0].capabilities.reliableCompletion).toBe(true)
        expect(detected.value[0].capabilities.usageData).toBe(true)
        expect(detected.value[0].capabilityReport?.structuredPermissions.status).toBe("unsupported")
        expect(detected.value[0].capabilityReport?.nativeSessionRestore.status).toBe("conditional")
      }
    })

    it("returns empty array when probe times out", async () => {
      const { adapter } = createMockAdapter({ probeTimeout: true })
      const node = nodeContextSchema.parse({
        schemaVersion: 1,
        nodeId: "node-contract",
        meshId: "mesh-contract",
        platform: "darwin",
        architecture: "arm64",
      })

      const detected = await adapter.detect(node)
      expect(detected.ok).toBe(true)
      if (detected.ok) {
        expect(detected.value).toEqual([])
      }
    })
  })

  describe("Launch argv & stdin protocol", () => {
    it("builds print-mode stream-json argv with --verbose, dontAsk and --append-system-prompt", async () => {
      const { adapter, calls } = createMockAdapter()
      const { session } = await launch(adapter, "argv-default", { model: "haiku" })
      const { args } = calls[calls.length - 1]

      expect(args.slice(0, 7)).toEqual(["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-hook-events"])
      const handle = adapter.sessionReference(session.sessionId)?.adapterMetadata.handle
      expect(args[args.indexOf("--session-id") + 1]).toBe(handle)
      expect(args[args.indexOf("--model") + 1]).toBe("haiku")
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk")
      expect(args).not.toContain("--system-prompt")
      expect(args).toContain("--append-system-prompt")
      expect(args[args.indexOf("--append-system-prompt") + 1].length).toBeGreaterThan(0)
      expect(args).not.toContain("--allowedTools")
    })

    it("translates a launch profile into argv", () => {
      const profile: ClaudeLaunchProfile = {
        allowedTools: ["Read", "Grep", "Bash(git log *)"],
        disallowedTools: ["Edit", "Write", "Read(./.env*)"],
        maxBudgetUsd: 2,
        maxTurns: 20,
        settingSources: ["user"],
        settingsPath: "/etc/aibridge/claude-staging-settings.json",
        strictMcpConfig: true,
        mcpConfigPath: "/etc/aibridge/mcp.json",
        appendSystemPrompt: "Never push to main.",
      }
      expect(validateClaudeLaunchProfile(profile)).toBeUndefined()
      expect(
        buildClaudeLaunchArgs({ providerSessionId: PROVIDER_SESSION, model: "sonnet", compiledSystemPrompt: "ROLE", profile }),
      ).toEqual([
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--include-hook-events",
        "--session-id",
        PROVIDER_SESSION,
        "--model",
        "sonnet",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "Read",
        "Grep",
        "Bash(git log *)",
        "--disallowedTools",
        "Edit",
        "Write",
        "Read(./.env*)",
        "--max-budget-usd",
        "2",
        "--max-turns",
        "20",
        "--setting-sources",
        "user",
        "--settings",
        "/etc/aibridge/claude-staging-settings.json",
        "--strict-mcp-config",
        "--mcp-config",
        "/etc/aibridge/mcp.json",
        "--append-system-prompt",
        "ROLE\n\nNever push to main.",
      ])
    })

    it("passes the request to the launchProfile hook and honours an explicit permission mode", async () => {
      const seen: string[] = []
      const { adapter, calls } = createMockAdapter({
        launchProfile: (request) => {
          seen.push(request.operation.commandId)
          return { permissionMode: "plan", allowedTools: ["Read"], maxBudgetUsd: 0.05 }
        },
      })
      await launch(adapter, "argv-profile-hook")
      const { args } = calls[calls.length - 1]
      expect(seen).toEqual(["argv-profile-hook"])
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan")
      expect(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 2)).toEqual(["--allowedTools", "Read"])
      expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.05")
    })

    it("refuses bypassPermissions and malformed profiles without spawning", async () => {
      const bypass = createMockAdapter({ launchProfile: () => ({ permissionMode: "bypassPermissions" }) })
      const request = await createTestLaunchRequest({ commandId: "argv-bypass", runtimeKind: "claude" })
      const denied = await bypass.adapter.launch(request)
      expect(denied.ok).toBe(false)
      if (!denied.ok) {
        expect(denied.error.category).toBe("policy_denied")
        expect(denied.error.code).toBe("runtime.launch.permission_bypass_denied")
      }
      expect(bypass.calls).toHaveLength(0)

      expect(validateClaudeLaunchProfile({ maxBudgetUsd: -1 })?.category).toBe("validation")
      expect(validateClaudeLaunchProfile({ maxTurns: 1.5 })?.category).toBe("validation")
      expect(validateClaudeLaunchProfile({ allowedTools: ["--dangerously-skip-permissions"] })?.category).toBe("validation")
      expect(validateClaudeLaunchProfile({ settingSources: ["everything"] })?.category).toBe("validation")
      expect(validateClaudeLaunchProfile({ disallowedTools: ["Bash(rm\n-rf)"] })?.category).toBe("validation")
    })

    it("writes the initial prompt as a stream-json user turn", async () => {
      const { adapter, processes } = createMockAdapter()
      await launch(adapter, "stdin-shape", { prompt: "Reply with the single word PONG" })
      await tick()
      const proc = processes[processes.length - 1]
      expect(proc.stdinLines).toHaveLength(1)
      expect(JSON.parse(proc.stdinLines[0])).toEqual({
        type: "user",
        message: { role: "user", content: "Reply with the single word PONG" },
        parent_tool_use_id: null,
      })
      expect(encodeClaudeUserTurn("x")).toBe('{"type":"user","message":{"role":"user","content":"x"},"parent_tool_use_id":null}\n')
    })

    it("lets Claude credentials through the env allowlist while stripping bridge secrets", async () => {
      const { adapter, calls } = createMockAdapter({
        env: {
          HOME: "/home/aibr",
          PATH: "/usr/local/bin:/usr/bin",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value",
          ANTHROPIC_API_KEY: "sk-ant-api-key-value",
          AIBRIDGE_BEARER_TOKEN: "bridge-secret",
          AIBRIDGE_OPERATOR_TOKEN: "operator-secret",
          GITHUB_TOKEN: "ghp-secret",
        },
      })
      await launch(adapter, "env-allowlist")
      const env = calls[calls.length - 1].env ?? {}
      expect(env.HOME).toBe("/home/aibr")
      expect(env.PATH).toBe("/usr/local/bin:/usr/bin")
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-value")
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api-key-value")
      expect(env.AIBRIDGE_BEARER_TOKEN).toBeUndefined()
      expect(env.AIBRIDGE_OPERATOR_TOKEN).toBeUndefined()
      expect(env.GITHUB_TOKEN).toBeUndefined()
    })
  })

  describe("Stream parsing & result normalization", () => {
    it("maps init, tool_use and tool_result to working, closes stdin after result, and completes on exit", async () => {
      const { adapter, processes } = createMockAdapter()
      const { session } = await launch(adapter, "flow-success")
      const proc = processes[processes.length - 1]
      await tick()

      // Real CLI 2.1.332 order: system/init, system/commands_changed, assistant, rate_limit_event, result.
      proc.emitEvent({ type: "system", subtype: "commands_changed", session_id: PROVIDER_SESSION })
      proc.emitEvent({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "README.md" } }] },
        parent_tool_use_id: null,
        session_id: PROVIDER_SESSION,
      })
      proc.emitEvent({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
        parent_tool_use_id: null,
        session_id: PROVIDER_SESSION,
      })
      proc.emitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id: PROVIDER_SESSION })
      proc.stdout.write("not json at all\n")
      await tick()
      expect(proc.stdinEnded).toBe(false)

      const running = await drain(adapter, session)
      const details = running.filter((e) => e.type === "lifecycle").map((e) => (e.type === "lifecycle" ? e.detail : undefined))
      expect(details[0]).toContain("Claude Code session initialised")
      expect(details[0]).toContain("claude-haiku-4-5")
      expect(details).toContain("Tool call: Read")
      expect(details).toContain("Tool result: 1")
      expect(details).toContain("Claude Code system event: commands_changed")
      expect(lastLifecycle(running).state).toBe("working")

      proc.emitEvent(successResult())
      await tick()
      expect(proc.stdinEnded).toBe(true)

      const afterResult = await drain(adapter, session)
      expect(afterResult.some((e) => e.type === "result_available")).toBe(true)
      expect(lastLifecycle(afterResult).state).toBe("working")

      proc.finish(0)
      await tick(30)
      const final = await drain(adapter, session)
      expect(lastLifecycle(final).state).toBe("completed")

      const result = await adapter.collectResult(session, createTestOperationContext("flow-success-collect"))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.outcome).toBe("succeeded")
        expect(result.value.summary.startsWith("PONG")).toBe(true)
        expect(result.value.summary).toContain("subtype=success")
        expect(result.value.summary).toContain("cost_usd=0.0123")
        if (result.value.outcome === "succeeded") {
          expect(result.value.completionEvidence).toEqual({ kind: "reliable_provider", mechanism: "claude_stream_result" })
        }
      }

      const usage = adapter.usageFor(session.sessionId)
      expect(usage?.initialized).toBe(true)
      expect(usage?.model).toBe("claude-haiku-4-5")
      expect(usage?.resultSubtype).toBe("success")
      expect(usage?.totalCostUsd).toBe(0.0123)
      expect(usage?.numTurns).toBe(2)
      expect(usage?.durationMs).toBe(1500)
      expect(usage?.usage).toEqual({ input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 100 })
      expect(usage?.providerSessionId).toBe(PROVIDER_SESSION)
      expect(usage?.exitCode).toBe(0)
    })

    it("treats error_max_budget_usd (no result field, errors[]) as failed", async () => {
      const { adapter, processes } = createMockAdapter()
      const { session } = await launch(adapter, "flow-budget")
      const proc = processes[processes.length - 1]
      await tick()

      proc.emitEvent({
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        total_cost_usd: 0.051,
        num_turns: 1,
        duration_ms: 900,
        session_id: PROVIDER_SESSION,
        errors: ["Reached maximum budget ($0.05)"],
        permission_denials: [],
      })
      await tick()
      expect(proc.stdinEnded).toBe(true)
      proc.finish(1)
      await tick(30)

      const events = await drain(adapter, session)
      expect(lastLifecycle(events).state).toBe("failed")
      expect(lastLifecycle(events).detail).toContain("error_max_budget_usd")

      const result = await adapter.collectResult(session, createTestOperationContext("flow-budget-collect"))
      expect(result.ok && result.value.outcome).toBe("failed")
      if (result.ok) {
        expect(result.value.summary).toContain("error_max_budget_usd")
        expect(result.value.summary).toContain("Reached maximum budget")
      }
      expect(adapter.usageFor(session.sessionId)?.errors).toEqual(["Reached maximum budget ($0.05)"])
      expect(adapter.usageFor(session.sessionId)?.totalCostUsd).toBe(0.051)
    })

    it("does not treat subtype success with is_error=true as succeeded", async () => {
      const { adapter, processes } = createMockAdapter()
      const { session } = await launch(adapter, "flow-is-error")
      const proc = processes[processes.length - 1]
      proc.emitEvent(successResult({ is_error: true, result: "API Error: 401" }))
      proc.finish(0)
      await tick(30)

      const result = await adapter.collectResult(session, createTestOperationContext("flow-is-error-collect"))
      expect(result.ok && result.value.outcome).toBe("failed")
      expect(lastLifecycle(await drain(adapter, session)).state).toBe("failed")
    })

    it("records permission denials from the stream and the result, de-duplicated by tool_use_id", async () => {
      const { adapter, processes } = createMockAdapter({ env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-secret-value-123456" } })
      const { session } = await launch(adapter, "flow-denied")
      const proc = processes[processes.length - 1]
      await tick()

      proc.emitEvent({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Write",
        tool_use_id: "toolu_w1",
        message: "Permission to use Write has been denied.",
        session_id: PROVIDER_SESSION,
      })
      await tick()
      expect(adapter.permissionDenialsFor(session.sessionId)).toHaveLength(1)

      const midway = await drain(adapter, session)
      expect(midway.some((e) => e.type === "lifecycle" && e.detail?.includes("Permission denied by launch profile: Write"))).toBe(true)

      proc.emitEvent(
        successResult({
          result: "I could not write the file.",
          permission_denials: [
            { tool_name: "Write", tool_use_id: "toolu_w1", tool_input: { file_path: "/tmp/x", content: "sk-ant-secret-value-123456" } },
            { tool_name: "Bash", tool_use_id: "toolu_b1", tool_input: { command: "touch /tmp/x" } },
          ],
        }),
      )
      proc.finish(0)
      await tick(30)

      const denials = adapter.permissionDenialsFor(session.sessionId)
      expect(denials.map((d) => d.toolName)).toEqual(["Write", "Bash"])
      expect(denials[0].source).toBe("stream")
      expect(denials[0].inputPreview).toContain("/tmp/x")
      expect(denials[0].inputPreview).not.toContain("sk-ant-secret-value-123456")
      expect(denials[1].inputPreview).toContain("touch /tmp/x")

      const result = await adapter.collectResult(session, createTestOperationContext("flow-denied-collect"))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.summary).toContain("permission_denials=2 (Write, Bash)")
      }
    })

    it("still sees a result line that arrives after the exit event", async () => {
      const { adapter, processes } = createMockAdapter()
      const { session } = await launch(adapter, "flow-late-result")
      const proc = processes[processes.length - 1]
      await tick()

      proc.emit("exit", 0, null)
      proc.emitEvent(successResult())
      proc.stdout.end()
      await tick(30)

      expect(lastLifecycle(await drain(adapter, session)).state).toBe("completed")
    })

    it("degrades to unknown on exit code 0 when result event is missing", async () => {
      const { adapter, processes } = createMockAdapter()
      const { session } = await launch(adapter, "claude-no-res-1")
      processes[processes.length - 1].finish(0)
      await tick(30)

      const result = await adapter.collectResult(session, createTestOperationContext("claude-res-op-1"))
      expect(result.ok && result.value.outcome).toBe("unknown")
      expect(lastLifecycle(await drain(adapter, session)).state).toBe("unknown")
    })

    it("fails a signal-killed process (code null) instead of treating it as exit 0", async () => {
      const { adapter, processes } = createMockAdapter()
      const { session } = await launch(adapter, "claude-signal")
      processes[processes.length - 1].finish(null, "SIGKILL")
      await tick(30)

      const result = await adapter.collectResult(session, createTestOperationContext("claude-signal-op"))
      expect(result.ok && result.value.outcome).toBe("failed")
      if (result.ok) expect(result.value.summary).toContain("signal SIGKILL")
      const last = lastLifecycle(await drain(adapter, session))
      expect(last.state).toBe("failed")
      expect(last.detail).toContain("SIGKILL")
      expect(adapter.usageFor(session.sessionId)?.signal).toBe("SIGKILL")
      expect(adapter.usageFor(session.sessionId)?.exitCode).toBeNull()
    })

    it("records failed outcome with a redacted stderr tail on non-zero exit", async () => {
      const { adapter, processes } = createMockAdapter({ env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-abcdef" } })
      const { session } = await launch(adapter, "claude-res-fail")
      const proc = processes[processes.length - 1]
      proc.stderr.write("Invalid token oauth-secret-abcdef\n")
      await tick()
      proc.finish(1)
      await tick(30)

      const result = await adapter.collectResult(session, createTestOperationContext("claude-res-op-3"))
      expect(result.ok && result.value.outcome).toBe("failed")
      if (result.ok) {
        expect(result.value.summary).toContain("exited with code 1")
        expect(result.value.summary).toContain("Invalid token")
        expect(result.value.summary).not.toContain("oauth-secret-abcdef")
      }
    })
  })

  describe("Turns, permissions & control", () => {
    it("rejects prompts once a single-shot session has closed stdin", async () => {
      const { adapter, processes } = createMockAdapter()
      const { session } = await launch(adapter, "turn-closed")
      processes[processes.length - 1].emitEvent(successResult())
      await tick()

      const prompted = await adapter.prompt(session, createTestPromptRequest(session, "follow up", "turn-closed-prompt"))
      expect(prompted.ok).toBe(false)
      if (!prompted.ok) expect(prompted.error.code).toBe("runtime.prompt.closed")
    })

    it("closes stdin only after every submitted turn has a result", async () => {
      const { adapter, processes } = createMockAdapter()
      const { session } = await launch(adapter, "turn-pending")
      const proc = processes[processes.length - 1]
      const prompted = await adapter.prompt(session, createTestPromptRequest(session, "second turn", "turn-pending-prompt"))
      expect(prompted.ok).toBe(true)

      proc.emitEvent(successResult({ result: "first" }))
      await tick()
      expect(proc.stdinEnded).toBe(false)

      proc.emitEvent(successResult({ result: "second" }))
      await tick()
      expect(proc.stdinEnded).toBe(true)
      expect(proc.stdinLines.map((line) => JSON.parse(line).message.content)).toEqual([expect.any(String), "second turn"])
    })

    it("keeps stdin open for multi-turn sessions when keepStdinOpen is set", async () => {
      const { adapter, processes } = createMockAdapter({ keepStdinOpen: true })
      const { session } = await launch(adapter, "turn-multi")
      const proc = processes[processes.length - 1]
      proc.emitEvent(successResult({ result: "first" }))
      await tick()
      expect(proc.stdinEnded).toBe(false)

      const prompted = await adapter.prompt(session, createTestPromptRequest(session, "next", "turn-multi-prompt"))
      expect(prompted.ok).toBe(true)
      await tick()
      expect(JSON.parse(proc.stdinLines[1])).toEqual({
        type: "user",
        message: { role: "user", content: "next" },
        parent_tool_use_id: null,
      })
    })

    it("respond() fails closed with unsupported_capability", async () => {
      const { adapter } = createMockAdapter()
      const { session } = await launch(adapter, "respond-unsupported")
      const responded = await adapter.respond(session, {
        schemaVersion: 1,
        operation: createTestOperationContext("respond-op"),
        responseId: "resp-1" as never,
        kind: "permission",
        value: "allow",
      })
      expect(responded.ok).toBe(false)
      if (!responded.ok) {
        expect(responded.error.category).toBe("unsupported_capability")
        expect(responded.error.code).toBe("runtime.claude.permissions_unsupported")
      }
    })

    it("sends SIGINT on interrupt and SIGTERM on terminate, closing stdin", async () => {
      const { adapter, processes } = createMockAdapter()
      const { session } = await launch(adapter, "claude-control-signals")
      const proc = processes[processes.length - 1]
      const op = createTestOperationContext("claude-control-op")

      await adapter.interrupt(session, op)
      expect(proc.signalsSent).toContain("SIGINT")

      await adapter.terminate(session, op)
      expect(proc.signalsSent).toContain("SIGTERM")
      await tick()
      expect(proc.stdinEnded).toBe(true)
    })
  })

  // Full Conformance Suite
  let currentAdapter: ClaudeCodeRuntimeAdapter | undefined
  describeAdapterConformance("ClaudeCodeRuntimeAdapter", () => {
    const created = createMockAdapter()
    currentAdapter = created.adapter
    return created.adapter
  }, {
    nodeId: "node-contract",
    projectId: "project-contract",
    installationId: "installation-contract",
    runtimeKind: "claude",
    getSessionReference: (session) => currentAdapter?.sessionReference(session.sessionId) ?? {
      ...session,
      adapterMetadata: { handle: "unknown", projectPathId: "project-path-contract" },
    },
  })

  // Credential-Free Smoke Test against installed binary
  describe("Installed Claude Binary Smoke Test (credential-free)", () => {
    const installedPath = "/Users/mac/.local/bin/claude"
    const hasBinary = existsSync(installedPath)

    it.skipIf(!hasBinary)("probes real installed claude binary version without credentials or network", async () => {
      const adapter = new ClaudeCodeRuntimeAdapter({
        executablePath: installedPath,
        nodeId: "node-smoke",
        installationId: "installation-smoke",
      })

      const node = nodeContextSchema.parse({
        schemaVersion: 1,
        nodeId: "node-smoke",
        meshId: "mesh-smoke",
        platform: "darwin",
        architecture: "arm64",
      })

      const detected = await adapter.detect(node)
      expect(detected.ok).toBe(true)
      if (detected.ok) {
        expect(detected.value.length).toBe(1)
        expect(detected.value[0].version).toContain("Claude Code")
        expect(detected.value[0].executable).toBe(installedPath)
      }
    })
  })
})
