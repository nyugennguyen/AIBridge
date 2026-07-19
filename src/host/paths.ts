import { join, isAbsolute } from "node:path"

// ── Types ──────────────────────────────────────────────────────────────

export interface ProfilePaths {
  readonly configDir: string
  readonly dataDir: string
  readonly secretsDir: string
  readonly stateDir: string
}

// ── Constants ──────────────────────────────────────────────────────────

const MAX_PROFILE_LEN = 64

/** Matches alphanumeric characters and hyphens (not at start/end). */
const PROFILE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

// ── Validation ─────────────────────────────────────────────────────────

/**
 * Validate a profile name for safe use in filesystem paths.
 *
 * Rules:
 * - Non-empty string
 * - 1–64 characters
 * - Alphanumeric and hyphens only
 * - Must not start or end with hyphen
 * - Must not contain `..` (traversal)
 * - Must not contain path separators
 *
 * Returns the validated name unchanged.
 */
export function validateProfileName(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Profile name must be a non-empty string")
  }

  if (name.includes("..")) {
    throw new Error("Profile name must not contain traversal (..)")
  }

  if (name.includes("/") || name.includes("\\")) {
    throw new Error("Profile name contains invalid characters")
  }

  if (name.length > MAX_PROFILE_LEN) {
    throw new Error(`Profile name must be at most ${MAX_PROFILE_LEN} characters`)
  }

  if (!PROFILE_RE.test(name)) {
    throw new Error(
      "Profile name contains invalid characters: use alphanumeric and hyphens only",
    )
  }

  return name
}

// ── Path resolution ────────────────────────────────────────────────────

/**
 * Resolve XDG-compliant profile directories for AIBridge.
 *
 * Lookup order (per XDG Base Directory spec):
 * - Config:  `$XDG_CONFIG_HOME/aibridge/<profile>` → `$HOME/.config/aibridge/<profile>`
 * - Data:    `$XDG_DATA_HOME/aibridge/<profile>`   → `$HOME/.local/share/aibridge/<profile>`
 * - Secrets: `<data>/secrets`
 * - State:   `$XDG_STATE_HOME/aibridge/<profile>`  → `$HOME/.local/state/aibridge/<profile>`
 *
 * @param profile - Validated profile name (validated internally).
 * @param env - Environment variables to read from. Defaults to `process.env`.
 *              Pass a custom object for deterministic testing.
 */
export function resolveProfilePaths(
  profile: string,
  env?: Record<string, string | undefined>,
): ProfilePaths {
  const validated = validateProfileName(profile)
  const e = env ?? process.env

  const home = e.HOME

  // At least one base directory must be resolvable.
  if (
    !home &&
    !e.XDG_CONFIG_HOME &&
    !e.XDG_DATA_HOME &&
    !e.XDG_STATE_HOME
  ) {
    throw new Error(
      "HOME environment variable is required when no XDG overrides are set",
    )
  }

  const configBase = e.XDG_CONFIG_HOME ?? join(home!, ".config")
  const dataBase = e.XDG_DATA_HOME ?? join(home!, ".local", "share")
  const stateBase = e.XDG_STATE_HOME ?? join(home!, ".local", "state")

  const paths: ProfilePaths = Object.freeze({
    configDir: join(configBase, "aibridge", validated),
    dataDir: join(dataBase, "aibridge", validated),
    secretsDir: join(dataBase, "aibridge", validated, "secrets"),
    stateDir: join(stateBase, "aibridge", validated),
  })

  // Safety: ensure no resolved path is relative (never depend on CWD).
  for (const [key, dir] of Object.entries(paths)) {
    if (!isAbsolute(dir)) {
      throw new Error(`Resolved ${key} is not absolute: ${dir}`)
    }
  }

  return paths
}
