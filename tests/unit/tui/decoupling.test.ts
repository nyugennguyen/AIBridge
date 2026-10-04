import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createApp } from "../../../src/server/app.js"
import { bridgeConfigSchema } from "../../../src/config/schemas.js"
import type { BridgeConfig } from "../../../src/config/types.js"
import type { JobManager } from "../../../src/jobs/manager.js"
import type { OpencodeClient } from "../../../src/opencode/types.js"
import type { CallbackReporter } from "../../../src/callback/reporter.js"
import type { TaskGraphSyncer } from "../../../src/tasks/types.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const TUI_DIRECTORY = join(REPOSITORY_ROOT, "src/tui")

function sourceFiles(directory: string): readonly { path: string; text: string }[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const path = join(entry.parentPath ?? directory, entry.name)
      return { path, text: readFileSync(path, "utf8") }
    })
}

function importsOf(text: string): readonly string[] {
  return [
    ...text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm),
    ...text.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
    ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]!)
}

function relativeToSource(path: string): string {
  return path.replace(`${REPOSITORY_ROOT}/`, "")
}
function minimalTestConfig(): BridgeConfig {
  return bridgeConfigSchema.parse({
    agent_id: "test-vps",
    bridge: { host: "0.0.0.0", port: 8787, public_url: "http://test-vps.tailnet:8787", ingress_mode: "engine" },
    opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096, username: "opencode", password_env: "OPENCODE_SERVER_PASSWORD" },
    security: {
      auth_mode: "bearer-token",
      allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["testing"], requires_plan_approval: ["deployment"] }],
    },
    permissions: { default_response: "reject", allow_tools: ["read"], require_plan_approval_for_tools: ["bash"] },
    projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["testing"] }],
    agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787", capabilities: ["development"] }],
    timeouts: { default_job_seconds: 60, callback_retry_attempts: 1 },
    planning: { plan_annotator_enabled: true, require_approval_for: ["deployment"] },
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
    bearerToken: "test-token",
    jobManager: fakeJobManager,
    opencodeClient: fakeOpencodeClient,
    callbackReporter: fakeCallbackReporter,
    monitorSession: async () => undefined,
    taskGraphSyncer: fakeTaskGraphSyncer,
  })
}

describe("M7.13 TUI decoupling assertions", () => {
  describe("Source-scan: TUI decoupling from job engine and ingress queue (SF-11)", () => {
    it("scans all TypeScript source files under src/tui/**", () => {
      const files = sourceFiles(TUI_DIRECTORY)
      expect(files.length).toBeGreaterThan(0)
    })

    it("forbids import edges from src/tui/** to src/jobs/ or relative jobs modules", () => {
      const files = sourceFiles(TUI_DIRECTORY)
      const violations: string[] = []

      for (const file of files) {
        const specifiers = importsOf(file.text)
        for (const specifier of specifiers) {
          if (
            specifier.includes("/jobs/") ||
            specifier.endsWith("/jobs.js") ||
            specifier.endsWith("/jobs.ts") ||
            specifier.startsWith("jobs/")
          ) {
            violations.push(`${relativeToSource(file.path)} imports ${specifier}`)
          }
        }
      }

      expect(violations).toEqual([])
    })

    it("forbids import edges from src/tui/** to ingress queue / outbox modules (src/ingress/, ingress_outbox)", () => {
      const files = sourceFiles(TUI_DIRECTORY)
      const violations: string[] = []

      for (const file of files) {
        const specifiers = importsOf(file.text)
        for (const specifier of specifiers) {
          if (
            specifier.includes("/ingress/") ||
            specifier.includes("ingress_outbox") ||
            specifier.includes("outbox") ||
            specifier.endsWith("/ingress.js") ||
            specifier.endsWith("/ingress.ts") ||
            specifier.startsWith("ingress/")
          ) {
            violations.push(`${relativeToSource(file.path)} imports ${specifier}`)
          }
        }
      }

      expect(violations).toEqual([])
    })
  })

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
})
