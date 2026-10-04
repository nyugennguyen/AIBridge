/**
 * M7.4: `bridge.ingress_mode` must be a decision, not a declaration.
 *
 * The flag existed in the schema and was read by nothing, which made the
 * rollback story in the plan ("rollback is deleting one key") untested: setting
 * `ingress_mode: "router"` changed no behaviour anywhere in the process.
 *
 * The behaviour it selects is shadow mirroring. Declaring the router as the
 * ingress owner without mirroring what the engine admits is how a cutover ships
 * with no divergence record — the one measurement M7.4 exists to produce.
 */

import { describe, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startBridge } from "../../../src/bridge.js"
import { testConfig } from "../../integration/fixtures.js"
import type { BridgeConfig } from "../../../src/config/types.js"

async function bridgeFor(config: BridgeConfig, options?: { shadowMode?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "aibr-ingress-mode-"))
  const configPath = join(dir, "config.json")
  await writeFile(configPath, JSON.stringify(config), "utf8")
  const stateDir = join(dir, "state")
  await mkdir(stateDir, { recursive: true })

  const bridge = await startBridge({
    configPath,
    stateDir,
    bearerToken: "secret",
    environment: { OPENCODE_SERVER_PASSWORD: "test-pass" },
    ...(options?.shadowMode !== undefined ? { shadowMode: options.shadowMode } : {}),
  })
  await bridge.app.close()
  return bridge
}

describe("bridge.ingress_mode", () => {
  it('defaults to "engine" for a config that omits it', async () => {
    const config = testConfig()
    delete (config.bridge as { ingress_mode?: string }).ingress_mode

    const bridge = await bridgeFor(config)
    expect(bridge.ingressMode).toBe("engine")
  })

  it("does not mirror ingress while the engine owns the socket", async () => {
    const bridge = await bridgeFor(testConfig())
    expect(bridge.ingressMode).toBe("engine")
    expect(bridge.shadowMirror).toBeUndefined()
  })

  it("mirrors ingress as soon as the router is declared the owner", async () => {
    const config = testConfig()
    config.bridge.ingress_mode = "router"

    const bridge = await bridgeFor(config)
    expect(bridge.ingressMode).toBe("router")
    expect(bridge.shadowMirror).toBeDefined()
  })

  it("still mirrors under ingress_mode=engine when --shadow-mode asks for it", async () => {
    const bridge = await bridgeFor(testConfig(), { shadowMode: true })
    expect(bridge.ingressMode).toBe("engine")
    expect(bridge.shadowMirror).toBeDefined()
  })
})
