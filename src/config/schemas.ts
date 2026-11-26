import { z } from "zod"

export const planStatusSchema = z.enum(["none", "submitted", "approved", "rejected"])
export const permissionResponseSchema = z.enum(["reject", "once", "always"])

/**
 * How this node authenticates inbound `/trigger` and `/report` requests.
 *
 * `bearer-token` is the released behaviour: every request carries a shared bearer
 * secret compared in constant time, and a missing or wrong token is a 401.
 *
 * `none` runs the routes with no authentication at all. It exists for a node
 * that is deliberately not a peer-facing endpoint -- a throwaway local profile, a
 * test harness, a single-machine install on a machine with no tailnet. It is NOT
 * a general-purpose option, and `aibr setup` refuses to author it unless the
 * bridge is bound to a Tailscale CGNAT address with a running backend (see
 * `src/cli/setup-wizard.ts`).
 *
 * Defaulted rather than required so an existing config keeps its meaning when it
 * is re-read: widening this literal without a default would turn every stored
 * config into a parse failure, which is the wrong way to discover an old file.
 */
export const authModeSchema = z.enum(["bearer-token", "none"])

/**
 * Per-request ed25519 node signatures on `/trigger` and `/report` (Phase 3,
 * ADR 0012). Orthogonal to `auth_mode`: with `bearer-token` the bearer stays
 * required AS WELL (defence in depth); `auth_mode: "none"` + `required` is
 * signature-only.
 *
 *  - `off`      -- signature headers are ignored (the released behaviour).
 *  - `optional` -- a signed request is verified and a bad one refused; an
 *                  unsigned request is accepted on its bearer alone.
 *  - `required` -- unsigned -> 401, unpinned key -> 403, replay -> refused, and
 *                  `source_agent_id` must equal the verified key's enrolled id.
 *
 * Optional (read as `off`) rather than defaulted so every stored config and
 * every hand-built `BridgeConfig` keeps its meaning; `aibr setup` writes
 * `required` for NEW profiles only.
 */
export const requestSigningModeSchema = z.enum(["off", "optional", "required"])

export const allowedSourceSchema = z.object({
  source_agent_id: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  requires_plan_approval: z.array(z.string().min(1)).default([]),
})

export const agentConfigSchema = z.object({
  id: z.string().min(1),
  url: z.url(),
  capabilities: z.array(z.string().min(1)),
})

export const projectConfigSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
})

/**
 * Terminal backend selection. Default "tmux" for headless safety.
 * "herdr" is deprecated since 3.1.1 (backend removed): still accepted so older
 * profiles load, ignored, and `loadConfig` warns. Remove in 3.2.0.
 */
export const terminalBackendSchema = z.enum(["tmux", "herdr"])
export const terminalConfigSchema = z.object({
  backend: terminalBackendSchema.default("tmux"),
})

/**
 * What this node does in the mesh. `worker` executes `/trigger` jobs,
 * `orchestrator` dispatches them, `both` does both. Defaulted so every config
 * written before the field existed keeps its meaning (a worker).
 */
export const nodeRoleSchema = z.enum(["worker", "orchestrator", "both"])

/** Which agent runtime executes `/trigger` jobs on this node. */
export const bridgeRuntimeKindSchema = z.enum(["opencode", "claude"])

export const runtimeConfigSchema = z.object({
  kind: bridgeRuntimeKindSchema,
  /** Executable for the runtime CLI. Claude defaults to `claude` on PATH. */
  executable: z.string().min(1).optional(),
  /** Default model passed to the runtime; a capability profile's `model` wins. */
  model: z.string().min(1).optional(),
})

/**
 * Names a capability profile can carry. A profile name IS the `capability`
 * string of a `/trigger`, and it is stamped into the runtime dispatch envelope,
 * so it must be an opaque identifier (the same pattern as every kernel id).
 */
export const CAPABILITY_PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * What a Claude Code worker may do for one capability. Rules use Claude Code
 * permission-rule syntax (`Read`, `Bash(git log *)`). Deny always wins over
 * allow inside Claude Code, and the safety floor in
 * `src/runtime/claude-job-runner.ts` (`CLAUDE_SAFETY_FLOOR_DENY`) is unioned
 * into every profile's deny list in code, so no profile can remove it.
 */
export const capabilityProfileSchema = z.object({
  allow: z.array(z.string().min(1)).optional(),
  deny: z.array(z.string().min(1)).optional(),
  max_budget_usd: z.number().positive().optional(),
  max_turns: z.number().int().positive().optional(),
  timeout_s: z.number().int().positive().optional(),
  /**
   * Held as `awaiting_approval` until an operator approves the job on this node
   * (`aibr approve <job>`, Phase 4). A caller's `metadata.plan_status` is never
   * consulted for this runtime.
   */
  requires_approval: z.boolean().default(false),
  /**
   * Deterministic script run INSTEAD of Claude Code (no LLM). A path relative
   * to the job's working directory that must resolve inside it; executed
   * directly (no shell), with a sanitized environment and the profile timeout.
   */
  script: z.string().min(1).optional(),
  /** Scripts run before the main step (Claude or `script`); same rules as `script`. */
  pre: z.array(z.string().min(1)).optional(),
  /** Scripts run after a main step that completed; same rules as `script`. */
  post: z.array(z.string().min(1)).optional(),
  model: z.string().min(1).optional(),
  append_system_prompt: z.string().min(1).optional(),
})

export const claudeSettingSourceSchema = z.enum(["user", "project", "local"])

/** Isolation knobs applied to every Claude Code launch on this node. */
export const claudeConfigSchema = z.object({
  /** `--settings <file>`: operator-owned settings layered on top of the sources below. */
  settings_path: z.string().min(1).optional(),
  /**
   * `--setting-sources`. Defaults to `user` only, so a repository's own
   * `.claude/settings.json`, hooks and MCP servers cannot widen what a worker
   * may do: the code under test comes from a peer, not from the operator.
   */
  setting_sources: z.array(claudeSettingSourceSchema).default(["user"]),
  /** `--strict-mcp-config`: ignore `.mcp.json`, `~/.claude.json` and plugin MCP servers. */
  strict_mcp_config: z.boolean().default(true),
})

/**
 * A repository a `/trigger` may name in `repo`. Only repositories listed here
 * are ever fetched: a peer names a key, never an arbitrary URL to clone.
 */
export const repositoryConfigSchema = z.object({
  url: z.string().min(1),
  /** Ref used when a trigger names the repository without a `ref`. Defaults to `HEAD`. */
  default_branch: z.string().min(1).optional(),
})

/** Repository keys are path components (`<state>/repos/<name>.git`), so they are opaque ids. */
export const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * A git ref or sha a peer may ask for. Deliberately narrower than git's own
 * grammar: no leading `-` (never an option to git), no whitespace, no `..`,
 * no `@{`, no control characters.
 */
export const GIT_REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/+-]{1,200}$/

/** Node-wide execution limits. */
export const limitsConfigSchema = z.object({
  /** Claude/script jobs that may run at once on this node; excess triggers get 429. Default 2. */
  max_concurrent_jobs: z.number().int().positive().optional(),
})

const opencodeConfigSchema = z.object({
  base_url: z.url(),
  server_port: z.number().int().positive(),
  username: z.string().default("opencode"),
  password_env: z.string().default("OPENCODE_SERVER_PASSWORD"),
})

export const bridgeConfigSchema = z.object({
  agent_id: z.string().min(1),
  role: nodeRoleSchema.default("worker"),
  bridge: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    public_url: z.url(),
    ingress_mode: z.enum(["engine", "router"]).default("engine"),
  }),
  terminal: terminalConfigSchema.default({ backend: "tmux" }),
  runtime: runtimeConfigSchema.default({ kind: "opencode" }),
  /** Required when `runtime.kind` is `opencode` (the default); unused for `claude`. */
  opencode: opencodeConfigSchema.optional(),
  capability_profiles: z.record(z.string(), capabilityProfileSchema).optional(),
  claude: claudeConfigSchema.optional(),
  /** Repositories `/trigger` may pin a job to (`repo` + `ref`). Absent: `repo` is refused. */
  repositories: z.record(z.string(), repositoryConfigSchema).optional(),
  limits: limitsConfigSchema.optional(),
  security: z.object({
    auth_mode: authModeSchema.default("bearer-token"),
    request_signing: requestSigningModeSchema.optional(),
    allowed_sources: z.array(allowedSourceSchema),
    /**
     * Operator endpoints (approve/reject/pending/stop-all) answer only requests
     * from this host itself: loopback or one of the host's own interface
     * addresses (the CLI connects through the bridge's bound address). Absent
     * means true; set false only to approve from another machine.
     */
    approval_from_loopback_only: z.boolean().optional(),
  }),
  permissions: z.object({
    default_response: permissionResponseSchema,
    allow_tools: z.array(z.string().min(1)),
    require_plan_approval_for_tools: z.array(z.string().min(1)),
  }),
  projects: z.array(projectConfigSchema),
  agents: z.array(agentConfigSchema),
  timeouts: z.object({
    default_job_seconds: z.number().int().positive(),
    callback_retry_attempts: z.number().int().nonnegative(),
  }),
  planning: z.object({
    plan_annotator_enabled: z.boolean(),
    require_approval_for: z.array(z.string().min(1)),
  }),
}).superRefine((config, ctx) => {
  if (config.runtime.kind === "opencode" && config.opencode === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["opencode"],
      message: 'The "opencode" block is required when runtime.kind is "opencode" (the default). Add it, or set runtime.kind to "claude".',
    })
  }
  if (config.runtime.kind === "claude" && config.bridge.ingress_mode === "router") {
    // The router's drain loop (src/ingress/drainer.ts) still launches OpenCode
    // only; accepting this combination would admit work that can never run.
    ctx.addIssue({
      code: "custom",
      path: ["bridge", "ingress_mode"],
      message: 'runtime.kind "claude" is only supported with bridge.ingress_mode "engine".',
    })
  }
  const requestSigning = config.security.request_signing ?? "off"
  if (config.bridge.ingress_mode === "router" && requestSigning !== "off") {
    // The Rust router admits /trigger on the bearer alone and does not carry the
    // signature headers into the admission record, so a signed-request policy
    // would silently go unenforced. Refused rather than half-honoured (ADR 0012).
    ctx.addIssue({
      code: "custom",
      path: ["security", "request_signing"],
      message:
        `security.request_signing "${requestSigning}" is not supported with bridge.ingress_mode "router": ` +
        `the Rust router admits /trigger on the bearer token only. Use ingress_mode "engine", or set ` +
        `request_signing to "off" (Docs/adr/0012-request-signing-and-pairing.md).`,
    })
  }
  for (const name of Object.keys(config.repositories ?? {})) {
    if (!REPOSITORY_NAME_PATTERN.test(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["repositories", name],
        message: `Repository name "${name}" must match ${REPOSITORY_NAME_PATTERN.source}.`,
      })
    }
  }
  for (const name of Object.keys(config.capability_profiles ?? {})) {
    if (!CAPABILITY_PROFILE_NAME_PATTERN.test(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["capability_profiles", name],
        message: `Capability profile name "${name}" must match ${CAPABILITY_PROFILE_NAME_PATTERN.source}.`,
      })
    }
  }
})

export const planMetadataSchema = z
  .object({
    plan_status: planStatusSchema,
    plan_reference: z.string().min(1).optional(),
    approved_by: z.string().min(1).optional(),
    approved_at: z.string().min(1).optional(),
  })
  .optional()

export const remoteDependencySchema = z.object({
  agent_id: z.string().min(1),
  job_id: z.string().min(1),
})

export const dependencyReferenceSchema = z.union([z.string().min(1), remoteDependencySchema])

export const triggerRequestSchema = z.object({
  job_id: z.string().min(1).optional(),
  source_agent_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  capability: z.string().min(1),
  project_dir: z.string().min(1),
  prompt: z.string().min(1),
  callback_url: z.url(),
  timeout_seconds: z.number().int().positive(),
  depends_on: z.array(dependencyReferenceSchema).default([]).optional(),
  task_id: z.string().optional(),
  metadata: planMetadataSchema,
  /**
   * A key of the worker's `repositories` map (or that entry's exact `url`).
   * The worker runs the job in a fresh worktree of that repository, checked
   * out at the resolved sha, instead of `project_dir`'s working tree. Claude
   * runtime only; `project_dir` must still be allowlisted.
   */
  repo: z.string().min(1).max(512).optional(),
  /** Branch, tag or sha inside `repo`; resolved to a sha when the job is accepted. Requires `repo`. */
  ref: z.string().regex(GIT_REF_PATTERN).optional(),
})

export const triggerResponseSchema = z.object({
  accepted: z.boolean(),
  job_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  opencode_session_id: z.string().min(1).optional(),
  /** The runtime's own session id for non-OpenCode runtimes (Claude Code's session UUID). */
  runtime_session_id: z.string().min(1).optional(),
  status_url: z.url(),
  status: z.enum(["accepted", "blocked", "failed", "awaiting_approval"]).optional(),
  task_id: z.string().optional(),
  /** For `awaiting_approval`: what the operator runs on the worker node to approve. */
  approve_hint: z.string().min(1).optional(),
  /** The commit the job is pinned to, when the trigger named a `repo`. */
  sha: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
})

/** One deterministic script step of a job, as reported back. Output tails are bounded and redacted. */
export const scriptResultSchema = z.object({
  phase: z.enum(["pre", "main", "post"]),
  script: z.string().min(1),
  exit_code: z.number().int().nullable(),
  signal: z.string().optional(),
  timed_out: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  stdout_tail: z.string(),
  stderr_tail: z.string(),
})

export const reportCallbackSchema = z.object({
  job_id: z.string().min(1),
  source_agent_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  opencode_session_id: z.string().min(1).optional(),
  status: z.enum(["completed", "failed", "timed_out", "callback_failed"]),
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      severity: z.enum(["low", "medium", "high", "critical"]),
      title: z.string(),
      details: z.string(),
      reproduction: z.string().optional(),
    }),
  ),
  artifacts: z.array(z.object({ type: z.string(), path: z.string() })),
  started_at: z.string(),
  completed_at: z.string(),
  /** The commit the job ran at, when the trigger named a `repo`. */
  sha: z.string().optional(),
  /** Deterministic steps the job ran (`pre`, `script`, `post`), in order. */
  script_results: z.array(scriptResultSchema).optional(),
})
