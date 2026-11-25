import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ProcessOptions, ProcessResult, ProcessRunner } from "../../../src/host/types.js"
import {
  gitEnvironment,
  GitOperationError,
  GitRefNotFoundError,
  defaultWorktreesDir,
  RepoWorkspaceManager,
  resolveConfiguredRepository,
  worktreeDirName,
} from "../../../src/runtime/repo-workspace.js"
import { CLAUDE_SAFETY_FLOOR_DENY } from "../../../src/runtime/claude-job-runner.js"
import { testConfig } from "../../integration/fixtures.js"

const SHA = "c".repeat(40)

class FakeGit implements ProcessRunner {
  readonly calls: string[][] = []
  constructor(private readonly answer: (argv: readonly string[]) => Partial<ProcessResult> = () => ({})) {}
  async exec(argv: readonly string[], _options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push([...argv])
    const subcommand = argv.find((arg) => ["clone", "fetch", "rev-parse", "worktree"].includes(arg))
    if (subcommand === "worktree" && argv.includes("add")) await mkdir(argv[argv.length - 2]!, { recursive: true })
    return { exitCode: 0, stdout: subcommand === "rev-parse" ? SHA : "", stderr: "", ...this.answer(argv) }
  }
}

const repository = { name: "app", url: "https://git.example.test/app.git", defaultRef: "main" }

describe("resolveConfiguredRepository", () => {
  const config = { ...testConfig(), repositories: { app: { url: "https://git.example.test/app.git" } } }
  it("matches a key or an exact url, and nothing else", () => {
    expect(resolveConfiguredRepository(config, "app")).toEqual({ name: "app", url: "https://git.example.test/app.git", defaultRef: "HEAD" })
    expect(resolveConfiguredRepository(config, "https://git.example.test/app.git")?.name).toBe("app")
    expect(resolveConfiguredRepository(config, "https://evil.example.test/app.git")).toBeUndefined()
    expect(resolveConfiguredRepository(config, "toString")).toBeUndefined()
    expect(resolveConfiguredRepository(testConfig(), "app")).toBeUndefined()
  })
})

describe("RepoWorkspaceManager (fake git)", () => {
  it("clones a mirror on first use, fetches after, and resolves the ref after --end-of-options", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-ws-"))
    const git = new FakeGit((argv) => {
      // The first clone creates the mirror directory the way git would.
      if (argv.includes("clone")) void mkdir(argv[argv.length - 1]!, { recursive: true })
      return {}
    })
    const manager = new RepoWorkspaceManager({ stateDir, runner: git })
    expect(await manager.resolveSha(repository, "main")).toBe(SHA)
    await new Promise((done) => setTimeout(done, 5))
    expect(await manager.resolveSha(repository, "feature/x")).toBe(SHA)
    const kinds = git.calls.map((argv) => argv.find((arg) => ["clone", "fetch", "rev-parse"].includes(arg)))
    expect(kinds).toEqual(["clone", "rev-parse", "fetch", "rev-parse"])
    expect(git.calls[0]).toEqual(["git", "clone", "--mirror", "--quiet", "--", repository.url, manager.mirrorPath("app")])
    const revParse = git.calls[3]!
    expect(revParse.slice(revParse.indexOf("--end-of-options"))).toEqual(["--end-of-options", "feature/x^{commit}"])
  })

  it("refuses option-like and unknown refs, and reports git failures", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-ws-"))
    const git = new FakeGit()
    const manager = new RepoWorkspaceManager({ stateDir, runner: git })
    await expect(manager.resolveSha(repository, "--upload-pack=evil")).rejects.toBeInstanceOf(GitRefNotFoundError)
    expect(git.calls).toHaveLength(0)

    const missing = new RepoWorkspaceManager({ stateDir, runner: new FakeGit((argv) => (argv.includes("rev-parse") ? { exitCode: 1, stdout: "" } : {})) })
    await expect(missing.resolveSha(repository, "nope")).rejects.toBeInstanceOf(GitRefNotFoundError)

    const broken = new RepoWorkspaceManager({ stateDir: await mkdtemp(join(tmpdir(), "aibridge-ws-")), runner: new FakeGit(() => ({ exitCode: 128, stderr: "fatal: unreachable" })) })
    await expect(broken.resolveSha(repository, "main")).rejects.toBeInstanceOf(GitOperationError)
  })

  it("adds a detached worktree with hooks disabled, and removes it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-ws-"))
    const git = new FakeGit()
    const manager = new RepoWorkspaceManager({ stateDir, runner: git })
    const path = await manager.createWorktree("app", "job_1", SHA)
    expect(path).toBe(join(stateDir, "worktrees", "job_1"))
    expect(git.calls[0]).toEqual([
      "git", "--git-dir", manager.mirrorPath("app"), "-c", "core.hooksPath=/dev/null",
      "worktree", "add", "--detach", "--quiet", "--", path, SHA,
    ])
    await expect(manager.createWorktree("app", "job_2", "main")).rejects.toBeInstanceOf(GitOperationError)
    await manager.removeWorktree("app", "job_1")
    expect(await readdir(join(stateDir, "worktrees"))).toEqual([])
  })

  it("sweeps worktrees left behind by a previous process", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-ws-"))
    await mkdir(join(stateDir, "worktrees", "job_old"), { recursive: true })
    await mkdir(join(stateDir, "worktrees", "job_live"), { recursive: true })
    await mkdir(join(stateDir, "repos", "app.git"), { recursive: true })
    await writeFile(join(stateDir, "worktrees", "job_old", "f"), "x")
    const git = new FakeGit()
    const manager = new RepoWorkspaceManager({ stateDir, runner: git })
    expect(await manager.sweepStale(new Set(["job_live"]))).toEqual(["job_old"])
    expect(await readdir(join(stateDir, "worktrees"))).toEqual(["job_live"])
    expect(git.calls).toEqual([["git", "--git-dir", join(stateDir, "repos", "app.git"), "worktree", "prune"]])
  })
})

describe("defaultWorktreesDir", () => {
  it("puts a standard profile's worktrees beside, not inside, the state tree the safety floor denies", () => {
    const stateDir = "/home/aibr/.local/state/aibridge/staging"
    const dir = defaultWorktreesDir(stateDir)
    expect(dir).toBe("/home/aibr/.local/state/aibridge-worktrees/staging")
    // Every floor rule over AIBridge's own trees is a `<prefix>/**` glob; none may cover the worktrees.
    const home = "/home/aibr"
    const prefixes = CLAUDE_SAFETY_FLOOR_DENY.filter((rule) => rule.includes("aibridge")).map((rule) =>
      rule.replace(/^(Read|Edit)\(~/, home).replace(/\/\*\*\)$/, "/"),
    )
    for (const prefix of prefixes) expect(`${dir}/job_1/src/a.ts`.startsWith(prefix), prefix).toBe(false)
    expect(new RepoWorkspaceManager({ stateDir }).worktreesDir).toBe(dir)
  })

  it("keeps <state>/worktrees for a state dir that is not a profile directory", () => {
    expect(defaultWorktreesDir("/tmp/x/state")).toBe("/tmp/x/state/worktrees")
  })
})

describe("helpers", () => {
  it("keeps safe job ids as directory names and digests the rest", () => {
    expect(worktreeDirName("job_1")).toBe("job_1")
    expect(worktreeDirName("../../etc")).toMatch(/^job-[0-9a-f]{40}$/)
    expect(worktreeDirName("..")).toMatch(/^job-/)
  })

  it("drops AIBridge secrets from git's environment and disables prompts", () => {
    expect(gitEnvironment({ PATH: "/bin", SSH_AUTH_SOCK: "/s", AIBRIDGE_OPERATOR_TOKEN: "t", AIBRIDGE_BEARER_TOKEN: "b" })).toEqual({
      PATH: "/bin",
      SSH_AUTH_SOCK: "/s",
      GIT_TERMINAL_PROMPT: "0",
    })
  })
})
