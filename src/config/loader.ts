import { readFile } from "node:fs/promises"
import { bridgeConfigSchema } from "./schemas.js"
import type { BridgeConfig } from "./types.js"

export const HERDR_BACKEND_DEPRECATION =
  'warning: terminal.backend "herdr" is deprecated and ignored since 3.1.1 (the Herdr backend was removed); ' +
  'remove the "terminal" block or set it to "tmux".\n'

export async function loadConfig(
  path: string,
  warn: (message: string) => void = (message) => {
    process.stderr.write(message)
  },
): Promise<BridgeConfig> {
  const raw = await readFile(path, "utf8")
  const config = bridgeConfigSchema.parse(JSON.parse(raw))
  // Still accepted so a profile written for 3.1.0 or earlier keeps loading.
  if (config.terminal.backend === "herdr") warn(HERDR_BACKEND_DEPRECATION)
  return config
}
