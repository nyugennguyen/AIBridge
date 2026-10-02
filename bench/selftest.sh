#!/usr/bin/env bash
# bench/selftest.sh -- asserts the noise classifier's decisions on synthetic
# series. This is the acceptance criterion for M7.0: "harness demonstrably
# reports a falling RSS series as noise, not a win".
#
# Every series here is SYNTHETIC and DETERMINISTIC (a fixed sin() sweep, not a
# random generator). A self-test that can flake teaches the reader to re-run it
# until it goes green, which is the opposite of what a gate needs. The p5/p95
# bands and medians are printed for each case so a reviewer can check the verdict
# against the distribution rather than trusting the harness's own summary.
#
# Usage: bench/selftest.sh   (also reachable as: bench/mem.sh --self-test)
# Exit: 0 all cases classified as expected; 1 at least one misclassification.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/stats.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/stats.sh"
# mem_probe.sh is sourced for bench_json_series only; the classifier cases below
# deliberately depend on nothing else in it.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/mem_probe.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/mem_probe.sh"

WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/aibr-bench-selftest.XXXXXX")
trap 'rm -rf "$WORKDIR"' EXIT

FAILURES=0
CASES=0

# gen FILE AWK_SNIPPET
gen() {
  awk "$2" > "$1"
}

report() {
  printf '  %-26s expected=%-21s actual=%-21s %s\n' "$1" "$2" "$3" "$4"
}

# assert_classify NAME EXPECTED BASELINE_AWK CANDIDATE_AWK
assert_classify() {
  local name="$1" expected="$2" baseline_awk="$3" candidate_awk="$4"
  local baseline_file="$WORKDIR/$name.baseline"
  local candidate_file="$WORKDIR/$name.candidate"
  gen "$baseline_file" "$baseline_awk"
  gen "$candidate_file" "$candidate_awk"
  local result verdict
  result=$(bench_classify "$baseline_file" "$candidate_file")
  verdict=$(printf '%s\n' "$result" | stats_get verdict)
  CASES=$((CASES + 1))
  if [ "$verdict" = "$expected" ]; then
    report "$name" "$expected" "$verdict" "OK"
  else
    FAILURES=$((FAILURES + 1))
    report "$name" "$expected" "$verdict" "MISCLASSIFIED"
    printf '    baseline  n=%s median=%s band=%s..%s\n' \
      "$(printf '%s\n' "$result" | stats_get baselineSamples)" \
      "$(printf '%s\n' "$result" | stats_get baselineMedian)" \
      "$(printf '%s\n' "$result" | stats_get baselineBandP5)" \
      "$(printf '%s\n' "$result" | stats_get baselineBandP95)"
    printf '    candidate n=%s median=%s band=%s..%s\n' \
      "$(printf '%s\n' "$result" | stats_get candidateSamples)" \
      "$(printf '%s\n' "$result" | stats_get candidateMedian)" \
      "$(printf '%s\n' "$result" | stats_get candidateBandP5)" \
      "$(printf '%s\n' "$result" | stats_get candidateBandP95)"
  fi
  printf '    %s\n' "$(printf '%s\n' "$result" | stats_get reason)"
}

printf '%s\n' "bench/selftest.sh -- noise classifier acceptance cases"
printf '%s\n' "noise floor: ${STATS_NOISE_FLOOR_PCT}%, required samples: ${STATS_MIN_SAMPLES}, percentile method: nearest rank"
printf '%s\n' ""

# 1. THE ACCEPTANCE CRITERION. The candidate's median sits ~8% BELOW the
#    baseline's -- it looks like a win to any threshold on the median -- but the
#    p5..p95 bands overlap heavily, which is exactly the shape produced by JSC
#    returning pages to its allocator across a request burst. Must be `noise`.
assert_classify falling-with-overlap noise \
  'BEGIN { for (i = 0; i < 64; i++) printf "%.4f\n", 100 + 20 * sin(i * 1.7) }' \
  'BEGIN { for (i = 0; i < 64; i++) printf "%.4f\n", 92 + 20 * sin(i * 1.7 + 0.4) }'

# 2. Same 8% fall, but with tight distributions: the bands separate, so the fall
#    is attributable. The control for case 1 -- it shows the classifier is
#    reading distribution shape, not just the median shift.
assert_classify falling-tight-noise noise \
  'BEGIN { for (i = 0; i < 64; i++) printf "%.4f\n", 100 + 0.2 * sin(i * 1.7) }' \
  'BEGIN { for (i = 0; i < 64; i++) printf "%.4f\n", 103 + 0.2 * sin(i * 1.7) }'

# 3. A clear regression: candidate band entirely above, 30% above.
assert_classify clear-regression regress \
  'BEGIN { for (i = 0; i < 64; i++) printf "%.4f\n", 100 + 0.5 * sin(i * 1.7) }' \
  'BEGIN { for (i = 0; i < 64; i++) printf "%.4f\n", 130 + 0.5 * sin(i * 1.7 + 0.3) }'

# 4. A clear improvement: candidate band entirely below, 30% below.
assert_classify clear-improvement improve \
  'BEGIN { for (i = 0; i < 64; i++) printf "%.4f\n", 100 + 0.5 * sin(i * 1.7) }' \
  'BEGIN { for (i = 0; i < 64; i++) printf "%.4f\n", 70 + 0.5 * sin(i * 1.7 + 0.3) }'

# 5. Too few samples on the candidate side, however dramatic the change: the
#    verdict must be insufficient-samples, never a pass.
assert_classify too-few-samples insufficient-samples \
  'BEGIN { for (i = 0; i < 64; i++) printf "%.4f\n", 100 + 0.5 * sin(i * 1.7) }' \
  'BEGIN { for (i = 0; i < 8; i++) printf "%.4f\n", 5 }'

# 6. Two identical series are noise by definition, not "improve" with a
#    zero-percent delta.
assert_classify identical-series noise \
  'BEGIN { for (i = 0; i < 64; i++) printf "%.4f\n", 100 + 5 * sin(i * 1.7) }' \
  'BEGIN { for (i = 0; i < 64; i++) printf "%.4f\n", 100 + 5 * sin(i * 1.7) }'

# --- statistics primitives -------------------------------------------------
# These are not classifier cases but they are what the classifier is made of, and
# a wrong percentile would quietly invalidate every gate number.

assert_equal() {
  local name="$1" expected="$2" actual="$3"
  CASES=$((CASES + 1))
  if [ "$expected" = "$actual" ]; then
    report "$name" "$expected" "$actual" "OK"
  else
    FAILURES=$((FAILURES + 1))
    report "$name" "$expected" "$actual" "MISMATCH"
  fi
}

printf '%s\n' ""
printf '%s\n' "statistic primitives"

gen "$WORKDIR/known.series" 'BEGIN { for (i = 1; i <= 100; i++) print i }'
assert_equal "median of 1..100 (even n)" "50.500000" "$(stats_compute < "$WORKDIR/known.series" | stats_get median)"
# Nearest rank, no interpolation: ceil(0.95 * 100) = 95 -> the 95th value.
assert_equal "p95 of 1..100 is nearest rank" "95.000000" "$(stats_compute < "$WORKDIR/known.series" | stats_get p95)"
assert_equal "p5 of 1..100 is nearest rank" "5.000000" "$(stats_compute < "$WORKDIR/known.series" | stats_get p5)"
assert_equal "n of 1..100" "100" "$(stats_compute < "$WORKDIR/known.series" | stats_get n)"
assert_equal "min of 1..100" "1.000000" "$(stats_compute < "$WORKDIR/known.series" | stats_get min)"
assert_equal "max of 1..100" "100.000000" "$(stats_compute < "$WORKDIR/known.series" | stats_get max)"
assert_equal "mean of 1..100" "50.500000" "$(stats_compute < "$WORKDIR/known.series" | stats_get mean)"
# Nearest rank with a small n: ceil(0.95 * 4) = 4 -> the largest value, never an
# interpolated value the series never contained.
gen "$WORKDIR/tiny.series" 'BEGIN { print 10; print 20; print 30; print 40 }'
assert_equal "p95 of a 4-sample series" "40.000000" "$(stats_compute < "$WORKDIR/tiny.series" | stats_get p95)"
# An absent sample arrives as "-". It must be DROPPED, not read as 0: a zero
# would drag the median of a memory series toward nothing.
gen "$WORKDIR/absent.series" 'BEGIN { for (i = 1; i <= 10; i++) { print i * 10; if (i % 5 == 0) print "-" } }'
assert_equal "absent samples are dropped, not zeroed" "55.000000" "$(stats_compute < "$WORKDIR/absent.series" | stats_get median)"
assert_equal "absent samples do not inflate n" "10" "$(stats_compute < "$WORKDIR/absent.series" | stats_get n)"
# Empty input must not divide by zero or emit a fabricated median.
gen "$WORKDIR/empty.series" 'BEGIN { exit 0 }'
assert_equal "empty series reports n=0" "0" "$(stats_compute < "$WORKDIR/empty.series" | stats_get n)"
assert_equal "empty series reports a null median" "" "$(stats_compute < "$WORKDIR/empty.series" | stats_get median)"

printf '%s\n' ""
printf '%s\n' "JSON emission"
# stats_json is what every artefact embeds its statistics through. A consumer
# strips the enclosing braces with `sed '1d;$d'`; if the first field shares the
# brace's line, that field is silently deleted. `n` was exactly that field, and
# an artefact reporting a distribution without its sample count is worse than no
# artefact: it cannot be checked against the sampling rule.
stats_compute < "$WORKDIR/known.series" | stats_json > "$WORKDIR/stats.json"
assert_equal "stats_json keeps n after brace stripping" "100" \
  "$(sed '1d;$d' "$WORKDIR/stats.json" | grep -o '"n": [0-9]*' | cut -d' ' -f2)"
assert_equal "stats_json reports the median" "50.500000" \
  "$(sed '1d;$d' "$WORKDIR/stats.json" | grep -o '"median": [0-9.]*' | cut -d' ' -f2)"
assert_equal "empty stats_json still reports n=0" "0" \
  "$(stats_compute < "$WORKDIR/empty.series" | stats_json | grep -o '"n": [0-9]*' | cut -d' ' -f2)"

printf '%s\n' ""
printf '%s\n' "baseline series extraction"
# bench_json_series is how a candidate run recovers the previous baseline's raw
# series. If it returns nothing for a key that IS present, bench_compare reports
# "no baseline series", which reads downstream as "no change" on a run that was
# never compared. Both layouts that bench_emit_json and hand-written JSON produce
# are asserted here, along with an absent key and an empty array.
printf '{"series": {"a": [1, 2, 3]}}\n' > "$WORKDIR/compact.json"
printf '{\n  "series": {\n    "a": [\n      1,\n      2,\n      3\n    ]\n  }\n}\n' > "$WORKDIR/pretty.json"
assert_equal "compact one-line array extracted" "1 2 3" "$(bench_json_series "$WORKDIR/compact.json" a | tr '\n' ' ' | sed 's/ $//')"
assert_equal "pretty multi-line array extracted" "1 2 3" "$(bench_json_series "$WORKDIR/pretty.json" a | tr '\n' ' ' | sed 's/ $//')"
assert_equal "absent key extracts nothing" "" "$(bench_json_series "$WORKDIR/compact.json" nope | tr '\n' ' ' | sed 's/ $//')"
printf '{"series": {"a": []}}\n' > "$WORKDIR/emptyarr.json"
assert_equal "empty array extracts nothing" "" "$(bench_json_series "$WORKDIR/emptyarr.json" a | tr '\n' ' ' | sed 's/ $//')"

printf '%s\n' ""
if [ "$FAILURES" -eq 0 ]; then
  printf 'SELF-TEST PASS: %s/%s cases classified as expected, including the falling-series case as noise.\n' "$CASES" "$CASES"
  exit 0
fi
printf 'SELF-TEST FAIL: %s of %s cases misclassified. The numbers above are not usable until this passes.\n' "$FAILURES" "$CASES"
exit 1