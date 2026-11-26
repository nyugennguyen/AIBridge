import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isProcessAlive } from "../../../src/host/process-identity.js"
import { resolveScriptPath, SCRIPT_OUTPUT_TAIL_CHARS, ScriptPathError, ScriptRunner } from "../../../src/runtime/script-runner.js"

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "aibridge-script-"))
}

async function script(dir: string, name: string, body: string): Promise<void> {
  await mkdir(join(dir, name, ".."), { recursive: true })
  await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`)
  await chmod(join(dir, name), 0o755)
}

describe("resolveScriptPath", () => {
  it("accepts a regular file inside the directory", async () => {
    const dir = await workspace()
    await script(dir, "scripts/ok.sh", "true")
    expect(await resolveScriptPath(dir, "scripts/ok.sh")).toMatch(/scripts\/ok\.sh$/)
  })

  it("refuses absolute paths, .. escapes, symlinks out of the tree, directories and missing files", async () => {
    const dir = await workspace()
    const outside = await workspace()
    await script(outside, "evil.sh", "true")
    await symlink(join(outside, "evil.sh"), join(dir, "link.sh"))
    await mkdir(join(dir, "adir"))
    for (const path of ["/bin/sh", "../evil.sh", "a/../../evil.sh", "link.sh", "adir", "missing.sh"]) {
      await expect(resolveScriptPath(dir, path), path).rejects.toBeInstanceOf(ScriptPathError)
    }
  })
})

describe("ScriptRunner", () => {
  it("runs without a shell, in the job directory, with a sanitized environment", async () => {
    const dir = await workspace()
    await script(dir, "run.sh", 'pwd; echo "job=$AIBR_JOB_ID"; echo "op=${AIBRIDGE_OPERATOR_TOKEN:-none}"; echo "key=${ANTHROPIC_API_KEY:-none}"')
    const runner = new ScriptRunner({ env: { PATH: process.env.PATH, AIBRIDGE_OPERATOR_TOKEN: "op-secret", ANTHROPIC_API_KEY: "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx" } })
    const result = await runner.start({ phase: "main", script: "run.sh", cwd: dir, timeoutMs: 10_000, extraEnv: { AIBR_JOB_ID: "job_9" } }).result
    expect(result.exit_code).toBe(0)
    expect(result.stdout_tail).toContain("job=job_9")
    expect(result.stdout_tail).toContain("op=none")
    expect(result.stdout_tail).toContain("key=none")
  })

  it("reports a non-zero exit, keeps only a bounded tail, and redacts known secrets", async () => {
    const dir = await workspace()
    await script(dir, "noisy.sh", `i=0; while [ $i -lt 3000 ]; do echo "line $i"; i=$((i+1)); done; echo "token=supersecretvalue" >&2; exit 4`)
    const runner = new ScriptRunner({ env: { PATH: process.env.PATH }, knownSecrets: ["supersecretvalue"] })
    const result = await runner.start({ phase: "pre", script: "noisy.sh", cwd: dir, timeoutMs: 10_000 }).result
    expect(result.exit_code).toBe(4)
    expect(result.stdout_tail.length).toBeLessThanOrEqual(SCRIPT_OUTPUT_TAIL_CHARS + 1)
    expect(result.stdout_tail).toContain("line 2999")
    expect(result.stdout_tail).not.toContain("line 0\n")
    expect(result.stderr_tail).toBe("token=[REDACTED]\n")
  })

  it("kills the whole process group on timeout and on kill()", async () => {
    const dir = await workspace()
    await script(dir, "slow.sh", "sleep 30 & sleep 30; wait")
    const runner = new ScriptRunner({ env: { PATH: process.env.PATH } })
    const timedOut = await runner.start({ phase: "main", script: "slow.sh", cwd: dir, timeoutMs: 200 }).result
    expect(timedOut).toMatchObject({ timed_out: true, exit_code: null, signal: "SIGTERM" })

    const running = runner.start({ phase: "main", script: "slow.sh", cwd: dir, timeoutMs: 30_000 })
    await new Promise((done) => setTimeout(done, 100))
    running.kill()
    expect(await running.result).toMatchObject({ timed_out: false, exit_code: null, signal: "SIGTERM" })
  }, 15_000)

  it("kills a group member that ignores SIGTERM as soon as the script itself exits, without waiting for the escalation", async () => {
    const dir = await workspace()
    const pids = join(dir, "pids")
    // The script exits on SIGTERM; the sleep it started ignores SIGTERM.
    await script(dir, "leader.sh", `(trap '' TERM; exec sleep 30) &\necho $! > ${JSON.stringify(pids)}\nwait`)
    const running = new ScriptRunner({ env: { PATH: process.env.PATH } }).start({ phase: "main", script: "leader.sh", cwd: dir, timeoutMs: 30_000 })
    let member = 0
    for (let attempt = 0; attempt < 250 && member === 0; attempt += 1) {
      member = Number((await readFile(pids, "utf8").catch(() => "")).trim()) || 0
      if (member === 0) await new Promise((done) => setTimeout(done, 20))
    }
    try {
      running.kill()
      expect(await running.result).toMatchObject({ signal: "SIGTERM" })
      const deadline = Date.now() + 1_500
      while (isProcessAlive(member) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
      expect(isProcessAlive(member)).toBe(false)
    } finally {
      try {
        process.kill(member, "SIGKILL")
      } catch {
        /* gone */
      }
    }
  }, 15_000)

  it("reports a script that cannot be executed instead of throwing", async () => {
    const dir = await workspace()
    await writeFile(join(dir, "plain.txt"), "not executable")
    const result = await new ScriptRunner({ env: { PATH: process.env.PATH } }).start({ phase: "main", script: "plain.txt", cwd: dir, timeoutMs: 5_000 }).result
    expect(result.exit_code).toBeNull()
    expect(result.stderr_tail).toMatch(/EACCES|permission/i)
  })
})
