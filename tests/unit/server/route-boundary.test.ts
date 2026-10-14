import { describe, expect, it } from "vitest"
import { buildTestApp } from "../../integration/fixtures.js"

describe("Route boundary: /v1/mesh/terminal and /v1/mesh/events answer 404", () => {
  it("createApp route table answers 404 for /v1/mesh/terminal across HTTP methods and never 101 upgrade", async () => {
    const { app } = await buildTestApp()
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
    const { app } = await buildTestApp()
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

  it("verifies the route table in src/server/app.ts exposes only documented routes and excludes /v1/mesh/*", async () => {
    const { app } = await buildTestApp()
    const routes = app.printRoutes()

    expect(routes).not.toContain("/v1/mesh/terminal")
    expect(routes).not.toContain("/v1/mesh/events")
    expect(routes).not.toContain("/v1/mesh")
  })
})
