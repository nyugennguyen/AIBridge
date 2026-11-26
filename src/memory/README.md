# src/memory - not yet wired

Scoped project memory: versioned records, an access-policy lattice, append-only
file and in-memory repositories, a propose/accept/reject workflow, and
summarization (handoffs, run summaries).

- **Serves:** roadmap V4 (handoff summaries) and V3 (project memory).
  See `Docs/implementation-plans/v3.2.0-plan.md` section 5.2.
- **Status:** unreachable from `src/cli.ts` and `src/index.ts`, except
  `redaction/`, which is wired in 3.2.0 through `src/runtime/sanitizer.ts`.
- **Wire by:** 3.3.0.
- **Delete by:** 3.4.0 if still unwired (ADR 0016).

The deadline is tracked in `scripts/docs/reachability-exemptions.json` and
checked by `bun run docs:reachability`. Do not extend it without recording the
reason there.
