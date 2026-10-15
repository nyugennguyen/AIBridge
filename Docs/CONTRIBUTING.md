# Documentation and contribution guide

> **Status:** Current
> **Applies to:** AIBridge repository documentation and contributions
> **Last verified:** 2026-10-15 against commit d012119
> **Owner:** maintainers

## 1. Documentation principles

Every document in this repository must adhere to the following principles:

1. **One document, one purpose:** Each file answers a distinct reader need. Do not conflate setup instructions, architectural design, operational triage, and historical progress.
2. **Code is authoritative for behavior:** Prose must never declare a command, flag, port, default, or security limit that the implementation does not enforce. Verify every claim against source code before writing.
3. **Distinguish current from historical documents:** Clearly mark whether a document represents running state or historical context. Do not silently rewrite past completion reports or closed ADRs.
4. **Make instructions executable:** Every documented command or code snippet must be directly runnable in the intended environment.
5. **Prefer links over duplicated explanations:** State canonical facts once in their authoritative document and link to them elsewhere.
6. **Describe failure modes and diagnostics:** Document expected error codes, diagnostic commands, recovery boundaries, and stopping points.
7. **Never include secrets:** Do not commit real bearer tokens, passwords, private keys, or internal network paths.
8. **Separate facts from intent:** Distinguish between what is implemented and tested versus what is proposed, planned, or advisory.

## 2. Language and style standards

- **Case and formatting:** Use sentence case for headings (e.g. `## Request and event flow`). Keep paragraphs concise and focused.
- **Precision:** Use exact configuration keys (`bridge.host`), environment variables (`AIBRIDGE_CONFIG`), status codes (`HTTP 202`), and exact units (`1 MiB`, `30,000 ms`).
- **Concrete assertions:** State exact behavior (e.g., "Returns HTTP 503 when the store cannot commit") rather than vague qualitative statements (e.g., "Highly resilient").
- **Tables and lists:** Use structured markdown tables for parameter lists and limits. Use numbered lists for sequential operational steps.
- **No unmeasured performance claims:** Never assert throughput or latency bounds without citing specific reproducible benchmarks and execution conditions.

## 3. Required metadata block

Operational and current-state documents must include a front-matter metadata block immediately following the main heading:

```markdown
> **Status:** Current | Historical | Superseded | Needs revalidation
> **Applies to:** AIBridge version or deployment scope
> **Last verified:** YYYY-MM-DD against `<commit-or-release>`
> **Owner:** `<team-or-role>`
```

- `Current`: Reflects verified, presently running implementation behavior.
- `Historical`: A historical milestone report or completion log; immutable evidence.
- `Superseded`: Replaced by a newer decision or implementation.
- `Needs revalidation`: Preserved design or runbook that does not match current code.

## 4. Required structure by document type

Use the standardized templates under `Docs/templates/` when adding new documents:

- **Current architecture guide (`Docs/templates/current-state-guide.md`):**
  1. Purpose and status
  2. Component responsibilities and trust boundaries
  3. Deployment and topology
  4. Request and event flow
  5. Persistence, consistency, retries, and recovery boundaries
  6. Authentication and authorization path
  7. Supported limits and platform assumptions
  8. External dependencies and known limitations
  9. Source files and tests validating each claim

- **Runbook (`Docs/templates/runbook.md`):**
  1. Symptom and scope
  2. Impact and safety warnings
  3. Preconditions and permissions
  4. Read-only diagnostics first
  5. Step-by-step remediation
  6. Verification
  7. Rollback and stop conditions
  8. Related runbooks and validated version

- **Architecture Decision Record (`Docs/templates/adr.md`):**
  1. Title, status, date, deciders, and related ADRs
  2. Context and problem statement
  3. Constraints and requirements
  4. Options considered and trade-offs
  5. Decision and rationale
  6. Consequences, risks, and operational impact
  7. Revisit triggers and superseding decision

- **Implementation and completion report (`Docs/templates/implementation-report.md`):**
  1. Actual scope and commit or branch
  2. Delivered versus deferred work
  3. Commands and tests executed with results
  4. Evidence and links to CI artifacts or PRs
  5. Known limitations and residual risks
  6. Sign-off and status

- **Agent skills (`.opencode/skills/`):**
  - Keep instructions concise and operational.
  - Link directly to canonical documents rather than duplicating text.
  - `.opencode/skills/` is the single canonical source. Never edit `.claude/skills/` or `.agents/skills/` manually.

## 5. Automated verification and gates

CI runs documentation checks to ensure consistency across the repository:

- **Documentation check gate:**
  Run locally before submitting a PR:
  ```bash
  bun run docs:check
  ```
  This command verifies that required entry points exist, local Markdown links and anchors resolve, mirrored skills match canonical sources, code fences do not document unsupported CLI commands, and configuration examples parse against the Zod schema.

- **Generated CLI reference:**
  `Docs/cli-reference.md` is generated directly from the executable `aibr --help`. Never edit it by hand. Regenerate with:
  ```bash
  bun scripts/docs/generate-cli-reference.ts
  ```

- **Synchronized agent skills:**
  Mirrored skill copies under `.claude/skills/` and `.agents/skills/` are kept in sync with `.opencode/skills/`. Update them with:
  ```bash
  bun scripts/docs/sync-skills.ts
  ```
  CI runs `bun scripts/docs/sync-skills.ts --check` to ensure no drift occurs.

## 6. Pull request documentation checklist

Before opening a pull request that touches documentation or operational code:

- [ ] Documentation accurately reflects changes introduced in this PR.
- [ ] Every documented command, option, port, and config key matches the running code.
- [ ] All internal links and anchor references resolve without error.
- [ ] No secrets, real bearer tokens, passwords, or private network paths are committed.
- [ ] Operational documents include the required metadata block.
- [ ] Canonical agent skills under `.opencode/skills/` were updated and synchronized via `bun scripts/docs/sync-skills.ts`.
- [ ] `Docs/cli-reference.md` was regenerated via `bun scripts/docs/generate-cli-reference.ts` if CLI options changed.
- [ ] `bun run docs:check` passes cleanly.
