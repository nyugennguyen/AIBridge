# src/notifications - not yet wired

Notification bus, in-memory store with dedupe and quieting rules, payload
types and the no-secret audit.

- **Serves:** roadmap V5 (job notifications to Discord or Telegram). See
  `Docs/implementation-plans/v3.2.0-plan.md` sections 5.2 and 7.6.
- **Status:** unreachable from `src/cli.ts` and `src/index.ts`. Until 3.2.0 it
  was wired into `createApp`, but its only source was the orchestration routes,
  which `aibr serve` never fed, so nothing was ever delivered. Block D5 removed
  that wiring and `consumer.ts` (it mapped kernel events: roundtable, charter,
  lease) together with the kernel.
- **Wire by:** 3.5.0.
- **Delete by:** 3.6.0 if still unwired (ADR 0016).
- **Known limits:** the store lives in memory only, and invariant N2 forbids
  prompts in a payload (plan section 7.6).

The deadline is tracked in `scripts/docs/reachability-exemptions.json` and
checked by `bun run docs:reachability`.
