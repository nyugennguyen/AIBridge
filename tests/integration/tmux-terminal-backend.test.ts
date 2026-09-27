import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BunProcessRunner } from "../../src/host/runtime.js"
import type { Result } from "../../src/orchestration/errors.js"
import {
  commandIdSchema,
  correlationIdSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  sessionIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
} from "../../src/orchestration/identifiers.js"
import type { TerminalOperationContext } from "../../src/terminal/schemas.js"
import { TmuxTerminalBackend, type TerminalAuthorizer } from "../../src/terminal/tmux-terminal-backend.js"

const enabled = process.env.AIBRIDGE_TMUX_INTEGRATION === "1"
const probeRunner = new BunProcessRunner()
const available = enabled && (await probeRunner.exec(["tmux", "-V"])).exitCode === 0

const authorizer: TerminalAuthorizer = {
  async authorize(): Promise<Result<void>> {
    return { ok: true, value: undefined }
  },
}

function operation(): TerminalOperationContext {
  return {
    schemaVersion: 1,
    commandId: commandIdSchema.parse("tmux-integration-command"),
    correlationId: correlationIdSchema.parse("tmux-integration-correlation"),
    projectId: projectIdSchema.parse("tmux-integration-project"),
    nodeId: nodeIdSchema.parse("tmux-integration-node"),
    clientId: terminalClientIdSchema.parse("tmux-integration-client"),
  }
}

describe.skipIf(!available)("TmuxTerminalBackend local integration", () => {
  it("creates, writes, snapshots, detaches, recovers, and terminates a real tmux session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-tmux-integration-"))
    const runner = new BunProcessRunner()
    const backend = new TmuxTerminalBackend({ processRunner: runner, authorizer, recoveryDirectory: directory })
    const context = operation()
    const control = {
      ...context,
      controllerAuthority: {
        controllerNodeId: context.nodeId,
        controllerEpoch: 1,
        leaseId: leaseIdSchema.parse("tmux-integration-lease"),
      },
    }
    const created = await backend.create({
      schemaVersion: 1,
      operation: control,
      terminalId: terminalIdSchema.parse(`tmux-integration-${process.pid}`),
      sessionId: sessionIdSchema.parse("tmux-integration-session"),
      backendKind: "tmux",
      columns: 80,
      rows: 24,
      bufferByteLimit: 4096,
    })
    if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`)

    let terminated = false
    try {
      const attached = await backend.attach(created.value, context)
      expect(attached.ok).toBe(true)
      if (!attached.ok) return
      expect(await attached.value.requestInputOwnership(context)).toMatchObject({ ok: true })
      expect(await attached.value.write(new TextEncoder().encode("printf 'aibr-tmux-smoke\\n'\n"))).toEqual({ ok: true, value: undefined })

      let output = ""
      for (let attempt = 0; attempt < 20 && !output.includes("aibr-tmux-smoke"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        const snapshot = await backend.snapshot(created.value, context)
        if (snapshot.ok) output = new TextDecoder().decode(snapshot.value.data)
      }
      expect(output).toContain("aibr-tmux-smoke")
      expect(await backend.detach(created.value, context)).toEqual({ ok: true, value: undefined })

      const restarted = new TmuxTerminalBackend({ processRunner: runner, authorizer, recoveryDirectory: directory })
      expect(await restarted.recover(context)).toEqual({ ok: true, value: [created.value] })
      expect(await restarted.terminate(created.value, control)).toEqual({ ok: true, value: undefined })
      terminated = true
    } finally {
      if (!terminated) await backend.terminate(created.value, control)
    }
  }, 15_000)
})
