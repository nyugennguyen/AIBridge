# bench/ — measurement harness for Milestone 7

Shell only. No TypeScript, no Rust, no npm dependencies, and no bash 4 features
(macOS `/bin/bash` is 3.2). Everything runs on `awk`, `ps`, `curl` and coreutils.

```
bench/
  mem.sh              sample absolute RSS levels of a process set over time
  latency.sh          HTTP round-trip latency, with an excluded warmup phase
  three-process.sh    the honest wrapper: SUM is primary, router-only is not
  imports-probe.sh    the ADR 0008 §1 import ladder, as levels
  capture-baseline.sh reproduce ADR 0008 §1 and write baseline/engines.json
  selftest.sh         acceptance cases for the noise classifier (M7.0 exit criterion)
  lib/stats.sh        median/p5/p95/p99 and the noise classifier
  lib/mem_probe.sh    process resolution, the sampling loop, JSON emission
  baseline/           the committed capture and its schema
```

---

## The one rule

**Every memory figure this harness produces is an absolute RSS level. No figure is
a difference between two samples.**

This is not a style preference. ADR 0008 §1 records that during the original
baselining, RSS **fell 4.4 MiB across 500 requests** because JSC returned pages
to its allocator. A delta-based harness reports that as a win. While building this
one, an idle `aibr serve` process was observed to fall from **65.0 MiB to 29.0 MiB
with no traffic at all** over 60 seconds — a delta harness would have reported a
55% improvement in a system that had done nothing.

Both facts are visible in the committed baseline: `steadyState.sum.rssMib` has
`median` 56.45 and `p5` 29.63, because the process spent part of the window in
each state. The spread is the honest reading. A single number would not be.

Consequences, all enforced in code:

- `lib/stats.sh` has no function that subtracts one series from another.
- `lib/mem_probe.sh` computes per-tick sums of *simultaneous* levels and never
  differences between ticks.
- `sum.completeTicks` counts only ticks where every included slot was present, so
  an absent process can never contribute a fabricated `0` to a total.
- The import ladder reports a **level per step**. ADR 0008 §1 has a "Delta"
  column; this harness does not reproduce it, and `bench/imports-probe.sh` says
  why in its header.

---

## Units

`ps -o rss= -p <pid>` reports **kilobytes** on macOS and Linux alike. Everything
the harness prints or writes is **MiB**, converted exactly once
(`MiB = KiB / 1024`) in `bench/lib/mem_probe.sh`. Latency is **milliseconds**
(`curl`'s `time_total` seconds × 1000, at microsecond source resolution).

The unit and the fact that the quantity is a level are both written into every
artefact's `units` block, so a figure lifted out of a JSON file still carries its
own provenance.

---

## Percentiles: nearest rank, no interpolation

`p5`, `p95` and `p99` use **nearest rank**: the value at the 1-based index
`ceil(p/100 * n)` of the ascending-sorted series. No interpolation.

Two reasons, both about the number going into a signed gate report:

1. A nearest-rank percentile is always a value the system **actually held**.
   Interpolated percentiles can report a level that never occurred, which is
   indefensible for a threshold a reviewer is signing.
2. It is reproducible by hand from the committed `series` array with no estimator
   choice in the way. A reviewer can recompute the gate number.

The **median** is the one exception, and follows the conventional definition: for
even `n` it is the mean of the two central order statistics.

Both facts are asserted in `selftest.sh` against known series (`1..100` → p95 = 95,
median = 50.5), so the method cannot drift silently.

---

## Sampling minimum: ≥ 1 Hz for ≥ 60 s

Milestone 7 §5.1 rule 2: *JIT allocation is lazy, so a 2 s sample after start
under-reports.*

`bench/mem.sh` **refuses** (exit 2, loud banner on stderr) any run that samples
fewer than 60 times, slower than 1 Hz, or for less than 60 seconds total. The only
override is `--allow-short`, which takes the measurement and stamps
`"shortSample": true` into the output, and warns on stderr that the run must not
be cited. The constants are `BENCH_MIN_SAMPLES`, `BENCH_MIN_INTERVAL_SECONDS` and
`BENCH_MIN_DURATION_SECONDS` in `lib/mem_probe.sh`.

The reason the harness refuses rather than warns: a 2-second run that reports
"no regression" is indistinguishable from a 2-second run that hid one. The
refusal makes the difference between a compliant measurement and a non-compliant
one impossible to lose in a transcript.

`bench/capture-baseline.sh` warms the bridge for 10 s before sampling, and those
warmup samples are **not** in the reported series.

---

## The noise classifier, and why the floor is 5%

`bench_classify BASELINE_SERIES CANDIDATE_SERIES` in `lib/stats.sh` returns one of
`improve`, `regress`, `noise`, or `insufficient-samples`.

A verdict of `improve` or `regress` requires **both**:

1. **Non-overlapping distributions.** The candidate's entire `p5..p95` band must
   sit below (improve) or above (regress) the baseline's band. Bands that
   intersect have not been shown to be different distributions.
2. **Magnitude beyond the floor.** The median move must exceed
   `STATS_NOISE_FLOOR_PCT` (default 5%).

Otherwise: `noise`. With fewer than `STATS_MIN_SAMPLES` (60) in either series:
`insufficient-samples` — never a silent pass, and `bench/mem.sh` exits 3 when a
comparison lands there.

**Why overlap rather than a threshold on the median difference.** This is the
acceptance criterion for M7.0, and the 4.4 MiB fall in ADR 0008 §1 is exactly the
case it exists for. A test on the median alone reads that fall as an improvement
and would sign off a security-relevant architecture change on allocator
behaviour. The self-test's first case is that shape: candidate median ~7% below
baseline, `p5..p95` bands overlapping, verdict `noise`.

**Why the floor is 5% and not something larger or smaller.** It is a tunable, not
a physical constant, and it is set where it is because run-to-run variation across
*identical* configurations of these processes is a few percent — JIT page
retention, allocator arena boundaries, and RSS accounting of shared pages. Below
that band a change is unresolvable, and calling it a win is how a harness
manufactures a result. It is deliberately **not** set higher: the effect the
milestone is looking for is ~22%, and a floor set near the effect would reject
genuine improvements as noise. A reviewer on a host with tighter variance may
lower it and must say so in the gate report.

Note the band edges are `p5`/`p95`, not `min`/`max`: on macOS one page-in moves
RSS by more than the effect under test.

---

## Usage

### `bench/mem.sh`

```sh
bench/mem.sh --samples 60 --interval 1 --pid NAME[,NAME...] --baseline FILE --out FILE
bench/mem.sh --all --duration 60 --out FILE
bench/mem.sh --self-test          # same as bench/selftest.sh
```

- `--pid` takes comma-separated matchers. A matcher is `|`-separated
  alternatives. An alternative matches a process's `comm` (executable name)
  **exactly**; argv substring matching is only consulted if *no* alternative of
  that slot matched a comm name, which is why `--pid bun` cannot accidentally sum
  every process that merely mentions `bun`. Multiple PIDs matching one matcher are
  **summed** and the count is reported.
- The slot's reported name is its **first** alternative, so JSON keys and series
  filenames stay stable while the match expression carries fallbacks. First
  alternatives must therefore be unique.
- A process that dies mid-run is recorded as an absent tick, not dropped. Samples
  stay aligned in time and the sample count stays truthful.
- The harness excludes itself, its ancestors, and its direct children from
  matching. argv-substring matching is otherwise self-inclusive: `--pid
  'engine|src/index.ts'` puts that literal text into the harness's own command
  line. (This was a real bug during development — the resolver's own `awk -v
  matchers=...` matched itself. Matchers are now passed through a file so they
  never appear in a spawned process's argv.)

Exit codes: `0` measured · `1` runtime error · `2` usage error or refused
non-compliant sampling · `3` a comparison regressed or was inconclusive.

### `bench/latency.sh`

```sh
bench/latency.sh --url URL --requests 200 --warmup 50 --out FILE \
                 [--method M] [--header 'K: V'] \
                 [--expect-p50-ms 2] [--expect-p99-ms 10]
```

Warmup requests are issued first, their distribution is measured and reported
separately, and **excluded** from the reported distribution — the exclusion is
visible in the output (`warmup.excludedFromReportedDistribution: true`) rather
than left implicit in a sample count.

Non-2xx/3xx responses are counted and excluded, never averaged in: a failed curl
prints `0.000000` and would otherwise be the best sample in the distribution. If
every request fails, the script exits 1 rather than reporting a distribution of
failures. Requests are sequential, so this is service time, not concurrency
behaviour.

Thresholds are enforced: exit `3` when one is violated, so this is usable in CI
directly.

### `bench/three-process.sh`

```sh
bench/three-process.sh [--samples N] [--interval SECONDS] [--duration SECONDS] \
                       [--baseline FILE] [--out FILE] [--allow-short]
```

Samples `aibr-router`, the worker and the TUI, and reports **the SUM as the
primary number**. It writes an explicit `headlineWarning` field into the JSON:

> router-only figures are not a host-level result; opencode serve, the ~20 MiB Bun
> runtime floor, and @opentui/core are untouched.

The warning is in the artefact, not just on the terminal, so a later report cannot
quote the router's 1.94 MiB as the headline without lifting the caveat with it.
This is a hard requirement from milestone 7 §5.1, not a nicety.

**Pre-router case:** until M7.1 there is no `aibr-router` binary. The slot is
reported `"absent": true` with `absentTicks` equal to the full tick count, the sum
covers the processes that were alive, and the run does not fail. Absence is
reported, never imputed as zero. Note that a pre-router sum is **not** comparable
to the post-router three-process total — the TUI is normally absent on a capture
host too.

### `bench/imports-probe.sh`

```sh
bench/imports-probe.sh [--repeats 7] [--out FILE]
```

The ADR 0008 §1 ladder (floor → fastify → zod → SDK → config parse → routes →
job store → `listen()`), one step per **fresh** process, RSS read from the kernel
after the step, reported as a level with median/p95 over repeats. A step whose
probe throws reports `levelMib: null` plus the error — never `0`, which would read
as "this module costs nothing".

This attributes a level to a module. It is **not** a steady-state measurement and
**not** the gate baseline.

### `bench/capture-baseline.sh`

```sh
bench/capture-baseline.sh [--out FILE] [--duration 60] [--warmup 10] [--repeat 1]
```

Starts the bridge, warms it, runs `three-process.sh`, `imports-probe.sh` and
`latency.sh`, and assembles `bench/baseline/engines.json`. It records
`"partial": true` and a `missing` list naming every ADR row or §5.2 target that
could not be reproduced, and why.

**Use `--repeat 3` (or more) for any capture meant to be compared against
something.** See the next section.

---

## ⚠ The finding that should change how M7.16 is gated

**Three consecutive, individually compliant 60 s captures of the same unchanged
`aibr serve` process produced SUM medians of 55.95, 34.84 and 34.63 MiB — a 61%
spread. The committed baseline's `runToRunVariance` records this.**

The process is not stationary. It sits at one of several plateaus (observed: ~24,
~35 and ~54–56 MiB) and transitions between them on a timescale of minutes while
receiving no traffic at all. Feeding the three captured series to the classifier
pairwise gives:

| baseline → candidate | median change | verdict |
| --- | --- | --- |
| run 1 → run 2 | −37.8% | `improve` |
| run 2 → run 3 | −0.6% | `noise` |

The classifier is behaving correctly: the two distributions really do not overlap,
because the process really did sit 20 MiB lower for the whole window. What is not
stable is the *system*, and no setting of this harness fixes that. A longer warmup
does not — measured on the capture host with `--repeat 2`, the SUM median was:

| warmup before sampling | run 1 | run 2 |
| --- | --- | --- |
| 10 s | 54.34 | 35.00 |
| 20 s | 35.05 (p95 60.06) | 34.77 |
| 30 s | 34.95 (p95 54.48) | 35.15 |
| 45 s | 23.83 | 23.91 |
| 75 s | 35.03 | 35.13 |

45 s lands in a *lower* plateau than 75 s. There is no warmup that pins it.

Consequences for the milestone, stated plainly:

1. **A single 60 s idle capture is not a reproducible baseline for the Bun
   engine.** ADR 0008 §1's 57.3 MiB is one sample of this same wandering
   quantity, not a stable property of it.
2. The effect M7 is trying to detect (57.3 → 45.2 MiB, ~21%) is **smaller than
   the observed plateau spread** (~21–35 MiB). A gate that compares one 60 s idle
   capture against another can therefore report a pass or a fail that is pure
   allocator state.
3. Milestone 7 §5.1's "≥1 Hz for ≥60 s" rule is **necessary but not sufficient**.
   It fixes sampling rate and window length; it does not make the quantity
   stationary.
4. Before M7.16 signs off a −39% total, the definition of "idle" needs to be
   reproducible. The obvious candidate is a **sustained workload** (continuous
   traffic, so JSC cannot release pages) with the level sampled under that load,
   reported separately from a genuinely idle level. That is an M7.16 decision, not
   something M7.0 should silently pick.

What M7.0 does about it: `--repeat N` is built in, `runToRunVariance` is recorded
in the artefact with the raw series of every run, and `capture-baseline.sh` prints
a loud warning when the spread exceeds 10%. A gate that ignores this field will be
gating on noise, and the harness says so on stderr at capture time.

---

## Output schemas

`bench/baseline/schema.json` documents all four artefact shapes
(`aibridge.bench.mem/1`, `.latency/1`, `.imports/1`, `.baseline/1`) as a single
JSON Schema document, keyed by schema id. M7.16's gate report should cite it so a
reviewer can check any number against the field that produced it.

`bench/baseline/engines.json` is the committed capture, produced by
`bench/capture-baseline.sh` — not hand-written.

---

## What `bench/baseline/engines.json` does and does not cover

It is **`partial: true`** with five named gaps, and its `runToRunVariance` field
records a 61% run-to-run spread on an unchanged system. **Read both before citing
any figure from it.** In summary, on the capture host:

- The eight ADR 0008 §1 import-ladder rows were reproduced, as levels.
- The end-to-end running-bridge level was reproduced (60 s at 1 Hz).
- **Admission latency is not baselined.** No `opencode serve` was reachable, so
  `/health` returned HTTP 500 for every request and `latency.sh` correctly refused
  to report a distribution of failures. The §5.2 latency targets remain unbaselined.
- **The TUI could not be started** (interactive, needs a TTY).
- The router does not exist yet.
- CPU idle %, 500-request burst cost, 24 h soak loss and rollback time are M7.x
  rows, not M7.0 deliverables, and are unbaselined.

Two further caveats worth carrying into M7.16:

1. **The figures were re-measured, not copied from the ADR.** The capture ran
   loopback with no `opencode serve` on a host with no `tailscale0`, against
   ADR 0008 §1's reference host which had all three. Differences against the ADR
   table are expected and are a deviation to reconcile, not an error to hide.
2. **The import-ladder rows are single-shot probes** and are **not** sampled at
   ≥1 Hz for ≥60 s. They are provenance for module attribution. The gate baseline
   is `steadyState`, and the schema's `notAIdleSteadyStateMeasurement: true` flag
   says so in the artefact itself.
3. **The steady-state figure is one sample of a non-stationary quantity.** The
   section above is the evidence. `steadyState` is the *first* of the `--repeat`
   runs, deliberately not the best or the most stable one: picking the flattering
   run would be exactly the cherry-picking this harness exists to prevent.

---

## Self-test

```sh
bench/selftest.sh      # or: bench/mem.sh --self-test
```

Exit `0` only if every case classifies as expected. It is the M7.0 acceptance
criterion and it fails loudly:

- a **falling** series (median ~7% down, bands overlapping) → must be `noise`,
  **not** `improve`
- a tight series separated by less than the noise floor → `noise`
- a clearly regressing series → `regress`
- a clearly improving series → `improve`
- too few samples → `insufficient-samples`
- two identical series → `noise`
- the percentile and median methods against known series
- absent samples dropped, not zeroed
- `stats_json` survives brace-stripping with its sample count intact
- baseline series extraction from both JSON layouts

Every synthetic series is deterministic (a fixed `sin()` sweep, not a random
generator). A self-test that can flake teaches the reader to re-run it until green,
which is the opposite of what a gate needs.

---

## Adding a process

1. Give it a matcher whose **first** alternative is the name you want in the JSON.
2. Prefer an exact `comm` match; reach for argv substrings only when the process's
   comm is not distinctive (`bun` is).
3. Confirm `pidCount` in the output is what you expect. argv matching can pick up
   an unrelated leftover shell whose command line happens to mention the matcher.
   The count makes that visible; the harness cannot rule it out for you.