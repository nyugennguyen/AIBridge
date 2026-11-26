/**
 * AIBridge Extension SDK — Registration Registry (M8.7).
 *
 * Invariants:
 * - Registration is explicit.
 * - Startup fails closed for incompatible SDK versions.
 * - Extensions do NOT receive event-store handles, private keys, or raw env.
 */

import {
  assertSdkVersionCompatible,
  type AdapterRegistration,
  type AgentRuntimeAdapter,
} from "./types.js"

export class ExtensionRegistry {
  private readonly adapters = new Map<string, AdapterRegistration>()

  registerAdapter(registration: AdapterRegistration): void {
    assertSdkVersionCompatible(registration.metadata.aibridgeSdkVersion)
    const kind = registration.adapter.kind
    if (this.adapters.has(kind)) {
      throw new Error(`Agent runtime adapter '${kind}' is already registered`)
    }
    this.adapters.set(kind, registration)
  }

  getAdapter(kind: string): AgentRuntimeAdapter | undefined {
    return this.adapters.get(kind)?.adapter
  }

  listAdapters(): readonly AdapterRegistration[] {
    return Array.from(this.adapters.values())
  }

  clear(): void {
    this.adapters.clear()
  }
}
