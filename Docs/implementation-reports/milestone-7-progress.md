# Milestone 7 — Progress and Audit Report

Date: 2026-10-04. Branch `aibr-v2`.

Milestone 7 replaces the Bun engine's HTTP ingress with a native Rust router that
owns the listening socket, authenticates and bounds every request, and admits work
to a durable SQLite queue before acknowledging it.

Per [`milestone-7-polyglot-ingress.md`](../implementation-plans/milestone-7-polyglot-ingress.md)
§"Execution Scope", this document records what is fully implemented and verified on the
reference host (macOS arm64), what is written and verified only by CI (`unverified-on-macOS`),
and what is deliberately unattempted (M7.14 canary rollout).

---

## Task Delivery Summary

| Task | State | Deliverable & Evidence |
| --- | --- | --- |
| **M7.0** benchmark harness | done | `bench/`, self-test 25/25, shellcheck clean |
| **M7.1** router spike | done | [`milestone-7-router-spike.md`](../spikes/milestone-7-router-spike.md) |
| **M7.2** contract chain | done | 27 schemas → 1768 Rust types, reproducible, generator exit 0 |
| **M7.3** router + four gates | done | 101 initial Rust tests; F-01/F-03/F-04/F-06 closed at ingress |
| **M7.4** `ingress_mode` & shadow mode | done | `bridge.ingress_mode: "engine" \| "router"` (**now read** — it was inert), `ShadowIngressMirror`, `--shadow-mode`, `tests/unit/server/shadow.test.ts` (8), `tests/unit/ingress/ingress-mode.test.ts` (4) |
| **M7.5** durable admission queue | done | `ingress_outbox` (WAL, `synchronous=FULL`), crash-matrix tests, and `--init-store` as the operator provisioning path |
| **M7.6** backoff policy port & parity | done | Rust `policy.rs` port, 16/16 golden vectors parity (`router/tests/backoff.rs`, `tests/unit/mesh/outbox/backoff-parity.test.ts`), documented full-jitter deviation in both languages |
| **M7.7** worker drain loop | done | `IngressDrainer`, Tier 2 `triggerRequestSchema.safeParse`, two durable writes (claim/acknowledge, SF-08), and **`aibr worker`** as a process (`src/ingress/worker.ts`) — previously the class existed only in its own test. `tests/unit/ingress/drainer.test.ts`, `tests/unit/ingress/worker.test.ts` |
| **M7.8** `egress_outbox` & F-02 closure | done | `assertDestinationOriginAllowed`, `safeEgressFetch`, `EgressOutboxStore`, unlisted origin rejected before header construction, CGNAT pinning, `tests/unit/callback/` (15) |
| **M7.9** static build matrix | code + CI (`unverified-on-macOS`) | `scripts/build-matrix.sh`, `tests/unit/packaging-ci.test.ts`, `.github/workflows/milestone-7.yml` (musl Linux, Darwin lipo universal binary) |
| **M7.10** supervisor units | code + CI (`unverified-on-macOS`) | Both systemd units now reference **flags and a CLI command that exist** (`--init-store`, `--preflight`, `aibr worker`); `sd_notify` READY/STOPPING makes `Type=notify` truthful; launchd worker plist + both wrappers added; `MemoryMax=64M` on the worker with the measurement recorded. `tests/unit/packaging/supervision.test.ts` |
| **M7.11** tailnet bind enforcement | code + CI (`unverified-on-macOS`) | `packaging/nftables/aibridge.nft`, router layer-1 bind preflight (`router/src/bind.rs`, exit 78), `.github/workflows/milestone-7.yml` |
| **M7.12** bound enforcement (SF-15) | done | `AdmissionBounds` (global inflight cap, per-source cap, queue depth cap, oldest row age cap), `429` + `Retry-After`, `router/tests/bounds.rs` (4 pass including flood test) |
| **M7.13** TUI decoupling assertion | done | `tests/unit/tui/decoupling.test.ts` (6 pass): source-scan forbids `src/tui/**` imports to `src/jobs/` or ingress outbox; router answers 404 for mesh endpoints |
| **M7.14** canary rollout | not attempted | Scoped out per plan §Execution Scope (requires two live nodes and 7-day soaks) |
| **M7.15** trust boundary review | done | Two-tier validation preserved: router has no 403, engine worker remains sole semantic authority |
| **M7.16** gate audit | **partial** | Gates re-run and green (above). **Not complete**: `bun run release:check` and `bench/mem.sh --all --samples 60` were not run in this pass, the `.github/workflows/milestone-7.yml` additions have never executed on a Linux runner (the branch is unpushed), router RSS has never been re-measured with SQLite present, and no signed security review is on file. |

---

## Still Not Done

Recorded so a reader of this report cannot mistake the fixes above for a
completed milestone.

1. **Nothing is committed.** HEAD is `4898fc5 "M7: partial progress report"`.
   M7.6–M7.16 exist only in the working tree; `packaging/` and the CI workflow are
   untracked; the branch is 26 commits ahead of `origin/aibr-v2` and unpushed. The
   plan's `git diff --exit-code contracts/` gate passes only because the regenerated
   contracts are staged-but-uncommitted — `git diff HEAD -- contracts/` is non-empty.
2. **CI has never run.** Last workflow run on this repo: 2026-08-25, before any M7
   work. The M7 workflow triggers on push/PR to `main`; this branch is neither.
   `workflow_dispatch` now exists so it can be run on demand.
3. **The 1000-cycle durability criterion is unmet.** The plan requires zero loss
   across 1000 kill/restart cycles. `router/tests/crash_matrix.rs` does 20 and 500
   *in-process* iterations and only two real `SIGKILL` spawns — and its own comment
   at line 73 cites a "1000-cycle loss test below" that does not exist.
4. **Router RSS was never re-measured with SQLite.** The −29.3% reduction is still
   M7.1's *stub* figure (1.91 MiB, no SQLite). R-M7.1-4 is unresolved.
5. **No sign-off.** The plan requires root agent + independent reviewer + security
   reviewer signatures (README §113). M7.15's "done" has no signed artefact behind it.
6. **M7.14 unattempted**, as scoped. Two live nodes and 7-day soaks.
7. **Plan checkboxes remain unticked** in `milestone-7-polyglot-ingress.md`, and there
   is still no `milestone-7-completion.md` — correctly, since M7.14 has not run.
8. **The `<= 2 MiB` binary criterion is NOT MET.** Measured on the first Linux CI
   run: `x86_64-unknown-linux-musl` is **2,222,768 bytes (2.12 MiB)**, over the
   bound by 125,616. The `readelf -d` half of the same gate passes — zero
   `NEEDED` on both musl targets. The delta from M7.1's 558 KiB stub is bundled
   SQLite, which is precisely the unknown R-M7.1-4 named. Two reductions were
   measured and rejected: a safe `SQLITE_OMIT_*` subset bought 19,360 bytes
   (1.2%, not enough) and `SQLITE_OMIT_JSON` silently broke admission (503 on
   every write) while `the_store_is_wal_and_synchronous_full` still passed;
   trimming `regress`'s default features produced a byte-identical binary.
   Recorded in `scripts/build-matrix.sh` so the next attempt starts from the
   measurements. Closing it is an architecture decision (dynamic linking, or a
   store sidecar), not a compiler flag.

---

## What the first CI run found (2026-10-04)

The M7 workflow had never executed. Its first run failed, and every failure was a
real defect that local verification could not see:

| Failure | Cause | Fix |
| --- | --- | --- |
| Job failed in 3 s: `Unable to resolve action korandador/setup-zig` | The workflow referenced an action repository that does not exist | `mlugg/setup-zig@v2`; two tests now pin every `uses:` to an allowlist and an immutable ref |
| Both jobs: `error[E0277] … SocketAddr: AsRef<Path>` at `notify.rs:101` | My `send_to` was wrong for the Linux abstract-namespace arm — and that arm is `cfg(target_os = "linux")`, so **136 macOS tests, clippy and fmt all passed on code that cannot build on Linux** | `send_to_addr`; verified locally with `rustc --target x86_64-unknown-linux-musl --emit=metadata` (exit 0) |
| `Build musl targets matrix` passed while producing nothing | `build_target ... \|\| true` and a `Warning:` for a missing artefact | Both removed: a target that fails to cross-compile is now a failure |
| `Verify binary size` failed at 2,222,768 bytes | The `<= 2 MiB` gate, genuinely missed | Reported NOT MET above; the bound was not moved |

`ci.yml` (`verify (1.3.14)`) is **green** on the current head.

The Linux arm of `notify.rs` is the item worth carrying forward: **a
platform-gated code path is unverified code**, and the build matrix is the only
thing that verifies it. That is the whole argument for M7.9 existing.

---

## Verification Gates (re-run 2026-10-04, after the supervision and worker audit)

Every figure below was produced by running the command on the reference host, not
carried over from an earlier run of this milestone.

```
bun run typecheck                                         clean (0 errors)
bun test                                                  5204 pass, 0 fail, 4 skip across 230 files
bun run build                                             clean
bun run generate:contracts                                 exit 0, 27 schemas -> 1768 types
cd router && cargo fmt --check                            clean
cd router && cargo clippy --all-targets -- -D warnings    clean (exit 0)
cd router && cargo test                                   136 pass, 0 fail across 11 suites
git diff --check                                          clean
shellcheck scripts/install.sh scripts/build-matrix.sh      clean
shellcheck packaging/launchd/aibr-router.sh
                      packaging/launchd/aibr-worker.sh    clean
bash -n (all three shell scripts)                         clean
plutil -lint packaging/launchd/*.plist                    OK (both)
```

`bun run release:check` and `bench/mem.sh --all --samples 60` were **not** re-run in
this pass and are recorded as not-run rather than passed.

---

## What the audit found, and what changed because of it

An independent review of this milestone found that several deliverables were
reported `done` on the strength of code that no process ever executed. Each item
below was a live defect, not a documentation nit.

| Finding | Defect | Fix | Test |
| --- | --- | --- | --- |
| Supervisor units could not run | `aibr-router.service` ran `ExecStartPre=aibr-router --preflight`, but the binary parsed **no arguments at all**. `aibr-worker.service` ran `aibr preflight` (no such subcommand) and `aibr serve` — the old Fastify listener, not a drain worker. Both `ExecStartPre` lines failed on every boot. | Three argv modes: `--init-store`, `--preflight`, and bare serve. Worker unit now starts `aibr worker --profile`, which exists. | `router/tests/cli_modes.rs` (12) |
| `Type=notify` was a lie | No `sd_notify` datagram was ever sent, so systemd would hold the router in `activating` until `TimeoutStartSec` and then kill a healthy process. | `router/src/notify.rs` sends `READY=1` after the bind and `STOPPING=1` on `SIGTERM`. Hand-rolled: two datagrams did not justify a dependency in a 1.6 MiB binary. | `router/tests/notify.rs` (2), unit tests in `notify.rs` |
| No way to provision the store | The router refuses to start when the store is absent (exit 78, by design) and **nothing could create it** except test code. A fresh install could not come up. | `--init-store`, wired into both units, both launchd wrappers, and `scripts/install.sh`. Idempotent, and it refuses to overwrite a path that is not a store. | `cli_modes.rs`, `packaging/supervision.test.ts` |
| `IngressDrainer` was dead code | `src/ingress/drainer.ts` was referenced by exactly one file: its own test. No command, no process, no CLI. | `aibr worker` (`src/ingress/worker.ts`), plus `src/ingress/runtime.ts` so the engine and the worker share one construction of the authority. | `tests/unit/ingress/worker.test.ts` |
| `ingress_mode` was inert | `bridge.ingress_mode` was declared in the schema and read by nothing. Setting it changed no behaviour, so the plan's "rollback is deleting one key" was untested. | `bridge.ts` reads it: `"router"` turns on shadow mirroring by default, so declaring an intent to cut over also starts measuring divergence. | `tests/unit/ingress/ingress-mode.test.ts` (4) |
| `create: false` was unusable | `createSqliteDriver({create:false})` threw `flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE` on every call. `IngressDrainer.fromPath` used it, so the drainer could never have opened a store. This is why it was never wired to a process. | `sqlite-driver.ts` maps `create:false` to `readwrite:true` and refuses an absent file explicitly, so the contract holds on **both** backends — `node:sqlite` has no do-not-create flag and would have created the file it was told not to. | `tests/unit/event-store/sqlite-driver.test.ts` |
| CI could not fail | `milestone-7.yml` verified systemd with `grep -q "Restart=always"` and swallowed every `systemd-analyze` error. | Real parser, real exit codes, plus a step that drives `--init-store`/`--preflight` against the built binary — the step that would have caught the missing flags. `workflow_dispatch` added. | `tests/unit/packaging/supervision.test.ts` (40 total in that directory) |
| `install.sh` fetched a URL that does not exist | It constructed a `releases/download/...` URL for an artifact that has never been published, failing softly on every install. | Finds a locally built router (`AIBRIDGE_ROUTER_BIN` or `PATH`), provisions the store, and prints build instructions when absent. Unit installation is opt-in (`--with-units`) and root-gated. | `tests/unit/packaging/install-provisioning.test.ts` |

### End-to-end, on the reference host

Not a unit test — the real release binary, a real store, a real socket:

```
aibr-router --init-store        -> "provisioned admission store at /tmp/.../store.db"  exit 0
aibr-router --preflight         -> exit 0
aibr worker --profile dev-main  -> exit 1, "no such file or directory ... bearer_token"
                                  (refused; created nothing at the requested store path)
GET  /health                    -> 200 {"ok":true,"queue":{"depth":0,...}}
POST /trigger                   -> 202 {"accepted":true,"job_id":"e2e-1",...}
sqlite3 store.db                -> e2e-1|pending          (committed before the 202)
NOTIFY_SOCKET datagrams         -> ['READY=1', 'STOPPING=1'] on SIGTERM
```

---

## Five Security Findings Closed

| ID | Finding | Closure | Verification Test |
| --- | --- | --- | --- |
| `F-01` | `job_id` → traversal via `join(dir, id + ".json")` | Charset `[A-Za-z0-9_-]{1,128}` enforced at ingress | `f01_a_traversal_job_id_is_refused_on_trigger`, `validate::tests::f01_the_threat_model_reproduction_is_refused` |
| `F-02` | Callback forwards bearer token to caller URL | Destination origin resolved against `config.agents[].url` **before** constructing any `Authorization` header; no cross-origin redirects; CGNAT pinned | `tests/unit/callback/origin.test.ts`, `tests/unit/callback/reporter.test.ts`, `tests/unit/callback/egress-outbox.test.ts` |
| `F-03` | `GET /jobs/:id` had no authentication | Every route behind constant-time bearer auth, reads included | `f03_no_route_answers_without_a_bearer`, `f03_the_job_read_route_refuses_an_unauthenticated_request` |
| `F-04` | Lexical `resolve()`, no `realpath` | Canonicalize + project root containment | `f04_a_symlink_escaping_the_configured_root_is_refused`, `canonical_project_roots` |
| `F-06` | Unversioned legacy state | `schemaVersion` envelope ("v1"), unknown refused | `f06_an_unknown_schema_version_is_refused`, `f06_a_missing_schema_version_is_refused` |

---

## Two-Tier Validation Contract Preserved (M7.15)

ADR 0008 §2.2 and plan §2:
- **Tier 1 (`aibr-router`)**: "Is this shaped like a valid request?" Rejection filter only.
  No `403` exists in the router. Does not evaluate `assertSourceAuthorized`, allowlists, or plan approval.
- **Tier 2 (`aibr worker` / `IngressDrainer`)**: "Is this caller allowed to do this?" Sole authority.
  Re-runs `triggerRequestSchema.safeParse` on delivered payloads. Retains complete semantic ordering:
  `assertSourceAuthorized` → `assertProjectAllowed` → `ConfigPlanReviewProvider` → OpenCode health → dependency resolution → duplicate rejection.

The boundary tests remain green:
- `a_structurally_valid_trigger_from_an_unauthorized_source_is_still_admitted`
- `a_report_from_an_unauthorized_source_is_still_admitted`
- `plan_status_approved_is_not_a_trust_signal_to_the_router`

---

## What is Recorded Honestly (Deliberate Scope Boundaries)

1. **Memory reduction**: The original `<= 45 MiB` total RSS target was withdrawn in M7.1. Measured worker-without-Fastify is 46.98 MiB. Measured reduction is −29.3%, not −39%. Baseline spread on unchanged engine is 34.7% (R-M7.1-1), so percentage claims are point estimates, not gateable constants. **The −29.3% still derives from M7.1's stub router, which had no SQLite; the shipped router has never been measured (R-M7.1-4). Treat the figure as a projection of the architecture, not a measurement of this binary.**
2. **Linux & Tailnet primitives**: M7.9 (static musl), M7.10 (systemd), M7.11 (nftables + tailscale0 bind) are implemented as code, configuration templates, and an automated GitHub Actions Linux workflow (`.github/workflows/milestone-7.yml`). They are documented `unverified-on-macOS` because the reference host lacks Linux kernel, systemd, and Tailscale interface.
3. **M7.14 Canary rollout**: Unattempted per plan §Execution Scope (requires two live physical nodes and 7-day soaks).
