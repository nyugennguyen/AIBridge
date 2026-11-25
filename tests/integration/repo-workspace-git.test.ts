/**
 * `RepoWorkspaceManager` against a real (local, bare) git repository in a
 * temp dir: no network. Two jobs at different shas get separate worktrees.
 */
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { GitRefNotFoundError, RepoWorkspaceManager } from "../../src/runtime/repo-workspace.js"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" },
  }).trim()
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

describe("RepoWorkspaceManager with a local bare repository", () => {
  it("mirrors, resolves refs, checks out two shas side by side, and cleans up", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibridge-git-"))
    const work = join(root, "work")
    execFileSync("git", ["init", "--quiet", "-b", "main", work])
    execFileSync("sh", ["-c", "echo one > file.txt"], { cwd: work })
    git(work, "add", "file.txt")
    git(work, "commit", "--quiet", "-m", "one")
    const first = git(work, "rev-parse", "HEAD")
    execFileSync("sh", ["-c", "echo two > file.txt"], { cwd: work })
    git(work, "commit", "--quiet", "-am", "two")
    const second = git(work, "rev-parse", "HEAD")
    const bare = join(root, "origin.git")
    execFileSync("git", ["clone", "--quiet", "--bare", work, bare])

    const manager = new RepoWorkspaceManager({ stateDir: join(root, "state") })
    const repository = { name: "app", url: bare, defaultRef: "main" }
    expect(await manager.resolveSha(repository, "main")).toBe(second)
    expect(await manager.resolveSha(repository, first)).toBe(first)
    await expect(manager.resolveSha(repository, "no-such-branch")).rejects.toBeInstanceOf(GitRefNotFoundError)

    // A new commit upstream is picked up by the next resolve (fetch --prune).
    execFileSync("sh", ["-c", "echo three > file.txt"], { cwd: work })
    git(work, "commit", "--quiet", "-am", "three")
    git(work, "push", "--quiet", bare, "main")
    const third = git(work, "rev-parse", "HEAD")
    expect(await manager.resolveSha(repository, "main")).toBe(third)

    const [a, b] = await Promise.all([manager.createWorktree("app", "job_a", first), manager.createWorktree("app", "job_b", third)])
    expect(a).not.toBe(b)
    expect((await readFile(join(a, "file.txt"), "utf8")).trim()).toBe("one")
    expect((await readFile(join(b, "file.txt"), "utf8")).trim()).toBe("three")
    expect(git(a, "rev-parse", "HEAD")).toBe(first)

    await manager.removeWorktree("app", "job_a")
    expect(await exists(a)).toBe(false)
    expect(await manager.sweepStale()).toEqual(["job_b"])
    expect(await readdir(manager.worktreesDir)).toEqual([])
    expect(git(root, "--git-dir", manager.mirrorPath("app"), "worktree", "list").split("\n")).toHaveLength(1)
  }, 30_000)
})
