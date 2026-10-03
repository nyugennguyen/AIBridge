# Milestone 7 — partial progress and handoff

Date: 2026-10-04. Branch `aibr-v2`. This is **not** a completion report.

Milestone 7 replaces the Bun engine's HTTP ingress with a Rust router that owns
the listening socket and admits work to a durable SQLite queue before
acknowledging it. That work is partly done. This document says exactly what
verifies, what does not, and what the next agent should do first.

Read [`milestone-7-polyglot-ingress.md`](../implementation-plans/milestone-7-polyglot-ingress.md)
§"Execution Scope" first — it is the decision that shapes everything below.

---

## What is done and verified

| Task | State | Evidence |
| --- | --- | --- |
| **M7.0** benchmark harness | done | `bench/`, self-test 25/25, shellcheck clean |
| **M7.1** router spike | done | [`milestone-7-router-spike.md`](milestone-7-router-spike.md) |
| **M7.2** contract chain | done | 27 schemas → 1767 Rust types, reproducible |
| **M7.3** router + four gates | done | 101 Rust tests; F-01/F-03/F-04/F-06 closed |
| **M7.5** durable admission | done | 9 crash-matrix tests |

M7.4, M7.6, M7.7, M7.8, M7.12, M7.13 remain. M7.9/M7.10/M7.11 are code-plus-CI
only (see below).

### Gates, all currently green

```
bun run typecheck                       clean
bun test                                5107 pass, 0 fail, 4 skip
bun run build                           clean
bun run generate:contracts && git diff  clean (generator exit 0 asserted)
cd router && cargo fmt --check          clean
cd router && cargo clippy --all-targets -- -D warnings   clean
cd router && cargo test                 101 pass, 0 fail
git diff --check                        clean
shellcheck scripts/install.sh           clean
```

---

## The four findings closed at ingress

| ID | Finding | Closure | Test |
| --- | --- | --- | --- |
| `F-01` | `job_id` → traversal via `join(dir, id + ".json")` | `[A-Za-z0-9_-]{1,128}` | `f01_a_traversal_job_id_is_refused_on_trigger`, `validate::tests::f01_the_threat_model_reproduction_is_refused` |
| `F-03` | `GET /jobs/:id` had **no authentication** | every route behind bearer auth, reads included | `f03_no_route_answers_without_a_bearer` |
| `F-04` | lexical `resolve()`, no `realpath` | `canonicalize` + containment | `f04_a_symlink_escaping_the_configured_root_is_refused` |
| `F-06` | unversioned legacy state | `schemaVersion` envelope, unknown refused | `f06_an_unknown_schema_version_is_refused` |

`F-02` (callback bearer forwarding) is **M7.8** and is still open.

---

## The constraint that must survive: Tier 1 has no authority

ADR 0008 §2.2. The router answers one question — *is this shaped like a valid
request?* — and never *is this caller allowed to do this?*. The Bun worker keeps
every semantic decision: `assertSourceAuthorized`, `assertProjectAllowed`,
plan approval, the job store.

Three tests exist purely to stop that boundary eroding, and they will **fail**
if the router grows authority:

- `a_structurally_valid_trigger_from_an_unauthorized_source_is_still_admitted`
- `a_report_from_an_unauthorized_source_is_still_admitted`
- `plan_status_approved_is_not_a_trust_signal_to_the_router`

There is deliberately **no `403`** anywhere in the router crate. "You are
forbidden" is a Tier-2 sentence; returning it would imply the router knows
something it has no identity model to know.

---

## What is deliberately unverified

**The headline memory claim was withdrawn.** Measured, not projected:

| Quantity | Measured | Originally claimed |
| --- | --- | --- |
| Worker without Fastify | **46.98 MiB** | 43.3 MiB |
| Reduction | **−29.3%** | −39% |
| `<= 45 MiB` total | **unreachable** | the target |

A single idle capture is not gateable evidence: three captures of the *unchanged*
engine spread **61%**, because Bun migrates between RSS plateaus while idle. The
gated quantity is now steady state under sustained load (plan §5.1.1 A1–A4).
Residual **R-M7.1-1** — the baseline itself is not gateable (34.7% spread) — is
still open and blocks any percentage claim.

M7.9 (musl/macOS build matrix), M7.10 (`systemd`/`launchd`) and M7.11 (`nft` +
`tailscale0`) are **not implemented**. The reference host has no `tailscale0`,
no `systemd`, and no `zig`, so writing them and claiming they work would be a
lie. They need a GitHub Actions workflow that actually executes them on Linux.

M7.14 (canary rollout, 7-day soaks) is **not attempted** — it needs two live nodes.

---

## Next, in order

**M7.6 — backoff port and parity.** Pure function, smallest remaining task.
`INGRESS_BACKOFF_MS` already exists in `router/src/outbox.rs`; what is missing is
the delay computation *with the documented full-jitter deviation*. `fail()` takes
`next_attempt_at_ms` as an argument precisely so this task owns the policy
instead of the storage layer. Port `src/mesh/outbox/policy.ts` and assert 16/16
golden-vector parity with the TypeScript.

**M7.7 — worker drain loop.** The largest remaining item. The Bun worker claims
from `ingress_outbox`, re-runs `triggerRequestSchema.safeParse` on the delivered
payload (Tier 2), then executes and acknowledges **as a second durable write**.
Fastify leaves the engine process. **Do not** delete the Fastify listener in the
same change — plan §5.3 step 6 is a separate reviewed change, because rollback
is one config key.

**M7.8 — `egress_outbox`, closes `F-02`.** Destination origin must resolve
against `config.agents[].url` **before any `Authorization` header is
constructed**. No cross-origin redirects. This is the last open High finding.

Then M7.4 (`ingress_mode` flag), M7.12 (bound enforcement), M7.13 (TUI decoupling).

---

## Traps, recorded because each cost real time

- **`cargo fmt` rewrites the 3 MB generated `contracts.rs`.** Both documented
  mechanisms for stopping it (`[workspace] ignore`, `.rustfmt.toml ignore`) are
  **nightly-only and silently dropped** — both were tried and each left 4892 diff
  hunks. The fix is `#[rustfmt::skip]` on the `mod` declaration in `lib.rs`.
- **A `.gitignore` containing a slash is anchored to its own directory.** A
  `spike/.gitignore` holding `spike/router-stub/target/` resolves to
  `spike/spike/...` and matches nothing. Use `/router/target/` at repo root.
- **`rusqlite` has no `ToSql for u64`**, by design. A wrapped timestamp reads as
  a row that is always ready. Use `bind_ms()`.
- **A schema and its own code can contradict each other.** `next_attempt_at_ms`
  was `NOT NULL` while `fail()` clears it — a record could reach attempt 8 and
  be unable to go terminal. Constraints and branches must be read together.
- **`git diff --exit-code` after a generator that FAILED is vacuously clean.**
  Always assert the generator's exit code too. This produced one false green
  during M7.2.
- **ajv is CommonJS.** Under NodeNext, `import Ajv2020 from "ajv/dist/2020.js"`
  yields the module; the class is `Ajv2020.default`.
- **`zod-to-json-schema` does not support Zod 4** — it returns `{}`. Zod 4.4.3's
  native `z.toJSONSchema()` is exact. Do not add that package.
- **Sub-agent connections dropped three times** on this milestone. Landed work was
  recovered each time by inspecting the tree rather than trusting the report.
  Commit in small increments.

---

## Reviewer notes

Two defects were found by review rather than by a test failing, and both are the
kind that pass every gate:

1. The router's `202` omitted `target_agent_id`, which its own generated contract
   lists as **required**. Nothing could catch it: the parity test checks the
   fifteen `tests/contracts/examples/` fixtures against their *input* schemas, and
   no fixture is a response body.
2. `migrate()` issued a bare `BEGIN IMMEDIATE` and never committed, so every
   admission returned `503`. The symptom read like a working `SF-08` refusal.

The lesson generalises: **assert the property, not the absence of a crash.** Where
a regression could produce a silent lie — a `202` with no row, a terminal row that
looks due, a contract field quietly dropped — write the assertion that names it.