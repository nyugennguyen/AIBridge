import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FileApprovalLedger, InMemoryApprovalLedger, verifyApprovalLedger } from "../../../src/jobs/approval-ledger.js"
import { legacyJobProjection } from "../../../src/jobs/legacy-projection.js"
import { JobManager } from "../../../src/jobs/manager.js"
import { buildTerminalReport } from "../../../src/jobs/report.js"
import type { JobRecord } from "../../../src/jobs/types.js"
import { InMemoryJobStore, validTrigger } from "../../integration/fixtures.js"

const trigger = () => validTrigger() as JobRecord["trigger"]
const at = "2026-11-25T00:00:00.000Z"

describe("approval ledger", () => {
  it("chains entries by hash and sequence, and detects tampering", async () => {
    const ledger = new InMemoryApprovalLedger()
    await Promise.all([
      ledger.append({ type: "approval.requested", jobId: "a", actor: "trigger", at }),
      ledger.append({ type: "approval.requested", jobId: "b", actor: "trigger", at }),
      ledger.append({ type: "approval.granted", jobId: "a", actor: "operator", at }),
    ])
    expect((await ledger.list()).map((event) => event.seq)).toEqual([1, 2, 3])
    expect(verifyApprovalLedger(ledger.lines)).toEqual({ ok: true })

    const edited = [...ledger.lines]
    edited[1] = edited[1]!.replace('"b"', '"c"')
    expect(verifyApprovalLedger(edited)).toMatchObject({ ok: false, line: 3, reason: "hash chain broken" })
    expect(verifyApprovalLedger([ledger.lines[0]!, ledger.lines[2]!])).toMatchObject({ ok: false, line: 2 })
  })

  it("persists to a 0600 file and continues the chain after a restart", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "aibridge-ledger-")), "approvals.jsonl")
    await new FileApprovalLedger(path).append({ type: "approval.requested", jobId: "a", actor: "trigger", at })
    const reopened = new FileApprovalLedger(path)
    const second = await reopened.append({ type: "approval.rejected", jobId: "a", reason: "no", actor: "operator", at })
    expect(second.seq).toBe(2)
    const lines = (await readFile(path, "utf8")).trim().split("\n")
    expect(verifyApprovalLedger(lines)).toEqual({ ok: true })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it("reads an absent file as an empty ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aibridge-ledger-"))
    expect(await new FileApprovalLedger(join(dir, "none.jsonl")).list()).toEqual([])
    await writeFile(join(dir, "x"), "")
  })
})

describe("JobManager approval transitions", () => {
  it("creates a held job and approves it exactly once", async () => {
    const manager = new JobManager(new InMemoryJobStore())
    const job = await manager.createJob(trigger(), at, { awaitingApproval: true })
    expect(job).toMatchObject({ status: "awaiting_approval", approval: { status: "pending", requestedAt: at } })
    const approved = await manager.approve(job.id, "2026-11-25T00:01:00.000Z")
    expect(approved).toMatchObject({ status: "accepted", approval: { status: "approved", decidedBy: "operator" } })
    await expect(manager.approve(job.id)).rejects.toThrow(/not awaiting approval/)
    await expect(manager.reject(job.id, "late")).rejects.toThrow(/not awaiting approval/)
  })

  it("rejects into failed with the reason as the error", async () => {
    const manager = new JobManager(new InMemoryJobStore())
    const job = await manager.createJob(trigger(), at, { awaitingApproval: true })
    const rejected = await manager.reject(job.id, "rejected by operator")
    expect(rejected).toMatchObject({ status: "failed", error: "rejected by operator", approval: { status: "rejected", reason: "rejected by operator" } })
  })

  it("records a checkout on creation", async () => {
    const manager = new JobManager(new InMemoryJobStore())
    const job = await manager.createJob(trigger(), at, { checkout: { repo: "app", ref: "main", sha: "a".repeat(40) } })
    expect(job.status).toBe("accepted")
    expect(job.checkout?.sha).toBe("a".repeat(40))
  })
})

describe("buildTerminalReport", () => {
  it("adds sha and script_results only when present", () => {
    const base: JobRecord = { id: "j", trigger: trigger(), status: "completed", createdAt: at, updatedAt: at }
    expect(buildTerminalReport(base, "me")).not.toHaveProperty("sha")
    expect(buildTerminalReport(base, "me")).not.toHaveProperty("script_results")
    const script = { phase: "main" as const, script: "s.sh", exit_code: 0, timed_out: false, duration_ms: 1, stdout_tail: "", stderr_tail: "" }
    const report = buildTerminalReport(
      { ...base, checkout: { repo: "app", ref: "main", sha: "a".repeat(40) }, runtimeResult: { summary: "ok", findings: [], scriptResults: [script] } },
      "me",
    )
    expect(report).toMatchObject({ sha: "a".repeat(40), script_results: [script] })
  })
})

describe("legacyJobProjection", () => {
  it("drops the fields the strict legacy schema does not know and maps awaiting_approval to accepted", () => {
    const projected = legacyJobProjection({
      id: "j",
      trigger: { ...trigger(), repo: "app", ref: "main" },
      status: "awaiting_approval",
      approval: { status: "pending", requestedAt: at },
      checkout: { repo: "app", ref: "main", sha: "a".repeat(40) },
      createdAt: at,
      updatedAt: at,
    })
    expect(projected.status).toBe("accepted")
    expect(projected).not.toHaveProperty("approval")
    expect(projected).not.toHaveProperty("checkout")
    expect(projected.trigger).not.toHaveProperty("repo")
    expect(projected.trigger).not.toHaveProperty("ref")
  })
})
