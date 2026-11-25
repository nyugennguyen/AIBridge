/**
 * The human-copyable pairing code printed by `aibr enroll issue`.
 *
 *   aibr1-<base64url("<worker public_url>\n<one-time secret>\n<worker key id>")>
 *
 * The secret authorises ONE redemption at the worker's `/enroll` endpoint; the
 * key id lets the joining side check that the worker it reached is the worker
 * that printed the code (the response must carry a public key with that id and
 * be signed by it). Only the secret is sensitive, and only until it is used or
 * expires.
 */
import { nodeKeyIdSchema } from "../mesh/protocol/identifiers.js"

export const PAIRING_CODE_PREFIX = "aibr1-"

export interface PairingCode {
  readonly url: string
  readonly secret: string
  readonly keyId: string
}

const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export function encodePairingCode(code: PairingCode): string {
  return PAIRING_CODE_PREFIX + Buffer.from(`${code.url}\n${code.secret}\n${code.keyId}`, "utf8").toString("base64url")
}

export function decodePairingCode(raw: string): { ok: true; value: PairingCode } | { ok: false; error: string } {
  const text = raw.trim()
  const invalid = { ok: false as const, error: "That is not an AIBridge pairing code. Copy the whole code printed by `aibr enroll issue` on the worker." }
  if (!text.startsWith(PAIRING_CODE_PREFIX)) return invalid
  const body = text.slice(PAIRING_CODE_PREFIX.length)
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return invalid
  const parts = Buffer.from(body, "base64url").toString("utf8").split("\n")
  if (parts.length !== 3) return invalid
  const [url, secret, keyId] = parts as [string, string, string]
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return invalid
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return invalid
  if (!SECRET_PATTERN.test(secret) || !nodeKeyIdSchema.safeParse(keyId).success) return invalid
  return { ok: true, value: { url: url.replace(/\/+$/, ""), secret, keyId } }
}

/** `10m`, `1h`, `90s`, or a bare number of minutes. */
export function parseTtl(raw: string): number | null {
  const match = /^(\d+)\s*([smh]?)$/.exec(raw.trim())
  if (match === null) return null
  const value = Number(match[1])
  const unit = match[2] === "s" ? 1_000 : match[2] === "h" ? 3_600_000 : 60_000
  const ms = value * unit
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null
}
