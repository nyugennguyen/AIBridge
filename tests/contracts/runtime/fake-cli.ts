#!/usr/bin/env bun
/**
 * Deterministic Fake CLI for testing runtime adapters (Claude Code, Codex, Generic).
 * Operates without real credentials or network access.
 */
import { existsSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)
const mode = process.env.FAKE_CLI_MODE ?? "generic"

function handleVersion(): boolean {
  if (args.includes("--version") || args.includes("-V") || args.includes("-v")) {
    if (process.env.FAKE_CLI_SLOW_VERSION === "true") {
      // Sleep synchronously without busy-wait CPU burn
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)
    }
    if (mode === "claude") {
      process.stdout.write("2.1.138 (Claude Code)\n")
    } else if (mode === "codex") {
      process.stdout.write("codex-cli 0.155.1\n")
    } else if (mode === "opencode") {
      process.stdout.write("1.18.32\n")
    } else {
      process.stdout.write("fake-cli 1.0.0\n")
    }
    return true
  }
  return false
}

if (handleVersion()) {
  process.exit(0)
}

// Check scenario
let scenarioJson = process.env.FAKE_CLI_SCENARIO
const scenarioArgIndex = args.indexOf("--scenario")
if (scenarioArgIndex !== -1 && args[scenarioArgIndex + 1]) {
  const scenarioVal = args[scenarioArgIndex + 1]
  if (existsSync(scenarioVal)) {
    scenarioJson = readFileSync(scenarioVal, "utf8")
  } else {
    scenarioJson = scenarioVal
  }
}

if (scenarioJson) {
  try {
    const scenario = JSON.parse(scenarioJson)
    runScenario(scenario)
  } catch (err) {
    process.stderr.write(`Invalid scenario: ${String(err)}\n`)
    process.exit(1)
  }
} else {
  // Default behavior based on mode
  if (mode === "claude") {
    runDefaultClaude()
  } else if (mode === "codex") {
    runDefaultCodex()
  } else {
    process.stdout.write("Fake CLI executed\n")
    process.exit(0)
  }
}

function runScenario(scenario: {
  delayMs?: number
  lines?: Array<{ stream?: "stdout" | "stderr"; text: string; delay?: number }>
  exitCode?: number
}) {
  const delayMs = scenario.delayMs ?? 10
  const lines = scenario.lines ?? []
  const exitCode = scenario.exitCode ?? 0

  let index = 0
  function next() {
    if (index >= lines.length) {
      setTimeout(() => process.exit(exitCode), delayMs)
      return
    }
    const item = lines[index++]
    const stream = item.stream === "stderr" ? process.stderr : process.stdout
    stream.write(item.text.endsWith("\n") ? item.text : `${item.text}\n`)
    setTimeout(next, item.delay ?? delayMs)
  }

  setTimeout(next, delayMs)
}

function runDefaultClaude() {
  const isPrint = args.includes("-p") || args.includes("--print")
  const isStreamJson = args.includes("--output-format") && args[args.indexOf("--output-format") + 1] === "stream-json"
  const isBidirectional = args.includes("--input-format") && args[args.indexOf("--input-format") + 1] === "stream-json"

  if (isPrint && isStreamJson) {
    process.stdout.write(JSON.stringify({ type: "system", message: "Claude initialized" }) + "\n")
    process.stdout.write(JSON.stringify({ type: "progress", message: "Analyzing repository" }) + "\n")

    if (isBidirectional) {
      // Keep process alive and process stdin messages
      const rl = createInterface({ input: process.stdin, terminal: false })
      rl.on("line", (line) => {
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === "user_message") {
            process.stdout.write(JSON.stringify({ type: "progress", message: `Processing: ${parsed.message}` }) + "\n")
          } else if (parsed.type === "permission_response") {
            process.stdout.write(JSON.stringify({ type: "progress", message: `Permission ${parsed.decision}` }) + "\n")
          }
        } catch {
          // Ignore unparseable stdin lines
        }
      })

      rl.on("close", () => {
        process.stdout.write(
          JSON.stringify({
            type: "result",
            outcome: "success",
            summary: "Task executed cleanly",
            total_cost_usd: 0.01,
            usage: { input_tokens: 150, output_tokens: 50 },
          }) + "\n",
        )
        process.exit(0)
      })
    } else {
      process.stdout.write(
        JSON.stringify({
          type: "result",
          outcome: "success",
          summary: "Task executed cleanly",
          total_cost_usd: 0.01,
          usage: { input_tokens: 150, output_tokens: 50 },
        }) + "\n",
      )
      process.exit(0)
    }
  } else {
    process.stdout.write("Claude Code standard response\n")
    process.exit(0)
  }
}

function runDefaultCodex() {
  const isJson = args.includes("--json")
  if (isJson) {
    process.stdout.write(JSON.stringify({ type: "thread.created", thread_id: "thread-fake-001" }) + "\n")
    process.stdout.write(JSON.stringify({ type: "turn.started", turn_id: "turn-001" }) + "\n")
    process.stdout.write(
      JSON.stringify({
        type: "turn.completed",
        turn_id: "turn-001",
        result: { status: "completed", message: "Codex finished task" },
      }) + "\n",
    )
    process.exit(0)
  } else {
    process.stdout.write("Codex executed cleanly\n")
    process.exit(0)
  }
}
