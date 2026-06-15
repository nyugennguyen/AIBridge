# AIBridge

AIBridge is a TypeScript POC for connecting opencode agents across machines on a private Tailscale network.

The first topology is two machines:

- `dev-main`: development workstation that triggers remote work.
- `test-vps`: testing VPS that creates a fresh opencode session, runs the requested task, and reports back.

The implementation keeps the POC ready for a future N-machine mesh through explicit registry, routing, job store, auth, plan review, and permission policy boundaries.

## Requirements

- Bun
- tmux
- opencode
- Tailscale on every participating machine
- `OPENCODE_SERVER_PASSWORD` set before starting `opencode serve`

## Configuration

Example configs live in `config/`:

- `config/dev-main.example.json`
- `config/test-vps.example.json`

Important fields:

- `security.bearer_token`: protects AIBridge webhook endpoints.
- `security.allowed_sources`: declares which source agents can trigger this agent and which capabilities they can request.
- `projects[].path`: allowlisted remote project directories. Trigger requests cannot run outside these paths.
- `planning.require_approval_for`: capabilities that require approved Plan Annotator metadata.
- `permissions`: controls opencode permission replies. Unknown tools are rejected by default.

## Start In tmux

On each machine, set environment variables and run:

```bash
export AIBRIDGE_AGENT_ID=test-vps
export AIBRIDGE_CONFIG=config/test-vps.example.json
export OPENCODE_SERVER_PASSWORD=replace-me
./scripts/tmux-start.sh
```

The script starts two tmux windows:

- `opencode`: `opencode serve --port 4096 --hostname 0.0.0.0`
- `aibridge`: `bun run dev`

Attach with:

```bash
tmux attach -t aibridge-test-vps
```

## Trigger Flow

`dev-main` sends a request to `test-vps`:

```bash
curl -X POST http://test-vps.tailnet:8787/trigger \
  -H 'Authorization: Bearer replace-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "job_id": "job_1",
    "source_agent_id": "dev-main",
    "target_agent_id": "test-vps",
    "capability": "testing",
    "project_dir": "/srv/apps/app-under-test",
    "prompt": "Run tests and report failures.",
    "callback_url": "http://dev-main.tailnet:8787/report",
    "timeout_seconds": 1800,
    "metadata": {
      "plan_status": "approved",
      "plan_reference": ".omo/plans/test-vps-qa.md"
    }
  }'
```

AIBridge validates auth, source authorization, project allowlist, and Plan Annotator metadata before creating an opencode session.

## Safety Model

- Keep bridge ports Tailscale-only.
- Do not expose `opencode serve` publicly.
- Use explicit opencode port `4096`.
- Use approved Plan Annotator metadata for sensitive capabilities.
- Keep project directories allowlisted per machine.
- Default opencode permission policy rejects unknown tools.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

See `Docs/remote-opencode-agent-bridge.md` for the architecture design and `Docs/remote-opencode-agent-bridge-visualization.html` for a browser-viewable architecture diagram.
