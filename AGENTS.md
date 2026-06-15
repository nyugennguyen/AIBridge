# AIBridge - Agent Instructions

TypeScript POC connecting opencode agents across machines via Tailscale.

## Commands

```bash
bun install          # install deps
bun run dev          # dev server (tsx src/index.ts)
bun test             # run all tests (vitest run)
bun run typecheck    # tsc --noEmit
bun run build        # tsc to dist/
```

Run a single test file: `bun test tests/unit/security/auth-provider.test.ts`

## Architecture

Fastify HTTP bridge on port 8787, talks to local `opencode serve` on port 4096.

```
src/
  server/       - Fastify app + routes (trigger, report, jobs, health)
  config/       - Zod schemas (schemas.ts), types (types.ts), loader
  security/     - Bearer auth, source authorization, project allowlist
  jobs/         - JobManager + JsonFileJobStore (file-backed in .aibridge/jobs/)
  opencode/     - SDK client adapter, session monitor, permission policy
  planning/     - Plan approval provider
  callback/     - Report callback reporter
  registry/     - Agent registry + router
```

Each module has `types.ts` (interfaces), implementation files, and mirrors in `tests/unit/`.

## Key Patterns

- **ESM only**: `"type": "module"`. All local imports MUST use `.js` extension: `import { foo } from "./bar.js"`.
- **Zod-first config**: Types are inferred from Zod schemas in `config/schemas.ts`, not hand-written. `config/types.ts` re-exports `z.infer<>` types.
- **Interface adapters**: External services (opencode SDK, fetch) are wrapped behind interfaces defined in `types.ts`. Tests use fakes (see `FakeOpencodeClient` in `tests/integration/fixtures.ts`).
- **Dependency injection**: `createApp()` takes `AppDependencies` object. No global state in routes.
- **Fastify inject**: Integration tests use `app.inject()` — no real HTTP server needed.

## Testing

- Unit tests: `tests/unit/{module}/` — test individual classes/functions in isolation.
- Integration tests: `tests/integration/` — test full request flows through Fastify routes.
- Test helpers: `tests/integration/fixtures.ts` has `buildTestApp()`, `testConfig()`, `validTrigger()`.
- Unit test fixtures: `tests/unit/jobs/fixtures.ts` has shared job test data.

## Config

JSON config files in `config/`. Two example configs: `dev-main.example.json`, `test-vps.example.json`.

Required env vars at runtime:
- `AIBRIDGE_AGENT_ID` — this machine's agent identifier
- `AIBRIDGE_CONFIG` — path to config JSON
- `OPENCODE_SERVER_PASSWORD` — for opencode serve auth

## Operational

- Process management via tmux. `scripts/tmux-start.sh` starts both opencode serve and aibridge.
- Job state persisted as JSON files in `.aibridge/jobs/` (gitignored).
- Bridge port (8787) must be Tailscale-only. Never expose opencode serve publicly.
- opencode serve must use port 4096 explicitly.
