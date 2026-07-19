import { mkdir, writeFile, readFile, lstat, chmod, rename, unlink } from "node:fs/promises"
import { join, dirname } from "node:path"
import { randomBytes } from "node:crypto"
import { bridgeConfigSchema } from "../config/schemas.js"
import type { ProfilePaths } from "./paths.js"

// ── Constants ──────────────────────────────────────────────────────────

const DIR_MODE = 0o700
const FILE_MODE = 0o600

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Assert that `path` is NOT a symlink.
 * Uses `lstat` (does not follow symlinks) so we can reject them.
 */
async function assertNotSymlink(path: string, label: string): Promise<void> {
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink: ${path}`)
    }
  } catch (err: unknown) {
    // ENOENT is fine — the path does not exist yet.
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return
    }
    throw err
  }
}

/**
 * Assert that a file's permissions are not more permissive than `maxMode`.
 */
async function assertFileMode(path: string, maxMode: number): Promise<void> {
  const st = await lstat(path)
  const mode = st.mode & 0o777
  if (mode > maxMode) {
    throw new Error(
      `File ${path} has mode 0${mode.toString(8)}, ` +
        `which is more permissive than the allowed 0${maxMode.toString(8)}`,
    )
  }
}

/**
 * Create a directory (and parents) with 0700 permissions.
 * If the directory already exists, its permissions are NOT downgraded.
 */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
}

/**
 * Atomic write: write to a temp file in the same directory, then rename.
 * Ensures readers never see a partial file.
 */
async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const dir = dirname(path)
  const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`)
  try {
    await writeFile(tmp, data, { mode: FILE_MODE })
    await rename(tmp, path)
  } catch (err) {
    // Clean up temp file on failure.
    try {
      await unlink(tmp)
    } catch {
      // Ignore cleanup errors.
    }
    throw err
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Assert that a resolved path does not contain traversal segments (`..`).
 */
function assertNoTraversal(path: string): void {
  const segments = path.split(/[/\\]/)
  if (segments.includes("..")) {
    throw new Error(`Path contains traversal segments: ${path}`)
  }
}

/**
 * Ensure all profile directories exist with 0700 permissions.
 *
 * Rejects if any path component is a symlink or contains traversal.
 */
export async function ensureProfileDirs(paths: ProfilePaths): Promise<void> {
  for (const dir of [paths.configDir, paths.dataDir, paths.secretsDir, paths.stateDir]) {
    // Reject traversal.
    assertNoTraversal(dir)

    // Reject symlinks in the path chain.
    await assertNotSymlink(dir, "Profile directory")

    await ensureDir(dir)

    // Ensure the created directory has 0700 permissions.
    const st = await lstat(dir)
    const mode = st.mode & 0o777
    if (mode !== DIR_MODE) {
      await chmod(dir, DIR_MODE)
    }
  }
}

/**
 * Read a config file, returning parsed JSON or `null` if the file does not exist.
 *
 * Security checks:
 * - Rejects symlinks
 * - Rejects files with permissions more permissive than 0600
 */
export async function readConfig(configPath: string): Promise<Record<string, unknown> | null> {
  await assertNotSymlink(configPath, "Config file")

  try {
    await assertFileMode(configPath, FILE_MODE)
    const raw = await readFile(configPath, "utf8")
    return JSON.parse(raw) as Record<string, unknown>
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }
    throw err
  }
}

/**
 * Write a config file atomically with 0600 permissions.
 *
 * Security checks:
 * - Validates data against `bridgeConfigSchema` before writing
 * - Rejects symlinks
 * - Atomic write (temp file + rename)
 * - Parent directories created with 0700
 */
export async function writeConfig(
  configPath: string,
  data: Record<string, unknown>,
): Promise<void> {
  await assertNotSymlink(configPath, "Config file")

  bridgeConfigSchema.parse(data)

  await ensureDir(dirname(configPath))

  const json = JSON.stringify(data, null, 2) + "\n"
  await atomicWrite(configPath, json)
}

/**
 * Read a secret file's contents.
 *
 * Security checks:
 * - Rejects symlinks
 * - Rejects files with permissions more permissive than 0600
 * - Throws if file does not exist (secrets must exist to be read)
 */
export async function readSecret(secretPath: string): Promise<string> {
  await assertNotSymlink(secretPath, "Secret file")
  await assertFileMode(secretPath, FILE_MODE)
  return readFile(secretPath, "utf8")
}

/**
 * Write a secret file atomically with 0600 permissions.
 *
 * Security checks:
 * - Rejects empty values
 * - Rejects symlinks
 * - Rejects overwrite of existing secrets
 * - Atomic write (temp file + rename)
 * - Parent directories created with 0700
 */
export async function writeSecret(secretPath: string, value: string): Promise<void> {
  if (value.length === 0) {
    throw new Error("Secret value must not be empty")
  }

  await assertNotSymlink(secretPath, "Secret file")

  // Reject overwrite: secrets are write-once.
  try {
    await lstat(secretPath)
    throw new Error(`Secret already exists: ${secretPath}`)
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      // Good — file does not exist yet.
    } else {
      throw err
    }
  }

  // Ensure parent directory exists.
  await ensureDir(dirname(secretPath))

  await atomicWrite(secretPath, value)
}
