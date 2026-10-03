// SPIKE CODE -- NOT PRODUCTION. Throwaway measurement artefact for M7.1.
//
// Topology A entrypoint: "today", unchanged. It calls the production
// startBridge() from src/bridge.ts verbatim, listens with Fastify on the
// configured address, and runs the shared spike load loop.
//
// The point of calling startBridge() rather than reconstructing it is that
// topology A must be the shipping composition: if this spike hand-rolled the
// engine, the A-vs-B difference would partly be the difference between two
// hand-rolled things.

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { startBridge } from "../src/bridge.js"
import { startLoadLoop } from "./load-loop.js"

const configPath = process.env.AIBRIDGE_CONFIG
if (!configPath) throw new Error("AIBRIDGE_CONFIG is required")
const bearerToken = process.env.AIBRIDGE_BEARER_TOKEN
if (!bearerToken) throw new Error("AIBRIDGE_BEARER_TOKEN is required")

const bridge = await startBridge({
  configPath,
  stateDir: resolve(process.env.SPIKE_STATE_DIR ?? ".aibridge"),
  bearerToken,
  environment: process.env as Record<string, string>,
})

await bridge.app.listen({ host: bridge.config.bridge.host, port: bridge.config.bridge.port })

const profile = JSON.parse(
  await readFile(process.env.SPIKE_LOAD_PROFILE ?? "spike/load-profile.json", "utf8"),
)
await startLoadLoop({
  inProcessRatePerSecond: profile.inProcessRatePerSecond,
  payload: profile.payload,
  stateDir: process.env.SPIKE_STATE_DIR ?? ".aibridge",
})

process.stdout.write(`spike topology A ready: fastify listening on ${bridge.config.bridge.host}:${bridge.config.bridge.port}\n`)