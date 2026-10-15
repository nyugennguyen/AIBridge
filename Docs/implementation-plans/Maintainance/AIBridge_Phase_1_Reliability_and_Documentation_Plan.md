# Phase 1 — CI Reliability and Documentation Governance

**Project:** AIBridge  
**Status:** Proposed implementation plan  
**Target repository:** `nyugennguyen/AIBridge`  
**Baseline reviewed:** `main` at `d0121190a0d4ad285f786f76fc55b7366aeb966f` (2026-10-14)  
**Primary areas:** `.github/workflows/`, `README.md`, `AGENTS.md`, `Docs/`, agent skills, documentation validation scripts

---

## 1. Executive Summary

Phase 1 improves release confidence and makes technical documentation a dependable representation of the current system. It deliberately avoids adding product features or redesigning the orchestration architecture.

The first priority is to make CI status unambiguous. In the reviewed baseline, the CI verification job passed, but the overall CI workflow failed when its publish job attempted to publish `@nyugennguyen/aibridge@3.0.0`, which had already been published by the release workflow. The repository currently has publishing logic in both `.github/workflows/ci.yml` and `.github/workflows/publish.yml`. The two paths can race during a release. Phase 1 will establish one publishing authority and keep ordinary CI focused on validation.

The second priority is to reconcile current-state documentation. Some documentation describes different ports, toolchain versions, deployment topologies, and product boundaries. Before changing those statements, the implementation and configuration schemas must be inspected and treated as authoritative. Historical ADRs and completion reports must remain historical evidence rather than being rewritten into current-state guides.

The third priority is to establish lightweight documentation governance: clear document ownership and purpose, reusable templates, a defined source-of-truth map, checks for stale internal links and duplicated agent skills, and a repeatable review checklist.

## 2. Goals

1. Make CI results represent code verification, not a race between two package publishers.
2. Ensure package publishing can only occur through one release workflow after release validation passes.
3. Reconcile high-impact documentation with the actual source code, config schemas, executable CLI, packaging scripts, and current supported deployment model.
4. Establish a consistent documentation hierarchy and explicit writing standards.
5. Automate low-cost checks that prevent documentation drift from returning.
6. Preserve useful historical evidence, ADR reasoning, and implementation reports without letting them masquerade as current operational instructions.

## 3. Non-goals

- No new agent runtime, orchestration capability, mesh protocol, or product feature.
- No architecture rewrite and no migration away from Rust, TypeScript/Bun, or SQLite.
- No mass rewrite of every historical implementation report.
- No change to security policy or default execution permissions as part of documentation cleanup.
- No claim that the system is production-ready solely because CI is green.

## 4. Findings to Address

### 4.1 CI and release

- The reviewed `main` CI run on 2026-10-14 had a successful verification job, but the workflow-level result was failure in the npm publish step.
- The log states that npm rejected publishing version `3.0.0` because that version had already been published.
- `.github/workflows/ci.yml` contains a publish job triggered by a push to `main` and performs a latest-version comparison before publishing.
- `.github/workflows/publish.yml` publishes in response to a published GitHub Release and runs `bun run release:check` first.
- Because both workflows can observe a version transition around the same time, the version comparison in CI does not provide a reliable single-publisher guarantee.

**Decision:** make `.github/workflows/publish.yml` the sole publishing authority. `.github/workflows/ci.yml` must validate but must not publish to npm.

### 4.2 Documentation drift to reconcile

The review found competing descriptions around:

- The router, bridge, and OpenCode ports.
- The Rust toolchain pin versus the router crate's declared minimum Rust version.
- The two-node initial topology versus the newer multi-agent orchestration / federation capabilities.
- Current CLI commands and operational steps across README, `AGENTS.md`, runbooks, and agent skills.
- Instructions repeated across `.opencode/`, `.claude/`, and `.agents/` skill directories.

These should be reconciled by inspecting source code and config first; do not mechanically copy values from one existing document into another.

## 5. Workstream A — CI and Release Reliability

### A1. Establish one release authority

**Change:** remove the npm publishing job and its publishing-only permissions/secrets from `.github/workflows/ci.yml`. Keep the workflow responsible for pull-request and `main` verification only. Keep `.github/workflows/publish.yml` as the only workflow that publishes packages.

**Requirements:**

- PR and push CI must never call `npm publish`.
- A published GitHub Release must pass the release tag/package version check and `bun run release:check` before publishing.
- Keep `contents: read` as the normal default; grant extra permissions only to the workflow that needs them.
- Do not expose `NPM_TOKEN` to test, lint, or build jobs.
- Retain package provenance behavior if it is part of the current release design.
- Ensure platform package publication failures are not silently hidden when the corresponding platform package is required for that release. If optional publication remains best-effort, state the reason and report the result explicitly.

### A2. Define behavior for already-published versions

The release workflow should not try to overwrite an immutable npm version. Add an explicit preflight that distinguishes:

1. **Version not published:** continue after verification and publish.
2. **Version already published and matches the release artifact:** exit successfully with a clear “already published; skipped” message only if the workflow can verify that this is the intended artifact/release state.
3. **Version already published but the release state is inconsistent or cannot be verified:** fail with a diagnostic explaining that a new package version is required; do not silently treat it as a successful new release.

Avoid treating a mere `npm view` race as an authoritative release state. The principal race is removed by having one publishing workflow; the preflight is a second line of defense.

### A3. Keep verification gates explicit

Retain the existing core gates and make their responsibilities clear:

- Bun dependency installation using the frozen lockfile.
- Installer shell checks.
- TypeScript tests, typecheck, and build.
- Generated-contract reproducibility and TypeScript/Rust contract parity.
- Rust formatting, Clippy, and workspace tests.
- CLI smoke test and package dry-run.
- Linux packaging/systemd/nftables checks in the dedicated workflow.

Avoid running the full release gate redundantly in multiple publishing-capable jobs. `bun run release:check` remains the comprehensive pre-release gate used by the sole release workflow; regular CI may keep its equivalent steps where that provides useful PR feedback.

### A4. Add workflow regression checks

Add a lightweight automated check or workflow test that fails if `.github/workflows/ci.yml` reintroduces package-publishing commands or publishing credentials. Prefer a deterministic repository-local check over a test that depends on npm network timing.

Review workflow permissions after the publish job is removed and verify that `NPM_TOKEN` is referenced only in the designated publishing workflow.

### A5. CI acceptance criteria

- A pull request with valid changes passes all required verification jobs.
- A push to `main` performs validation but does not publish to npm.
- A published release performs validation before publishing.
- One version transition cannot be concurrently published by two workflows.
- A duplicate or inconsistent release state produces an explicit, actionable outcome.
- CI status is green when all verification steps pass; a publishing failure cannot turn a normal code-verification workflow red because of a competing publisher.

## 6. Workstream B — Documentation Inventory and Reconciliation

### B1. Create an inventory before editing

Create a short documentation inventory, initially covering the following high-impact files:

- `README.md`
- `AGENTS.md`
- `CHANGELOG.md`
- `Docs/architecture/` and relevant architecture/implementation plans
- `Docs/architecture/failure-modes-and-recovery.md`
- `Docs/adr/0008-polyglot-ingress-and-admission.md` and other relevant ADRs
- `.opencode/skills/aibr-onboarding/SKILL.md`
- `.opencode/skills/debugging-aibr-v2/SKILL.md`
- the corresponding `.claude/` and `.agents/` copies
- `config/*.example.json`
- user-facing setup HTML and technical landing-page claims where relevant

For each file, record its purpose, intended reader, whether it represents current state or history, authoritative code/config sources, and validation method.

### B2. Verify facts from implementation, not from other prose

Use the following source-of-truth map during reconciliation:

| Claim | Primary source of truth | Validation approach |
|---|---|---|
| CLI commands and flags | `src/cli.ts` and CLI command implementation | Run `bun run aibr -- --help` or built CLI help; compare docs with actual output |
| Package and Bun requirements | `package.json`, `bun.lock`, build scripts | Frozen install and package dry-run |
| Rust toolchain used by CI | `rust-toolchain.toml` and workflow setup | Compare workflow pin with toolchain file |
| Minimum supported Rust version | `router/Cargo.toml` `rust-version` and tested build matrix | Do not confuse MSRV with the pinned CI compiler version |
| Ports and network binding | Config schemas/types, router config/bind/routes, runtime startup, firewall rules, example configs | Trace each listener from config through startup and test it |
| Default security behavior | Auth providers, source authorization, project allowlists, policy floor, router authentication | Link to relevant tests; never infer policy from README wording alone |
| Supported OS/CPU targets | `scripts/build-matrix.sh`, packaging manifests, CI workflows, installer code | Verify each claimed target is built and packaged |
| Resource limits and retry behavior | Constants and implementation in router/worker/outbox modules | Reference named tests and keep values synchronized |
| Current architecture | Current source tree + accepted/amended ADRs | Maintain a concise as-built architecture document |
| Historical decisions and delivery evidence | ADRs and implementation reports | Preserve date, branch/commit context, and original conclusions |

### B3. Reconcile high-impact user-facing docs first

Recommended edit order:

1. **README:** present-day product description, supported topology, prerequisites, installation, ports, trust boundaries, basic operation, and links to detailed guides.
2. **Current architecture guide:** create or update `Docs/architecture/current-state.md` as the as-built description of processes, data flow, persistence boundaries, external dependencies, supported topology, and known limitations.
3. **CLI reference:** make CLI help the executable truth. Keep README concise and link to a focused reference or generate the reference from the executable/help source.
4. **Runbooks:** correct operational steps only after validating commands and paths against source. Clearly identify destructive steps and required backups.
5. **Agent instructions and skills:** remove obsolete command/port assumptions and make mirrored files reproducible from one canonical copy.
6. **Configuration examples:** validate examples with the same schema/parser used by the application; do not maintain a separate undocumented config dialect.

### B4. Preserve historical artifacts

- Do not silently rewrite old completion reports to make them appear as if they described current code.
- Mark old implementation reports as historical evidence where a future reader could mistake them for current instructions.
- Use ADR amendments or superseding ADRs when a technical decision changes; preserve the original context and record the new status.
- Move current operational instructions into runbooks/current-state docs and link to historical reports as evidence.
- Clearly mark any “known limitation” as `Open`, `Resolved`, `Superseded`, or `Needs revalidation`, with a source or issue reference where possible.

## 7. Workstream C — Documentation Governance and Writing Standards

### C1. Documentation principles

1. **One document, one purpose.** A file should answer a clearly defined reader question; avoid mixing onboarding, design rationale, operations, and release history.
2. **Code is authoritative for behavior.** Prose must not declare a command, flag, port, default, or security guarantee that the implementation does not enforce.
3. **State whether content is current or historical.** Dates, version/commit context, and status matter for operational documents.
4. **Make instructions executable.** Commands must be copied from validated scripts/source and tested in a clean supported environment where practical.
5. **Prefer links over duplicated explanations.** State a fact once in the canonical location and link to it from other documents.
6. **Describe failure behavior, not only the happy path.** Document diagnostics, expected output, recovery boundaries, and when to stop.
7. **Never include secrets.** Do not use real bearer tokens, private keys, customer prompts, or production paths that reveal sensitive information in examples or diagnostics.
8. **Separate facts from intent.** “Implemented,” “tested,” “planned,” and “proposed” are different claims and must not be used interchangeably.

### C2. Language and style

- Technical repository documentation should use clear, consistent English unless a specific document has an explicitly different audience.
- Use sentence case for headings and concise paragraphs.
- Define an acronym on first use when it is not universally understood in the repository.
- Prefer concrete wording (“The router returns HTTP 503 when the store is unavailable”) over vague claims (“The router is highly reliable”).
- Use exact file paths, command names, config keys, error codes, and units.
- Use tables for comparisons and reference data; use numbered steps for procedures; use bullets for short sets of requirements.
- Do not present an unmeasured performance statement as a guarantee. Attach a benchmark/test reference and the measurement conditions.
- Keep diagrams aligned with the current source. Include a note that diagrams are conceptual where they omit failure paths or operational details.

### C3. Required metadata for operational/current-state documents

At the top of a runbook or current-state guide, include a small metadata block:

```markdown
> **Status:** Current | Historical | Superseded | Needs revalidation
> **Applies to:** AIBridge version or deployment mode
> **Last verified:** YYYY-MM-DD against `<commit-or-release>`
> **Owner:** Team or role responsible for maintaining this document
```

Use the metadata only when it improves clarity; short explanatory documents do not need boilerplate. Historical reports should preserve their original date/branch/commit rather than being repeatedly updated.

### C4. Required structure by document type

#### README / project entry point

1. What the project does and who it is for.
2. Current status and supported environments/topology.
3. Architecture summary with links to detail.
4. Requirements and installation.
5. Minimal quickstart and verification commands.
6. Security boundary and explicit limitations.
7. Links to CLI reference, architecture, runbooks, ADRs, contribution guide, and release notes.

Avoid long historical narratives or duplicating implementation plans in the README.

#### Current architecture document

1. Purpose and status.
2. Component responsibilities and trust boundaries.
3. Deployment/topology diagram.
4. Request and event flow.
5. Persistence, consistency, retries, and recovery boundaries.
6. Authentication/authorization path.
7. Supported limits and platform assumptions.
8. External dependencies and known limitations.
9. Source files and tests that validate the claims.

#### Runbook

1. Symptom and scope.
2. Impact and safety warnings.
3. Preconditions and permissions.
4. Read-only diagnostics first.
5. Step-by-step remediation with expected output.
6. Verification that service and data are healthy.
7. Rollback/stop conditions and escalation path.
8. Related runbooks and validated version/commit.

Never put a destructive command before backup/preflight steps. Clearly label actions that may discard state, rotate credentials, or restart production services.

#### ADR

1. Title, status, date, deciders, and related ADRs.
2. Context and problem.
3. Constraints and requirements.
4. Options considered and trade-offs.
5. Decision and rationale.
6. Consequences, risks, and operational impact.
7. Revisit triggers and superseding decision, if any.

Accepted ADRs record why a decision was made. Do not turn them into a mutable current-state tutorial.

#### Implementation plan

1. Objective and measurable outcomes.
2. Scope and non-goals.
3. Baseline evidence/findings.
4. Workstreams and ordered tasks.
5. Dependencies and affected files.
6. Validation/test strategy.
7. Rollout, rollback, and risk controls.
8. Acceptance criteria.
9. Deliverables and ownership.

#### Implementation/completion report

1. Actual scope and commit/branch.
2. Delivered versus deferred work.
3. Commands/tests actually run and their results.
4. Evidence and links to CI artifacts/PRs.
5. Known limitations and residual risks.
6. Sign-off/status and date.

Never describe a test as passed if it was only planned or inferred from another test.

#### Agent skills and `AGENTS.md`

- Keep instructions short, operational, and tied to commands and files that exist.
- State when a skill should be used and what it must not assume.
- Resolve source-of-truth conflicts in favor of current source/config/tests.
- Avoid embedding lengthy copies of README or runbooks; link to the canonical document.
- For mirrored skills, declare one canonical file and generate/sync the other copies automatically.

### C5. Documentation change review checklist

Every PR changing operational behavior or documentation must answer:

- Does the document describe current state or history?
- Have every changed command, flag, port, config key, version, and limit been verified against code or CI?
- Were code/config examples validated, and are secrets/real private paths absent?
- Are internal relative links and anchors valid?
- Are mirrored agent skill files in sync?
- Are limitations, failure behavior, and rollback implications documented where relevant?
- Did the author update the canonical document rather than adding another conflicting copy?

## 8. Workstream D — Automated Documentation Checks

Build a small, repository-local check rather than introducing a large documentation toolchain all at once.

### D1. Add a documentation check command

Add a script such as `scripts/docs/check-docs.ts` and expose it as `bun run docs:check`. It should initially:

- Check that required documentation entry points exist.
- Validate local Markdown links and referenced repository files where practical.
- Verify mirrored `.opencode/`, `.claude/`, and `.agents/` skill files are byte-identical to the canonical copy.
- Verify key docs do not contain unapproved publishing commands in the regular CI workflow.
- Check documented CLI commands/reference output against actual CLI help, or generate the CLI reference from the help/source to avoid maintaining command lists twice.
- Validate the example configuration files using the existing config schema/parser test path.

Do not make CI depend on checking every external link over the public internet. External link checking may be a scheduled or optional job because external sites can fail independently of the repository.

### D2. Add a canonical skill-sync mechanism

Use `.opencode/skills/` as the canonical source only if confirmed as the existing repository convention. Add a script that copies canonical skill content to `.claude/skills/` and `.agents/skills/`, with a `--check` mode that exits non-zero when copies drift.

Do not edit mirrored copies separately. If a skill is intentionally different for one agent platform, document the exception and test it explicitly.

### D3. Keep checks incremental

Start with deterministic checks for internal links, mirrored skills, CLI references, and config examples. Adopt a Markdown style linter only after reviewing its impact on existing ADRs and generated/historical documents. Avoid bulk reformatting that makes future diffs hard to review.

## 9. Execution Sequence and Deliverables

### Step 1 — Establish baseline and source-of-truth map

- Record the affected workflow runs and the failing publish log.
- Trace current port/bind configuration and determine the values actually used by each process.
- Verify CLI help, Rust versions, supported build targets, and config examples from code/scripts.
- Produce a short discrepancy checklist before bulk editing.

**Deliverables:** baseline note and documentation discrepancy list.

### Step 2 — Fix CI/release separation

- Remove publishing behavior from `.github/workflows/ci.yml`.
- Keep the release workflow as the sole npm publisher.
- Add an explicit duplicate-version preflight and clearer failure states.
- Reduce workflow permissions/secrets to least privilege.
- Add a deterministic test that prevents a second publisher from being introduced.

**Deliverables:** workflow patch and regression test.

### Step 3 — Reconcile canonical current-state documents

- Update README and add/update `Docs/architecture/current-state.md`.
- Correct port, toolchain, topology, platform, and CLI statements only after verifying source.
- Update runbooks and onboarding/debugging skills against current executable behavior.
- Preserve historical ADRs and reports, but label them clearly when their content is not current operating guidance.

**Deliverables:** coherent entry-point docs and current architecture guide.

### Step 4 — Introduce documentation standards and automation

- Add the documentation standard and templates under `Docs/` (for example `Docs/CONTRIBUTING.md` and `Docs/templates/`).
- Add canonical skill synchronization and `docs:check`.
- Wire documentation checks into CI.
- Add a PR checklist or update the repository contribution template if one exists.

**Deliverables:** written standard, reusable templates, and automated checks.

### Step 5 — Validate and close Phase 1

- Run `bun run docs:check`.
- Run the project's normal verification gate and the dedicated Linux packaging workflow.
- Confirm no npm publish occurs on a normal `main` push.
- Confirm a test release workflow reaches the intended preflight/publish path without concurrent publishers.
- Have a second reviewer inspect the documentation changes against source and executable commands.
- Record exactly which validation steps ran and which remain unverified.

**Deliverables:** passing CI, merged documentation corrections, verification report, and a list of any deferred documentation discrepancies.

## 10. Definition of Done

Phase 1 is complete only when all of the following are true:

- [ ] `.github/workflows/ci.yml` is validation-only and contains no npm publishing step or publishing token.
- [ ] `.github/workflows/publish.yml` is the sole publishing authority and validates the release before publication.
- [ ] Duplicate/inconsistent package version behavior is explicit and does not create competing publisher races.
- [ ] Pull-request and `main` verification jobs pass.
- [ ] README, current architecture, CLI guidance, and onboarding/runbooks agree with verified source/config/CLI behavior.
- [ ] Port and toolchain descriptions distinguish runtime configuration, minimum supported versions, and pinned CI toolchains.
- [ ] Historical ADRs and implementation reports remain identifiable as historical evidence.
- [ ] Agent skill mirrors are generated from one canonical source and the drift check passes.
- [ ] `bun run docs:check` runs deterministically and is part of CI.
- [ ] Internal links and config examples covered by the check are valid.
- [ ] A completion report records test commands, outcomes, changed documents, unresolved risks, and commit/release references.

## 11. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Removing the CI publisher changes the release path unexpectedly | Verify release-trigger workflow and tag/version validation before merging; use a test release or controlled dry-run where supported |
| Documentation cleanup repeats a wrong value from an existing document | Trace ports, versions, commands, and limits to source/config/tests first |
| Historical evidence is accidentally rewritten as current state | Preserve timestamps and branches; use status banners and ADR amendments rather than rewriting history |
| Skill copies drift again after cleanup | One canonical file, sync script, and CI `--check` mode |
| Link-checking adds flaky network dependencies | Check local links in required CI; keep external link checks optional/scheduled |
| CI becomes slower because the same gates run multiple times | Separate quick PR feedback from the comprehensive release gate while preserving required test coverage |
| Documentation claims overstate production readiness | Require evidence for every “passed,” “supported,” or performance claim and document remaining unverified deployment behavior |

## 12. References

- [Repository](https://github.com/nyugennguyen/AIBridge)
- [CI workflow](https://github.com/nyugennguyen/AIBridge/blob/main/.github/workflows/ci.yml)
- [Release publishing workflow](https://github.com/nyugennguyen/AIBridge/blob/main/.github/workflows/publish.yml)
- [README](https://github.com/nyugennguyen/AIBridge/blob/main/README.md)
- [Contributor/agent instructions](https://github.com/nyugennguyen/AIBridge/blob/main/AGENTS.md)
- [Milestone 8 hardening report](https://github.com/nyugennguyen/AIBridge/blob/main/Docs/implementation-reports/milestone-8-completion.md)
- [Rule language and evaluation ADR](https://github.com/nyugennguyen/AIBridge/blob/main/Docs/adr/0007-rule-language-and-evaluation.md)
- [Polyglot ingress ADR](https://github.com/nyugennguyen/AIBridge/blob/main/Docs/adr/0008-polyglot-ingress-and-admission.md)

---

## Appendix A — Recommended document front matter

```markdown
# Document title

> **Status:** Current
> **Applies to:** AIBridge vX.Y.Z / deployment mode
> **Last verified:** YYYY-MM-DD against `<commit-or-release>`
> **Owner:** `<team-or-role>`

## Purpose

Explain what this document helps the reader accomplish and who should use it.

## Scope

State what is and is not covered.

## Procedure or design

Keep instructions concrete, ordered, and linked to implementation evidence.

## Validation

List the exact commands/tests and the expected result.

## Limitations and related documents

State known gaps and link to canonical source documents.
```

## Appendix B — Pull request documentation checklist

- [ ] Documentation updates reflect the implementation in this PR.
- [ ] Commands/flags/config examples have been executed or validated where practical.
- [ ] Internal links and anchors work.
- [ ] No secrets, private keys, bearer tokens, or sensitive production paths were added.
- [ ] Current-state documents were updated; historical evidence was not rewritten without an amendment.
- [ ] Mirrored skills were synchronized from the canonical source.
- [ ] CI documentation checks pass.
