import { describe, expect, it } from "vitest"
import { createApp } from "../../../src/server/app.js"
import { bridgeConfigSchema } from "../../../src/config/schemas.js"
import type { BridgeConfig } from "../../../src/config/types.js"
import type { JobManager } from "../../../src/jobs/manager.js"
import type { OpencodeClient } from "../../../src/opencode/types.js"
import type { CallbackReporter } from "../../../src/callback/reporter.js"
import type { TaskGraphSyncer } from "../../../src/tasks/types.js"

function minimalTestConfig(): BridgeConfig {
  return bridgeConfigSchema.parse({
    node_id: "node-test-1",
    agent_id: "agent-test-1",
    listen_host: "127.0.0.1",
    bridge_port: 8787,
    opencode_port: 4096,
    log_level: "info",
    projects: [
      {
        id: "proj-1",
        root: "/tmp",
      },
    ],
  })
}

function minimalApp() {
  const config = minimalTestConfig()
  const fakeJobManager = {} as JobManager
  const fakeOpencodeClient = {
    health: async () => true,
  } as OpencodeClient
  const fakeCallbackReporter = {} as CallbackReporter
  const fakeTaskGraphSyncer = {} as TaskGraphSyncer

  return createApp({
    config,
    jobManager: fakeJobManager,
    opencodeClient: fakeOpencodeClient,
    callbackReporter: fakeCallbackReporter,
    taskGraphSyncer: fakeTaskGraphSyncer,
  })
}

describe("Route boundary: /v1/mesh/terminal and /v1/mesh/events answer 404", () => {
  it("createApp route table answers 404 for /v1/mesh/terminal across HTTP methods and never 101 upgrade", async () => {
    const app = minimalApp()
    const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const

    for (const method of methods) {
      const response = await app.inject({
        method,
        url: "/v1/mesh/terminal",
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
        },
      })

      expect(response.statusCode).toBe(404)
      expect(response.statusCode).not.toBe(101)
      expect(response.headers.upgrade).toBeUndefined()
    }
  })

  it("createApp route table answers 404 for /v1/mesh/events across HTTP methods and never streaming 200", async () => {
    const app = minimalApp()
    const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const

    for (const method of methods) {
      const response = await app.inject({
        method,
        url: "/v1/mesh/events",
        headers: {
          accept: "text/event-stream",
        },
      })

      expect(response.statusCode).toBe(404)
      expect(response.statusCode).not.toBe(200)
      expect(response.headers["content-type"]).not.toContain("text/event-stream")
    }
  })

  it("verifies the route table in src/server/app.ts exposes only documented routes and excludes /v1/mesh/*", () => {
    const app = minimalApp()
    const routes = app.printRoutes()

    expect(routes).not.toContain("/v1/mesh/terminal")
    expect(routes).not.toContain("/v1/mesh/events")
    expect(routes).not.toContain("/v1/mesh")
  })
})
