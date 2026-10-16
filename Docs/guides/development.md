# Developer Guide

> **Status:** Current  
> **Applies to:** AIBridge codebase development  
> **Owner:** Maintainers  

This guide details the development toolchain, local workflows, test suites, contract parity checks, and release verification gates for contributors working on AIBridge.

---

## 1. Toolchain & Environment

AIBridge is a hybrid polyglot codebase:

- **TypeScript / Bun Engine & CLI:** Requires [Bun](https://bun.sh) `>= 1.3.0`.
- **Rust Ingress Router & IPC:** Implemented under `router/` and `crates/`. Requires Rust MSRV `1.94`, with toolchain `1.99.0` pinned via `rust-toolchain.toml`.
- **Shell Scripts:** Validated using `shellcheck` and `bash -n`.

### Quick Setup

```bash
# Clone the repository
git clone https://github.com/nyugennguyen/AIBridge.git
cd AIBridge

# Install Node dependencies
bun install
```

---

## 2. Core Development Commands

```bash
# Start local development bridge server (tsx src/index.ts)
bun run dev

# Run local CLI entrypoint directly with Bun
bun run aibr -- <args>

# Compile TypeScript to dist/ (tsc -p tsconfig.build.json)
bun run build

# Typecheck TypeScript without emitting output
bun run typecheck
```

---

## 3. Testing Workflows

The test suite uses Vitest for TypeScript tests and Cargo for Rust crates:

```bash
# Run complete TypeScript test suite
bun test

# Run unit tests only
bun run test:unit

# Run integration tests only
bun run test:integration

# Run a specific test file
bun test tests/unit/orchestration/roundtable.test.ts

# Test installer scripts (shellcheck, syntax, unit tests)
bun run test:installer

# Run Rust router tests
cargo test --manifest-path router/Cargo.toml
```

---

## 4. Contract Parity & Code Generation

AIBridge maintains synchronized wire contracts across TypeScript, JSON Schema, and Rust. Hand-editing generated files is strictly forbidden.

```
src/config/schemas.ts  ──▶  contracts/v1/*.schema.json  ──▶  router/src/contracts.rs
src/ipc/schemas.ts     ──▶  crates/aibr-ipc/src/contracts.rs
```

### Regeneration & Parity Checks

Whenever TypeScript schemas in `src/config/schemas.ts` or `src/ipc/schemas.ts` are updated:

```bash
# 1. Regenerate JSON schemas and Rust contracts
bun run generate:contracts

# 2. Verify parity between TS, JSON schemas, and Rust crates
bun run contracts:check
```

`bun run contracts:check` ensures generated files are committed and identical across languages.

---

## 5. Documentation Tooling & Validation

```bash
# Validate documentation entry points, internal links, commands, and schemas
bun run docs:check

# Regenerate the canonical CLI reference from aibr --help
bun scripts/docs/generate-cli-reference.ts

# Synchronize canonical .opencode/skills/ to Claude and Codex mirrors
bun scripts/docs/sync-skills.ts

# Check for skill mirror drift without modifying files
bun scripts/docs/sync-skills.ts --check
```

---

## 6. Pre-Release Verification Gate

Before opening a pull request or cutting a release, run the complete release verification gate:

```bash
bun run release:check
```

This gate executes:
1. Frozen lockfile installation (`bun install --frozen-lockfile`).
2. TypeScript build (`bun run build`).
3. Complete Vitest test suite (`bun test`).
4. TypeScript type checking (`bun run typecheck`).
5. Shell script linting (`shellcheck` and `bash -n`).
6. Contract parity validation (`bun run contracts:check`).
7. CLI smoke tests (`dist/cli.js --help`).
8. Package tarball dry-run packaging (`bun pm pack --dry-run`).

---

## 7. Key Engineering Standards

- **ESM Only:** All local TypeScript imports must use the `.js` extension (e.g., `import { foo } from "./bar.js"`).
- **Zod-First Typing:** Define schemas in `config/schemas.ts` and infer types via `z.infer<>` in `config/types.ts`. Never write duplicate interface definitions by hand.
- **Single Source of Truth:** Kernel state changes commit exclusively to `SqliteEventStore`. Projections and UI consumers are strictly read-only subscribers.
- **The Immutable Core:** Policy modifications cannot relax the safety floor, input fencing, budget ceilings, or kernel authority (`assertCharterDoesNotRelaxCore`).
- **No Semicolons:** Semicolons are omitted in TypeScript files.
