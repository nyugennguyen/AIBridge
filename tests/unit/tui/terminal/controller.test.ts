import { describe, expect, it } from "vitest"
import { createTerminalViewController } from "../../../../src/tui/terminal/index.js"
import {
  Deferred,
  FakeTerminalBackend,
  ManualScheduler,
  RecordingView,
  clientId,
  decode,
  labels,
  operation,
  otherClientId,
  ownership,
  reference,
  settle,
  text,
} from "./fixtures.js"

describe("embedded terminal view controller", () => {
  it("attaches read-only and serializes output reads in byte order", async () => {
    const backend = new FakeTerminalBackend()
    const view = new RecordingView()
    backend.channel.readChunks.push(text("one"), text("-two"), text("-three"))
    const controller = createTerminalViewController(backend, { operation, view, presentationByteLimit: 64 })

    await expect(controller.attach(reference, labels)).resolves.toEqual({ ok: true, value: undefined })
    expect(controller.getViewModel()).toMatchObject({ mode: "read-only", status: "READ ONLY", output: "one" })
    await Promise.all([controller.refreshOutput(), controller.refreshOutput()])

    expect(controller.getViewModel().output).toBe("one-two-three")
    expect(backend.channel.reads).toEqual([64, 64, 64])
    expect(view.models.at(-1)?.footer).toBe("READ ONLY — i requests input")
  })

  it("bounds the rendered stream and exposes truncation without persisting after detach", async () => {
    const backend = new FakeTerminalBackend()
    backend.channel.readChunks.push(text("1234"), text("5678"))
    const controller = createTerminalViewController(backend, { operation, presentationByteLimit: 6 })

    await controller.attach(reference, labels)
    await controller.refreshOutput()
    expect(controller.getViewModel()).toMatchObject({ output: "[earlier terminal output truncated]\n345678", outputByteCount: 6, outputTruncated: true })

    await controller.detach()
    expect(controller.getViewModel()).toMatchObject({ mode: "detached", output: "", outputByteCount: 0, outputTruncated: false })
    expect(backend.terminateCount).toBe(0)
    expect(backend.detachCalls).toEqual([reference])
  })

  it("consumes exact Ctrl+] locally and never forwards its tail", async () => {
    const backend = new FakeTerminalBackend()
    const controller = createTerminalViewController(backend, { operation })
    await controller.attach(reference, labels)
    await controller.requestInput()

    const sent = await controller.sendInput(Uint8Array.of(0x61, 0x62, 0x1d, 0x63, 0x64))

    expect(sent).toEqual({ ok: true, value: { forwardedBytes: 2, discardedBytes: 3, escapedToCommandMode: true } })
    expect(backend.channel.writes.map(decode)).toEqual(["ab"])
    expect(backend.channel.releaseCount).toBe(1)
    expect(controller.getViewModel()).toMatchObject({ mode: "read-only", status: "READ ONLY" })
    await expect(controller.sendInput(text("tail"))).resolves.toMatchObject({ ok: false, error: { code: "terminal_view.input_not_owned" } })
  })

  it("forwards separately received chunks in their original order", async () => {
    const backend = new FakeTerminalBackend()
    const gate = new Deferred<void>()
    backend.channel.writeGate = gate
    const controller = createTerminalViewController(backend, { operation })
    await controller.attach(reference, labels)
    await controller.requestInput()

    const first = controller.sendInput(text("first"))
    await settle()
    const second = controller.sendInput(text("second"))
    expect(backend.channel.writes.map(decode)).toEqual(["first"])
    gate.resolve()
    await Promise.all([first, second])

    expect(backend.channel.writes.map(decode)).toEqual(["first", "second"])
  })

  it("bounds queued input and revokes ownership instead of buffering without limit", async () => {
    const backend = new FakeTerminalBackend()
    const gate = new Deferred<void>()
    backend.channel.writeGate = gate
    const controller = createTerminalViewController(backend, { operation })
    await controller.attach(reference, labels)
    await controller.requestInput()

    const first = controller.sendInput(new Uint8Array(40 * 1024).fill(0x61))
    await settle()
    await expect(controller.sendInput(new Uint8Array(30 * 1024).fill(0x62))).resolves.toMatchObject({
      ok: false,
      error: { code: "terminal_view.input_queue_full" },
    })
    expect(controller.getViewModel()).toMatchObject({ mode: "read-only" })
    gate.resolve()
    await first
  })

  it("requires a separate explicit, reasoned takeover confirmation", async () => {
    const backend = new FakeTerminalBackend()
    backend.channel.owner = otherClientId
    const controller = createTerminalViewController(backend, { operation })
    await controller.attach(reference, labels)

    await expect(controller.requestInput()).resolves.toMatchObject({ ok: false, error: { code: "terminal.input_owned" } })
    expect(backend.channel.takeoverReasons).toEqual([])
    expect(controller.beginTakeover("terminal-ui-b")).toEqual({ ok: true, value: undefined })
    await expect(controller.confirmTakeover("   ")).resolves.toMatchObject({ ok: false, error: { code: "terminal_view.takeover_reason_required" } })
    expect(backend.channel.takeoverReasons).toEqual([])

    await expect(controller.confirmTakeover("Owner disconnected")).resolves.toEqual({ ok: true, value: undefined })
    expect(backend.channel.takeoverReasons).toEqual(["Owner disconnected"])
    expect(controller.getViewModel()).toMatchObject({ mode: "input-owned", ownerLabel: clientId, takeoverConfirmation: null })
  })

  it("keeps recovery without canonical history permanently inspect-only", async () => {
    const backend = new FakeTerminalBackend()
    backend.channel.owner = otherClientId
    const controller = createTerminalViewController(backend, { operation, mutationAllowed: false })
    await controller.attach(reference, labels)
    await expect(controller.requestInput()).resolves.toMatchObject({ ok: false, error: { code: "terminal_view.recovery_read_only" } })
    expect(controller.beginTakeover("another client")).toMatchObject({ ok: false, error: { code: "terminal_view.recovery_read_only" } })
    await expect(controller.confirmTakeover("attempt bypass")).resolves.toMatchObject({ ok: false, error: { code: "terminal_view.recovery_read_only" } })
    await expect(controller.sendInput(text("attempt bypass"))).resolves.toMatchObject({ ok: false, error: { code: "terminal_view.recovery_read_only" } })
    expect(backend.channel.takeoverReasons).toEqual([])
    expect(backend.channel.writes).toEqual([])
  })

  it("stops forwarding immediately and discards queued bytes on ownership loss", async () => {
    const backend = new FakeTerminalBackend()
    const gate = new Deferred<void>()
    backend.channel.writeGate = gate
    const controller = createTerminalViewController(backend, { operation })
    await controller.attach(reference, labels)
    await controller.requestInput()

    const first = controller.sendInput(text("first"))
    await settle()
    const queued = controller.sendInput(text("queued"))
    controller.observeOwnership(ownership(otherClientId))

    await expect(queued).resolves.toMatchObject({ ok: false, error: { code: "terminal_view.forwarding_stopped" } })
    expect(controller.getViewModel()).toMatchObject({ mode: "read-only", ownerLabel: otherClientId })
    await expect(controller.sendInput(text("late"))).resolves.toMatchObject({ ok: false, error: { code: "terminal_view.input_not_owned" } })
    expect(backend.channel.writes.map(decode)).toEqual(["first"])

    gate.resolve()
    await first
    expect(backend.channel.writes.map(decode)).toEqual(["first"])
  })

  it("coalesces resize bursts and resizes the process only while input-owned", async () => {
    const backend = new FakeTerminalBackend()
    const scheduler = new ManualScheduler()
    const controller = createTerminalViewController(backend, { operation, scheduler })
    await controller.attach(reference, labels)
    const readsAfterAttach = backend.channel.reads.length

    expect(controller.resizeContent({ columns: 90.9, rows: 20.8 })).toBe(true)
    expect(controller.resizeContent({ columns: 100, rows: 30 })).toBe(true)
    expect(scheduler.size).toBe(1)
    scheduler.flush()
    await settle()
    expect(backend.resizeCalls).toEqual([])
    expect(backend.channel.reads.length).toBe(readsAfterAttach + 1)

    await controller.requestInput()
    controller.resizeContent({ columns: 90.9, rows: 20.8 })
    controller.resizeContent({ columns: 2000, rows: 31.9 })
    expect(controller.resizeContent({ columns: Number.NaN, rows: 10 })).toBe(false)
    scheduler.flush()
    await settle()

    expect(backend.resizeCalls).toEqual([{ columns: 1000, rows: 31 }])
  })

  it("detaches safely, discards pending input, and never terminates the session", async () => {
    const backend = new FakeTerminalBackend()
    const gate = new Deferred<void>()
    backend.channel.writeGate = gate
    const controller = createTerminalViewController(backend, { operation })
    await controller.attach(reference, labels)
    await controller.requestInput()
    const first = controller.sendInput(text("started"))
    await settle()
    const queued = controller.sendInput(text("discard-me"))

    const detached = controller.detach()
    await expect(queued).resolves.toMatchObject({ ok: false, error: { code: "terminal_view.forwarding_stopped" } })
    expect(backend.terminateCount).toBe(0)
    expect(backend.channel.writes.map(decode)).toEqual(["started"])
    gate.resolve()
    await first
    await expect(detached).resolves.toEqual({ ok: true, value: undefined })

    expect(backend.detachCalls).toEqual([reference])
    expect(controller.getViewModel().mode).toBe("detached")
    expect(backend.terminateCount).toBe(0)
  })

  it("uses the same discard-and-detach safety on close", async () => {
    const backend = new FakeTerminalBackend()
    const gate = new Deferred<void>()
    backend.channel.writeGate = gate
    const controller = createTerminalViewController(backend, { operation })
    await controller.attach(reference, labels)
    await controller.requestInput()
    const started = controller.sendInput(text("started"))
    await settle()
    const queued = controller.sendInput(text("never-forward"))

    const closed = controller.close()
    await expect(queued).resolves.toMatchObject({ ok: false, error: { code: "terminal_view.forwarding_stopped" } })
    gate.resolve()
    await started
    await closed

    expect(backend.channel.writes.map(decode)).toEqual(["started"])
    expect(backend.detachCalls).toEqual([reference])
    expect(backend.terminateCount).toBe(0)
    expect(controller.getViewModel()).toMatchObject({ mode: "closed", output: "" })
  })
})
