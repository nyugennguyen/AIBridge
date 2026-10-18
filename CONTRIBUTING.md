# AIBridge Contribution and Documentation Guide

> **Status:** Current  
> **Applies to:** AIBridge repository contributions, architecture, and documentation  
> **Owner:** Maintainers  

Welcome to AIBridge! This document sets forth the development workflow, contribution rules, documentation governance lifecycle, and verification gates for this repository.

---

## 1. Documentation Principles

Every document in this repository adheres to these core principles:

1. **One Canonical Source per Topic:** Every important topic has exactly one canonical source of truth. Prefer cross-document links over duplicating explanations across READMEs, runbooks, and agent skills.
2. **Code is Authoritative for Behavior:** Prose must never declare a command, option, port, schema default, or safety limit that the implementation does not enforce. Always verify assertions against the source code.
3. **Executable Instructions:** Every documented command or code snippet must be runnable in its intended environment.
4. **Distinct Current vs. Historical Separation:** Operational documents represent verified running state. Historical milestone plans, brainstorms, and superseded recovery proposals are clearly marked and isolated in `Docs/archive/`.
5. **No Secrets:** Real bearer tokens, passwords, private keys, or internal private network paths must never be committed.
6. **Explicit Failure Modes:** Document expected HTTP error codes, diagnostic commands, recovery boundaries, and stopping points.
7. **No Unmeasured Performance Claims:** Latency and throughput figures must cite reproducible benchmarks and execution parameters.

---

## 2. Documentation Lifecycle States

All documentation in AIBridge belongs to one of four explicit lifecycle states:

| State | Definition | Treatment |
|---|---|---|
| **Current** | Valid for the implemented, running system. | Maintained actively under `Docs/` and root README. Checked by automated gates. |
| **Superseded** | Replaced by a newer architectural decision, design, or implementation. | Marked with an explicit `Superseded` status banner linking to the replacement document. |
| **Archived** | Retained for historical context, design evolution, or forensic audit. | Stored in `Docs/archive/` or milestone directories. Must never be treated as operational guidance. |
| **Deleted** | Redundant, accidental, empty, or obsolete without historical value. | Removed to eliminate confusion, after verifying zero incoming runtime dependencies. |

### Metadata Block Requirement

All current, superseded, and archived documents must include a front-matter metadata block immediately following the primary heading:

```markdown
> **Status:** Current | Superseded | Archived | Needs revalidation
> **Applies to:** AIBridge version or scope
> **Last verified:** YYYY-MM-DD against `<commit-or-release>` (omit if unverified)
> **Owner:** `<team-or-role>`
```

---

## 3. Documentation Governance Rules

Contributors and AI agents must follow these eight governance rules:

1. **Update before adding:** Update existing documentation before creating another document on the same topic.
2. **One canonical source:** State technical facts in their authoritative location and link to them.
3. **Synchronize changes:** Any change to runtime behavior, CLI options, configuration schemas, architecture, security, or deployment must update corresponding documentation in the same change set.
4. **Do not edit generated files:** Generated references (`Docs/reference/cli-reference.md`) must be regenerated via their build scripts (`bun scripts/docs/generate-cli-reference.ts`), never edited by hand.
5. **No operational ambiguity:** Historical or archived documents must never be presented as current operational instructions.
6. **Maintain cross-document links:** Update incoming links whenever moving, merging, or archiving files.
7. **Keep agent skills focused:** AI agent skills in `.opencode/skills/` must link to canonical documentation rather than duplicating large documentation sections.
8. **Accurate verification metadata:** Documentation metadata must not claim a verification date or commit that has not actually been tested.

---

## 4. Development & Contribution Workflow

### Prerequisites
- [Bun](https://bun.sh) >= 1.3.0
- [Rust toolchain](https://www.rust-lang.org) (MSRV 1.94, pinned toolchain 1.99.0 via `rust-toolchain.toml`)
- [Tailscale](https://tailscale.com) running and authenticated
- [tmux](https://github.com/tmux/tmux) for headless session management

### Local Development Commands

```bash
# Install dependencies
bun install

# Development server (TypeScript bridge engine)
bun run dev

# Run CLI entrypoint locally
bun run aibr -- <args>

# Build TypeScript to dist/
bun run build

# Typecheck without emit
bun run typecheck

# Run test suites
bun test                     # Vitest test suite
bun run test:unit            # Unit tests only
bun run test:integration     # Integration tests only
bun run test:installer       # Shellcheck & installer tests
```

### Contract Parity & Schemas

AIBridge synchronizes wire contracts between TypeScript (`src/config/schemas.ts`, `src/ipc/schemas.ts`), generated JSON schemas (`contracts/v1/`), and Rust crates (`router/src/contracts.rs`, `crates/aibr-ipc/src/contracts.rs`).

```bash
# Regenerate wire contracts and JSON schemas
bun run generate:contracts

# Verify contract parity
bun run contracts:check
```

### Full Pre-Release Gate

Before submitting a pull request, run the full verification gate:

```bash
bun run release:check
```

---

## 5. Automated Documentation Gates

AIBridge includes an automated documentation gate (`bun run docs:check`) that verifies:

- **Required entry points exist:** Root documents, getting-started, current-state architecture, and generated CLI reference.
- **Internal links and anchors resolve:** All relative Markdown links and heading anchors are verified.
- **Skill mirrors match canonical source:** `.claude/skills/` and `.agents/skills/` must remain byte-identical mirrors of `.opencode/skills/`. Synchronize with:
  ```bash
  bun scripts/docs/sync-skills.ts
  ```
- **CLI reference accuracy:** `Docs/reference/cli-reference.md` must match `aibr --help`. Regenerate with:
  ```bash
  bun scripts/docs/generate-cli-reference.ts
  ```
- **Documented command validity:** Fenced code blocks documenting `aibr <command>` must only reference commands implemented in the CLI.
- **Configuration example validity:** All `config/*.example.json` files must parse cleanly against the Zod schema (`bridgeConfigSchema`).

---

## 6. Pull Request Checklist

Before opening a pull request:

- [ ] Code follows project standards (TypeScript ESM with `.js` import extensions, no semicolons, Zod-first config).
- [ ] Relevant documentation updated in the same pull request.
- [ ] No secrets, real tokens, or private paths committed.
- [ ] If CLI flags or commands changed, regenerated `Docs/reference/cli-reference.md`.
- [ ] If agent skills changed in `.opencode/skills/`, synced mirrors via `bun scripts/docs/sync-skills.ts`.
- [ ] `bun run docs:check` passes with zero errors.
- [ ] `bun run typecheck` and `bun test` pass.
