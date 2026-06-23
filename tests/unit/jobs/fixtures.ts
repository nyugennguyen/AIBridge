import type { TriggerRequest } from "../../../src/config/types.js"

export function trigger(overrides: Partial<TriggerRequest> = {}): TriggerRequest {
  return {
    source_agent_id: "dev-main",
    target_agent_id: "test-vps",
    capability: "testing",
    project_dir: "/srv/apps/app",
    prompt: "Run tests.",
    callback_url: "http://dev-main.tailnet:8787/report",
    timeout_seconds: 60,
    ...overrides,
  }
}

export function triggerWithDeps(deps: string[], overrides: Partial<TriggerRequest> = {}): TriggerRequest {
  return { ...trigger(), depends_on: deps, ...overrides }
}
