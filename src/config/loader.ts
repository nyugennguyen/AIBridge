import { readFile } from "node:fs/promises"
import { bridgeConfigSchema } from "./schemas.js"
import type { BridgeConfig } from "./types.js"

export const TERMINAL_KEY_IGNORED =
  'warning: "terminal" is no longer a config key and is ignored (removed in 3.2.0); delete it from the profile.\n'

export async function loadConfig(
  path: string,
  warn: (message: string) => void = (message) => {
    process.stderr.write(message)
  },
): Promise<BridgeConfig> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"))
  const config = bridgeConfigSchema.parse(raw)
  // The schema is not strict, so a profile written for 3.1.x keeps loading.
  // Drop this warning in 3.3.0.
  if (typeof raw === "object" && raw !== null && "terminal" in raw) warn(TERMINAL_KEY_IGNORED)
  return config
}
