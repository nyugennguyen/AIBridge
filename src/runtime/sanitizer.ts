import { isAbsolute, relative, resolve } from "node:path"

const SENSITIVE_KEY_PATTERN = /(?:AIBRIDGE_|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|_KEY$|^KEY$)/i

export function sanitizeChildProcessEnv(
  sourceEnv: Record<string, string | undefined>,
  allowedProviderKeys: string[] = [],
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

