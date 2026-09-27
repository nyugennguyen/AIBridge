import { createTestRenderer } from "@opentui/core/testing"
import { describe, expect, it } from "vitest"
import { createOpenTuiRenderer } from "../../../src/tui/index.js"

describe("OpenTUI renderer boundary", () => {
  it("renders the pure shell view on an OpenTUI headless renderer", async () => {
    const testRenderer = await createTestRenderer({ width: 100, height: 30, useThread: false })
    const renderer = createOpenTuiRenderer(testRenderer.renderer)

    renderer.render("AIBridge — Projects\n[READY] Projects")
    await testRenderer.flush()

    expect(testRenderer.captureCharFrame()).toContain("AIBridge — Projects")
    renderer.destroy()
  })
})
