/**
 * Which port `aibr _opencode` should start opencode on.
 *
 * ## Why this is a function and not a line in the CLI
 *
 * `aibr start` reads `opencode.server_port` from the profile config and passes it
 * to the supervisor, but the hidden `_opencode` command -- the process that
 * actually launches the server inside that session -- read only `OPENCODE_PORT`
 * and otherwise hardcoded `4096`. A profile configured for any other port was
 * silently ignored: the server came up on 4096, the bridge on its configured port
 * dialed `opencode.base_url`, and the only symptom was a bare
 * `Error: opencode2 serve failed` naming neither the port nor the conflict.
 *
 * The two callers disagreed, so the value is resolved once, here, and both read it.
 */
/** The port assumed when neither the environment nor the profile names one. */
export const DEFAULT_OPENCODE_PORT = "4096"

export function resolveOpencodePort(
  config: { readonly opencode?: { readonly server_port?: unknown } } | null | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  // The env var wins: it is how an operator overrides a profile for one run
  // without editing the file, and it is what the supervisor already honours.
  const fromEnv = env.OPENCODE_PORT
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv

  const fromConfig = config?.opencode?.server_port
  if (typeof fromConfig === "number" && Number.isInteger(fromConfig) && fromConfig > 0) {
    return String(fromConfig)
  }

  return DEFAULT_OPENCODE_PORT
}