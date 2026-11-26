# src/orchestration/event-store - not yet wired

Append-only SQLite event store with fingerprinting, migrations and an outbox.

- **Serves:** roadmap V4 (durable job event log, the base for `aibr` following
  work instead of agents polling). See
  `Docs/implementation-plans/v3.2.0-plan.md` section 5.2.
- **Status:** unreachable from `src/cli.ts` and `src/index.ts`. Block D5 keeps
  `event-store.ts`, `fingerprint.ts` and `migrations.ts` and removes the
  orchestration kernel that used to call them.
- **Wire by:** 3.3.0.
- **Delete by:** 3.4.0 if still unwired (ADR 0016).

The deadline is tracked in `scripts/docs/reachability-exemptions.json` and
checked by `bun run docs:reachability`.
