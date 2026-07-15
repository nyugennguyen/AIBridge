# Task Graph & Dependency Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution Mode:** Subagent-Driven Development — dispatch a fresh subagent per task, review between tasks, fast iteration. Each task is independent and can be executed in isolation.
>
> **Guardrails:** Each task includes guardrails (what could go wrong), rollback procedures (how to undo), and investigation steps (how to diagnose). Follow these strictly.

**Goal:** Add Hive-inspired task graph with dependency tracking to AIBridge, enabling multi-step workflows where jobs can wait for other jobs to complete before executing.

**Architecture:** New `tasks/` and `memory/` modules provide task graph parsing, syncing, and shared context. Existing `jobs/` module extended with `blocked` status and `depends_on` field. Trigger route gains dependency resolution logic. Monitor session gains unblock cascade on completion/failure.

**Tech Stack:** TypeScript, Zod (schema validation), Vitest (testing), Fastify (HTTP), existing AIBridge patterns

---

## Guardrails & Rollback Strategy

### Global Guardrails

| Risk | Prevention | Detection |
|------|------------|-----------|
| Breaking existing tests | Run full test suite after each task | `bun test` fails |
| Type errors introduced | Run typecheck after each change | `bun run typecheck` fails |
| Build breaks | Run build before committing | `bun run build` fails |
| Breaking API contracts | Schema changes are additive only | Integration tests fail |
| Infinite dependency loops | DFS cycle detection in `unblockDependents` | Timeout in tests |
| Data loss in task graph | Always read-modify-write, never overwrite | Missing tasks after sync |

### Per-Task Rollback Protocol

**Before each task:** Create a git checkpoint
```bash
git stash push -m "checkpoint: before task N"
```

**If task fails:** Rollback to checkpoint
```bash
git stash pop  # or git checkout -- <files>
```

**After successful task:** Commit and continue

### Investigation Checklist (When Tests Fail)

1. **Type errors:** Check `src/config/types.ts` — types are inferred from Zod schemas
2. **Import errors:** Verify `.js` extension on all local imports (ESM requirement)
3. **Test failures:** Run specific test with `--reporter=verbose` for details
4. **Integration failures:** Check `tests/integration/fixtures.ts` for missing dependencies
5. **Runtime errors:** Check `src/index.ts` for wiring issues

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `src/tasks/types.ts` | TaskEntry, TaskGraphSyncer interfaces |
| `src/tasks/parser.ts` | Parse `.aibridge/tasks.md` markdown format |
| `src/tasks/syncer.ts` | TaskGraphSyncer implementation |
| `src/memory/types.ts` | Decision, Handoff, MemoryStore interfaces |
| `src/memory/store.ts` | File-based MemoryStore implementation |
| `tests/unit/tasks/parser.test.ts` | Parser unit tests |
| `tests/unit/tasks/syncer.test.ts` | Syncer unit tests |
| `tests/unit/memory/store.test.ts` | MemoryStore unit tests |

### Modified Files

| File | Changes |
|------|---------|
| `src/jobs/types.ts` | Add `"blocked"` to JobStatus, add `depends_on?` to JobRecord |
| `src/jobs/store.ts` | Add `listByStatus()` to JobStore interface and implementation |
| `src/jobs/manager.ts` | Add `markBlocked()`, `unblockDependents()`, update `createJob()` |
| `src/config/schemas.ts` | Add `depends_on`, `task_id` to trigger schemas |
| `src/server/routes/trigger.ts` | Add dependency resolution logic |
| `src/index.ts` | Update monitorSession for unblock cascade |
| `src/server/app.ts` | Add taskGraphSyncer to AppDependencies |
| `tests/unit/jobs/fixtures.ts` | Add dependency test helpers |
| `tests/unit/jobs/manager.test.ts` | Add dependency resolution tests |
| `tests/integration/fixtures.ts` | Add dependency integration test helpers |
| `tests/integration/trigger-flow.test.ts` | Add blocked trigger flow tests |

---

## Task 1: Extend Job Types with Dependency Support

**Files:**
- Modify: `src/jobs/types.ts`
- Test: `tests/unit/jobs/manager.test.ts`

**Guardrails:**
- ⚠️ Adding new union member to `JobStatus` — all switch/match statements must handle it
- ⚠️ Adding optional field to `JobRecord` — existing JSON files won't have it (OK, it's optional)
- ✅ Safe: Change is additive, no existing code breaks

**Rollback:**
```bash
git checkout -- src/jobs/types.ts
```

**Investigation if fails:**
- Type errors in other files? → Check for exhaustive `JobStatus` handling
- Import errors? → Verify `types.ts` uses `.js` extension in import
- Existing tests break? → Check if test fixtures create jobs with explicit status

- [ ] **Step 1: Add `blocked` status and `depends_on` field to types**

```typescript
// src/jobs/types.ts
import type { TriggerRequest } from "../config/types.js"

export type JobStatus =
  | "received"
  | "accepted"
  | "blocked"        // NEW: waiting for dependencies
  | "session_created"
  | "running"
  | "reporting"
  | "completed"
  | "failed"
  | "timed_out"
  | "callback_failed"

export interface JobRecord {
  id: string
  trigger: TriggerRequest
  status: JobStatus
  opencodeSessionId?: string
  error?: string
  depends_on?: string[]      // NEW: dependency job IDs
  blockedAt?: string         // NEW: when entered blocked state
  createdAt: string
  updatedAt: string
}
```

- [ ] **Step 2: Run typecheck to verify types compile**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/jobs/types.ts
git commit -m "feat(jobs): add blocked status and depends_on field to JobRecord"
```

---

## Task 2: Extend Job Store with Status Query

**Files:**
- Modify: `src/jobs/store.ts`
- Test: `tests/unit/jobs/store.test.ts`

**Guardrails:**
- ⚠️ Interface change — `JsonFileJobStore` must implement new method
- ⚠️ Existing `InMemoryJobStore` in tests must also implement it
- ✅ Safe: New method, no existing code calls it yet

**Rollback:**
```bash
git checkout -- src/jobs/store.ts
```

**Investigation if fails:**
- "Class incorrectly implements interface" → Add `listByStatus` to `JsonFileJobStore`
- Test fixture errors? → Check `tests/integration/fixtures.ts` for `InMemoryJobStore`
- Performance issues? → `listByStatus` filters in-memory Map, should be fast

- [ ] **Step 1: Add `listByStatus` to JobStore interface**

```typescript
// src/jobs/store.ts (add to interface)
export interface JobStore {
  get(id: string): Promise<JobRecord | undefined>
  list(): Promise<JobRecord[]>
  listByStatus(status: JobStatus): Promise<JobRecord[]>  // NEW
  save(job: JobRecord): Promise<void>
}
```

- [ ] **Step 2: Implement `listByStatus` in JsonFileJobStore**

```typescript
// src/jobs/store.ts (add to class)
async listByStatus(status: JobStatus): Promise<JobRecord[]> {
  await this.ensureLoaded()
  return [...this.jobs.values()].filter((j) => j.status === status)
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Run existing store tests**

Run: `bun test tests/unit/jobs/store.test.ts`
Expected: All pass (no regressions)

- [ ] **Step 5: Commit**

```bash
git add src/jobs/store.ts
git commit -m "feat(jobs): add listByStatus query to JobStore"
```

---

## Task 3: Extend Job Manager with Dependency Methods

**Files:**
- Modify: `src/jobs/manager.ts`
- Test: `tests/unit/jobs/manager.test.ts`

**Guardrails:**
- ⚠️ `unblockDependents` has complex logic — must handle all edge cases
- ⚠️ Cascade failure must propagate correctly — one failed dep fails all dependents
- ⚠️ Race condition: multiple jobs completing simultaneously → use `getJob` fresh reads
- ✅ Safe: New methods, no existing code calls them yet

**Rollback:**
```bash
git checkout -- src/jobs/manager.ts
```

**Investigation if fails:**
- "Cannot transition terminal job" → Check `TERMINAL_STATUSES` includes new states correctly
- Infinite loop in `unblockDependents` → Add cycle detection (DFS with visited set)
- Missing dependencies? → Verify `depends_on` is populated correctly in test fixtures
- Cascade not working? → Check `markFailed` is called before `continue` in loop

- [ ] **Step 1: Add `markBlocked` method**

```typescript
// src/jobs/manager.ts (add to JobManager class)
async markBlocked(id: string, depends_on: string[], now = new Date().toISOString()): Promise<JobRecord> {
  return this.transition(id, "blocked", now, { depends_on, blockedAt: now })
}
```

- [ ] **Step 2: Add `unblockDependents` method**

```typescript
// src/jobs/manager.ts (add to JobManager class)
async unblockDependents(completedJobId: string, now = new Date().toISOString()): Promise<JobRecord[]> {
  const allJobs = await this.store.list()
  const unblocked: JobRecord[] = []

  // Find all blocked jobs that depend on the completed job
  const dependents = allJobs.filter(
    (j) => j.status === "blocked" && j.depends_on?.includes(completedJobId),
  )

  for (const job of dependents) {
    const deps = job.depends_on ?? []

    // Check all dependencies
    const depStatuses = await Promise.all(
      deps.map(async (depId) => {
        const dep = await this.store.get(depId)
        return { id: depId, status: dep?.status ?? "missing" }
      }),
    )

    // Any dependency failed/timed out → cascade failure
    const failedDep = depStatuses.find(
      (d) => d.status === "failed" || d.status === "timed_out",
    )
    if (failedDep) {
      await this.markFailed(job.id, `Dependency ${failedDep.id} ${failedDep.status}`, now)
      continue
    }

    // All dependencies completed → unblock
    const allCompleted = depStatuses.every((d) => d.status === "completed")
    if (allCompleted) {
      await this.transition(job.id, "accepted", now)
      unblocked.push(await this.getJob(job.id))
    }
  }

  return unblocked
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Run existing manager tests**

Run: `bun test tests/unit/jobs/manager.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/jobs/manager.ts
git commit -m "feat(jobs): add markBlocked and unblockDependents methods"
```

---

## Task 4: Add Dependency Tests to Job Manager

**Files:**
- Modify: `tests/unit/jobs/fixtures.ts`
- Modify: `tests/unit/jobs/manager.test.ts`

**Guardrails:**
- ⚠️ Tests must be isolated — each test creates fresh `JobManager` instance
- ⚠️ Test data must be deterministic — use fixed timestamps, not `Date.now()`
- ⚠️ Cascade tests must verify intermediate states — don't just check final state
- ✅ Safe: Tests only, no production code changes

**Rollback:**
```bash
git checkout -- tests/unit/jobs/fixtures.ts tests/unit/jobs/manager.test.ts
```

**Investigation if fails:**
- Tests pass individually but fail together? → Check for shared state between tests
- Timeout errors? → Add `jest.setTimeout()` or check for infinite loops
- Fixture errors? → Verify `validTrigger()` returns valid `TriggerRequest`
- Type errors in tests? → Import types from correct path with `.js` extension

- [ ] **Step 1: Add dependency test helpers to fixtures**

```typescript
// tests/unit/jobs/fixtures.ts (add these helpers)
export function triggerWithDeps(deps: string[], overrides: Partial<TriggerRequest> = {}): TriggerRequest {
  return { ...validTrigger(), depends_on: deps, ...overrides }
}
```

- [ ] **Step 2: Write test for `markBlocked`**

```typescript
// tests/unit/jobs/manager.test.ts
describe("markBlocked", () => {
  it("transitions job to blocked status with depends_on", async () => {
    const { manager } = createManager()
    const job = await manager.createJob(validTrigger())
    const blocked = await manager.markBlocked(job.id, ["dep-1", "dep-2"])

    expect(blocked.status).toBe("blocked")
    expect(blocked.depends_on).toEqual(["dep-1", "dep-2"])
    expect(blocked.blockedAt).toBeDefined()
  })

  it("throws if job is in terminal status", async () => {
    const { manager } = createManager()
    const job = await manager.createJob(validTrigger())
    await manager.markCompleted(job.id)

    await expect(manager.markBlocked(job.id, ["dep-1"])).rejects.toThrow("Cannot transition terminal job")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/jobs/manager.test.ts -t "markBlocked"`
Expected: FAIL (method doesn't exist yet)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/jobs/manager.test.ts -t "markBlocked"`
Expected: PASS

- [ ] **Step 5: Write test for `unblockDependents` unblocking**

```typescript
// tests/unit/jobs/manager.test.ts
describe("unblockDependents", () => {
  it("unblocks job when all dependencies completed", async () => {
    const { manager } = createManager()
    const dep1 = await manager.createJob(validTrigger())
    await manager.markCompleted(dep1.id)

    const blocked = await manager.createJob(triggerWithDeps([dep1.id]))
    await manager.markBlocked(blocked.id, [dep1.id])

    const unblocked = await manager.unblockDependents(dep1.id)
    expect(unblocked).toHaveLength(1)
    expect(unblocked[0].status).toBe("accepted")
  })

  it("does not unblock job when some dependencies pending", async () => {
    const { manager } = createManager()
    const dep1 = await manager.createJob(validTrigger())
    const dep2 = await manager.createJob(validTrigger())
    await manager.markCompleted(dep1.id)

    const blocked = await manager.createJob(triggerWithDeps([dep1.id, dep2.id]))
    await manager.markBlocked(blocked.id, [dep1.id, dep2.id])

    const unblocked = await manager.unblockDependents(dep1.id)
    expect(unblocked).toHaveLength(0)

    const job = await manager.getJob(blocked.id)
    expect(job.status).toBe("blocked")
  })

  it("cascade-fails job when dependency fails", async () => {
    const { manager } = createManager()
    const dep1 = await manager.createJob(validTrigger())
    await manager.markFailed(dep1.id, "dep failed")

    const blocked = await manager.createJob(triggerWithDeps([dep1.id]))
    await manager.markBlocked(blocked.id, [dep1.id])

    await manager.unblockDependents(dep1.id)
    const job = await manager.getJob(blocked.id)
    expect(job.status).toBe("failed")
    expect(job.error).toContain("dep failed")
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test tests/unit/jobs/manager.test.ts -t "unblockDependents"`
Expected: FAIL

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test tests/unit/jobs/manager.test.ts -t "unblockDependents"`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add tests/unit/jobs/fixtures.ts tests/unit/jobs/manager.test.ts
git commit -m "test(jobs): add dependency resolution tests"
```

---

## Task 5: Extend Trigger Schemas with Dependency Fields

**Files:**
- Modify: `src/config/schemas.ts`

**Guardrails:**
- ⚠️ Schema changes affect type inference — `TriggerRequest` type will change
- ⚠️ `depends_on` must have `.default([]).optional()` for backward compatibility
- ⚠️ `opencode_session_id` in response becomes optional — existing code may assume it exists
- ✅ Safe: Zod defaults ensure backward compatibility

**Rollback:**
```bash
git checkout -- src/config/schemas.ts
```

**Investigation if fails:**
- Type errors in `TriggerRequest` usage? → Check all places that destructure trigger
- Validation errors in tests? → Update test fixtures to include new fields
- Response schema errors? → Check `trigger.ts` route for `opencode_session_id` usage
- Existing integration tests fail? → Update fixtures to include `depends_on: []`

- [ ] **Step 1: Add `depends_on` and `task_id` to triggerRequestSchema**

```typescript
// src/config/schemas.ts (update triggerRequestSchema)
export const triggerRequestSchema = z.object({
  job_id: z.string().min(1).optional(),
  source_agent_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  capability: z.string().min(1),
  project_dir: z.string().min(1),
  prompt: z.string().min(1),
  callback_url: z.url(),
  timeout_seconds: z.number().int().positive(),
  depends_on: z.array(z.string().min(1)).default([]).optional(),  // NEW
  task_id: z.string().optional(),                                  // NEW
  metadata: planMetadataSchema,
})
```

- [ ] **Step 2: Update triggerResponseSchema to support blocked status**

```typescript
// src/config/schemas.ts (update triggerResponseSchema)
export const triggerResponseSchema = z.object({
  accepted: z.boolean(),
  job_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  opencode_session_id: z.string().min(1).optional(),  // CHANGED: optional for blocked
  status_url: z.url(),
  status: z.enum(["accepted", "blocked", "failed"]).optional(),  // NEW
  task_id: z.string().optional(),                                // NEW
})
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Run existing tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/config/schemas.ts
git commit -m "feat(config): add depends_on and task_id to trigger schemas"
```

---

## Task 6: Create Task Graph Types

**Files:**
- Create: `src/tasks/types.ts`

**Guardrails:**
- ⚠️ New module — ensure directory exists before creating file
- ⚠️ Types must match parser output exactly — verify field names and types
- ✅ Safe: New file, no existing code affected

**Rollback:**
```bash
rm src/tasks/types.ts
```

**Investigation if fails:**
- Import errors? → Check `src/tasks/` directory exists
- Type mismatches? → Compare with parser output in Task 7
- Circular imports? → `types.ts` should not import from other `tasks/` files

- [ ] **Step 1: Define TaskEntry and TaskGraphSyncer interfaces**

```typescript
// src/tasks/types.ts
export type TaskStatus = "pending" | "blocked" | "running" | "done" | "failed"

export interface TaskEntry {
  id: string           // #1, #2, etc.
  title: string
  agent?: string
  status: TaskStatus
  depends_on: string[] // task IDs (#1, #2)
  job_id?: string      // correlated JobRecord ID
  metadata: Record<string, string>
}

export interface TaskGraphSyncer {
  getTasks(): Promise<TaskEntry[]>
  syncJobToTask(jobId: string, status: string, metadata?: Record<string, string>): Promise<void>
  parseTaskDependencies(): Promise<Map<string, string[]>>
  startWatching(): void
  stopWatching(): void
}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/tasks/types.ts
git commit -m "feat(tasks): add TaskEntry and TaskGraphSyncer interfaces"
```

---

## Task 7: Implement Task Graph Parser

**Files:**
- Create: `src/tasks/parser.ts`
- Create: `tests/unit/tasks/parser.test.ts`

**Guardrails:**
- ⚠️ Regex must handle all task formats — test edge cases thoroughly
- ⚠️ Parser must be robust to malformed input — never throw, return partial results
- ⚠️ Task IDs must be consistent (#1, #2, etc.) — parser must preserve format
- ✅ Safe: Pure function, no side effects

**Rollback:**
```bash
rm src/tasks/parser.ts tests/unit/tasks/parser.test.ts
```

**Investigation if fails:**
- Regex not matching? → Test regex separately with `console.log(TASK_HEADING_RE.exec(line))`
- Missing metadata? → Check bullet point parsing logic
- Edge cases failing? → Test with empty lines, missing fields, extra whitespace
- Performance issues? → Parser processes line-by-line, should be O(n)

- [ ] **Step 1: Write failing test for parser**

```typescript
// tests/unit/tasks/parser.test.ts
import { describe, it, expect } from "vitest"
import { parseTasks } from "../../src/tasks/parser.js"

describe("parseTasks", () => {
  it("parses task with status and agent", () => {
    const md = `## #1 Implement auth [agent:mac-dev] [status:done]
- Completed: 2026-06-23`
    const tasks = parseTasks(md)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toEqual(expect.objectContaining({
      id: "#1",
      title: "Implement auth",
      agent: "mac-dev",
      status: "done",
      depends_on: [],
    }))
  })

  it("parses task with dependencies", () => {
    const md = `## #2 Deploy [agent:vps] [status:running] [needs: #1]
- Started: 2026-06-23`
    const tasks = parseTasks(md)
    expect(tasks[0].depends_on).toEqual(["#1"])
  })

  it("parses multiple tasks", () => {
    const md = `## #1 Task A [status:done]
## #2 Task B [status:running] [needs: #1]
## #3 Task C [status:blocked] [needs: #1, #2]`
    const tasks = parseTasks(md)
    expect(tasks).toHaveLength(3)
    expect(tasks[2].depends_on).toEqual(["#1", "#2"])
  })

  it("returns empty array for empty input", () => {
    expect(parseTasks("")).toEqual([])
    expect(parseTasks("# Title\nNo tasks here")).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/tasks/parser.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement parser**

```typescript
// src/tasks/parser.ts
import type { TaskEntry, TaskStatus } from "./types.js"

const TASK_HEADING_RE = /^## #(\d+)\s+(.+?)(?:\s+\[agent:([^\]]+)\])?(?:\s+\[status:([^\]]+)\])?(?:\s+\[needs:\s*([^\]]+)\])?\s*$/

export function parseTasks(markdown: string): TaskEntry[] {
  const lines = markdown.split("\n")
  const tasks: TaskEntry[] = []
  let current: TaskEntry | null = null

  for (const line of lines) {
    const headingMatch = TASK_HEADING_RE.exec(line)
    if (headingMatch) {
      if (current) tasks.push(current)
      const [, id, title, agent, status, needsStr] = headingMatch
      const depends_on = needsStr
        ? needsStr.split(",").map((s) => s.trim()).filter(Boolean)
        : []
      current = {
        id: `#${id}`,
        title: title.trim(),
        agent: agent ?? undefined,
        status: (status as TaskStatus) ?? "pending",
        depends_on,
        metadata: {},
      }
      continue
    }

    if (current && line.startsWith("- ")) {
      const [key, ...valueParts] = line.slice(2).split(":")
      if (key && valueParts.length > 0) {
        current.metadata[key.trim()] = valueParts.join(":").trim()
      }
    }
  }

  if (current) tasks.push(current)
  return tasks
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/tasks/parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tasks/parser.ts tests/unit/tasks/parser.test.ts
git commit -m "feat(tasks): implement task graph markdown parser"
```

---

## Task 8: Implement Task Graph Syncer

**Files:**
- Create: `src/tasks/syncer.ts`
- Create: `tests/unit/tasks/syncer.test.ts`

**Guardrails:**
- ⚠️ File I/O must handle missing files gracefully — return empty array
- ⚠️ Sync must be atomic — read full file, modify, write full file
- ⚠️ Concurrent syncs could cause data loss — use file locking or serialize access
- ⚠️ Task ID format must match parser output (#1, #2, etc.)
- ✅ Safe: New file, isolated from existing code

**Rollback:**
```bash
rm src/tasks/syncer.ts tests/unit/tasks/syncer.test.ts
```

**Investigation if fails:**
- File not found errors? → Check `mkdir` is called before `writeFile`
- Data loss after sync? → Verify read-modify-write pattern, not overwrite
- Task not found? → Check task ID format matches (#1 vs 1)
- Concurrent access issues? → Add mutex or queue for file operations
- Test flakiness? → Use unique temp directories per test

- [ ] **Step 1: Write failing test for syncer**

```typescript
// tests/unit/tasks/syncer.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileTaskGraphSyncer } from "../../src/tasks/syncer.js"

describe("FileTaskGraphSyncer", () => {
  let dir: string
  let tasksPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aibridge-test-"))
    tasksPath = join(dir, "tasks.md")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("reads tasks from file", async () => {
    await writeFile(tasksPath, `## #1 Test [status:done]\n- Key: value`, "utf8")
    const syncer = new FileTaskGraphSyncer(tasksPath)
    const tasks = await syncer.getTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe("#1")
  })

  it("returns empty array when file missing", async () => {
    const syncer = new FileTaskGraphSyncer(tasksPath)
    const tasks = await syncer.getTasks()
    expect(tasks).toEqual([])
  })

  it("syncJobToTask updates existing task status", async () => {
    await writeFile(tasksPath, `## #1 Test [status:running]`, "utf8")
    const syncer = new FileTaskGraphSyncer(tasksPath)
    await syncer.syncJobToTask("#1", "done", { Job: "job-123" })

    const content = await readFile(tasksPath, "utf8")
    expect(content).toContain("[status:done]")
    expect(content).toContain("Job: job-123")
  })

  it("syncJobToTask appends new task if not found", async () => {
    await writeFile(tasksPath, `## #1 Existing [status:done]`, "utf8")
    const syncer = new FileTaskGraphSyncer(tasksPath)
    await syncer.syncJobToTask("#2", "running", { Agent: "test-vps" })

    const content = await readFile(tasksPath, "utf8")
    expect(content).toContain("## #2")
    expect(content).toContain("[status:running]")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/tasks/syncer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement syncer**

```typescript
// src/tasks/syncer.ts
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { TaskEntry, TaskGraphSyncer } from "./types.js"
import { parseTasks } from "./parser.js"

export class FileTaskGraphSyncer implements TaskGraphSyncer {
  constructor(private readonly filePath: string) {}

  async getTasks(): Promise<TaskEntry[]> {
    try {
      const content = await readFile(this.filePath, "utf8")
      return parseTasks(content)
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return []
      }
      throw error
    }
  }

  async syncJobToTask(taskId: string, status: string, metadata: Record<string, string> = {}): Promise<void> {
    const tasks = await this.getTasks()
    const existing = tasks.find((t) => t.id === taskId)

    if (existing) {
      // Update existing task
      existing.status = status as TaskEntry["status"]
      Object.assign(existing.metadata, metadata)
    } else {
      // Append new task
      tasks.push({
        id: taskId,
        title: `Task ${taskId}`,
        status: status as TaskEntry["status"],
        depends_on: [],
        metadata,
      })
    }

    const content = this.serializeTasks(tasks)
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, content, "utf8")
  }

  async parseTaskDependencies(): Promise<Map<string, string[]>> {
    const tasks = await this.getTasks()
    const deps = new Map<string, string[]>()
    for (const task of tasks) {
      deps.set(task.id, task.depends_on)
    }
    return deps
  }

  startWatching(): void {
    // POC: no-op, future: chokidar watch
  }

  stopWatching(): void {
    // POC: no-op
  }

  private serializeTasks(tasks: TaskEntry[]): string {
    const lines: string[] = ["# Project Tasks", ""]
    for (const task of tasks) {
      const agentPart = task.agent ? ` [agent:${task.agent}]` : ""
      const needsPart = task.depends_on.length > 0 ? ` [needs: ${task.depends_on.join(", ")}]` : ""
      lines.push(`## ${task.id} ${task.title}${agentPart} [status:${task.status}]${needsPart}`)
      for (const [key, value] of Object.entries(task.metadata)) {
        lines.push(`- ${key}: ${value}`)
      }
      lines.push("")
    }
    return lines.join("\n")
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/tasks/syncer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tasks/syncer.ts tests/unit/tasks/syncer.test.ts
git commit -m "feat(tasks): implement FileTaskGraphSyncer"
```

---

## Task 9: Create Memory Store Types and Implementation

**Files:**
- Create: `src/memory/types.ts`
- Create: `src/memory/store.ts`
- Create: `tests/unit/memory/store.test.ts`

**Guardrails:**
- ⚠️ JSON persistence must handle corrupt files — catch parse errors, return defaults
- ⚠️ Handoff IDs must be unique — use `randomUUID()`
- ⚠️ File writes must be atomic — use temp file + rename pattern
- ✅ Safe: New module, no existing code affected

**Rollback:**
```bash
rm -rf src/memory/ tests/unit/memory/
```

**Investigation if fails:**
- JSON parse errors? → Add try/catch in `ensureLoaded()`, return default data
- Missing directory? → Verify `mkdir` with `recursive: true`
- Data not persisting? → Check file write is awaited and path is correct
- Test isolation issues? → Each test uses unique temp directory

- [ ] **Step 1: Define memory types**

```typescript
// src/memory/types.ts
export interface Decision {
  id: string
  timestamp: string
  agent: string
  content: string
}

export interface Handoff {
  id: string
  from: string
  to: string
  context: string
  status: "pending" | "accepted" | "completed"
  createdAt: string
}

export interface MemoryStore {
  getProjectId(): Promise<string>
  getDecisions(): Promise<Decision[]>
  addDecision(decision: Decision): Promise<void>
  getConstraints(): Promise<string[]>
  addConstraint(constraint: string): Promise<void>
  createHandoff(handoff: Omit<Handoff, "id" | "status" | "createdAt">): Promise<Handoff>
  getPendingHandoffs(agentId: string): Promise<Handoff[]>
}
```

- [ ] **Step 2: Write failing test for store**

```typescript
// tests/unit/memory/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileMemoryStore } from "../../src/memory/store.js"

describe("FileMemoryStore", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aibridge-test-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("returns empty decisions initially", async () => {
    const store = new FileMemoryStore(dir, "github.com:test/repo")
    expect(await store.getDecisions()).toEqual([])
  })

  it("adds and retrieves decisions", async () => {
    const store = new FileMemoryStore(dir, "github.com:test/repo")
    await store.addDecision({ id: "d1", timestamp: "2026-06-23", agent: "dev", content: "Use bcrypt" })
    const decisions = await store.getDecisions()
    expect(decisions).toHaveLength(1)
    expect(decisions[0].content).toBe("Use bcrypt")
  })

  it("returns project id", async () => {
    const store = new FileMemoryStore(dir, "github.com:test/repo")
    expect(await store.getProjectId()).toBe("github.com:test/repo")
  })

  it("manages constraints", async () => {
    const store = new FileMemoryStore(dir, "github.com:test/repo")
    expect(await store.getConstraints()).toEqual([])
    await store.addConstraint("No DB changes without approval")
    expect(await store.getConstraints()).toEqual(["No DB changes without approval"])
  })

  it("creates and retrieves handoffs", async () => {
    const store = new FileMemoryStore(dir, "github.com:test/repo")
    const handoff = await store.createHandoff({ from: "dev", to: "test", context: "Auth complete" })
    expect(handoff.id).toBeDefined()
    expect(handoff.status).toBe("pending")

    const pending = await store.getPendingHandoffs("test")
    expect(pending).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/memory/store.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement store**

```typescript
// src/memory/store.ts
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { Decision, Handoff, MemoryStore } from "./types.js"

interface MemoryData {
  projectId: string
  decisions: Decision[]
  constraints: string[]
  handoffs: Handoff[]
}

export class FileMemoryStore implements MemoryStore {
  private readonly dataPath: string
  private data: MemoryData | null = null

  constructor(private readonly directory: string, private readonly projectId: string) {
    this.dataPath = join(directory, "memory.json")
  }

  async getProjectId(): Promise<string> {
    return this.projectId
  }

  async getDecisions(): Promise<Decision[]> {
    await this.ensureLoaded()
    return this.data!.decisions
  }

  async addDecision(decision: Decision): Promise<void> {
    await this.ensureLoaded()
    this.data!.decisions.push(decision)
    await this.save()
  }

  async getConstraints(): Promise<string[]> {
    await this.ensureLoaded()
    return this.data!.constraints
  }

  async addConstraint(constraint: string): Promise<void> {
    await this.ensureLoaded()
    this.data!.constraints.push(constraint)
    await this.save()
  }

  async createHandoff(handoff: Omit<Handoff, "id" | "status" | "createdAt">): Promise<Handoff> {
    await this.ensureLoaded()
    const full: Handoff = {
      ...handoff,
      id: randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
    }
    this.data!.handoffs.push(full)
    await this.save()
    return full
  }

  async getPendingHandoffs(agentId: string): Promise<Handoff[]> {
    await this.ensureLoaded()
    return this.data!.handoffs.filter((h) => h.to === agentId && h.status === "pending")
  }

  private async ensureLoaded(): Promise<void> {
    if (this.data) return
    try {
      const raw = await readFile(this.dataPath, "utf8")
      this.data = JSON.parse(raw)
    } catch {
      this.data = { projectId: this.projectId, decisions: [], constraints: [], handoffs: [] }
    }
  }

  private async save(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await writeFile(this.dataPath, JSON.stringify(this.data, null, 2), "utf8")
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/memory/store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/memory/types.ts src/memory/store.ts tests/unit/memory/store.test.ts
git commit -m "feat(memory): implement FileMemoryStore for shared context"
```

---

## Task 10: Update Trigger Route with Dependency Resolution

**Files:**
- Modify: `src/server/routes/trigger.ts`
- Modify: `src/server/app.ts`

**Guardrails:**
- ⚠️ This is the critical integration point — must handle all edge cases
- ⚠️ Dependency validation must happen BEFORE job creation
- ⚠️ Blocked jobs must NOT create opencode sessions
- ⚠️ Response schema changed — `opencode_session_id` now optional
- ⚠️ Error responses must be consistent with existing patterns
- 🔴 HIGH RISK: This changes the core trigger flow — test thoroughly

**Rollback:**
```bash
git checkout -- src/server/routes/trigger.ts src/server/app.ts
```

**Investigation if fails:**
- 400 errors in existing tests? → Check if fixtures include `depends_on: []`
- 500 errors? → Check error handling in dependency validation
- Blocked jobs executing? → Verify `hasDeps` check is before session creation
- Response validation errors? → Check `triggerResponseSchema` handles optional fields
- Integration tests fail? → Update fixtures to include `taskGraphSyncer` mock

- [ ] **Step 1: Add taskGraphSyncer to AppDependencies**

```typescript
// src/server/app.ts
import type { TaskGraphSyncer } from "../tasks/types.js"

export interface AppDependencies {
  config: BridgeConfig
  jobManager: JobManager
  opencodeClient: OpencodeClient
  callbackReporter: CallbackReporter
  monitorSession: (job: JobRecord) => Promise<void>
  reports: ReportCallback[]
  taskGraphSyncer: TaskGraphSyncer  // NEW
}
```

- [ ] **Step 2: Update trigger route with dependency logic**

```typescript
// src/server/routes/trigger.ts (replace the try block starting at line 32)
try {
  const { depends_on, task_id, ...triggerData } = trigger
  const hasDeps = depends_on && depends_on.length > 0

  // Validate dependencies exist
  if (hasDeps) {
    for (const depId of depends_on!) {
      try {
        await dependencies.jobManager.getJob(depId)
      } catch {
        return reply.code(400).send({ error: `Dependency job not found: ${depId}` })
      }
    }
  }

  // Create job
  const job = await dependencies.jobManager.createJob(triggerData)

  // Check if dependencies are all completed
  if (hasDeps) {
    const allCompleted = await Promise.all(
      depends_on!.map(async (depId) => {
        const dep = await dependencies.jobManager.getJob(depId)
        return dep.status === "completed"
      }),
    )

    if (!allCompleted.every(Boolean)) {
      // Some dependencies not met → block
      await dependencies.jobManager.markBlocked(job.id, depends_on!)
      await dependencies.taskGraphSyncer.syncJobToTask(task_id ?? `#${job.id}`, "blocked", {
        Job: job.id,
      })

      return reply.code(202).send(
        triggerResponseSchema.parse({
          accepted: true,
          job_id: job.id,
          target_agent_id: dependencies.config.agent_id,
          status_url: `${dependencies.config.bridge.public_url}/jobs/${job.id}`,
          status: "blocked",
          task_id: task_id,
        }),
      )
    }
  }

  // Execute immediately (no deps or all completed)
  const session = await dependencies.opencodeClient.createSession(`AIBridge ${job.id}`, triggerData.project_dir)
  await dependencies.jobManager.attachSession(job.id, session.id)
  await dependencies.opencodeClient.sendPromptAsync(session.id, triggerData.prompt, triggerData.project_dir)
  const running = await dependencies.jobManager.markRunning(job.id)

  await dependencies.taskGraphSyncer.syncJobToTask(task_id ?? `#${job.id}`, "running", {
    Job: job.id,
    Session: session.id,
  })

  void dependencies.monitorSession(running).catch(async (error: unknown) => {
    await dependencies.jobManager.markFailed(job.id, error instanceof Error ? error.message : "Session monitor failed")
  })

  return reply.code(202).send(
    triggerResponseSchema.parse({
      accepted: true,
      job_id: job.id,
      target_agent_id: dependencies.config.agent_id,
      opencode_session_id: session.id,
      status_url: `${dependencies.config.bridge.public_url}/jobs/${job.id}`,
      status: "accepted",
      task_id: task_id,
    }),
  )
} catch (error) {
  const message = error instanceof Error ? error.message : "Trigger failed"
  if (message.includes("already exists")) return reply.code(409).send({ error: message })
  return reply.code(500).send({ error: message })
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Run existing tests**

Run: `bun test`
Expected: All pass (may need to update fixtures)

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/routes/trigger.ts
git commit -m "feat(trigger): add dependency resolution to trigger route"
```

---

## Task 11: Update Monitor Session with Unblock Cascade

**Files:**
- Modify: `src/index.ts`

**Guardrails:**
- ⚠️ This is the second critical integration point — cascade must work correctly
- ⚠️ Unblock must happen AFTER `markCompleted` or `markFailed`, not before
- ⚠️ Unblocked jobs must execute immediately — don't just mark as accepted
- ⚠️ Errors in unblock cascade must not fail the original job
- ⚠️ Recursive unblock: job A completes → unblocks B → B completes → unblocks C
- 🔴 HIGH RISK: Async cascade logic — test with multi-level dependencies

**Rollback:**
```bash
git checkout -- src/index.ts
```

**Investigation if fails:**
- Cascade not triggering? → Check `unblockDependents` is called after both success and failure
- Unblocked jobs not executing? → Verify session creation and prompt send in loop
- Infinite cascade? → Add depth limit or cycle detection
- Original job marked wrong? → Ensure `markCompleted`/`markFailed` happens before unblock
- Import errors? → Verify `FileTaskGraphSyncer` import path

- [ ] **Step 1: Update monitorSession to unblock dependents**

```typescript
// src/index.ts (update monitorSession closure)
monitorSession: async (job) => {
  if (!job.opencodeSessionId) throw new Error(`Job ${job.id} has no opencode session`)
  try {
    await waitForIdle(opencodeClient, job.opencodeSessionId, {
      directory: job.trigger.project_dir,
      timeoutMs: job.trigger.timeout_seconds * 1000,
      pollIntervalMs: 1000,
      permissionPolicy: new StaticPermissionPolicy(config.permissions),
      planMetadata: job.trigger.metadata,
    })
    await jobManager.markCompleted(job.id)
    await taskGraphSyncer.syncJobToTask(job.trigger.task_id ?? `#${job.id}`, "done")
  } catch (error) {
    await jobManager.markFailed(job.id, error instanceof Error ? error.message : "Session failed")
    await taskGraphSyncer.syncJobToTask(job.trigger.task_id ?? `#${job.id}`, "failed")
  }

  // Unblock dependents (works for both success and failure)
  const unblockedJobs = await jobManager.unblockDependents(job.id)
  for (const unblocked of unblockedJobs) {
    // Execute unblocked job
    try {
      const session = await opencodeClient.createSession(`AIBridge ${unblocked.id}`, unblocked.trigger.project_dir)
      await jobManager.attachSession(unblocked.id, session.id)
      await opencodeClient.sendPromptAsync(session.id, unblocked.trigger.prompt, unblocked.trigger.project_dir)
      const running = await jobManager.markRunning(unblocked.id)
      void dependencies.monitorSession(running).catch(async (err: unknown) => {
        await jobManager.markFailed(unblocked.id, err instanceof Error ? err.message : "Session monitor failed")
      })
    } catch (err) {
      await jobManager.markFailed(unblocked.id, err instanceof Error ? err.message : "Execution failed")
    }
  }
},
```

- [ ] **Step 2: Add taskGraphSyncer to app creation**

```typescript
// src/index.ts (add imports and instantiation)
import { FileTaskGraphSyncer } from "./tasks/syncer.js"

// After jobManager creation:
const taskGraphSyncer = new FileTaskGraphSyncer(".aibridge/tasks.md")

// Add to createApp call:
const app = createApp({
  config,
  jobManager,
  opencodeClient,
  callbackReporter: new CallbackReporter({ attempts: config.timeouts.callback_retry_attempts, baseDelayMs: 250 }),
  reports: [],
  taskGraphSyncer,  // NEW
  monitorSession: async (job) => { /* ... */ },
})
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(monitor): add unblock cascade and task graph sync"
```

---

## Task 12: Add Integration Tests for Dependency Flow

**Files:**
- Modify: `tests/integration/fixtures.ts`
- Modify: `tests/integration/trigger-flow.test.ts`

**Guardrails:**
- ⚠️ Integration tests must use real `JobManager`, not mocks
- ⚠️ Test isolation: each test must create fresh app instance
- ⚠️ Mock `taskGraphSyncer` must implement full interface
- ⚠️ Test both happy path AND error cases (missing deps, failed deps)
- ✅ Safe: Tests only, no production code changes

**Rollback:**
```bash
git checkout -- tests/integration/fixtures.ts tests/integration/trigger-flow.test.ts
```

**Investigation if fails:**
- Fixture errors? → Check `InMemoryJobStore` implements `listByStatus`
- Mock errors? → Verify `taskGraphSyncer` mock has all required methods
- Test flakiness? → Check for shared state between tests
- Timeout errors? → Integration tests may be slow, increase timeout

- [ ] **Step 1: Update test fixtures with taskGraphSyncer**

```typescript
// tests/integration/fixtures.ts (update buildTestApp)
import { FileTaskGraphSyncer } from "../../src/tasks/syncer.js"

export function buildTestApp(overrides: Partial<AppDependencies> = {}): FastifyInstance {
  const taskGraphSyncer = overrides.taskGraphSyncer ?? {
    getTasks: async () => [],
    syncJobToTask: async () => {},
    parseTaskDependencies: async () => new Map(),
    startWatching: () => {},
    stopWatching: () => {},
  }

  return createApp({
    config: testConfig(),
    jobManager: overrides.jobManager ?? new JobManager(new InMemoryJobStore()),
    opencodeClient: overrides.opencodeClient ?? fakeOpencodeClient(),
    callbackReporter: overrides.callbackReporter ?? { send: async () => {} },
    reports: overrides.reports ?? [],
    taskGraphSyncer,
    monitorSession: overrides.monitorSession ?? (async () => {}),
  })
}
```

- [ ] **Step 2: Write integration test for blocked trigger**

```typescript
// tests/integration/trigger-flow.test.ts
describe("dependency resolution", () => {
  it("returns blocked status when dependencies not met", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    const dep = await jobManager.createJob(validTrigger())
    // dep is still "accepted", not completed

    const app = buildTestApp({ jobManager })
    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer test-token" },
      payload: {
        ...validTrigger(),
        depends_on: [dep.id],
        task_id: "#2",
      },
    })

    expect(response.statusCode).toBe(202)
    const body = response.json()
    expect(body.status).toBe("blocked")
    expect(body.opencode_session_id).toBeUndefined()
  })

  it("executes immediately when all dependencies completed", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    const dep = await jobManager.createJob(validTrigger())
    await jobManager.markCompleted(dep.id)

    const opencodeClient = fakeOpencodeClient()
    const app = buildTestApp({ jobManager, opencodeClient })

    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer test-token" },
      payload: {
        ...validTrigger(),
        depends_on: [dep.id],
      },
    })

    expect(response.statusCode).toBe(202)
    const body = response.json()
    expect(body.status).toBe("accepted")
    expect(body.opencode_session_id).toBeDefined()
  })

  it("returns 400 when dependency job not found", async () => {
    const app = buildTestApp()
    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer test-token" },
      payload: {
        ...validTrigger(),
        depends_on: ["nonexistent-job"],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain("Dependency job not found")
  })
})
```

- [ ] **Step 3: Run integration tests**

Run: `bun test tests/integration/trigger-flow.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/integration/fixtures.ts tests/integration/trigger-flow.test.ts
git commit -m "test(integration): add dependency resolution integration tests"
```

---

## Task 13: Final Verification

**Guardrails:**
- ⚠️ This is the final gate — ALL checks must pass before considering work complete
- ⚠️ Don't skip any verification step — each catches different issues
- ⚠️ If any check fails, investigate and fix before proceeding

**Rollback:**
If verification fails and fix is unclear:
```bash
git log --oneline -10  # Find last good commit
git diff HEAD~N        # See what changed
```

**Investigation if fails:**
- Tests fail? → Run failing test individually with `--reporter=verbose`
- Type errors? → Check recent changes to schemas or types
- Build fails? → Check for syntax errors or missing imports
- Task graph parsing issues? → Test parser with real `.aibridge/tasks.md` content

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 3: Run build**

Run: `bun run build`
Expected: Clean build

- [ ] **Step 4: Verify task graph format matches design**

Create `.aibridge/tasks.md` manually with this content:
```markdown
# Project Tasks

## #1 Implement auth [agent:mac-dev] [status:done]
- Completed: 2026-06-23
- Job: test-job-1

## #2 Deploy [agent:vps] [status:running] [needs: #1]
- Started: 2026-06-23

## #3 Test [agent:mac-dev] [status:blocked] [needs: #2]
- Waiting for deploy
```

Then verify parser handles it:
```typescript
import { parseTasks } from "./src/tasks/parser.js"
import { readFile } from "node:fs/promises"
const content = await readFile(".aibridge/tasks.md", "utf8")
const tasks = parseTasks(content)
console.log(JSON.stringify(tasks, null, 2))
```

Expected output:
```json
[
  {"id": "#1", "title": "Implement auth", "agent": "mac-dev", "status": "done", "depends_on": [], "metadata": {"Completed": "2026-06-23", "Job": "test-job-1"}},
  {"id": "#2", "title": "Deploy", "agent": "vps", "status": "running", "depends_on": ["#1"], "metadata": {"Started": "2026-06-23"}},
  {"id": "#3", "title": "Test", "agent": "mac-dev", "status": "blocked", "depends_on": ["#2"], "metadata": {"Waiting for deploy"}}
]
```

- [ ] **Step 5: Verify dependency resolution end-to-end**

Run this test scenario:
1. Create job A (no dependencies) → should execute immediately
2. Create job B (depends on A) → should be blocked
3. Complete job A → should unblock B and execute it
4. Verify B transitions: blocked → accepted → running → completed

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete task graph and dependency tracking implementation"
```

---

## Summary

| Task | Component | Files Changed |
|------|-----------|---------------|
| 1 | Job types | `src/jobs/types.ts` |
| 2 | Job store | `src/jobs/store.ts` |
| 3 | Job manager | `src/jobs/manager.ts` |
| 4 | Job tests | `tests/unit/jobs/*` |
| 5 | Config schemas | `src/config/schemas.ts` |
| 6 | Task types | `src/tasks/types.ts` |
| 7 | Task parser | `src/tasks/parser.ts`, tests |
| 8 | Task syncer | `src/tasks/syncer.ts`, tests |
| 9 | Memory store | `src/memory/*`, tests |
| 10 | Trigger route | `src/server/routes/trigger.ts` |
| 11 | Monitor | `src/index.ts` |
| 12 | Integration tests | `tests/integration/*` |
| 13 | Verification | All |

**New modules:** `tasks/`, `memory/`
**Modified modules:** `jobs/`, `config/`, `server/`
**New test files:** 4
**Modified test files:** 4
