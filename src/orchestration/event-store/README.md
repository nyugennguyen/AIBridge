# src/orchestration/event-store - not yet wired

Append-only SQLite event store with fingerprinting, migrations and an outbox.

- **Serves:** roadmap V4 (durable job event log, the base for `aibr` following
  work instead of agents polling). See
  `Docs/implementation-plans/v3.2.0-plan.md` section 5.2.
- **Status:** unreachable from `src/cli.ts` and `src/index.ts`, except
  `sqlite-driver.ts` and `schema.ts` (used by the egress outbox, the router
  drain worker and the diagnostics integrity check). Block D5 (3.2.0) removed
  the orchestration kernel that used to call `event-store.ts`; `outbox-store.ts`
  and `types.ts` are kept with it because `event-store.ts` imports them.
- **Wire by:** 3.3.0.
- **Delete by:** 3.4.0 if still unwired (ADR 0016).

The deadline is tracked in `scripts/docs/reachability-exemptions.json` and
checked by `bun run docs:reachability`.
