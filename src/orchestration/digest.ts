import { createHash } from "node:crypto"
import { digestSchema, type Digest } from "./identifiers.js"
import { dispatchEnvelopeSchema } from "./schemas.js"

function encodeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null"

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value)
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode non-finite numbers")
      return JSON.stringify(value)
    case "object": {
      if (ancestors.has(value)) throw new TypeError("Canonical JSON cannot encode cyclic values")
      ancestors.add(value)
      try {
        if (Array.isArray(value)) {
          const encoded: string[] = []
          for (let index = 0; index < value.length; index += 1) {
            if (!(index in value)) throw new TypeError("Canonical JSON cannot encode sparse arrays")
            encoded.push(encodeCanonical(value[index], ancestors))
          }
          return `[${encoded.join(",")}]`
        }

        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError("Canonical JSON only accepts plain objects")
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new TypeError("Canonical JSON cannot encode symbol keys")
        }

        const record = value as Record<string, unknown>
        const keys = Object.keys(record).sort()
        const encoded = keys.map((key) => `${JSON.stringify(key)}:${encodeCanonical(record[key], ancestors)}`)
        return `{${encoded.join(",")}}`
      } finally {
        ancestors.delete(value)
      }
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError(`Canonical JSON cannot encode ${typeof value}`)
  }

  throw new TypeError("Canonical JSON received an unsupported value")
}

export function canonicalJson(value: unknown): string {
  return encodeCanonical(value, new Set())
}

export function digestJson(value: unknown): Digest {
  const hex = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")
  return digestSchema.parse(`sha256:${hex}`)
}

export function digestDispatchEnvelope(envelope: unknown): Digest {
  return digestJson(dispatchEnvelopeSchema.parse(envelope))
}
