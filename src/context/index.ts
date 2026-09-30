/**
 * The context subsystem's public surface.
 *
 * Four modules and one direction of dependency:
 *
 *   `types`  — the manifest, item, exclusion, policy, and candidate shapes, plus
 *              the two ports the assembler reads through (`ContextCandidateProvider`,
 *              `ContextTextRedactor`). The Zod schemas are here so a persisted or
 *              transmitted manifest is validated by the same definition that built it.
 *   `assembler` — the pure assembly and rendering. No clock, no repository, no
 *              filesystem. Every input arrives in the request.
 *   `isolation`  — the M5.9 audit: the seven egress paths and the checks over them.
 *   `tui/memory-view` — the M5.8 view model, structured rather than a string.
 *
 * The assembler imports from `src/memory/`, and nothing in `src/memory/` imports
 * from here. That one-way edge is what makes the determinism guarantee checkable:
 * the assembler cannot reach a repository even by accident, so "the same inputs
 * produce the same manifest" is a property of its signature and not of a code
 * review.
 */

export * from "./types.js"
export * from "./assembler.js"
export * from "./isolation.js"
export * from "./tui/memory-view.js"
