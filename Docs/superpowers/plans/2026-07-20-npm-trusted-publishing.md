# npm Trusted Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish validated GitHub Releases to npm using trusted publishing.

**Architecture:** A dedicated release-event workflow isolates npm publication from normal CI. It uses GitHub OIDC, verifies the release tag against the package manifest, then runs the existing release validation before publication.

**Tech Stack:** GitHub Actions, Bun 1.3.14, Node.js 24/npm, npm trusted publishing, Vitest.

---

### Task 1: Lock the publish contract with a test

**Files:**
- Create: `tests/unit/release/publish-workflow.test.ts`

- [ ] Write a Vitest contract that reads `.github/workflows/publish.yml` and requires the `release: published` trigger, OIDC permissions, the manifest/tag guard, and `npm publish`.
- [ ] Run `bun test tests/unit/release/publish-workflow.test.ts` and confirm it fails because the workflow does not exist.

### Task 2: Add the trusted-publishing workflow

**Files:**
- Create: `.github/workflows/publish.yml`

- [ ] Grant `contents: read` and `id-token: write`; set `release: published` as the only trigger.
- [ ] Check out the release tag, configure Bun 1.3.14 and Node 24, fail on a mismatched `v<package.json version>` tag, run `bun run release:check`, then run `npm publish` without an npm token.
- [ ] Run `bun test tests/unit/release/publish-workflow.test.ts` and confirm it passes.

### Task 3: Document release authorization

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/specs/2026-07-20-npm-trusted-publishing-design.md`

- [ ] Replace the manual npm credential instruction with the GitHub Release and npm trusted-publisher flow.
- [ ] Document the required npmjs.com trusted publisher values: `nyugennguyen`, `AIBridge`, and `publish.yml`.

### Task 4: Verify the release path

**Files:**
- Verify: `.github/workflows/publish.yml`
- Verify: `tests/unit/release/publish-workflow.test.ts`

- [ ] Run `bun test tests/unit/release/publish-workflow.test.ts`.
- [ ] Run `bun run release:check`.
