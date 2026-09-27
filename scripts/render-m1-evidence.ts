import { createTerminalViewController, createTuiShell } from "../src/tui/index.js"
import {
  M1Harness,
  ScriptedRenderer,
  correlationId,
  primaryClientId,
  text,
  userId,
  waitForShell,
} from "../tests/integration/fixtures/m1/harness.js"

const harness = new M1Harness()
const renderer = new ScriptedRenderer({ columns: 80, rows: 24 })
const shell = createTuiShell({
  service: harness.service,
  correlationId,
  operationId: () => harness.operationId(),
  userId,
  rendererFactory: { create: async () => renderer },
  terminalClientId: primaryClientId,
  terminalConnector: {
    open: async (run, view) => {
      const reference = harness.terminal.reference
      if (!reference || reference.terminalId !== run.session?.terminalId) {
        return { ok: false as const, error: { schemaVersion: 1 as const, category: "conflict" as const, code: "evidence.terminal_missing", message: "Terminal missing.", retryable: false, correlationId } }
      }
      const controller = createTerminalViewController(harness.terminal, {
        operation: () => harness.terminalOperation(primaryClientId),
        view,
      })
      const attached = await controller.attach(reference, { terminal: "Fixture terminal", session: "Fixture OpenCode session", project: "M1 fixture project" })
      return attached.ok ? { ok: true as const, value: controller } : attached
    },
    openRecovery: async () => ({ ok: false as const, error: { schemaVersion: 1 as const, category: "unsupported_capability" as const, code: "evidence.recovery_unused", message: "Not used by evidence renderer.", retryable: false, correlationId } }),
  },
})

const completion = shell.run("evidence")
const frames: Array<{ title: string; content: string }> = []
const capture = (title: string): void => { frames.push({ title, content: renderer.renders.at(-1) ?? "" }) }

await waitForShell(harness.service, () => shell.getState().shell === "ready" && shell.getState().projects.length === 1)
capture("1. Authorized project")
renderer.key("n")
await waitForShell(harness.service, () => shell.getState().screen === "draft" && shell.getState().pending === null)
renderer.type("Prove the approved flow")
renderer.key("tab"); renderer.type("One deterministic task")
renderer.key("tab"); renderer.type("Exercise the integrated M1 boundaries")
renderer.key("tab"); renderer.type("Inspect, interact, and report verified completion")
renderer.key("tab"); renderer.type("fixture-model")
renderer.key("tab")
for (let index = 0; index < 4; index += 1) renderer.key("backspace")
renderer.type("900")
capture("2. One-task draft")
renderer.key("escape"); renderer.key("enter")
await waitForShell(harness.service, () => shell.getState().screen === "proposal" && shell.getState().pending === null)
capture("3. Immutable proposal")
renderer.key("a")
capture("4. Exact approval guard")
renderer.key("tab"); renderer.key("enter")
await waitForShell(harness.service, () => shell.getState().run?.session?.state === "starting" && shell.getState().pending === null)
harness.runtime.queueLifecycle("working")
renderer.key("f")
await waitForShell(harness.service, () => shell.getState().run?.session?.state === "working")
capture("5. Working session")
harness.terminal.output.push(text("agent> working\n"))
renderer.key("t")
await waitForShell(harness.service, () => shell.getState().screen === "terminal" && shell.getState().pending === null)
capture("6. Read-only terminal")
shell.close()
await completion

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")

const panelWidth = 760
const panelHeight = 390
const gap = 24
const width = panelWidth * 2 + gap * 3
const height = panelHeight * 3 + gap * 4
const panels = frames.map((frame, index) => {
  const column = index % 2
  const row = Math.floor(index / 2)
  const x = gap + column * (panelWidth + gap)
  const y = gap + row * (panelHeight + gap)
  const lines = frame.content.split("\n").slice(0, 24)
  const textLines = lines.map((line, lineIndex) => `<text x="${x + 18}" y="${y + 58 + lineIndex * 13}" class="terminal">${escapeXml(line.slice(0, 100))}</text>`).join("\n")
  return `<g><rect x="${x}" y="${y}" width="${panelWidth}" height="${panelHeight}" rx="12" class="panel"/><text x="${x + 18}" y="${y + 30}" class="title">${escapeXml(frame.title)}</text>${textLines}</g>`
}).join("\n")

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>
  .background { fill: #0b1020; }
  .panel { fill: #111827; stroke: #334155; stroke-width: 2; }
  .title { fill: #7dd3fc; font: 700 17px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .terminal { fill: #e5e7eb; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
</style>
<rect width="100%" height="100%" class="background"/>
${panels}
</svg>\n`

await Bun.write("Docs/implementation-reports/milestone-1-core-states.svg", svg)
console.log(`wrote ${frames.length} verified frames`)
