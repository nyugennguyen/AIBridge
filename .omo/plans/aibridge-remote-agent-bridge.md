# AIBridge Remote Agent Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript POC that lets a development opencode agent trigger a testing VPS opencode agent over Tailscale, create a fresh remote session, monitor it through opencode events, handle permissions safely, and receive a structured report callback.

**Architecture:** AIBridge is a Fastify service running on each machine. The POC uses static config for `dev-main` and `test-vps`, validates bearer auth plus source-agent authorization, persists job state as JSON files, talks to persistent `opencode serve` through `@opencode-ai/sdk/v2`, monitors `session.status` SSE events with polling fallback, and gates sensitive work through Plan Annotator metadata. Mesh readiness comes from explicit interfaces for registry, routing, job store, transport, auth, plan review, and permission policy.

**Tech Stack:** Node.js, TypeScript, Fastify, Zod, Vitest, `@opencode-ai/sdk/v2`, pino/Fastify structured logging, tmux, Tailscale.

---

## File Structure

Create or update this structure:

```text
package.json
tsconfig.json
vitest.config.ts
.gitignore
README.md
config/dev-main.example.json
config/test-vps.example.json
scripts/tmux-start.sh
src/index.ts
src/config/schemas.ts
src/config/loader.ts
src/config/types.ts
src/server/app.ts
src/server/routes/health.ts
src/server/routes/trigger.ts
src/server/routes/report.ts
src/server/routes/jobs.ts
src/security/auth-provider.ts
src/security/source-authorization.ts
src/security/allowlist.ts
src/opencode/client.ts
src/opencode/monitor.ts
src/opencode/permissions.ts
src/opencode/types.ts
src/jobs/types.ts
src/jobs/store.ts
src/jobs/manager.ts
src/registry/types.ts
src/registry/config-registry.ts
src/registry/router.ts
src/callback/types.ts
src/callback/reporter.ts
src/planning/types.ts
src/planning/provider.ts
tests/unit/config/schemas.test.ts
tests/unit/security/auth-provider.test.ts
tests/unit/security/source-authorization.test.ts
tests/unit/security/allowlist.test.ts
tests/unit/jobs/manager.test.ts
tests/unit/jobs/store.test.ts
tests/unit/registry/router.test.ts
tests/unit/callback/reporter.test.ts
tests/unit/planning/provider.test.ts
tests/unit/opencode/permissions.test.ts
tests/integration/trigger-flow.test.ts
tests/integration/report-flow.test.ts
```

## Execution Tasks

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Create package metadata**

Write `package.json`:

```json
{
  "name": "aibridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@opencode-ai/sdk": "latest",
    "fastify": "latest",
    "pino": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

- [ ] **Step 2: Create compiler and test config**

Write `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

Write `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
})
```

Write `.gitignore`:

```gitignore
node_modules/
dist/
.env
.DS_Store
.aibridge/jobs/
```

- [ ] **Step 3: Verify scaffold**

Run: `bun install`

Expected: dependencies install and lockfile is created.

Run: `bun run typecheck`

Expected: exits 0 after source files exist, or reports missing inputs before source files are created.

### Task 2: Schemas and Shared Types

**Files:**
- Create: `src/config/schemas.ts`
- Create: `src/config/types.ts`
- Create: `src/jobs/types.ts`
- Create: `src/callback/types.ts`
- Create: `src/planning/types.ts`
- Test: `tests/unit/config/schemas.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `tests/unit/config/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { bridgeConfigSchema, triggerRequestSchema, triggerResponseSchema } from "../../../src/config/schemas"

describe("AIBridge schemas", () => {
  it("accepts source authorization, permission policy, and planning config", () => {
    const parsed = bridgeConfigSchema.parse({
      agent_id: "test-vps",
      bridge: { host: "0.0.0.0", port: 8787, public_url: "http://test-vps.tailnet:8787" },
      opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096, username: "opencode", password_env: "OPENCODE_SERVER_PASSWORD" },
      security: {
        auth_mode: "bearer-token",
        bearer_token: "secret",
        allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["testing"], requires_plan_approval: ["deployment"] }]
      },
      permissions: { default_response: "reject", allow_tools: ["read", "grep", "glob"], require_plan_approval_for_tools: ["bash", "edit", "write"] },
      projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["testing"] }],
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787", capabilities: ["development"] }],
      timeouts: { default_job_seconds: 1800, callback_retry_attempts: 3 },
      planning: { plan_annotator_enabled: true, require_approval_for: ["deployment", "multi-agent-fanout"] }
    })

    expect(parsed.security.allowed_sources[0].source_agent_id).toBe("dev-main")
  })

  it("validates approved plan metadata on trigger requests", () => {
    const parsed = triggerRequestSchema.parse({
      source_agent_id: "dev-main",
      target_agent_id: "test-vps",
      capability: "testing",
      project_dir: "/srv/apps/app",
      prompt: "Run tests and report failures.",
      callback_url: "http://dev-main.tailnet:8787/report",
      timeout_seconds: 1800,
      metadata: { plan_status: "approved", plan_reference: ".omo/plans/test.md" }
    })

    expect(parsed.metadata?.plan_status).toBe("approved")
  })

  it("validates immediate trigger response shape", () => {
    const parsed = triggerResponseSchema.parse({
      accepted: true,
      job_id: "job_1",
      target_agent_id: "test-vps",
      opencode_session_id: "ses_1",
      status_url: "http://test-vps.tailnet:8787/jobs/job_1"
    })

    expect(parsed.accepted).toBe(true)
  })
})
```

Run: `bun test tests/unit/config/schemas.test.ts`

Expected: FAIL because schema files do not exist.

- [ ] **Step 2: Implement schemas**

Create `src/config/schemas.ts`:

```ts
import { z } from "zod"

export const planStatusSchema = z.enum(["none", "submitted", "approved", "rejected"])
export const permissionResponseSchema = z.enum(["reject", "once", "always"])

export const allowedSourceSchema = z.object({
  source_agent_id: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  requires_plan_approval: z.array(z.string().min(1)).default([]),
})

export const agentConfigSchema = z.object({ id: z.string().min(1), url: z.string().url(), capabilities: z.array(z.string().min(1)) })
export const projectConfigSchema = z.object({ id: z.string().min(1), path: z.string().min(1), capabilities: z.array(z.string().min(1)) })

export const bridgeConfigSchema = z.object({
  agent_id: z.string().min(1),
  bridge: z.object({ host: z.string().min(1), port: z.number().int().positive(), public_url: z.string().url() }),
  opencode: z.object({ base_url: z.string().url(), server_port: z.number().int().positive(), username: z.string().default("opencode"), password_env: z.string().default("OPENCODE_SERVER_PASSWORD") }),
  security: z.object({ auth_mode: z.literal("bearer-token"), bearer_token: z.string().min(1), allowed_sources: z.array(allowedSourceSchema) }),
  permissions: z.object({ default_response: permissionResponseSchema, allow_tools: z.array(z.string().min(1)), require_plan_approval_for_tools: z.array(z.string().min(1)) }),
  projects: z.array(projectConfigSchema),
  agents: z.array(agentConfigSchema),
  timeouts: z.object({ default_job_seconds: z.number().int().positive(), callback_retry_attempts: z.number().int().nonnegative() }),
  planning: z.object({ plan_annotator_enabled: z.boolean(), require_approval_for: z.array(z.string().min(1)) }),
})

export const planMetadataSchema = z.object({
  plan_status: planStatusSchema,
  plan_reference: z.string().min(1).optional(),
  approved_by: z.string().min(1).optional(),
  approved_at: z.string().min(1).optional(),
}).optional()

export const triggerRequestSchema = z.object({
  job_id: z.string().min(1).optional(),
  source_agent_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  capability: z.string().min(1),
  project_dir: z.string().min(1),
  prompt: z.string().min(1),
  callback_url: z.string().url(),
  timeout_seconds: z.number().int().positive(),
  metadata: planMetadataSchema,
})

export const triggerResponseSchema = z.object({
  accepted: z.boolean(),
  job_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  opencode_session_id: z.string().min(1),
  status_url: z.string().url(),
})

export const reportCallbackSchema = z.object({
  job_id: z.string().min(1),
  source_agent_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  opencode_session_id: z.string().min(1).optional(),
  status: z.enum(["completed", "failed", "timed_out", "callback_failed"]),
  summary: z.string().min(1),
  findings: z.array(z.object({ severity: z.enum(["low", "medium", "high", "critical"]), title: z.string(), details: z.string(), reproduction: z.string().optional() })),
  artifacts: z.array(z.object({ type: z.string(), path: z.string() })),
  started_at: z.string(),
  completed_at: z.string(),
})
```

Create `src/config/types.ts`, `src/jobs/types.ts`, `src/callback/types.ts`, and `src/planning/types.ts` by exporting `z.infer` types from the schemas plus `JobRecord` with statuses `received`, `accepted`, `session_created`, `running`, `reporting`, `completed`, `failed`, `timed_out`, and `callback_failed`.

- [ ] **Step 3: Verify schemas**

Run: `bun test tests/unit/config/schemas.test.ts`

Expected: PASS.

### Task 3: Config Loader, Registry, and Routing

**Files:**
- Create: `src/config/loader.ts`
- Create: `src/registry/types.ts`
- Create: `src/registry/config-registry.ts`
- Create: `src/registry/router.ts`
- Create: `config/dev-main.example.json`
- Create: `config/test-vps.example.json`
- Test: `tests/unit/registry/router.test.ts`

- [ ] **Step 1: Write failing routing tests**

Create `tests/unit/registry/router.test.ts` with tests for explicit target validation and `routeByCapability("testing")` selecting `test-vps` from static config.

Run: `bun test tests/unit/registry/router.test.ts`

Expected: FAIL because registry files do not exist.

- [ ] **Step 2: Implement config loader and registry**

Create `loadConfig(path)` that parses JSON with `bridgeConfigSchema`. Create `AgentRegistry` with `getAgent`, `listAgents`, and `findByCapability`. Create `CapabilityRouter` with `resolve(targetAgentId, capability)` and `routeByCapability(capability)`.

- [ ] **Step 3: Add example configs**

Create both example configs with `dev-main`, `test-vps`, bridge port `8787`, opencode port `4096`, `security.allowed_sources`, `permissions`, JSON persistence defaults, and bearer token value `replace-me`.

- [ ] **Step 4: Verify config and routing**

Run: `bun test tests/unit/registry/router.test.ts tests/unit/config/schemas.test.ts`

Expected: PASS.

### Task 4: Security, Source Authorization, and Plan Gate

**Files:**
- Create: `src/security/auth-provider.ts`
- Create: `src/security/source-authorization.ts`
- Create: `src/security/allowlist.ts`
- Create: `src/planning/provider.ts`
- Test: `tests/unit/security/auth-provider.test.ts`
- Test: `tests/unit/security/source-authorization.test.ts`
- Test: `tests/unit/security/allowlist.test.ts`
- Test: `tests/unit/planning/provider.test.ts`

- [ ] **Step 1: Write failing security tests**

Tests must verify bearer auth accepts only `Authorization: Bearer secret`, source authorization allows `dev-main` to request `testing`, source authorization rejects `dev-main` requesting `deployment`, project allowlist rejects `/etc`, and plan provider requires `metadata.plan_status === "approved"` for configured sensitive capabilities.

Run: `bun test tests/unit/security/auth-provider.test.ts tests/unit/security/source-authorization.test.ts tests/unit/security/allowlist.test.ts tests/unit/planning/provider.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 2: Implement security modules**

Create `AuthProvider` interface and `BearerAuthProvider`. Create `assertSourceAuthorized(sourceAgentId, capability, allowedSources)`. Create `assertProjectAllowed(projectDir, projects)` using resolved absolute path equality. Create `ConfigPlanReviewProvider` that returns allow/deny for configured capabilities.

- [ ] **Step 3: Verify security behavior**

Run: `bun test tests/unit/security/auth-provider.test.ts tests/unit/security/source-authorization.test.ts tests/unit/security/allowlist.test.ts tests/unit/planning/provider.test.ts`

Expected: PASS.

### Task 5: JSON Job Store and Lifecycle Manager

**Files:**
- Create: `src/jobs/store.ts`
- Create: `src/jobs/manager.ts`
- Test: `tests/unit/jobs/store.test.ts`
- Test: `tests/unit/jobs/manager.test.ts`

- [ ] **Step 1: Write failing persistence and lifecycle tests**

Tests must verify `JsonFileJobStore` writes `.json` files, reloads jobs after construction, rejects duplicate client-supplied `job_id` with an error, transitions jobs through `accepted`, `session_created`, `running`, `completed`, and marks jobs `timed_out` after timeout handling.

Run: `bun test tests/unit/jobs/store.test.ts tests/unit/jobs/manager.test.ts`

Expected: FAIL because store and manager do not exist.

- [ ] **Step 2: Implement JSON store**

Create `JobStore` interface and `JsonFileJobStore` that writes one file per job to `.aibridge/jobs/{job_id}.json` using atomic write through a temporary file followed by rename.

- [ ] **Step 3: Implement lifecycle manager**

Create `JobManager` with `createJob`, `attachSession`, `markRunning`, `markCompleted`, `markFailed`, `markTimedOut`, `getJob`, and `sweepExpiredJobs(now)`. Reject duplicate IDs before creating sessions.

- [ ] **Step 4: Verify job persistence**

Run: `bun test tests/unit/jobs/store.test.ts tests/unit/jobs/manager.test.ts`

Expected: PASS.

### Task 6: Opencode SDK v2 Adapter, SSE Monitor, and Permission Policy

**Files:**
- Create: `src/opencode/types.ts`
- Create: `src/opencode/client.ts`
- Create: `src/opencode/monitor.ts`
- Create: `src/opencode/permissions.ts`
- Test: `tests/unit/opencode/permissions.test.ts`

- [ ] **Step 1: Write failing permission policy tests**

Tests must verify allowed tools return `always`, plan-gated tools return `always` only when metadata is approved, and unknown tools return `reject`.

Run: `bun test tests/unit/opencode/permissions.test.ts`

Expected: FAIL because permission policy does not exist.

- [ ] **Step 2: Define opencode interfaces**

Create an `OpencodeClient` interface with `health`, `createSession`, `sendPromptAsync`, `subscribeEvents`, `getSessionStatus`, `replyPermission`, and `abortSession`. Use `@opencode-ai/sdk/v2` in the concrete implementation. Construct Basic Auth from configured username plus `process.env[password_env]`.

- [ ] **Step 3: Implement SSE-first monitor**

Create `waitForIdle(client, sessionId, options)` that listens for `session.status` events where `status.type === "idle"`, handles `permission.asked` by applying the permission policy, watches `server.heartbeat`, and falls back to polling if SSE fails.

- [ ] **Step 4: Verify opencode types**

Run: `bun run typecheck`

Expected: PASS after adapting to installed SDK v2 types.

### Task 7: Callback Reporter and Report Receiver Types

**Files:**
- Create: `src/callback/reporter.ts`
- Test: `tests/unit/callback/reporter.test.ts`

- [ ] **Step 1: Write failing retry tests**

Create tests with injected `fetch` that fails twice then succeeds, verifies three attempts, JSON body, bearer auth header, and failure after configured retry count.

Run: `bun test tests/unit/callback/reporter.test.ts`

Expected: FAIL because reporter does not exist.

- [ ] **Step 2: Implement reporter**

Create `CallbackReporter.send(url, report, token)` with exponential backoff and injected `fetch`/sleep for tests.

- [ ] **Step 3: Verify callback reporter**

Run: `bun test tests/unit/callback/reporter.test.ts`

Expected: PASS.

### Task 8: HTTP App and Routes

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/routes/health.ts`
- Create: `src/server/routes/trigger.ts`
- Create: `src/server/routes/report.ts`
- Create: `src/server/routes/jobs.ts`
- Create: `src/index.ts`
- Test: `tests/integration/trigger-flow.test.ts`
- Test: `tests/integration/report-flow.test.ts`

- [ ] **Step 1: Write failing integration tests**

Tests must verify `/health` returns 200, unauthorized `/trigger` returns 401, unauthorized source returns 403, missing plan approval for a plan-gated capability returns 403, duplicate `job_id` returns 409, authorized `/trigger` creates an opencode session and returns `triggerResponseSchema`, `/jobs/:id` returns persisted job status, and `/report` accepts a completed report.

Run: `bun test tests/integration/trigger-flow.test.ts tests/integration/report-flow.test.ts`

Expected: FAIL because app does not exist.

- [ ] **Step 2: Implement app factory**

Create `createApp(dependencies)` with Fastify `bodyLimit: 1048576`, structured logger enabled, and injectable config, registry, router, auth provider, source authorization, job manager, opencode client, callback reporter, and plan review provider.

- [ ] **Step 3: Implement `/trigger` route**

Route order: authenticate bearer token, parse trigger schema, assert target agent, assert source authorization, assert project allowlist, assert plan approval if required, reject duplicate IDs, health-check opencode, create job, create opencode session, send prompt async with remote `project_dir`, start monitor, return trigger response.

- [ ] **Step 4: Implement `/report`, `/jobs/:id`, `/health`, and entrypoint**

`/report` validates `reportCallbackSchema` and records inbound reports. `/jobs/:id` returns job state. `/health` returns bridge health and opencode health. `src/index.ts` loads `AIBRIDGE_CONFIG` and starts Fastify.

- [ ] **Step 5: Verify HTTP flows**

Run: `bun test tests/integration/trigger-flow.test.ts tests/integration/report-flow.test.ts`

Expected: PASS.

### Task 9: tmux Startup Script and Operator Docs

**Files:**
- Create: `scripts/tmux-start.sh`
- Modify: `README.md`

- [ ] **Step 1: Write tmux startup script**

Create `scripts/tmux-start.sh` that requires `AIBRIDGE_AGENT_ID`, `AIBRIDGE_CONFIG`, and `OPENCODE_SERVER_PASSWORD`, starts tmux session `aibridge-$AIBRIDGE_AGENT_ID`, runs `opencode serve --port 4096 --hostname 0.0.0.0`, and runs `bun run dev` in a second pane.

- [ ] **Step 2: Write README**

Document prerequisites, Tailscale-only network model, OpenCode server password, bearer token, config examples, source authorization, Plan Annotator metadata, permission policy, startup command, and two-machine trigger flow.

- [ ] **Step 3: Verify script syntax**

Run: `bash -n scripts/tmux-start.sh`

Expected: exit 0.

### Task 10: Final Verification Wave

**Files:**
- All source, tests, config, docs, scripts.

- [ ] **Step 1: Run full automated verification**

Run: `bun test`

Expected: all tests pass.

Run: `bun run typecheck`

Expected: exit 0.

Run: `bun run build`

Expected: `dist/` emitted and command exits 0.

Run: `bash -n scripts/tmux-start.sh`

Expected: exit 0.

- [ ] **Step 2: Run manual API smoke test**

Start service with `AIBRIDGE_CONFIG=config/test-vps.example.json bun run dev`, then use `curl` to verify `/health` returns 200 JSON and unauthorized `/trigger` returns 401.

- [ ] **Step 3: Verify design requirements**

Confirm implementation includes SDK v2, source-agent authorization, Plan Annotator route enforcement, JSON job persistence, permission handling, SSE-first monitoring, timeout/duplicate protection, structured logging, and docs in `Docs/`.

## Final Verification Checklist

- [ ] `bun test` passes.
- [ ] `bun run typecheck` passes.
- [ ] `bun run build` passes.
- [ ] `bash -n scripts/tmux-start.sh` passes.
- [ ] `/health` smoke test returns 200.
- [ ] Unauthorized `/trigger` smoke test returns 401.
- [ ] Source-agent authorization rejects unapproved source/capability pairs.
- [ ] Plan Annotator metadata is enforced for gated capabilities.
- [ ] Job state persists to `.aibridge/jobs/{job_id}.json`.
- [ ] Duplicate client-supplied job IDs return 409.
- [ ] OpenCode monitor uses `session.status` idle as the completion signal.
- [ ] Permission policy handles `permission.asked` events.
- [ ] `Docs/remote-opencode-agent-bridge.md` documents the final design.
- [ ] `Docs/remote-opencode-agent-bridge-visualization.html` remains browser-openable.
