/**
 * Per-job git worktrees pinned to a resolved sha (Phase 5 of
 * `Docs/implementation-plans/claude-adapter-and-plugin.md`).
 *
 * Layout:
 *
 *   <state>/repos/<name>.git        bare mirror (`git clone --mirror`, then `git fetch --prune`)
 *   <worktrees>/<job-dir>           detached worktree of one job, removed when the job ends
 *
 * `<worktrees>` is deliberately NOT `<state>/worktrees` for a profile at the
 * standard XDG location: the Claude safety floor denies Read/Edit on
 * `~/.local/state/aibridge/**` (job records, ledgers, outbox), and Claude must
 * be able to read and edit its own checkout. So a profile state dir
 * `<base>/aibridge/<profile>` gets the sibling `<base>/aibridge-worktrees/<profile>`;
 * any other state dir (a local dev run) keeps `<state>/worktrees`
 * (`defaultWorktreesDir`).
 *
 * Only repositories named in the config's `repositories` map are ever fetched;
 * a peer names a key, never a URL (`resolveConfiguredRepository`). The ref a
 * peer sends is validated by `GIT_REF_PATTERN` (no leading `-`) and is also
 * passed after `--end-of-options`, so it can never become a git option.
 *
 * All git calls go through an injectable `ProcessRunner`, so unit tests never
 * touch the network or a real repository.
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { basename, dirname, join, resolve as resolvePath } from "node:path"
import { GIT_REF_PATTERN } from "../config/schemas.js"
import type { BridgeConfig } from "../config/types.js"
import type { ProcessOptions, ProcessResult, ProcessRunner } from "../host/types.js"

const DEFAULT_GIT_TIMEOUT_MS = 120_000
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024
const SAFE_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/**
 * `ProcessRunner` over `child_process.execFile` (never a shell). Works under
 * both Node and Bun, unlike `BunProcessRunner`. `env` is merged over the
 * runner's `baseEnv`, not over `process.env`.
 */
export class NodeProcessRunner implements ProcessRunner {
  constructor(private readonly baseEnv: Readonly<Record<string, string | undefined>> = process.env) {}

  exec(argv: readonly string[], options?: ProcessOptions): Promise<ProcessResult> {
    const [command, ...args] = argv
    if (command === undefined) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "argv must not be empty" })
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries({ ...this.baseEnv, ...options?.env })) {
      if (value !== undefined) env[key] = value
    }
    return new Promise((done) => {
      execFile(
        command,
        args,
        {
          ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
          env,
          ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          shell: false,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : null
          done({ exitCode: code, stdout: String(stdout).trim(), stderr: String(stderr || (error?.message ?? "")).trim() })
        },
      )
    })
  }
}

/** The environment git runs with: the bridge's own, minus AIBridge secrets, never prompting. */
export function gitEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || /^AIBRIDGE_/i.test(key)) continue
    env[key] = value
  }
  env.GIT_TERMINAL_PROMPT = "0"
  return env
}

export interface ConfiguredRepository {
  readonly name: string
  readonly url: string
  readonly defaultRef: string
}

/**
 * The configured repository a trigger's `repo` names: a key of `repositories`,
 * or the exact `url` of one entry. Anything else is `undefined` (the route
 * answers 403): a peer cannot make this node fetch an unconfigured URL.
 */
export function resolveConfiguredRepository(config: BridgeConfig, repo: string): ConfiguredRepository | undefined {
  const repositories = config.repositories ?? {}
  const byName = Object.hasOwn(repositories, repo) ? repositories[repo] : undefined
  const entry =
    byName !== undefined
      ? ([repo, byName] as const)
      : Object.entries(repositories).find(([, candidate]) => candidate.url === repo)
  if (entry === undefined) return undefined
  const [name, value] = entry
  return { name, url: value.url, defaultRef: value.default_branch ?? "HEAD" }
}

export class GitRefNotFoundError extends Error {
  readonly code = "unknown_ref"
}

export class GitOperationError extends Error {
  readonly code = "git_failed"
}

/** A directory name for a job's worktree: the id when it is already safe, else a stable digest. */
export function worktreeDirName(jobId: string): string {
  if (SAFE_DIR_NAME.test(jobId) && jobId !== "." && jobId !== "..") return jobId
  return `job-${createHash("sha256").update(jobId, "utf8").digest("hex").slice(0, 40)}`
}

/** Where job worktrees live for a state dir; see the module comment for why it is a sibling. */
export function defaultWorktreesDir(stateDir: string): string {
  const resolved = resolvePath(stateDir)
  const parent = dirname(resolved)
  if (basename(parent) === "aibridge") return join(dirname(parent), "aibridge-worktrees", basename(resolved))
  return join(resolved, "worktrees")
}

export interface RepoWorkspaceManagerOptions {
  readonly stateDir: string
  /** Defaults to `defaultWorktreesDir(stateDir)`. */
  readonly worktreesDir?: string
  readonly runner?: ProcessRunner
  readonly gitExecutable?: string
  readonly timeoutMs?: number
}

export class RepoWorkspaceManager {
  readonly reposDir: string
  readonly worktreesDir: string
  readonly #runner: ProcessRunner
  readonly #git: string
  readonly #timeoutMs: number
  /** Per-mirror serialization: fetches and worktree add/remove on one mirror never interleave. */
  readonly #locks = new Map<string, Promise<unknown>>()

  constructor(options: RepoWorkspaceManagerOptions) {
    this.reposDir = join(options.stateDir, "repos")
    this.worktreesDir = options.worktreesDir ?? defaultWorktreesDir(options.stateDir)
    this.#runner = options.runner ?? new NodeProcessRunner(gitEnvironment(process.env))
    this.#git = options.gitExecutable ?? "git"
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  }

  mirrorPath(name: string): string {
    return join(this.reposDir, `${name}.git`)
  }

  worktreePath(jobId: string): string {
    return join(this.worktreesDir, worktreeDirName(jobId))
  }

  /**
   * Brings the mirror up to date (clone on first use, `fetch --prune` after)
   * and resolves `ref` to a full commit sha. Throws `GitRefNotFoundError` for
   * a ref the repository does not have, `GitOperationError` for anything else.
   */
  async resolveSha(repository: ConfiguredRepository, ref: string): Promise<string> {
    if (!GIT_REF_PATTERN.test(ref)) throw new GitRefNotFoundError(`Invalid ref: ${ref}`)
    return this.#withLock(repository.name, async () => {
      const mirror = this.mirrorPath(repository.name)
      if (await exists(mirror)) {
        await this.#git_(["--git-dir", mirror, "fetch", "--prune", "--quiet", "origin"], "fetch")
      } else {
        await mkdir(this.reposDir, { recursive: true, mode: 0o700 })
        await this.#git_(["clone", "--mirror", "--quiet", "--", repository.url, mirror], "clone")
      }
      const resolved = await this.#runner.exec(
        [this.#git, "--git-dir", mirror, "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
        { timeoutMs: this.#timeoutMs },
      )
      const sha = resolved.stdout.trim()
      if (resolved.exitCode !== 0 || !SHA_PATTERN.test(sha)) {
        throw new GitRefNotFoundError(`Ref "${ref}" was not found in repository "${repository.name}".`)
      }
      return sha
    })
  }

  /** Creates the job's detached worktree at `sha` (replacing a leftover one) and returns its path. */
  async createWorktree(repositoryName: string, jobId: string, sha: string): Promise<string> {
    if (!SHA_PATTERN.test(sha)) throw new GitOperationError(`Not a full commit sha: ${sha}`)
    return this.#withLock(repositoryName, async () => {
      const mirror = this.mirrorPath(repositoryName)
      const path = this.worktreePath(jobId)
      await mkdir(this.worktreesDir, { recursive: true, mode: 0o700 })
      if (await exists(path)) await this.#removeUnlocked(mirror, path)
      // `core.hooksPath=/dev/null`: no hook in the mirror runs on checkout.
      await this.#git_(
        ["--git-dir", mirror, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--quiet", "--", path, sha],
        "worktree add",
      )
      return path
    })
  }

  /** Removes the job's worktree. Never throws: cleanup must not mask the job's outcome. */
  async removeWorktree(repositoryName: string, jobId: string): Promise<void> {
    try {
      await this.#withLock(repositoryName, () => this.#removeUnlocked(this.mirrorPath(repositoryName), this.worktreePath(jobId)))
    } catch {
      /* best effort; the startup sweep retries */
    }
  }

  /**
   * Startup sweep: removes every worktree directory not belonging to a job in
   * `keep` (a crashed worker leaves them behind) and prunes each mirror's
   * worktree bookkeeping. Returns the removed directory names.
   */
  async sweepStale(keep: ReadonlySet<string> = new Set()): Promise<string[]> {
    const keepDirs = new Set([...keep].map(worktreeDirName))
    const removed: string[] = []
    for (const entry of await listDir(this.worktreesDir)) {
      if (keepDirs.has(entry)) continue
      await rm(join(this.worktreesDir, entry), { recursive: true, force: true }).catch(() => undefined)
      removed.push(entry)
    }
    for (const entry of await listDir(this.reposDir)) {
      if (!entry.endsWith(".git")) continue
      await this.#runner
        .exec([this.#git, "--git-dir", join(this.reposDir, entry), "worktree", "prune"], { timeoutMs: this.#timeoutMs })
        .catch(() => undefined)
    }
    return removed
  }

  async #removeUnlocked(mirror: string, path: string): Promise<void> {
    await this.#runner
      .exec([this.#git, "--git-dir", mirror, "worktree", "remove", "--force", "--", path], { timeoutMs: this.#timeoutMs })
      .catch(() => undefined)
    await rm(path, { recursive: true, force: true })
    await this.#runner.exec([this.#git, "--git-dir", mirror, "worktree", "prune"], { timeoutMs: this.#timeoutMs }).catch(() => undefined)
  }

  async #git_(args: readonly string[], what: string): Promise<ProcessResult> {
    const result = await this.#runner.exec([this.#git, ...args], { timeoutMs: this.#timeoutMs })
    if (result.exitCode !== 0) {
      // stderr can echo the remote URL; credentials belong in a helper, not the URL.
      throw new GitOperationError(`git ${what} failed (exit ${result.exitCode ?? "signal"}): ${result.stderr.slice(0, 500)}`)
    }
    return result
  }

  async #withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve()
    const run = previous.then(work, work)
    const settled = run.catch(() => undefined)
    this.#locks.set(key, settled)
    try {
      return await run
    } finally {
      if (this.#locks.get(key) === settled) this.#locks.delete(key)
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}
