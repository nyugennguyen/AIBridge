import { resolve } from "node:path"
import { startBridge } from "./bridge.js"

const configPath = process.env.AIBRIDGE_CONFIG
if (!configPath) throw new Error("AIBRIDGE_CONFIG is required")
const bearerToken = process.env.AIBRIDGE_BEARER_TOKEN
if (!bearerToken) throw new Error("AIBRIDGE_BEARER_TOKEN is required")

const bridge = await startBridge({
  configPath,
  stateDir: resolve(".aibridge"),
  bearerToken,
  environment: process.env as Record<string, string>,
})

await bridge.app.listen({ host: bridge.config.bridge.host, port: bridge.config.bridge.port })
