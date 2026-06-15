import { readFile } from "node:fs/promises"
import { bridgeConfigSchema } from "./schemas.js"
import type { BridgeConfig } from "./types.js"

export async function loadConfig(path: string): Promise<BridgeConfig> {
  const raw = await readFile(path, "utf8")
  return bridgeConfigSchema.parse(JSON.parse(raw))
}
