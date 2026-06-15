import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../app.js"

export function registerHealthRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  app.get("/health", async () => ({ ok: true, opencode: await dependencies.opencodeClient.health() }))
}
