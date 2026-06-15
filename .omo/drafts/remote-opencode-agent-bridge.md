# Draft Design: Remote Opencode Agent Bridge / Multi-Agent Mesh

## Status

- **Document type**: Brainstorming and system architecture draft
- **Project**: `AIBrigde` / remote opencode agent bridge
- **Current phase**: Design approval before implementation planning
- **Implementation status**: Not started
- **Primary constraint**: POC first, mesh-ready architecture later
- **Canonical design location**: `Docs/remote-opencode-agent-bridge.md`

## Original Idea

Build a tool that acts as a bridge between AI agents running on multiple devices and locations. Each agent runs separately, but can automatically call another agent when needed.

Example workflow:

1. A development agent finishes coding.
2. The development agent deploys to a testing environment.
3. The development agent triggers an AI agent running inside the testing VPS.
4. The testing VPS agent creates a new opencode session, runs tests/QA, and sends a report back.
5. The development agent continues development using that report.

The long-term goal is a remote multi-agent architecture where agents can cooperate across machines like local multi-agent orchestration, but distributed over a secure private network.

## Confirmed Requirements

- POC agents all run with **opencode**.
- All participating machines must be on the same **Tailscale network**.
- Agents stay alive inside **tmux sessions**.
- Agents call each other through **HTTP webhooks** or a similar real-time mechanism.
- Every remote trigger creates a **new opencode session** on the remote machine.
- The remote agent sends a **structured report** back to the main/development agent.
- POC topology is **two machines**:
  - Machine A: development/main agent
  - Machine B: testing VPS agent
- Future topology should support **N-machine mesh**.

## Confirmed Technical Decisions

### Runtime

Use **Node.js/TypeScript** for the bridge POC.

Reasoning:

- Strong fit for HTTP webhook servers.
- Good JSON schema validation and typed message contracts.
- Good process orchestration for opencode/tmux integration.
- Good test tooling for a greenfield POC.
- Natural fit for `@opencode-ai/sdk`.

### Transport

Use **HTTP webhook receivers on each agent**, reachable only through Tailscale addresses.

Reasoning:

- Simple and debuggable for the two-machine POC.
- Maps naturally to future peer-to-peer mesh behavior.
- Avoids introducing a central coordinator too early.
- Keeps callback/reporting model explicit.

### Opencode Execution Mode

Use **persistent `opencode serve` + HTTP API/SDK** on each remote agent machine.

Use **`@opencode-ai/sdk/v2`** for implementation. The v2 SDK is preferred because it matches current opencode internals more closely and supports directory routing through `x-opencode-directory` / `directory` handling.

Remote machine pattern:

```bash
OPENCODE_SERVER_PASSWORD=... opencode serve --port 4096 --hostname 0.0.0.0
```

The bridge service then:

1. Receives a trigger webhook.
2. Creates a new opencode session.
3. Sends the prompt asynchronously.
4. Monitors session status through opencode events/SSE, using `session.status` with `status.type === "idle"` as the completion signal.
5. Sends a report callback when the session completes or fails.

This is preferred over starting `opencode run` for each job because it gives better session visibility, event monitoring, and future mesh compatibility.

### Resolved POC Defaults

- Project name in package/docs: **AIBridge**. The current folder may remain `AIBrigde` unless renamed separately.
- Job persistence: **local JSON files** under `.aibridge/jobs/{job_id}.json`.
- Bridge authentication: **bearer token** for the POC, behind an `AuthProvider` interface so HMAC or mTLS can replace it later.
- Monitoring: **SSE first**, polling fallback.
- Permission handling: **mandatory**. The bridge must handle opencode `permission.asked` events according to an explicit permission policy.

## Current Project Context

The project directory is a greenfield workspace.

Confirmed absent:

- No application code.
- No package manifest.
- No README.
- No git repository.
- No Docker/systemd/tmux scripts.
- No CI.
- No test framework.
- No existing project conventions.
- No OpenSpec or Spec Kit files.

The design can therefore define the runtime, folder structure, tests, and operational scripts from scratch.

## Architecture Overview

### POC Architecture: Two-Machine Bridge

```text
┌────────────────────────────────────────────────────────────┐
│ Machine A: Development Workstation                         │
│                                                            │
│  ┌─────────────────────┐       ┌────────────────────────┐  │
│  │ Development Agent   │──────▶│ AIBridge Local Node    │  │
│  │ opencode session    │       │ HTTP client/server     │  │
│  └─────────────────────┘       └───────────┬────────────┘  │
│                                            │               │
└────────────────────────────────────────────┼───────────────┘
                                             │ Tailscale HTTP
                                             ▼
┌────────────────────────────────────────────────────────────┐
│ Machine B: Testing VPS                                     │
│                                                            │
│  ┌─────────────────────┐       ┌────────────────────────┐  │
│  │ AIBridge Agent Node │──────▶│ opencode serve         │  │
│  │ POST /trigger       │       │ :4096 in tmux          │  │
│  └──────────┬──────────┘       └───────────┬────────────┘  │
│             │                              │               │
│             │ monitors session             │ creates new   │
│             │ via SDK/API                  │ session       │
└─────────────┼──────────────────────────────┼───────────────┘
              │                              │
              └──────── report callback ◀────┘
```

### Future Architecture: N-Machine Mesh

```text
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│ Agent Node A │◀─────▶│ Agent Node B │◀─────▶│ Agent Node C │
└──────┬───────┘       └──────┬───────┘       └──────┬───────┘
       │                      │                      │
       └──────────────┬───────┴──────────────┬───────┘
                      ▼                      ▼
              ┌────────────────────────────────┐
              │ Agent Registry Interface        │
              │ POC: static config              │
              │ Future: registry/gossip/service │
              └────────────────────────────────┘
```

The POC should include an `AgentRegistry` abstraction even if the first implementation is only a static config file. This prevents rework when moving from two machines to N-machine mesh.

## Core Components

### 1. Bridge HTTP Server

Runs on every participating machine.

Responsibilities:

- Expose `POST /trigger` for remote job requests.
- Validate request schema and authentication.
- Create a new opencode session for every accepted trigger.
- Start prompt execution asynchronously.
- Track job lifecycle.
- Send completion/failure callback to the source agent.

### 2. Opencode Client Adapter

Wraps the opencode HTTP API or `@opencode-ai/sdk`.

Responsibilities:

- Health check remote/local opencode server.
- Create sessions.
- Send prompts with `prompt_async`.
- Monitor status through SSE events first, using `session.status` idle as completion.
- Fall back to polling if SSE disconnects.
- Reply to `permission.asked` events according to the configured permission policy.
- Fetch session result/report data.

Important opencode constraints:

- Always use explicit ports.
- Use `OPENCODE_SERVER_PASSWORD` for network-exposed opencode servers.
- `--dir` must be a valid path on the remote machine, not the caller's local path.
- `prompt_async` returns `204 No Content`; completion must be inferred from events or status checks.
- Avoid deprecated `session.idle` events; use `session.status` with `status.type === "idle"`.

### 3. Job Lifecycle Manager

Tracks remote job state.

Required states:

```text
received → accepted → session_created → running → reporting → completed
                                      ↘ failed
                                      ↘ timed_out
                                      ↘ callback_failed
```

Responsibilities:

- Assign correlation IDs.
- Enforce timeouts.
- Prevent duplicate job execution where possible.
- Persist enough local state for crash/debug recovery.
- Clean up orphaned jobs.

POC persistence uses a `JsonFileJobStore` writing each job transition to `.aibridge/jobs/{job_id}.json`. If the bridge restarts, it can reload jobs for debugging and mark uncertain active jobs for manual inspection or timeout recovery.

### 4. Agent Registry

POC implementation:

- Static config file containing known agents.
- Example agents: `dev-main`, `test-vps`.

Future mesh implementation:

- Registry service, distributed config, or gossip/discovery model.
- Health-aware routing.
- Capability-aware routing, e.g. `testing`, `deployment`, `security-review`, `frontend-qa`.

Suggested conceptual interface:

```ts
interface AgentRegistry {
  getAgent(id: string): AgentConfig
  listAgents(): AgentConfig[]
  findByCapability(capability: string): AgentConfig[]
}
```

### 5. Callback Reporter

Sends structured reports back to the source agent.

Responsibilities:

- POST report payload to callback URL.
- Retry transient callback failures.
- Store failed callback payload locally for later inspection.
- Include enough metadata for the development agent to continue work.

### 6. Authorization and Permission Policy

The bridge endpoint is a privileged remote execution interface. Authentication alone is not enough; the target must also authorize the source and capability.

Responsibilities:

- Validate bearer token through an `AuthProvider` interface.
- Check `source_agent_id` against the target machine's allowed source rules.
- Check that the requested capability is allowed for that source.
- Check project directory allowlists before creating any opencode session.
- Apply an opencode permission policy when `permission.asked` events occur.

Suggested config shape:

```json
{
  "allowed_sources": [
    {
      "source_agent_id": "dev-main",
      "capabilities": ["testing", "qa"],
      "requires_plan_approval": ["deployment", "multi-agent-fanout"]
    }
  ],
  "permissions": {
    "default_response": "reject",
    "allow_tools": ["read", "grep", "glob"],
    "require_plan_approval_for_tools": ["bash", "edit", "write"]
  }
}
```

For the POC, the safe default is to reject unknown permission requests and only auto-approve configured low-risk tools. Capabilities or tools that can modify files, run shell commands, deploy, or fan out to multiple agents should require approved Plan Annotator metadata.

### 7. Plan Annotator Integration

Plan Annotator is included as the human approval and plan-review layer for AIBridge-generated work plans.

Responsibilities:

- Present generated implementation plans before agents execute them.
- Capture user approval, rejection, or requested revisions.
- Preserve a clear boundary between design/planning and remote execution.
- Allow the development agent to send approved plans to remote agents with less ambiguity.
- Support future mesh governance where sensitive jobs require approval before dispatch.

POC behavior:

- The development machine uses Plan Annotator before starting execution work.
- Remote agents receive only approved, execution-ready prompts/plans.
- Plan Annotator is not required on the testing VPS for the first POC unless the remote agent itself generates a follow-up plan.
- The `/trigger` route must call the `PlanReviewProvider` before accepting jobs for capabilities that require approval.

Future mesh behavior:

- Any agent that creates a plan can route it through Plan Annotator before dispatching work.
- Policies can decide which jobs require approval, such as deployment, destructive operations, production access, or multi-agent fan-out.
- Plan review status becomes part of the job metadata: `plan_status`, `approved_by`, `approved_at`, and `plan_reference`.

## Message Contracts

### Trigger Request

```json
{
  "job_id": "optional-client-generated-id",
  "source_agent_id": "dev-main",
  "target_agent_id": "test-vps",
  "capability": "testing",
  "project_dir": "/srv/apps/example-project",
  "prompt": "Run the deployed app tests and report failures with reproduction steps.",
  "callback_url": "http://dev-main.tailnet:8787/report",
  "timeout_seconds": 1800,
  "metadata": {
    "deployment_url": "https://test.example.internal",
    "git_sha": "abc123",
    "environment": "testing",
    "plan_reference": ".omo/plans/test-vps-qa.md",
    "plan_status": "approved"
  }
}
```

### Immediate Trigger Response

```json
{
  "accepted": true,
  "job_id": "job_20260615_001",
  "target_agent_id": "test-vps",
  "opencode_session_id": "ses_xxx",
  "status_url": "http://test-vps.tailnet:8787/jobs/job_20260615_001"
}
```

### Report Callback

```json
{
  "job_id": "job_20260615_001",
  "source_agent_id": "test-vps",
  "target_agent_id": "dev-main",
  "opencode_session_id": "ses_xxx",
  "status": "completed",
  "summary": "Testing completed. 12 passed, 1 failed.",
  "findings": [
    {
      "severity": "high",
      "title": "Login fails on invalid token refresh",
      "details": "The test environment returns HTTP 500 instead of 401.",
      "reproduction": "Open /login, authenticate, wait for token expiry, refresh page."
    }
  ],
  "artifacts": [
    {
      "type": "log",
      "path": ".omo/evidence/job_20260615_001.log"
    }
  ],
  "started_at": "2026-06-15T10:00:00Z",
  "completed_at": "2026-06-15T10:12:00Z"
}
```

## End-to-End POC Flow

1. `test-vps` starts tmux session `aibridge-test-vps`.
2. Inside tmux, `opencode serve --port 4096 --hostname 0.0.0.0` runs continuously with `OPENCODE_SERVER_PASSWORD` set.
3. Inside tmux, AIBridge HTTP server runs on a separate port, e.g. `8787`.
4. `dev-main` finishes coding/deploying and, when a plan exists, presents the plan through Plan Annotator for approval.
5. After approval, `dev-main` sends `POST /trigger` to `http://test-vps.tailnet:8787/trigger` with plan metadata.
6. `test-vps` validates auth, source authorization, payload, plan status metadata, permission policy, and project directory allowlist.
7. `test-vps` creates a new opencode session through the opencode API/SDK.
8. `test-vps` sends the requested prompt asynchronously with the target `project_dir`.
9. `test-vps` monitors opencode session status.
10. On completion, timeout, or failure, `test-vps` creates a structured report.
11. `test-vps` sends the report to `dev-main` callback URL.
12. `dev-main` stores/displays the report so its opencode agent can continue development.

## Security Model

### Network Security

- All bridge endpoints are reachable only over Tailscale.
- Tailscale ACLs should restrict AIBridge ports to known machines.
- No public internet exposure for the POC.

### Authentication

- AIBridge webhook endpoints require a shared bearer token or HMAC signature.
- OpenCode server requires `OPENCODE_SERVER_PASSWORD`.
- Credentials are local environment variables, never sent in trigger payloads.

### Authorization

- Each agent config lists which source agents may trigger it.
- Each allowed source can be restricted by capability.
- Example: `dev-main` can trigger `test-vps` for `testing`, but not arbitrary deployment actions.
- Jobs with `requires_plan_approval: true` must include approved Plan Annotator metadata before dispatch.
- Source authorization is required: a target must reject requests from sources not listed in `allowed_sources`.
- Capabilities are source-scoped: an allowed source can only request capabilities explicitly granted to it.

### Execution Safety

- Treat `POST /trigger` as a privileged remote-code-execution interface.
- Validate and limit payload size.
- Require explicit `project_dir` allowlist on each machine.
- Never allow callers to choose arbitrary filesystem paths outside configured project roots.

## Error Handling

| Failure | Expected Behavior |
|---|---|
| Invalid JSON/schema | Return `400` with validation error. |
| Missing/invalid auth | Return `401`; log attempt without exposing secrets. |
| Unknown target/capability | Return `404` or `422` depending on route semantics. |
| Project dir not allowlisted | Return `403`. |
| Source not authorized for target/capability | Return `403`. |
| Plan approval required but missing/rejected | Return `403`. |
| Opencode server unhealthy | Return `503`; do not accept job. |
| Session creation fails | Mark job `failed`; callback with failure report if callback URL is valid. |
| SSE disconnects | Reconnect with backoff; fallback to polling session status. |
| Opencode permission request unsupported | Reply according to policy; default reject and mark job failed if execution cannot proceed. |
| Job exceeds timeout | Abort session if possible; mark `timed_out`; callback report. |
| Duplicate client-supplied `job_id` | Return `409` and do not start a second opencode session. |
| Callback fails | Retry with exponential backoff; persist report locally after final failure. |
| Bridge process restarts | Recover known jobs from local state where possible; otherwise mark uncertain jobs for manual inspection. |

## Observability

Every job should have a correlation ID used across:

- Bridge logs.
- Opencode session title or metadata.
- Callback reports.
- Local evidence files.

Minimum logs:

- Incoming trigger accepted/rejected.
- Session created.
- Prompt sent.
- Session status transitions.
- Callback success/failure.
- Timeout/abort events.
- Permission decisions.
- Authorization denials.

Use Fastify's structured logger or `pino` directly. Log JSON records with `job_id`, `source_agent_id`, `target_agent_id`, `capability`, and `opencode_session_id` when available.

## Configuration Model

Each machine should have local config in this shape:

```json
{
  "agent_id": "test-vps",
  "bridge": {
    "host": "0.0.0.0",
    "port": 8787,
    "public_url": "http://test-vps.tailnet:8787"
  },
  "opencode": {
    "base_url": "http://127.0.0.1:4096",
    "server_port": 4096
  },
  "security": {
    "auth_mode": "bearer-token",
    "allowed_sources": [
      {
        "source_agent_id": "dev-main",
        "capabilities": ["testing", "qa"],
        "requires_plan_approval": ["deployment", "multi-agent-fanout"]
      }
    ]
  },
  "projects": [
    {
      "id": "app-under-test",
      "path": "/srv/apps/app-under-test",
      "capabilities": ["testing", "qa"]
    }
  ],
  "agents": [
    {
      "id": "dev-main",
      "url": "http://dev-main.tailnet:8787",
      "capabilities": ["development", "orchestration"]
    }
  ],
  "timeouts": {
    "default_job_seconds": 1800,
    "callback_retry_attempts": 3
  },
  "planning": {
    "plan_annotator_enabled": true,
    "require_approval_for": ["deployment", "destructive", "multi-agent-fanout"]
  },
  "permissions": {
    "default_response": "reject",
    "allow_tools": ["read", "grep", "glob"],
    "require_plan_approval_for_tools": ["bash", "edit", "write"]
  }
}
```

## Mesh Evolution Path

The POC should avoid hardcoding logic directly into request handlers. Instead, use interfaces that can later be swapped:

- `AgentRegistry`: static config now, dynamic registry later.
- `CapabilityRouter`: direct target now, best-agent routing later.
- `JobStore`: local JSON files now, distributed view later.
- `Transport`: HTTP webhook now, optional queue/pubsub later.
- `AuthProvider`: shared token now, mTLS or per-agent keys later.
- `PlanReviewProvider`: local Plan Annotator now, policy-based mesh approval later.
- `PermissionPolicyProvider`: static policy now, per-agent trust policy later.

Future mesh features:

- Agent capability discovery.
- Health-aware routing.
- Job delegation chains.
- Fan-out jobs to multiple agents.
- Aggregated reports.
- Agent trust policies.
- Plan approval policies through Plan Annotator.
- Central dashboard or distributed status view.

## POC Scope

### Include

- Node.js/TypeScript bridge service.
- Two-machine config: `dev-main` and `test-vps`.
- HTTP webhook trigger endpoint.
- Opencode SDK/API integration.
- New opencode session per trigger.
- Async prompt execution.
- Session monitoring.
- Report callback to source agent.
- Tailscale-only deployment assumption.
- tmux run scripts or documented tmux commands.
- Basic auth/token protection.
- Local structured logs.
- Tests for schema validation, job lifecycle, and callback behavior.
- Plan Annotator integration as the approval step for generated plans before dispatch.
- Source-agent authorization and project allowlist enforcement.
- JSON job persistence under `.aibridge/jobs/`.
- Opencode permission handling policy.
- Structured logs for job lifecycle and security decisions.

### Exclude From POC

- Public internet exposure.
- Full dynamic mesh discovery.
- Central dashboard.
- Multi-provider agent support beyond opencode.
- Kubernetes or heavyweight orchestration.
- Complex queue infrastructure.
- Browser UI.

## Open Questions Before Implementation Planning

No blocking design questions remain for the POC. The selected defaults are: package/docs name `AIBridge`, local JSON job persistence, bearer-token bridge auth through an interface, SDK v2, SSE-first monitoring, and explicit source authorization.

## Recommended Defaults

If no further preference is given:

- Use **AIBridge** in package/docs, while leaving the current folder unchanged unless user approves renaming.
- Use local JSON job files for the POC to minimize dependencies.
- Use bearer-token auth for the POC, with an `AuthProvider` interface that allows HMAC/mTLS later.
- Use HTTP webhook + opencode SDK/API as the execution path.
- Use static agent config with an `AgentRegistry` interface to preserve the N-machine mesh path.
- Use `@opencode-ai/sdk/v2`.
- Use opencode SSE events as the primary completion signal and polling as fallback.

## Design Review Notes

- Oracle architecture review found no hard NO-GO concerns.
- Main risks are path mismatches for remote `project_dir`, opencode port collisions, orphaned sessions, SSE instability, callback failures, and securing a privileged remote execution interface.
- The most important design guardrail is to include registry/routing interfaces in the POC even if their first implementation is static config.
