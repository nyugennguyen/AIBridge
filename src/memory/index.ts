/**
 * The memory subsystem's public surface.
 *
 * A barrel with a stated ordering rather than a re-export wall, because "what is
 * the order things happen in" is the question a reader of a memory system has
 * first, and a flat list of 200 names does not answer it.
 *
 * The pipeline, in the order the data flows:
 *
 *   1. `ontology`  — the vocabulary. Read this first; everything else is
 *                    expressed in its terms and the lattices live here.
 *   2. `record`    — the versioned record, and the read projection of v1.
 *   3. `ports`     — the interfaces. Read before the implementations, because
 *                    the implementations are behind them and a reader deciding
 *                    "where should this code go" needs the seam, not the class.
 *   4. redaction   — before persistence, when input is prohibited.
 *   5. repository  — append-only storage, authorization, supersession, tombstones.
 *   6. migration   — v1 and legacy `memory.json` -> v2, as a plan then a write.
 *   7. workflow    — propose / accept / reject / supersede, with audit events.
 *   8. summarization — bounded handoffs, dependency results, run summaries.
 *
 * The context assembler and the TUI live in `src/context/` and are not
 * re-exported here: they depend on this module, and a barrel that re-exported
 * them would make the dependency bidirectional and the import graph unreadable.
 */

export * from "./ontology.js"
export * from "./record.js"
export * from "./ports.js"
export * from "./primitives.js"
export * from "./repository-errors.js"
export * from "./access-policy.js"
export * from "./in-memory-repository.js"
export * from "./file-repository.js"
export * from "./redaction/index.js"
export * from "./migration.js"
export * from "./workflow.js"
export * from "./summarization.js"
