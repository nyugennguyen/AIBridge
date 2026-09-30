import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import type { NodeId } from "../../orchestration/identifiers.js"
import { parseStoredNodeKey, type KeyStore, type StoredNodeKey } from "./key-store.js"

/**
 * The in-memory key store.
 *
 * Used by tests and by a node whose key material is injected by whatever owns its
 * secrets. It is NOT a mock: it is the same contract with the durability provided
 * by the process, and it is written so a test that passes against it is testing
 * the interface rather than this class.
 *
 * One behaviour is deliberately stricter than the filesystem store's. `save`
 * refuses to overwrite an existing key, and so does the filesystem store — but
 * here the refusal is observable in the same process that would have performed
 * the overwrite, so a test can assert it directly rather than inferring it from a
 * file's mtime.
 */
export class InMemoryKeyStore implements KeyStore {
  readonly #keys = new Map<string, StoredNodeKey>()

  async save(key: StoredNodeKey): Promise<Result<true>> {
    const parsed = parseStoredNodeKey(key)
    if (!parsed.ok) return parsed
    if (this.#keys.has(parsed.value.nodeId)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "identity.key_exists",
          `Node ${parsed.value.nodeId} already has a stored key. Overwriting it in place is refused: a replacement that nobody asked for is indistinguishable from one an attacker arranged, and a rotation is supposed to produce a NEW key id rather than reuse a node's file.`,
        ),
      }
    }
    this.#keys.set(parsed.value.nodeId, parsed.value)
    return { ok: true, value: true }
  }

  async load(nodeId: NodeId): Promise<Result<StoredNodeKey | null>> {
    return { ok: true, value: this.#keys.get(nodeId) ?? null }
  }

  async remove(nodeId: NodeId): Promise<Result<true>> {
    this.#keys.delete(nodeId)
    return { ok: true, value: true }
  }

  /**
   * Replaces a key unconditionally.
   *
   * The one escape from {@link save}'s no-overwrite rule, and it exists for the
   * rotation test: a node that rotates generates a NEW key, and proving the old
   * one no longer loads is the assertion the milestone asks for. It is not on the
   * `KeyStore` interface, so production code cannot reach it by accident.
   */
  forceReplace(key: StoredNodeKey): void {
    const parsed = parseStoredNodeKey(key)
    if (!parsed.ok) throw new Error(parsed.error.message)
    this.#keys.set(parsed.value.nodeId, parsed.value)
  }

  get size(): number {
    return this.#keys.size
  }
}
