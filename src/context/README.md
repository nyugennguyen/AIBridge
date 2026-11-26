# src/context - not yet wired

Deterministic context assembler: builds a manifest of included and withheld
memory items for a dispatch, renders it, and audits the egress paths
(`isolation.ts`). It depends on `src/memory/`; nothing in `src/memory/`
imports it.

- **Serves:** roadmap V3 (context snapshot attached to a job, built from
  project memory). See `Docs/implementation-plans/v3.2.0-plan.md` section 5.2.
- **Status:** unreachable from `src/cli.ts` and `src/index.ts`.
- **Wire by:** 3.4.0.
- **Delete by:** 3.5.0 if still unwired (ADR 0016).

It cannot be wired before `src/memory` is. The deadline is tracked in
`scripts/docs/reachability-exemptions.json` and checked by
`bun run docs:reachability`.
