import { resolve } from "node:path"
import { startBridge } from "./bridge.js"

const configPath = process.env.AIBRIDGE_CONFIG
if (!configPath) throw new Error("AIBRIDGE_CONFIG is required")

// Not required here: the legacy entrypoint serves whatever `security.auth_mode`
// the profile declares, and a profile in `none` mode has no token to read. The
// bearer check itself fails closed when a mode and a missing secret disagree.
const bearerToken = process.env.AIBRIDGE_BEARER_TOKEN ?? null

const bridge = await startBridge({
  configPath,
  stateDir: resolve(".aibridge"),
  bearerToken,
  environment: process.env as Record<string, string>,
})

await bridge.app.listen({ host: bridge.config.bridge.host, port: bridge.config.bridge.port })
