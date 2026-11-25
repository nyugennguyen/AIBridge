import { isAbsolute, relative, resolve } from "node:path"

const SENSITIVE_KEY_PATTERN = /(?:AIBRIDGE_|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|_KEY$|^KEY$)/i

/**
 * Provider credentials the Claude Code CLI needs to authenticate in print mode.
 * Both match SENSITIVE_KEY_PATTERN, so they must be allowlisted explicitly.
 * `CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token`; `ANTHROPIC_API_KEY`
 * is an API key. In `-p` mode the API key wins when both are present, so a
 * worker environment should carry only one of them. Non-secret variables such
 * as HOME and PATH are not matched by the pattern and always pass through.
 */
export const CLAUDE_PROVIDER_ENV_KEYS: readonly string[] = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]

export function sanitizeChildProcessEnv(
  sourceEnv: Record<string, string | undefined>,
  allowedProviderKeys: readonly string[] = [],
): Record<string, string> {
  const allowedSet = new Set(allowedProviderKeys)
  const sanitized: Record<string, string> = {}

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue

    // If explicitly allowed provider key (e.g. ANTHROPIC_API_KEY), pass through
    if (allowedSet.has(key)) {
      sanitized[key] = value
      continue
    }

    // Strip sensitive internal keys
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      continue
    }

    sanitized[key] = value
  }

  return sanitized
}

const COMMON_KEY_PATTERNS = [
  /sk-(?:proj|ant)?[A-Za-z0-9_-]{20,}/g,
  /bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
]

export function redactSecretsFromText(text: string, knownSecrets: string[] = []): string {
  let result = text
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) {
      result = result.replaceAll(secret, "[REDACTED]")
    }
  }
  for (const pattern of COMMON_KEY_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]")
  }
  return result
}

export function isPathContained(targetPath: string, allowedRoot: string): boolean {
  const resolvedTarget = resolve(targetPath)
  const resolvedRoot = resolve(allowedRoot)
  const rel = relative(resolvedRoot, resolvedTarget)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

