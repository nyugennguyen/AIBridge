/**
 * On-disk layout of a profile's node identity (Phase 3, ADR 0012).
 *
 *   <stateDir>/identity/            0700
 *     self.node-key.json            0600  this node's ed25519 key (FileSystemKeyStore)
 *     peers.json                    0600  pinned peer keys, trust and revocations
 *     enrollment-codes.json         0600  issued one-time pairing codes (hashes only)
 *
 * Every file is written atomically (temp file + rename) under a lock file, because
 * two processes touch them: `aibr enroll …` (CLI) and the running bridge (the
 * `/enroll` endpoint consumes codes and reads pins on every signed request).
 */
import { randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { nodeIdSchema, type NodeId } from "../orchestration/identifiers.js"
import { FileSystemKeyStore } from "../mesh/identity/file-key-store.js"
import { NodeKeyPair } from "../mesh/identity/node-key.js"

/** The mesh id every pairing pin and trust record is scoped to. */
export const PAIRING_MESH_ID = "aibridge-pairing"

/** The key store node id of THIS node's own key (stable across agent-id edits). */
export const SELF_KEY_NODE_ID: NodeId = nodeIdSchema.parse("self")

export function identityDirFor(stateDir: string): string {
  return join(stateDir, "identity")
}

export function peersFileFor(stateDir: string): string {
  return join(identityDirFor(stateDir), "peers.json")
}

export function enrollmentCodesFileFor(stateDir: string): string {
  return join(identityDirFor(stateDir), "enrollment-codes.json")
}

/** Per-peer bearer token written by `aibr enroll join` (0600). */
export function peerBearerTokenPath(secretsDir: string, peerId: string): string {
  return join(secretsDir, "peers", `${peerId}.bearer_token`)
}

/** Agent ids used as pin keys and file names must be opaque wire ids. */
export function isPairableAgentId(value: unknown): value is string {
  return typeof value === "string" && nodeIdSchema.safeParse(value).success
}

// ── node key ────────────────────────────────────────────────────────────

/** This node's key, or `null` when it has none. Throws on an unsafe/corrupt key file. */
export async function loadNodeKey(stateDir: string): Promise<NodeKeyPair | null> {
  const dir = identityDirFor(stateDir)
  try {
    await stat(dir)
  } catch {
    return null
  }
  const loaded = await new FileSystemKeyStore(dir).load(SELF_KEY_NODE_ID)
  if (!loaded.ok) throw new Error(loaded.error.message)
  return loaded.value === null ? null : NodeKeyPair.fromPrivateKeyPem(loaded.value.privateKeyPem)
}

/** This node's key, generated (0600, in a 0700 directory) on first use. */
export async function loadOrCreateNodeKey(stateDir: string, now: () => number = Date.now): Promise<NodeKeyPair> {
  const existing = await loadNodeKey(stateDir)
  if (existing !== null) return existing
  const key = NodeKeyPair.generate()
  const saved = await new FileSystemKeyStore(identityDirFor(stateDir)).save({
    nodeId: SELF_KEY_NODE_ID,
    nodeKeyId: key.keyId,
    publicKey: key.publicKey,
    fingerprint: key.fingerprint,
    privateKeyPem: key.exportPrivateKeyPem(),
    createdAt: now(),
  })
  if (!saved.ok) {
    // Lost a creation race with another process: use the key that won.
    const raced = await loadNodeKey(stateDir)
    if (raced !== null) return raced
    throw new Error(saved.error.message)
  }
  return key
}

// ── JSON files ──────────────────────────────────────────────────────────

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await lstat(dir)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dir} is not a directory`)
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700)
}

export async function readJsonFile(path: string): Promise<unknown | undefined> {
  let raw: string
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`Refusing to read ${path}: it is a symlink`)
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  return JSON.parse(raw) as unknown
}

/** Atomic 0600 write (temp file + rename) into a 0700 directory. */
export async function writePrivateFile(path: string, data: string): Promise<void> {
  const dir = dirname(path)
  await ensurePrivateDir(dir)
  const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 3_000

/**
 * Serialises read-modify-write cycles on `path` across processes with an
 * `O_EXCL` lock file. A lock older than 10 s is a crashed holder and is broken.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`
  await ensurePrivateDir(dirname(path))
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600)
      await handle.close()
      break
    } catch (error) {
      if (!isExists(error)) throw error
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => undefined)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock on ${path}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  try {
    return await fn()
  } finally {
    await unlink(lockPath).catch(() => undefined)
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function isExists(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST"
}
