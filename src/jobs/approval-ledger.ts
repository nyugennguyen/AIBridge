/**
 * Append-only, hash-chained audit log of operator approval decisions for
 * Claude-runtime jobs (ADR 0012).
 *
 * Why not the kernel's `dispatch.propose -> dispatch.approve -> dispatch.execute`:
 * the profile bridge (`aibr serve`) does not attach the orchestration kernel at
 * all today, and when it is attached a legacy `/trigger` only records a held
 * DRAFT/PAUSED run that nothing can schedule. Wiring a real kernel approval
 * would need a controller lease, a run activation and a task promotion per
 * job, none of which the Claude runner consumes. This ledger is the minimal
 * record that makes every approval auditable now; ADR 0012 records the move
 * to kernel events as follow-up work.
 *
 * Each entry carries `seq` and `prev` (the sha256 of the previous line), so a
 * deleted or edited line breaks the chain and `verifyApprovalLedger` reports it.
 * Entries hold ids, the decision and the operator's reason — never a token.
 */
import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"

export type ApprovalEventType =
  | "approval.requested"
  | "approval.granted"
  | "approval.rejected"
  | "approval.expired"
  | "jobs.stopped"

export interface ApprovalEventInput {
  readonly type: ApprovalEventType
  /** The job the event is about; absent only for `jobs.stopped` (which lists `jobIds`). */
  readonly jobId?: string
  readonly jobIds?: readonly string[]
  readonly capability?: string
  readonly sourceAgentId?: string
  readonly sha?: string
  readonly reason?: string
  /** `operator` for decisions; `trigger` for the request a peer caused. */
  readonly actor: "operator" | "trigger"
  readonly at: string
}

export interface ApprovalEvent extends ApprovalEventInput {
  readonly seq: number
  /** sha256 (hex) of the previous serialized entry; `"0"` for the first. */
  readonly prev: string
}

export interface ApprovalLedger {
  append(event: ApprovalEventInput): Promise<ApprovalEvent>
  list(): Promise<readonly ApprovalEvent[]>
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** Shared chaining for both implementations. Appends are serialized so `seq`/`prev` never race. */
abstract class ChainedLedger implements ApprovalLedger {
  #tail: Promise<unknown> = Promise.resolve()
  #state: { seq: number; prev: string } | undefined

  protected abstract load(): Promise<string[]>
  protected abstract write(line: string): Promise<void>

  append(event: ApprovalEventInput): Promise<ApprovalEvent> {
    const run = this.#tail.then(async () => {
      if (this.#state === undefined) {
        const lines = await this.load()
        const last = lines.at(-1)
        this.#state = last === undefined ? { seq: 0, prev: "0" } : { seq: (JSON.parse(last) as ApprovalEvent).seq, prev: sha256(last) }
      }
      const entry: ApprovalEvent = { seq: this.#state.seq + 1, prev: this.#state.prev, ...event }
      const line = JSON.stringify(entry)
      await this.write(line)
      this.#state = { seq: entry.seq, prev: sha256(line) }
      return entry
    })
    this.#tail = run.catch(() => undefined)
    return run
  }

  async list(): Promise<readonly ApprovalEvent[]> {
    await this.#tail
    return (await this.load()).map((line) => JSON.parse(line) as ApprovalEvent)
  }
}

/** `<stateDir>/approvals.jsonl`, created 0600. */
export class FileApprovalLedger extends ChainedLedger {
  constructor(private readonly path: string) {
    super()
  }

  protected async load(): Promise<string[]> {
    try {
      return (await readFile(this.path, "utf8")).split("\n").filter((line) => line.length > 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }

  protected async write(line: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await appendFile(this.path, `${line}\n`, { encoding: "utf8", mode: 0o600 })
  }
}

export class InMemoryApprovalLedger extends ChainedLedger {
  readonly lines: string[] = []

  protected async load(): Promise<string[]> {
    return [...this.lines]
  }

  protected async write(line: string): Promise<void> {
    this.lines.push(line)
  }
}

/** Checks `seq` continuity and the hash chain of serialized ledger lines. */
export function verifyApprovalLedger(lines: readonly string[]): { ok: true } | { ok: false; line: number; reason: string } {
  let prev = "0"
  for (const [index, line] of lines.entries()) {
    let entry: ApprovalEvent
    try {
      entry = JSON.parse(line) as ApprovalEvent
    } catch {
      return { ok: false, line: index + 1, reason: "not JSON" }
    }
    if (entry.seq !== index + 1) return { ok: false, line: index + 1, reason: `seq ${entry.seq}, expected ${index + 1}` }
    if (entry.prev !== prev) return { ok: false, line: index + 1, reason: "hash chain broken" }
    prev = sha256(line)
  }
  return { ok: true }
}
