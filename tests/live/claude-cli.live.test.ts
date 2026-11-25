/**
 * Live harness for the Claude Code runtime adapter (Phase 0).
 *
 * Spawns the REAL `claude` CLI through ClaudeCodeRuntimeAdapter. It costs money
 * and needs credentials (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or an
 * existing `claude` login for the current OS user), so it only runs when
 * AIBR_LIVE_CLAUDE=1:
 *
 *   bun run test:live
 *
 * Optional overrides:
 *   AIBR_LIVE_CLAUDE_BIN         executable (default: `claude` from PATH)
 *   AIBR_LIVE_CLAUDE_MODEL       --model value (default: haiku -- the account default
 *                                model can cost >$0.10 for one turn, and --max-budget-usd
 *                                is a soft cap checked AFTER a turn, so it cannot stop that)
 *   AIBR_LIVE_CLAUDE_BUDGET_USD  --max-budget-usd per run (default: 0.25)
 *
 * Self-contained at runtime: every run uses a fresh temp directory as cwd and
 * nothing else on disk besides the test's own imports.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ClaudeCodeRuntimeAdapter,
  type ClaudeLaunchProfile,
} from "../../src/runtime/claude-adapter.js"
import type { AgentRuntimeEvent, RuntimeSession } from "../../src/runtime/schemas.js"
import { createTestLaunchRequest, createTestOperationContext } from "../contracts/runtime/conformance-helpers.js"

const LIVE = process.env.AIBR_LIVE_CLAUDE === "1"
const CLAUDE_BIN = process.env.AIBR_LIVE_CLAUDE_BIN ?? "claude"
const MODEL = process.env.AIBR_LIVE_CLAUDE_MODEL ?? "haiku"
const BUDGET_USD = Number(process.env.AIBR_LIVE_CLAUDE_BUDGET_USD ?? "0.25")
const RUN_TIMEOUT_MS = 150_000
const TEST_TIMEOUT_MS = 180_000

/**
 * Flags Phase 1–2 rely on; checked against `claude --help` of the installed version.
 * `--max-turns` is deliberately absent: CLI 2.1.332 hides it from --help but still
 * accepts it, which the isolation-flags test below proves by running with it.
 */
const REQUIRED_FLAGS = [
  "--print",
  "--output-format",
  "--input-format",
  "--verbose",
  "--include-hook-events",
  "--session-id",
  "--permission-mode",
  "--allowedTools",
  "--disallowedTools",
  "--max-budget-usd",
  "--setting-sources",
  "--settings",
  "--strict-mcp-config",
  "--mcp-config",
  "--append-system-prompt",
]

const READ_ONLY_PROFILE: ClaudeLaunchProfile = {
  permissionMode: "dontAsk",
  allowedTools: ["Read"],
  disallowedTools: ["Edit", "Write", "Bash"],
  maxBudgetUsd: BUDGET_USD,
}

interface LiveRun {
  readonly adapter: ClaudeCodeRuntimeAdapter
  readonly session: RuntimeSession
  readonly events: AgentRuntimeEvent[]
  readonly terminal: AgentRuntimeEvent
}

describe.skipIf(!LIVE)("Claude Code CLI (live)", () => {
  let workRoot = ""
  let runCounter = 0

  beforeAll(() => {
    workRoot = mkdtempSync(join(tmpdir(), "aibr-live-claude-"))
    const version = spawnSync(CLAUDE_BIN, ["--version"], { encoding: "utf8" })
    // Printed on purpose: a CLI upgrade that breaks the protocol should be traceable to a version.
    console.log(`[live] ${CLAUDE_BIN} --version → ${(version.stdout ?? "").trim() || `(failed: ${version.error ?? version.stderr})`}`)
    console.log(`[live] model=${MODEL ?? "(default)"} budget_usd=${BUDGET_USD} workRoot=${workRoot}`)
  })

  afterAll(() => {
    if (workRoot) rmSync(workRoot, { recursive: true, force: true })
  })

  async function runOnce(prompt: string, profile: ClaudeLaunchProfile): Promise<LiveRun & { directory: string }> {
    runCounter += 1
    const directory = mkdtempSync(join(workRoot, `run-${runCounter}-`))
    const adapter = new ClaudeCodeRuntimeAdapter({
      executablePath: CLAUDE_BIN,
      nodeId: "node-contract",
      installationId: "installation-contract",
      projects: { resolve: async () => ({ ok: true, value: directory }) },
      launchProfile: () => profile,
    })

    const request = await createTestLaunchRequest({
      commandId: `live-${runCounter}`,
      dispatchId: `dispatch-live-${runCounter}`,
      runtimeKind: "claude",
      prompt,
      ...(MODEL ? { model: MODEL } : {}),
    })
    const launched = await adapter.launch(request)
    if (!launched.ok) throw new Error(`launch failed: ${launched.error.code}: ${launched.error.message}`)
    const session = launched.value

    const op = createTestOperationContext(`live-observe-${runCounter}`, {
      projectId: session.projectId,
      nodeId: session.nodeId,
      dispatchId: session.dispatchId,
      runId: session.runId,
    })

    // observe() is a snapshot: poll until a terminal lifecycle state appears.
    const events: AgentRuntimeEvent[] = []
    const deadline = Date.now() + RUN_TIMEOUT_MS
    for (;;) {
      let last: AgentRuntimeEvent | undefined
      for await (const item of adapter.observe(session, op)) {
        if (!item.ok) throw new Error(`observe failed: ${item.error.code}`)
        events.push(item.value)
        last = item.value
      }
      if (last?.type === "lifecycle" && ["completed", "failed", "unknown"].includes(last.state)) {
        for (const event of events) {
          if (event.type === "lifecycle" && event.detail) console.log(`[live] ${event.state}: ${event.detail}`)
        }
        console.log(`[live] usage: ${JSON.stringify(adapter.usageFor(session.sessionId))}`)
        return { adapter, session, events, terminal: last, directory }
      }
      if (Date.now() > deadline) {
        await adapter.terminate(session, op)
        throw new Error(`claude did not finish within ${RUN_TIMEOUT_MS}ms; last state: ${JSON.stringify(last)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  it("installed CLI advertises every flag the adapter relies on", () => {
    const help = spawnSync(CLAUDE_BIN, ["--help"], { encoding: "utf8" })
    expect(help.status).toBe(0)
    const missing = REQUIRED_FLAGS.filter((flag) => !(help.stdout ?? "").includes(flag))
    expect(missing).toEqual([])
  })

  it(
    "runs a tiny prompt under a read-only profile: init seen, result succeeded, process exited",
    async () => {
      const run = await runOnce("Reply with the single word PONG", READ_ONLY_PROFILE)
      const usage = run.adapter.usageFor(run.session.sessionId)

      expect(usage?.initialized).toBe(true)
      expect(usage?.exitCode).toBe(0)
      expect(usage?.signal ?? null).toBeNull()
      expect(usage?.resultSubtype).toBe("success")
      expect(usage?.totalCostUsd).toBeGreaterThan(0)
      expect(run.terminal.type === "lifecycle" && run.terminal.state).toBe("completed")

      const result = await run.adapter.collectResult(run.session, createTestOperationContext("live-collect-1"))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.outcome).toBe("succeeded")
        expect(result.value.summary.toUpperCase()).toContain("PONG")
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "denies a write under dontAsk: file not created and a denial recorded",
    async () => {
      // Write is deliberately NOT in disallowedTools here: a bare name in
      // --disallowedTools removes the tool from context, so Claude would never
      // try it and no denial would be produced. Leaving it visible but not
      // allowed makes dontAsk refuse the call, which is what we want to observe.
      const profile: ClaudeLaunchProfile = {
        permissionMode: "dontAsk",
        allowedTools: ["Read"],
        disallowedTools: ["Edit", "Bash", "NotebookEdit"],
        maxBudgetUsd: BUDGET_USD,
      }
      const run = await runOnce(
        "Use the Write tool to create a file named live-proof.txt in the current directory containing the text hello. Do not use any other tool. If it is refused, reply DENIED.",
        profile,
      )
      const usage = run.adapter.usageFor(run.session.sessionId)

      expect(existsSync(join(run.directory, "live-proof.txt"))).toBe(false)
      expect(usage?.exitCode === 0 || usage?.exitCode === 1).toBe(true)
      expect(usage?.signal ?? null).toBeNull()
      const denials = run.adapter.permissionDenialsFor(run.session.sessionId)
      expect(denials.length).toBeGreaterThan(0)
      expect(denials.some((d) => d.toolName === "Write")).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "accepts the Phase 2 isolation flags (--setting-sources user, --strict-mcp-config, --max-turns)",
    async () => {
      const run = await runOnce("Reply with the single word PONG", {
        ...READ_ONLY_PROFILE,
        settingSources: ["user"],
        strictMcpConfig: true,
        maxTurns: 2,
      })
      const usage = run.adapter.usageFor(run.session.sessionId)
      expect(usage?.initialized).toBe(true)
      expect(usage?.exitCode).toBe(0)
      expect(usage?.resultSubtype).toBe("success")
    },
    TEST_TIMEOUT_MS,
  )
})
