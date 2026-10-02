#!/usr/bin/env bash
# bench/lib/stats.sh -- distribution statistics and the RSS noise classifier.
#
# Sourced by bench/mem.sh, bench/latency.sh, bench/three-process.sh and
# bench/selftest.sh. Contains no side effects beyond defining constants.
#
# WHY AWK AND NOT bc/datamash/jq/python: this harness has to run on the
# reference host and on whatever minimal CI image signs off a security-relevant
# architecture change. A measurement tool that refuses to start because a
# convenience binary is missing produces no evidence at all, and "no evidence"
# is then quietly reported as "no change".
#
# PERCENTILE METHOD (deterministic on purpose -- these numbers end up in a
# signed gate report):
#   p5/p95 use NEAREST RANK: the value at 1-based index ceil(p/100 * n) of the
#   ascending-sorted series. No interpolation. Two reasons: (a) nearest rank
#   always returns an OBSERVED value, so a p95 cannot be a number the system
#   never held; (b) it is reproducible by hand from the committed series, which
#   matters more here than statistical elegance. Interpolation would make the
#   reported gate number depend on an estimator choice rather than on the host.
#   The median is the one exception: for even n it is the mean of the two
#   central order statistics, the conventional definition, stated here so a
#   reviewer does not have to guess which convention produced the number.

# Sample count below which bench_classify refuses to emit a verdict. 60 is the
# plan's own floor (Docs/implementation-plans/milestone-7-polyglot-ingress.md
# section 5.1 rule 2: sample at >= 1 Hz for >= 60 s).
STATS_MIN_SAMPLES=60

# Relative change, in percent, below which a distribution shift is called noise
# rather than a win or a regression.
#
# 5% is a TUNABLE, not a physical constant. It is set where it is because the
# quantities being classified are idle RSS levels of long-lived processes on a
# fixed host: run-to-run variation across identical configurations is a few
# percent, dominated by JIT page retention, allocator arena boundaries and RSS
# accounting of shared pages. Anything below that band is unresolvable, and
# calling it a win is how a harness manufactures a result. A reviewer who has a
# host with tighter variance may lower it via STATS_NOISE_FLOOR_PCT and must say
# so in the gate report.
STATS_NOISE_FLOOR_PCT=5

# Lower edge of the band compared for overlap. p5..p95 rather than min..max
# because a single sample is not a distribution: on macOS a page-in spike moves
# RSS by more than the effect under test.
STATS_BAND_LOW_PCT=5
STATS_BAND_HIGH_PCT=95

# stats_compute: numeric series on stdin (one value per line; blank and
# non-numeric lines are ignored, which is how absent samples stay absent rather
# than silently becoming 0). Emits "key=value" lines on stdout:
#   n min max mean stdev median p5 p95 p99
# Values are KiB for memory or ms for latency; the caller owns the unit.
stats_compute() {
  # The band edges come from the constants above rather than being written as
  # literals here, so changing the band is one edit and the classifier cannot
  # quietly keep comparing a different band from the one that is documented.
  sort -g | awk -v plow="$STATS_BAND_LOW_PCT" -v phigh="$STATS_BAND_HIGH_PCT" '
    # The explicit numeric test is load-bearing. awk coerces any non-numeric
    # line to 0, so an absent sample ("-", written when a process was missing at
    # a tick) would otherwise become a zero-valued observation and drag the
    # median of a memory series toward nothing. An absent sample is absent.
    /^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/ { v = $0 + 0; a[++n] = v; sum += v }
    END {
      if (n == 0) {
        printf "n=0\nmedian=\nmin=\nmax=\nmean=\nstdev=\n"
        printf "p%d=\n", plow; printf "p%d=\n", phigh; printf "p99=\n"
        exit
      }
      for (i = 2; i <= n; i++) {                       # insertion sort
        x = a[i]; j = i - 1
        while (j >= 1 && a[j] > x) { a[j + 1] = a[j]; j-- }
        a[j + 1] = x
      }
      mean = sum / n
      ss = 0
      for (i = 1; i <= n; i++) ss += (a[i] - mean) * (a[i] - mean)
      # Sample standard deviation (n-1). n < 2 has no variance estimate and
      # reports 0 rather than a divide-by-zero sentinel.
      stdev = (n > 1) ? sqrt(ss / (n - 1)) : 0
      if (n % 2 == 1) median = a[(n + 1) / 2]
      else median = (a[n / 2] + a[n / 2 + 1]) / 2
      printf "n=%d\n", n
      printf "min=%.6f\n", a[1]
      printf "max=%.6f\n", a[n]
      printf "mean=%.6f\n", mean
      printf "stdev=%.6f\n", stdev
      printf "median=%.6f\n", median
      printf "p%d=%.6f\n", plow, a[pick(plow, n)]
      printf "p%d=%.6f\n", phigh, a[pick(phigh, n)]
      printf "p99=%.6f\n", a[pick(99, n)]
    }
    # Nearest rank: 1-based index ceil(p/100 * n), clamped into range.
    function pick(p, n,   idx) {
      idx = int(p * n / 100)
      if (idx * 100 < p * n) idx++
      if (idx < 1) idx = 1
      if (idx > n) idx = n
      return idx
    }
  '
}

# stats_get KEY: read one field out of "key=value" output lines on stdin.
# Splits on the FIRST '=' only, so reasons containing '=' survive intact.
stats_get() {
  # Leading whitespace is tolerated because the JSON form is nested and indented.
  # Without it, `stats_get` on an indented line silently returns nothing, and an
  # empty result reads like a missing measurement rather than a lookup mistake.
  awk -v want="$1" '
    {
      line = $0
      sub(/^[ \t]+/, "", line)
      if (index(line, want "=") == 1) { print substr(line, length(want) + 2); exit }
    }
  '
}

# stats_json: "key=value" lines on stdin -> a flat JSON object. Numeric fields
# become numbers, absent fields become null. Deliberately unquoted so downstream
# `jq`-less tooling can still do arithmetic.
stats_json() {
  # The opening brace is followed by a newline here, not by the first field. A
  # consumer strips the brace with `sed '1d;$d'`; emitting `{` and the first
  # field on one line put the first field (n) on the brace's line, where the
  # stripper deleted it. The sample count is not a field this harness can afford
  # to lose from a JSON artefact.
  awk -F= '
    BEGIN { printf "{\n" }
    {
      key = $1
      val = substr($0, index($0, "=") + 1)
      if (seen++) printf ",\n"
      printf "  \"%s\": ", key
      if (val == "") printf "null"
      else if (val ~ /^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/) printf "%s", val
      else printf "\"%s\"", val
    }
    END { printf "\n}" }
  '
}

# bench_classify_decide: the whole decision rule as one pure awk program so it
# can be unit-tested against synthetic distributions without any sampling.
# Reads every input as a variable:
#   bn cn  baseline/candidate sample counts
#   bm cm  baseline/candidate medians
#   b5 b95 candidate p5..p95 band edges
#   floor  noise floor, percent
# Emits "key=value" lines including verdict=improve|regress|noise|
# insufficient-samples and a human-readable reason.
#
# THE RULE, and why it is this rule rather than a threshold on the median
# difference: ADR 0008 section 1 records that RSS FELL 4.4 MiB across 500
# requests because JSC returned pages to its allocator. A median-only test
# reports that as an improvement and would have signed off a security-relevant
# architecture change on allocator behaviour. So a verdict requires BOTH:
#   (a) non-overlap -- the candidate's whole p5..p95 band sits below (improve)
#       or above (regress) the baseline's band, and
#   (b) magnitude -- the median moved by more than the noise floor.
# A median move inside overlapping bands is `noise`, always, no matter how
# large it looks. Overlap is the whole point: two bands that intersect have not
# been shown to be different distributions.
bench_classify_decide() {
  awk -v bn="$1" -v cn="$2" -v bm="$3" -v cm="$4" -v b5="$5" -v b95="$6" \
      -v c5="$7" -v c95="$8" -v floor="$9" -v minsamples="${10}" '
    function emit(k, v) { printf "%s=%s\n", k, v }
    BEGIN {
      emit("noiseFloorPct", floor)
      emit("requiredSamples", minsamples)
      emit("baselineSamples", bn)
      emit("candidateSamples", cn)
      emit("baselineMedian", (bn > 0 ? bm : ""))
      emit("candidateMedian", (cn > 0 ? cm : ""))
      if (bn < minsamples || cn < minsamples) {
        emit("verdict", "insufficient-samples")
        emit("reason", "need >= " minsamples " samples per series to classify; have baseline=" bn " candidate=" cn ". Refusing to pass a measurement this thin silently.")
        exit
      }
      if (bm == 0) {
        emit("verdict", "noise")
        emit("relativeChangePct", "")
        emit("reason", "baseline median is 0; relative change is undefined, so no verdict can be issued.")
        exit
      }
      rel = (cm - bm) / bm * 100
      emit("relativeChangePct", sprintf("%.3f", rel))
      emit("baselineBandP5", b5)
      emit("baselineBandP95", b95)
      emit("candidateBandP5", c5)
      emit("candidateBandP95", c95)
      if (c95 < b5) {
        sep = "lower"
      } else if (c5 > b95) {
        sep = "upper"
      } else {
        sep = "overlapping"
      }
      emit("bandRelationship", sep)
      if (sep == "overlapping") {
        emit("verdict", "noise")
        emit("reason", "p5..p95 bands overlap (baseline " b5 ".." b95 " vs candidate " c5 ".." c95 "). A median difference of " sprintf("%.2f", rel) "% is not evidence of a distribution shift.")
        exit
      }
      if ((rel < 0 ? -rel : rel) <= floor) {
        emit("verdict", "noise")
        emit("reason", "bands are separated but the median moved " sprintf("%.2f", rel) "%, within the " floor "% noise floor. Not attributable.")
        exit
      }
      if (sep == "lower") {
        emit("verdict", "improve")
        emit("reason", "candidate band " c5 ".." c95 " lies entirely below baseline band " b5 ".." b95 " and the median moved " sprintf("%.2f", rel) "%, beyond the " floor "% noise floor.")
      } else {
        emit("verdict", "regress")
        emit("reason", "candidate band " c5 ".." c95 " lies entirely above baseline band " b5 ".." b95 " and the median moved " sprintf("%.2f", rel) "%, beyond the " floor "% noise floor.")
      }
    }
  '
}

# bench_classify BASELINE_SERIES_FILE CANDIDATE_SERIES_FILE
# Applies bench_classify_decide using stats computed from the two series files.
# Both series are passed as files, not arguments: a 1000-sample latency series
# on the command line is fine on macOS but not portable, and a measurement tool
# should not have an argv size ceiling.
bench_classify() {
  local baseline_file="$1"
  candidate_file="$2"
  local bstats cstats bn cn bm cm
  bstats=$(stats_compute < "$baseline_file")
  cstats=$(stats_compute < "$candidate_file")
  bn=$(printf '%s\n' "$bstats" | stats_get n)
  cn=$(printf '%s\n' "$cstats" | stats_get n)
  bm=$(printf '%s\n' "$bstats" | stats_get median)
  cm=$(printf '%s\n' "$cstats" | stats_get median)
  bench_classify_decide \
    "${bn:-0}" "${cn:-0}" "${bm:-0}" "${cm:-0}" \
    "$(printf '%s\n' "$bstats" | stats_get p5)" "$(printf '%s\n' "$bstats" | stats_get p95)" \
    "$(printf '%s\n' "$cstats" | stats_get p5)" "$(printf '%s\n' "$cstats" | stats_get p95)" \
    "$STATS_NOISE_FLOOR_PCT" "$STATS_MIN_SAMPLES"
}