import { chmod, link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { nodeIdSchema, type NodeId } from "../../orchestration/identifiers.js"
import {
  FOREIGN_READABLE_BITS,
  parseStoredNodeKey,
  PRIVATE_KEY_DIR_MODE,
  PRIVATE_KEY_FILE_MODE,
  serializeStoredNodeKey,
  type KeyStore,
  type StoredNodeKey,
} from "./key-store.js"

/**
 * The filesystem key store.
 *
 * THIS MODULE IS ALLOWED TO TOUCH THE FILESYSTEM. It is one of exactly two places
 * in `src/mesh/identity/` that is (the other is the Fastify adapter), because the
 * policy that decides everything else here — fail closed, no clock reads, no
 * ambient state — is only testable when the I/O is separated from the decisions.
 *
 * The store exists to make ONE guarantee that a `Map` cannot: that a private key
 * on disk is unreadable to anyone but its owner. Everything below serves that.
 *
 *   - The file is created `0600` and the directory `0700`, and BOTH are verified
 *     after creation rather than assumed from the mode argument, because the mode
 *     argument is applied through the process umask on some paths and silently
 *     widened on an existing file on others. The directory is verified on the READ
 *     path too, because a loose directory lets a local user replace a `0600` file
 *     with a `0600` file of their own.
 *   - A READ verifies the mode first and refuses anything with a group- or
 *     world-readable bit, in either direction. A private key that another local
 *     account can read has already lost the property it exists for, and a store
 *     that merely warns is the difference between a local compromise and a mesh
 *     compromise: with a `0600`-assumed reader, every other user account on the
 *     box becomes a mesh credential.
 *   - Writes are temp-file + hard `link`, so a crash mid-write cannot leave a
 *     truncated PEM that a later read would report as a corrupt key rather than a
 *     missing one, and — the reason it is `link` and not `rename` — a second `save`
 *     for a live node is refused rather than silently swapping its private key.
 *   - The path is checked for traversal and for symlinks. A key path built from a
 *     `nodeId` is still a path, and `nodeId` arrives from the wire at the moment a
 *     node is enrolled.
 */

const KEY_FILE_SUFFIX = ".node-key.json"

export class FileSystemKeyStore implements KeyStore {
  readonly #directory: string

  constructor(directory: string) {
    this.#directory = directory
  }

  async save(key: StoredNodeKey): Promise<Result<true>> {
    const nodeId = nodeIdSchema.safeParse(key.nodeId)
    if (!nodeId.success) {
      return {
        ok: false,
        error: createContractError("validation", "identity.key_node_id_invalid", "A private key cannot be stored under a node id that is not a wire id."),
      }
    }
    const target = this.#pathFor(nodeId.data)
    if (target === null) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "identity.key_path_refused",
          "Refusing to write a private key to a path containing a traversal segment. The node id is wire-supplied, so the path is attacker-influenced at exactly the moment a key is being created.",
        ),
      }
    }

    const directoryOk = await ensurePrivateDirectory(this.#directory)
    if (!directoryOk.ok) return directoryOk

    // `wx` is a claim about the TEMPORARY, which nobody else cares about, so it is
    // not the no-overwrite guarantee. The guarantee comes from the `link` below.
    // The temporary name is random so two concurrent writers to DIFFERENT nodes cannot
    // collide on it. `randomBytes` and not `Math.random`: the name is guessable, and a
    // guessable name in a directory the store has just verified is private is the only
    // thing standing between two writers and each other's key material. The randomness
    // is the reason this module — one of the two permitted to touch the outside world —
    // does not read a clock.
    const temporary = join(this.#directory, `.tmp-key-${randomBytes(8).toString("hex")}`)
    try {
      await writeFile(temporary, serializeStoredNodeKey(key), { mode: PRIVATE_KEY_FILE_MODE, flag: "wx" })
      const mode = await modeOf(temporary)
      if (mode === null || (mode & FOREIGN_READABLE_BITS) !== 0) {
        await unlink(temporary).catch(() => undefined)
        return refuseLooseFile(temporary, mode)
      }
      await chmod(temporary, PRIVATE_KEY_FILE_MODE)

      // `link`, NOT `rename`. This is the whole of the no-overwrite guarantee and it
      // is why the write is not a `rename`: `rename` replaces an existing target
      // SILENTLY, so a second `save` for a live node would quietly swap its private
      // key — the exact outcome the `InMemoryKeyStore` refuses in the same process
      // where a test can see it, and the one this store used to perform on disk where
      // nothing noticed. `link` fails with `EEXIST` instead, and the failure is atomic
      // rather than a `stat` that a concurrent writer can invalidate between the check
      // and the write. A hard link also keeps the inode the mode was just verified on,
      // where `rename` would move that verified inode into a name that another process
      // may already have replaced.
      await link(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      if (isAlreadyExists(error)) {
        // Same refusal the in-memory store makes, and for the same reason: a
        // replacement nobody asked for is indistinguishable from one an attacker
        // arranged. The honest remedy is to remove the node, not to overwrite its key.
        return {
          ok: false,
          error: createContractError(
            "conflict",
            "identity.key_exists",
            `Node ${key.nodeId} already has a stored private key. Overwriting it in place is refused: a replacement that nobody asked for is indistinguishable from one an attacker arranged, and a rotation is supposed to produce a NEW key id rather than reuse a node's key file.`,
          ),
        }
      }
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "identity.key_write_failed",
          `The node private key could not be written (${describeError(error)}). The message deliberately excludes the key material.`,
        ),
      }
    }
    // The link succeeded, so the key is durable under its real name. The temporary is
    // a second name for the same inode and keeping it would leave two files holding
    // private key material, one of which no later read path knows to clean up. A
    // failure HERE is deliberately swallowed: the key is already stored, and reporting
    // a write failure would invite the caller to retry into the `EEXIST` above.
    await unlink(temporary).catch(() => undefined)
    return { ok: true, value: true }
  }

  async load(nodeId: NodeId): Promise<Result<StoredNodeKey | null>> {
    const target = this.#pathFor(nodeId)
    if (target === null) {
      return {
        ok: false,
        error: createContractError("validation", "identity.key_path_refused", "Refusing to read a private key from a path containing a traversal segment."),
      }
    }
    // The DIRECTORY is checked on the way in, not only on the way out. `save` already
    // refuses to write into a group- or world-accessible directory, and the reason it
    // gives is that a `0600` file inside a `0777` directory is still unlinkable and
    // replaceable by any local user. That reasoning applies just as much to a READ: if
    // the directory is loose, another user can have unlinked the verified file and put
    // their own `0600` key in its place, and every check below would then be a check of
    // THEIR file. Checking the file but not the directory is the shape of a defence
    // that has been defeated by the one thing it did not look at.
    const directoryMode = await modeOf(this.#directory)
    if (directoryMode === null) {
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "identity.key_directory_missing",
          "The node key directory does not exist, so a private key cannot be read from it.",
        ),
      }
    }
    if ((directoryMode & FOREIGN_READABLE_BITS) !== 0) {
      return refuseReadableDirectory(this.#directory, directoryMode)
    }
    let stats
    try {
      stats = await lstat(target)
    } catch (error) {
      if (isMissing(error)) return { ok: true, value: null }
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "identity.key_read_failed",
          `The node private key could not be inspected (${describeError(error)}).`,
        ),
      }
    }
    // Checked BEFORE the read, and via `lstat`, so a symlink pointing at a
    // world-readable file is refused rather than followed. Following it would make
    // the mode check below a check of the wrong inode.
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "identity.key_is_symlink",
          "The node private key path is a symlink. Refusing to read it: a symlink here can point at a readable copy of the key, and the permission check below would then be checking a different file than the one being read.",
        ),
      }
    }
    if (!stats.isFile()) {
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "identity.key_not_a_file",
          "The node private key path is not a regular file.",
        ),
      }
    }
    const mode = stats.mode & 0o777
    if ((mode & FOREIGN_READABLE_BITS) !== 0) {
      // FAIL CLOSED. This is the single most important line in the file. A
      // group- or world-readable private key has already been read by whoever the
      // mode exposed it to, and continuing would convert a local permissions
      // mistake into a mesh-wide credential.
      return refuseLooseFile(target, mode)
    }
    let raw: string
    try {
      raw = await readFile(target, "utf8")
    } catch (error) {
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "identity.key_read_failed",
          `The node private key could not be read (${describeError(error)}).`,
        ),
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "identity.key_record_unparseable",
          "The node private key file is not valid JSON. It is refused rather than repaired: a key file this store did not write, or one truncated by a crash mid-write, is not something to guess at.",
        ),
      }
    }
    return parseStoredNodeKey(parsed)
  }

  async remove(nodeId: NodeId): Promise<Result<true>> {
    const target = this.#pathFor(nodeId)
    if (target === null) {
      return {
        ok: false,
        error: createContractError("validation", "identity.key_path_refused", "Refusing to remove a private key at a path containing a traversal segment."),
      }
    }
    try {
      await unlink(target)
    } catch (error) {
      if (isMissing(error)) return { ok: true, value: true }
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "identity.key_remove_failed",
          `The node private key could not be removed (${describeError(error)}).`,
        ),
      }
    }
    return { ok: true, value: true }
  }

  /**
   * The absolute-ish path for a node, or `null` if the id is not a plain segment.
   *
   * The `nodeId` grammar already excludes `/` and `\`, so this is a second
   * opinion rather than the primary defence. It is here because a key path is the
   * one place in this module where a wire-supplied string becomes a filesystem
   * path, and a defence that only exists in a Zod regex is a defence that is one
   * refactor away from not existing.
   */
  #pathFor(nodeId: NodeId): string | null {
    const segments = String(nodeId).split(/[/\\]/)
    if (segments.length !== 1 || segments[0] === "." || segments[0] === "..") return null
    return join(this.#directory, `${segments[0]}${KEY_FILE_SUFFIX}`)
  }
}

async function ensurePrivateDirectory(directory: string): Promise<Result<true>> {
  try {
    await mkdir(directory, { recursive: true, mode: PRIVATE_KEY_DIR_MODE })
  } catch (error) {
    return {
      ok: false,
      error: createContractError(
        "internal_failure",
        "identity.key_directory_failed",
        `The node key directory could not be created (${describeError(error)}).`,
      ),
    }
  }
  const mode = await modeOf(directory)
  if (mode === null) {
    return {
      ok: false,
      error: createContractError(
        "internal_failure",
        "identity.key_directory_missing",
        "The node key directory does not exist after being created, so its permissions cannot be verified. A private key is not written to a directory whose mode is unknown.",
      ),
    }
  }
  if ((mode & FOREIGN_READABLE_BITS) !== 0) {
    // The DIRECTORY is checked as well as the file, and this is not pedantry: a
    // `0600` file inside a `0777` directory is still deletable and replaceable by
    // any local user, and "replaceable" is enough to substitute a key the node
    // will then sign with and publish under a fingerprint an attacker chose.
    return refuseReadableDirectory(directory, mode)
  }
  await chmod(directory, PRIVATE_KEY_DIR_MODE)
  return { ok: true, value: true }
}

/**
 * The one refusal for a directory another local user can reach.
 *
 * Shared by the write and the read path, because the two must agree: a store that
 * refuses to WRITE a key into a loose directory and then HAPPILY READS one back out of
 * it has not refused anything, it has just deferred the decision to whoever widened the
 * mode. The message names the directory and its mode so an operator can act on it.
 */
function refuseReadableDirectory(directory: string, mode: number): { ok: false; error: ContractError } {
  return {
    ok: false,
    error: createContractError(
      "internal_failure",
      "identity.key_directory_readable",
      `The node key directory ${directory} has mode 0${mode.toString(8)}, which lets users other than the owner list or replace its contents. A 0600 private key inside a directory they can write to is still replaceable — they can unlink it and substitute a key the node would then sign with — so the directory is refused on the way in as well as on the way out. Fix the mode (chmod 700) once the directory's owner is confirmed.`,
    ),
  }
}

function refuseLooseFile(path: string, mode: number | null): { ok: false; error: ContractError } {
  const described = mode === null ? "an unreadable mode" : `0${mode.toString(8)}`
  return {
    ok: false,
    error: createContractError(
      "internal_failure",
      "identity.key_file_readable",
      `The node private key at ${path} has permissions ${described}, which are group- or world-accessible. The read is REFUSED rather than repaired: a private key another local account can read has already lost the property it exists for, and silently continuing turns a local permissions mistake into a mesh-wide credential. Fix the mode (chmod 600) once the file's owner is confirmed.`,
    ),
  }
}

async function modeOf(path: string): Promise<number | null> {
  try {
    const stats = await lstat(path)
    return stats.mode & 0o777
  } catch {
    return null
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
}

/**
 * The `code` of a filesystem error, never its `message`.
 *
 * Node's `ENOENT` messages embed the full path, and a path can embed a node id
 * an operator would rather not see in an aggregate log; more importantly, a
 * `message` from a driver can include a fragment of the buffer that failed. The
 * `code` is the whole of what this module needs to branch on.
 */
function describeError(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string") {
    return (error as NodeJS.ErrnoException).code as string
  }
  return error instanceof Error ? error.name : "an unknown error"
}
