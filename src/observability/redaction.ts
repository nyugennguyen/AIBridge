/**
 * Telemetry and structured logging redaction engine (M8.3).
 *
 * Excludes:
 * - Credentials, bearer tokens, passwords, private keys
 * - Prompts, terminal content, raw memory payloads
 * - Environment secrets and private paths
 */

const SENSITIVE_KEY_REGEX =
  /(?:authorization|bearer|token|secret|password|private_key|api_key|cert|key|cookie)/i

const CONTENT_KEY_REGEX =
  /(?:prompt|terminal_content|memory_payload|payload_json|raw_output|transcript|env_values)/i
const SENSITIVE_VALUE_REGEXES: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /tailscale-[a-z0-9]+/gi,
  /(?:key|token|secret|pass(?:word)?)[=:]\s*["']?([^\s"',;]+)/gi,
]

export interface RedactionOptions {
  readonly customSecrets?: readonly string[]
  readonly projectRoot?: string
}

export function redactString(
  input: string,
  options?: RedactionOptions,
): string {
  let result = input

  // 1. Redact explicit custom secrets (e.g. canary tokens)
  if (options?.customSecrets) {
    for (const secret of options.customSecrets) {
      if (secret && secret.length >= 4) {
        result = result.replaceAll(secret, "[REDACTED_CANARY_SECRET]")
      }
    }
  }

  // 2. Redact authorization headers & tokens
  for (const regex of SENSITIVE_VALUE_REGEXES) {
    result = result.replace(regex, "[REDACTED_SECRET]")
  }

  // 3. Redact private home directory paths if outside project root
  if (options?.projectRoot) {
    result = result.replaceAll(options.projectRoot, "[PROJECT_ROOT]")
  }
  result = result.replace(/\/Users\/[A-Za-z0-9_.-]+/g, "/Users/[REDACTED_USER]")
  result = result.replace(/\/home\/[A-Za-z0-9_.-]+/g, "/home/[REDACTED_USER]")

  return result
}

export function redactValue(
  value: unknown,
  keyName = "",
  options?: RedactionOptions,
): unknown {
  if (value === null || value === undefined) {
    return value
  }

  // Check key name
  if (SENSITIVE_KEY_REGEX.test(keyName)) {
    return "[REDACTED_SECRET]"
  }
  if (CONTENT_KEY_REGEX.test(keyName)) {
    return "[REDACTED_CONTENT]"
  }

  if (typeof value === "string") {
    return redactString(value, options)
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, keyName, options))
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const cleaned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(record)) {
      cleaned[k] = redactValue(v, k, options)
    }
    return cleaned
  }

  return value
}

export function redactLogAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
  options?: RedactionOptions,
): Record<string, unknown> | undefined {
  if (!attributes) return undefined
  return redactValue(attributes, "", options) as Record<string, unknown>
}
