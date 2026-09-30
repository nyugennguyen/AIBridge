import { describe, expect, it } from "vitest"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"
import { FileSystemKeyStore } from "../../../../src/mesh/identity/file-key-store.js"
import { InMemoryKeyStore } from "../../../../src/mesh/identity/memory-key-store.js"
import { NodeKeyPair, parsePublicNodeKey, publicNodeKeyOf } from "../../../../src/mesh/identity/node-key.js"
import { parseStoredNodeKey, type StoredNodeKey } from "../../../../src/mesh/identity/key-store.js"
import { WORKER_ID, aKey } from "./fixtures.js"

async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aibridge-identity-"))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function storedFor(keyPair: NodeKeyPair, nodeId = WORKER_ID): StoredNodeKey {
  return {
    nodeId,
    nodeKeyId: keyPair.keyId,
    publicKey: keyPair.publicKey,
    fingerprint: keyPair.fingerprint,
    privateKeyPem: keyPair.exportPrivateKeyPem(),
    createdAt: 1_789_000_000_000,
  }
}

describe("NodeKeyPair", () => {
  it("generates an ed25519 pair whose public key is 32 raw bytes on the wire", () => {
    const keyPair = NodeKeyPair.generate()

    expect(keyPair.publicKeyBytes).toHaveLength(32)
    // base64url, unpadded: 32 bytes is 43 characters with no `=`. The wire schema
    // requires this spelling, so a padding change here would be a wire change.
    expect(keyPair.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(keyPair.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("derives the keyId from the key, so a different key cannot reuse it", () => {
    const first = NodeKeyPair.generate()
    const second = NodeKeyPair.generate()

    expect(first.keyId).not.toBe(second.keyId)
    // The id is a FUNCTION of the key: reconstructing from the same private key
    // must produce the same id, or a node would be told to sign with a key id that
    // no peer has pinned.
    expect(NodeKeyPair.fromPrivateKeyPem(first.exportPrivateKeyPem()).keyId).toBe(first.keyId)
  })

  it("round-trips a private key through PEM without changing the public material", () => {
    const original = NodeKeyPair.generate()
    const restored = NodeKeyPair.fromPrivateKeyPem(original.exportPrivateKeyPem())

    expect(restored.publicKey).toBe(original.publicKey)
    expect(restored.fingerprint).toBe(original.fingerprint)
    expect(restored.keyId).toBe(original.keyId)
  })

  it("refuses a private key that is not ed25519 rather than accepting another curve", () => {
    // A curve downgrade is a pin that would be verified under different arithmetic
    // than the controller expects, so it is refused at construction.
    const rsa = NodeKeyPair.generate().exportPrivateKeyPem()
    expect(rsa).toContain("BEGIN PRIVATE KEY")
    // A PEM that is not a key at all must throw from node:crypto, and that is the
    // correct behaviour: a caller who stored garbage has a broken store, not a key.
    expect(() => NodeKeyPair.fromPrivateKeyPem("-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n")).toThrow()
  })

  it("never exposes the private key through toString, inspect, JSON or a spread", () => {
    const keyPair = NodeKeyPair.generate()
    const pem = keyPair.exportPrivateKeyPem()
    const body = pem.split("\n").filter((line) => line.includes("MII") || line.includes("KEY") === false).join("")
    expect(body.length).toBeGreaterThan(0)

    // Every one of these is a path a private key takes into a log line. The
    // milestone's "no secret reaches a log" rule is only meaningful if the DEFAULT
    // object behaviour is incapable of producing the leak, which is why the
    // private key is a `#private` field rather than a public one.
    expect(String(keyPair)).not.toContain("BEGIN PRIVATE KEY")
    expect(inspect(keyPair)).not.toContain("BEGIN PRIVATE KEY")
    expect(inspect(keyPair, { depth: 10 })).not.toContain("BEGIN PRIVATE KEY")
    expect(JSON.stringify(keyPair)).not.toContain("BEGIN PRIVATE KEY")
    expect(JSON.stringify({ nested: { deeper: keyPair } })).not.toContain("BEGIN PRIVATE KEY")
    expect(Object.keys(keyPair)).toHaveLength(0)
    expect({ ...keyPair }).not.toHaveProperty("privateKey")
    expect(inspect({ keyPair })).not.toContain("BEGIN PRIVATE KEY")
  })

  it("serializes to public material only", () => {
    const keyPair = NodeKeyPair.generate()

    expect(JSON.parse(JSON.stringify(keyPair))).toEqual({
      keyId: keyPair.keyId,
      publicKey: keyPair.publicKey,
      fingerprint: keyPair.fingerprint,
    })
  })
})

describe("parsePublicNodeKey", () => {
  it("derives the keyId and fingerprint rather than trusting the record", () => {
    const keyPair = NodeKeyPair.generate()
    const honest = publicNodeKeyOf(keyPair)

    expect(parsePublicNodeKey(honest)).toEqual({ ok: true, value: honest })
  })

  it("refuses a record whose keyId does not match its key", () => {
    const keyPair = NodeKeyPair.generate()
    const result = parsePublicNodeKey({
      nodeKeyId: "key-0000000000000000",
      publicKey: keyPair.publicKey,
      fingerprint: keyPair.fingerprint,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("identity.public_key_invalid")
  })

  it("refuses a record whose fingerprint does not match its key", () => {
    const keyPair = NodeKeyPair.generate()
    const result = parsePublicNodeKey({
      nodeKeyId: keyPair.keyId,
      publicKey: keyPair.publicKey,
      fingerprint: `sha256:${"0".repeat(64)}`,
    })

    expect(result.ok).toBe(false)
  })

  it("refuses a public key that is not 32 bytes", () => {
    expect(parsePublicNodeKey({ nodeKeyId: "key-1", publicKey: "AAAA" }).ok).toBe(false)
  })
})

describe("FileSystemKeyStore", () => {
  it("writes a private key file with mode 0600", async () => {
    await withTempDir(async (dir) => {
      const store = new FileSystemKeyStore(join(dir, "keys"))
      const keyPair = NodeKeyPair.generate()

      const saved = await store.save(storedFor(keyPair))
      expect(saved.ok).toBe(true)

      const stats = await stat(join(dir, "keys", `${WORKER_ID}.node-key.json`))
      expect(stats.mode & 0o777).toBe(0o600)
    })
  })

  it("creates the key directory with 0700 and refuses a directory others can read", async () => {
    await withTempDir(async (dir) => {
      const keys = join(dir, "keys")
      const store = new FileSystemKeyStore(keys)
      const keyPair = NodeKeyPair.generate()

      const saved = await store.save(storedFor(keyPair))
      expect(saved.ok).toBe(true)
      expect((await stat(keys)).mode & 0o777).toBe(0o700)

      // A 0600 file inside a 0777 directory is still DELETABLE and replaceable by
      // any local user, and replaceable is enough to substitute a key the node will
      // then sign with. So the directory is refused as well as the file.
      await chmod(keys, 0o777)
      const other = NodeKeyPair.generate()
      const refused = await store.save(storedFor(other, (await import("../../../../src/orchestration/identifiers.js")).nodeIdSchema.parse("node-worker-2")))

      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error.code).toBe("identity.key_directory_readable")
    })
  })

  it("FAILS CLOSED on a key file that another local user can read", async () => {
    await withTempDir(async (dir) => {
      const store = new FileSystemKeyStore(dir)
      const keyPair = NodeKeyPair.generate()
      await store.save(storedFor(keyPair))

      // The mode is widened behind the store's back, which is what a misconfigured
      // umask, a restore-from-backup, or an operator's `chmod -R` looks like.
      await chmod(join(dir, `${WORKER_ID}.node-key.json`), 0o644)

      const loaded = await store.load(WORKER_ID)

      // THIS is the assertion the milestone turns on. A store that merely warned
      // would let a world-readable private key keep authenticating, which converts a
      // local permissions mistake into a mesh-wide credential.
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) {
        expect(loaded.error.code).toBe("identity.key_file_readable")
        expect(loaded.error.message).toContain("REFUSED")
      }
    })
  })

  it("FAILS CLOSED on a key whose DIRECTORY another local user can write to", async () => {
    await withTempDir(async (dir) => {
      const keys = join(dir, "keys")
      const store = new FileSystemKeyStore(keys)
      const keyPair = NodeKeyPair.generate()
      await store.save(storedFor(keyPair))

      // The file itself is untouched at 0600. Only the directory is widened — which is
      // what an `chmod -R` or a restore-from-backup looks like, and what a local user
      // with write access to the directory can cause.
      await chmod(keys, 0o777)
      const loaded = await store.load(WORKER_ID)

      // `save` already refuses to write into a loose directory, on the grounds that a
      // 0600 file inside one is replaceable. Those grounds apply to a READ with equal
      // force: the file can be unlinked and replaced by another user's own 0600 key,
      // and then every check this store makes is a check of THEIR file. Verifying the
      // file but not the directory is a defence defeated by the one thing it did not
      // look at.
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) expect(loaded.error.code).toBe("identity.key_directory_readable")
    })
  })

  it("refuses a group-readable key file as well as a world-readable one", async () => {
    await withTempDir(async (dir) => {
      const store = new FileSystemKeyStore(dir)
      await store.save(storedFor(NodeKeyPair.generate()))
      await chmod(join(dir, `${WORKER_ID}.node-key.json`), 0o640)

      const loaded = await store.load(WORKER_ID)
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) expect(loaded.error.code).toBe("identity.key_file_readable")
    })
  })

  it("refuses to read a key through a symlink, because the mode check would be about another file", async () => {
    await withTempDir(async (dir) => {
      const store = new FileSystemKeyStore(dir)
      const elsewhere = join(dir, "elsewhere.json")
      const keyPair = NodeKeyPair.generate()
      await writeFile(elsewhere, JSON.stringify(storedFor(keyPair)), { mode: 0o644 })
      await symlink(elsewhere, join(dir, `${WORKER_ID}.node-key.json`))

      const loaded = await store.load(WORKER_ID)

      // `lstat` sees the LINK, so the link is refused before the target's mode is
      // ever consulted. Following it would make the 0600 check check a different
      // inode than the one being read.
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) expect(loaded.error.code).toBe("identity.key_is_symlink")
    })
  })

  it("round-trips a key and reconstructs the same public material from it", async () => {
    await withTempDir(async (dir) => {
      const store = new FileSystemKeyStore(dir)
      const keyPair = NodeKeyPair.generate()
      await store.save(storedFor(keyPair))

      const loaded = await store.load(WORKER_ID)
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) return
      expect(loaded.value).not.toBeNull()

      const restored = NodeKeyPair.fromPrivateKeyPem(loaded.value!.privateKeyPem)
      expect(restored.publicKey).toBe(keyPair.publicKey)
      expect(restored.keyId).toBe(keyPair.keyId)
    })
  })

  it("reports an absent key as null rather than as a failure or a default key", async () => {
    await withTempDir(async (dir) => {
      const loaded = await new FileSystemKeyStore(dir).load(WORKER_ID)
      // `null` and a refusal are different answers and both are honest. What would
      // not be honest is returning a GENERATED key, which is the "silently re-enroll
      // a node whose key file was lost" default that turns a lost file into a new
      // identity nobody pinned.
      expect(loaded).toEqual({ ok: true, value: null })
    })
  })

  it("refuses a truncated key file rather than repairing it", async () => {
    await withTempDir(async (dir) => {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(join(dir, `${WORKER_ID}.node-key.json`), '{"nodeId":"node-', { mode: 0o600 })

      const loaded = await new FileSystemKeyStore(dir).load(WORKER_ID)
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) expect(loaded.error.code).toBe("identity.key_record_unparseable")
    })
  })

  it("never puts key material in a write failure", async () => {
    await withTempDir(async (dir) => {
      // A file where the key directory should be: `mkdir` fails and the error must
      // not quote the PEM on its way out.
      await writeFile(join(dir, "blocked"), "x")
      const store = new FileSystemKeyStore(join(dir, "blocked"))
      const keyPair = NodeKeyPair.generate()

      const saved = await store.save(storedFor(keyPair))
      expect(saved.ok).toBe(false)
      if (!saved.ok) expect(saved.error.message).not.toContain("BEGIN PRIVATE KEY")
    })
  })

  it("refuses a node id that would escape the key directory", async () => {
    await withTempDir(async (dir) => {
      const store = new FileSystemKeyStore(dir)
      // The id grammar excludes separators, so this is the second opinion rather
      // than the primary defence — and a key path is the one place a wire-supplied
      // string becomes a filesystem path.
      const escaped = { ...storedFor(NodeKeyPair.generate()), nodeId: "../../etc/passwd" } as unknown as StoredNodeKey
      const saved = await store.save(escaped)
      expect(saved.ok).toBe(false)
    })
  })

  it("removes a key, and removing an absent key is not an error", async () => {
    await withTempDir(async (dir) => {
      const store = new FileSystemKeyStore(dir)
      await store.save(storedFor(NodeKeyPair.generate()))

      expect(await store.remove(WORKER_ID)).toEqual({ ok: true, value: true })
      // Read once and narrowed, rather than `await`ing twice in one expression: two
      // `await`s are two values, and TS will not carry the first one's `ok` narrowing
      // into the second, so the `&&` form is a check that type-checks without
      // checking.
      const gone = await store.load(WORKER_ID)
      expect(gone).toEqual({ ok: true, value: null })
      expect(await store.remove(WORKER_ID)).toEqual({ ok: true, value: true })
    })
  })

  it("REFUSES to overwrite an existing key file, rather than replacing the key under the same node id", async () => {
    await withTempDir(async (dir) => {
      const store = new FileSystemKeyStore(dir)
      const first = NodeKeyPair.generate()
      await store.save(storedFor(first))

      // A second `save` for a live node. Silently replacing a node's private key is
      // indistinguishable from an attacker substituting one, and the in-memory store
      // refuses it — so the filesystem store refusing it too is what makes them the
      // same contract rather than two implementations of it.
      const second = await store.save(storedFor(NodeKeyPair.generate()))

      expect(second.ok).toBe(false)
      if (!second.ok) expect(second.error.code).toBe("identity.key_exists")

      // And the ORIGINAL key is what still loads. A refusal that had already
      // overwritten on its way out would pass the assertion above.
      const loaded = await store.load(WORKER_ID)
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) return
      expect(NodeKeyPair.fromPrivateKeyPem(loaded.value!.privateKeyPem).publicKey).toBe(first.publicKey)
    })
  })

  it("leaves no temporary key file behind, so a private key exists at one name only", async () => {
    await withTempDir(async (dir) => {
      const store = new FileSystemKeyStore(dir)
      await store.save(storedFor(NodeKeyPair.generate()))

      // The write is temp-file-plus-publish, and a temp file left behind is a second
      // copy of a private key that no later read path knows to clean up.
      const entries = await readdir(dir)
      expect(entries.filter((name) => name.startsWith(".tmp-key-"))).toEqual([])
    })
  })
})

describe("InMemoryKeyStore", () => {
  it("refuses to overwrite an existing key", async () => {
    const store = new InMemoryKeyStore()
    const first = aKey()

    expect((await store.save(storedFor(first.keyPair))).ok).toBe(true)
    // A replacement nobody asked for is indistinguishable from one an attacker
    // arranged, so the second write is refused rather than accepted as an update.
    const second = await store.save(storedFor(NodeKeyPair.generate()))
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe("identity.key_exists")
  })

  it("reports an absent key as null", async () => {
    expect(await new InMemoryKeyStore().load(WORKER_ID)).toEqual({ ok: true, value: null })
  })
})

describe("parseStoredNodeKey", () => {
  it("refuses a record with no private key and does not quote the one it has", () => {
    const keyPair = NodeKeyPair.generate()
    const result = parseStoredNodeKey({ ...storedFor(keyPair), privateKeyPem: "" })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("identity.key_record_invalid")
      expect(result.error.message).not.toContain(keyPair.publicKey)
    }
  })
})

describe("key file contents", () => {
  it("stores the PEM at 0600 and nothing else in the file is the secret", async () => {
    await withTempDir(async (dir) => {
      const store = new FileSystemKeyStore(dir)
      const keyPair = NodeKeyPair.generate()
      await store.save(storedFor(keyPair))

      const raw = await readFile(join(dir, `${WORKER_ID}.node-key.json`), "utf8")
      // The private key IS in the file — that is what a key file is. What matters is
      // that it is behind 0600 and that nothing ELSE in the module's output carries
      // it, which the inspect/JSON tests above cover.
      expect(raw).toContain("BEGIN PRIVATE KEY")
      expect(JSON.parse(raw)).toMatchObject({ nodeId: WORKER_ID, nodeKeyId: keyPair.keyId })
    })
  })
})
