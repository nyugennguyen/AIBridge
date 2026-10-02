#!/usr/bin/env bash
# bench/lib/mem_probe.sh -- shared RSS sampling engine.
#
# Sourced by bench/mem.sh and bench/three-process.sh. Owns process resolution,
# the sampling loop, JSON emission and baseline comparison so that the honest
# wrapper and the plain sampler cannot drift apart.
#
# Callers must export these before calling bench_emit_json; they describe the
# invocation being recorded, and the engine reads them rather than re-parsing
# argv it no longer has:
#   BENCH_INTERVAL       seconds between samples
#   BENCH_SAMPLES        requested sample count
#   BENCH_COMMAND_LINE   the command line to record in the output
#
# MEASUREMENT RULES ENFORCED HERE (Docs/implementation-plans/milestone-7-polyglot-ingress.md
# section 5.1, and ADR 0008 section 1):
#
#   1. Every figure this file emits is an ABSOLUTE RSS LEVEL. No function here
#      computes, prints or stores a difference between two samples. RSS deltas
#      over a short window on Bun are not evidence: RSS was observed to FALL
#      4.4 MiB across 500 requests during the M7 baseline capture, and this
#      harness has since reproduced a ~7x fall (82.0 MiB -> 11.4 MiB) in the
#      same bridge process as it went idle. A delta would have reported that as
#      a catastrophic win. Only the distribution of levels is meaningful.
#   2. Sampling is refused below 1 Hz or below 60 s unless --allow-short is
#      passed, and a short run is stamped "shortSample": true so it can never be
#      mistaken for a compliant one.

# ps reports RSS in kilobytes on macOS and Linux alike; converting once, here,
# keeps every consumer in MiB.
BENCH_KIB_PER_MIB=1024

# The lines below are consumed by bench_emit_json in this file, not by the
# caller, which shellcheck cannot see across the source boundary.
# shellcheck disable=SC2034
BENCH_INTERVAL=1
# shellcheck disable=SC2034
BENCH_SAMPLES=1
# shellcheck disable=SC2034
BENCH_COMMAND_LINE=""

# The sampling minimum, from section 5.1 rule 2. Kept as constants so a future
# revision has one place to change them and so the refusal message can print
# the exact rule it is enforcing.
BENCH_MIN_SAMPLES=60
BENCH_MIN_INTERVAL_SECONDS=1
BENCH_MIN_DURATION_SECONDS=60

# bench_matcher_matches SLOT -- no. Documented matcher syntax:
#   "aibr-worker|aibr worker|aibr serve"
# Alternatives are separated by '|' and tried in order against each process.
# An alternative matches if it equals the process's `comm` (executable name)
# exactly, or -- only when NO alternative of this slot matched any `comm`
# exactly -- appears as a substring of the full argv. The comm-first ordering
# means `--pid bun` cannot accidentally sum every process that merely mentions
# bun on its command line. Substring fallback exists because a bridged worker is
# a `bun` process whose argv carries the real identity.
#
# The slot's reported NAME is its first alternative, so a JSON key and a series
# filename stay stable and readable while the match expression carries the
# fallbacks. First alternatives must therefore be unique.
#
# EXCLUSION_FILE lists PIDs that must never be counted (see
# bench_exclusion_pids). MATCHERS_FILE holds one matcher expression per line.
#
# Two separate self-inclusion traps are closed here, and both were observed in
# practice while building this:
#   1. `bench/mem.sh --pid 'engine|src/index.ts'` puts that literal text into the
#      argv of the harness and its ancestors, so they match their own matcher.
#      Closed by the exclusion list.
#   2. Passing the matchers to awk with `-v matchers=...` puts the same text
#      into the RESOLVER's own argv, and the resolver is spawned after the
#      exclusion list was built, so it cannot exclude itself. Closed by passing
#      the matchers through a file instead of argv; the file path is all that
#      appears in the resolver's argv.
bench_resolve_tick() {
  ps -axo pid=,rss=,comm=,args= | awk -v matchersfile="$1" -v exclfile="$2" '
    BEGIN {
      while ((getline excluded < exclfile) > 0) skip[excluded] = 1
      close(exclfile)
      slotCount = 0
      while ((getline expr < matchersfile) > 0) {
        if (expr == "") continue
        slotList[++slotCount] = expr
        n = split(expr, altTmp, "|")
        altCount[expr] = n
        for (j = 1; j <= n; j++) alts[expr, j] = altTmp[j]
      }
      close(matchersfile)
    }
    {
      pid = $1
      if (skip[pid]) next
      rss = $2 + 0; comm = $3
      argv = ""
      for (f = 4; f <= NF; f++) argv = argv (f > 4 ? " " : "") $f
      for (s = 1; s <= slotCount; s++) {
        slot = slotList[s]
        hit = 0
        for (j = 1; j <= altCount[slot]; j++) if (comm == alts[slot, j]) { hit = 1; break }
        if (hit) {
          exCnt[slot]++; exRss[slot] += rss
          exPid[slot] = (exPid[slot] == "" ? pid : exPid[slot] "," pid)
          continue
        }
        for (j = 1; j <= altCount[slot]; j++) if (index(argv, alts[slot, j]) > 0) { hit = 1; break }
        if (hit) {
          sbCnt[slot]++; sbRss[slot] += rss
          sbPid[slot] = (sbPid[slot] == "" ? pid : sbPid[slot] "," pid)
        }
      }
    }
    END {
      for (s = 1; s <= slotCount; s++) {
        slot = slotList[s]
        label = alts[slot, 1]
        if (exCnt[slot] > 0) { kind = "comm"; cnt = exCnt[slot]; tot = exRss[slot]; pids = exPid[slot] }
        else                { kind = "argv"; cnt = sbCnt[slot]; tot = sbRss[slot]; pids = sbPid[slot] }
        # "-" rather than an empty field: consecutive tabs collapse under
        # IFS-splitting, which would turn "absent" into a shifted column.
        printf "%s\t%s\t%s\t%s\t%d\n", label, (cnt > 0 ? tot : "-"), (pids == "" ? "-" : pids), kind, cnt
      }
    }
  '
}

# bench_exclusion_pids FILE
# Writes the PIDs that must never be measured: this harness, its own ancestry,
# and its direct children (ps and awk run once per tick). Ancestry is excluded
# because you reach this script through shells whose command lines carry the
# matcher text, and none of them is part of the bridge topology.
bench_exclusion_pids() {
  local pid children
  printf '%s\n' "$$" > "$1"
  pid="$PPID"
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    printf '%s\n' "$pid" >> "$1"
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$pid" ] || break
  done
  children=$(pgrep -P "$$" 2>/dev/null || true)
  for pid in $children; do
    printf '%s\n' "$pid" >> "$1"
  done
  return 0
}

# bench_sample_series OUTDIR INTERVAL SECONDS SAMPLES MATCHERS
# Writes per-slot KiB series (one value per tick, "-" for an absent process) and
# a one-line record of the last observation per slot. Never drops a tick for a
# process that died mid-run: an absent tick is recorded as absent so the series
# keeps its temporal alignment and the sample count stays truthful.
bench_sample_series() {
  local outdir="$1" interval="$2" samples="$3" matchers="$4"
  local tick=0
  mkdir -p "$outdir"
  bench_exclusion_pids "$outdir/excluded.pids"
  # Slot files are named by the slot's first alternative (see bench_resolve_tick).
  printf '%s' "$matchers" | tr ';' '\n' | awk -F'|' '{ print $1 }' > "$outdir/slots"
  printf '%s\n' "$matchers" | tr ';' '\n' > "$outdir/matchers"
  : > "$outdir/ticks"
  while [ "$tick" -lt "$samples" ]; do
    tick=$((tick + 1))
    # One ps snapshot per tick: the slots in a tick are resolved against the
    # same instant, so a sum is a sum of simultaneous levels.
    bench_resolve_tick "$outdir/matchers" "$outdir/excluded.pids" > "$outdir/tick.$tick"
    while IFS="$(printf '\t')" read -r slot rss pids kind cnt; do
      [ -n "$slot" ] || continue
      printf '%s\n' "$rss" >> "$outdir/$slot.rss"
      if [ "$rss" != "-" ]; then
        printf '%s\t%s\t%s\t%s\n' "$rss" "$pids" "$kind" "$cnt" > "$outdir/$slot.last"
      fi
    done < "$outdir/tick.$tick"
    printf '%s\n' "$tick" >> "$outdir/ticks"
    if [ "$tick" -lt "$samples" ]; then sleep "$interval"; fi
  done
}

# bench_sampling_short INTERVAL SAMPLES -> prints "true" or "false".
bench_sampling_short() {
  awk -v interval="$1" -v samples="$2" -v minsamples="$BENCH_MIN_SAMPLES" \
      -v maxinterval="$BENCH_MIN_INTERVAL_SECONDS" -v minduration="$BENCH_MIN_DURATION_SECONDS" '
    BEGIN {
      duration = interval * samples
      short = (samples < minsamples) || (interval + 0 > maxinterval + 0) || (duration + 0 < minduration + 0)
      print (short ? "true" : "false")
    }
  '
}

# bench_enforce_sampling INTERVAL SAMPLES ALLOW_SHORT
# Loud refusal, exit 2, when the run would violate section 5.1 rule 2. Returns
# non-zero only for an actual refusal so callers can `|| exit 2`.
bench_enforce_sampling() {
  local interval="$1" samples="$2" allow_short="$3"
  if [ "$(bench_sampling_short "$interval" "$samples")" = "true" ]; then
    if [ "$allow_short" != "true" ]; then
      printf '%s\n' \
        "=====================================================================" \
        "REFUSING TO MEASURE: this run violates the milestone sampling rule." \
        "" \
        "  requested : ${samples} samples every ${interval}s = $(awk -v i="$interval" -v s="$samples" 'BEGIN { printf "%.1f", i * s }')s" \
        "  required  : >= ${BENCH_MIN_SAMPLES} samples, interval <= ${BENCH_MIN_INTERVAL_SECONDS}s," \
        "              total >= ${BENCH_MIN_DURATION_SECONDS}s (JIT allocation is lazy;" \
        "              a short sample after start under-reports)." \
        "" \
        "  A compliant run that reports a regression is useful." \
        "  A 2 second run that reports no regression is not evidence." \
        "" \
        "  Re-run with compliant values, or pass --allow-short to take the" \
        "  measurement anyway. A short run is stamped \"shortSample\": true and" \
        "  MUST NOT be cited in a gate report." \
        "=====================================================================" >&2
      return 2
    fi
    printf '%s\n' "WARNING: --allow-short was passed; this run is NOT compliant with the >=1 Hz / >=60 s rule and will be stamped \"shortSample\": true." >&2
  fi
  return 0
}

bench_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

_bench_json_count=0
_bench_json_indent=""
_bench_json_open() {
  _bench_json_indent="$1"
  _bench_json_count=0
  printf '{'
}
# _bench_json_field KEY VALUE_OR_JSON
_bench_json_field() {
  if [ "$_bench_json_count" -gt 0 ]; then printf ','; fi
  _bench_json_count=$((_bench_json_count + 1))
  printf '\n%s"%s": %s' "$_bench_json_indent" "$(bench_json_escape "$1")" "$2"
}
_bench_json_close() {
  printf '\n%s}' "$1"
}

_bench_json_str() {
  printf '"%s"' "$(bench_json_escape "$1")"
}

# bench_json_series FILE KEY
# Extracts a flat "key": [ n, n, n ] array from a file written by this harness.
# Intentionally understands only the exact shape bench_emit_json produces; the
# README says so, because a JSON parser that silently returns nothing on an
# unfamiliar layout would turn a comparison into a false "no change".
bench_json_series() {
  awk -v needle="\"$2\": [" '
    { lines[++nlines] = $0 }
    END {
      # Find "key": [ then take everything up to the next "]" and stop. The
      # the first "]" after the opening bracket is unambiguously the close:
      # the series holds numbers only, so nothing inside can nest. Scanning for
      # the terminator rather than guessing at line boundaries is what makes a
      # compact one-line array and a pretty-printed multi-line array both work;
      # guessing produced an empty series for one of the two layouts, which
      # downstream reads as "no baseline to compare against" and therefore as
      # "no change" on a run that was never actually compared.
      for (i = 1; i <= nlines; i++) {
        at = index(lines[i], needle)
        if (at == 0) continue
        text = substr(lines[i], at + length(needle) - 1)
        for (j = i; j <= nlines; j++) {
          if (j > i) text = text " " lines[j]
          close_at = index(text, "]")
          if (close_at > 0) { emit(substr(text, 1, close_at - 1)); exit }
        }
        break
      }
    }
    function emit(text,   parts, k, m, v) {
      # Brackets are separators too, not just attached to the first and last
      # value: leaving them attached would drop the first element of every
      # single-line array and the last element of every multi-line one.
      m = split(text, parts, /[][ ,]+/)
      for (k = 1; k <= m; k++) {
        v = parts[k]
        if (v ~ /^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/) print v
      }
    }
  ' "$1"
}

_bench_series_stats_json() {
  # _bench_series_stats_json SERIES_FILE INDENT -> JSON object, or null if empty.
  local series_file="$1" indent="$2" n
  n=$(stats_compute < "$series_file" | stats_get n)
  if [ "${n:-0}" -eq 0 ]; then
    printf 'null'
    return
  fi
  printf '{\n'
  stats_compute < "$series_file" | stats_json | sed '1d;$d' | sed "s/^/$indent/"
  printf '%s}' "$indent"
}

# _bench_series_array_json SERIES_FILE -> [n, n, ...]
# The series files hold OBSERVED samples only: an absent tick contributes no
# value and is counted in the slot's absentTicks, so a reader can see the gap
# without a null having polluted the distribution.
_bench_series_array_json() {
  local series_file="$1" line seen=0
  printf '['
  while IFS= read -r line; do
    if [ -z "$line" ]; then continue; fi
    if [ "$seen" -eq 0 ]; then seen=1; else printf ', '; fi
    printf '%s' "$line"
  done < "$series_file"
  printf ']'
}

# _bench_json_pids "123,456" -> [123,456]; empty or "-" -> []
_bench_json_pids() {
  printf '%s' "$1" | awk -F, '
    BEGIN { printf "[" }
    {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^[0-9]+$/) { if (seen++) printf ", "; printf "%d", $i }
      }
    }
    END { printf "]" }
  '
}

# bench_emit_json OUTDIR EXTRA_FIELDS BASELINE_JSON
# Writes the complete JSON document on stdout. EXTRA_FIELDS is newline-separated
# "key=value" pairs for wrapper-supplied top-level annotations (three-process.sh's
# headline warning); values must not contain a newline or a double quote and are
# inserted as JSON strings. BASELINE_JSON, when non-empty, is compared and
# embedded. Returns 3 if any comparison regressed or could not be decided, so an
# inconclusive comparison cannot be read as a pass.
bench_emit_json() {
  local outdir="$1" extra="$2" baseline="${3:-}"
  local slot slots tick_count matcher
  slots=$(cat "$outdir/slots")
  tick_count=$(wc -l < "$outdir/ticks" | tr -d ' ')
  # Tab-joined slot/matcher pairs: bash 3.2 has no arrays, and indexing a list
  # through nested command substitution is where readability dies.
  paste "$outdir/slots" "$outdir/matchers" > "$outdir/slot-matcher"

  # KiB series -> MiB series files, and the per-tick SUM series. The sum is the
  # primary number in ADR 0008 section 2.1's topology and the sum here is only
  # computed over slots that were actually alive; a slot absent for every tick
  # (the router before M7.1 exists) is reported as absent rather than
  # contributing a fabricated 0.
  local live=""
  while IFS= read -r slot; do
    [ -n "$slot" ] || continue
    awk -v kib="$BENCH_KIB_PER_MIB" '/^-?[0-9]+$/ { printf "%.6f\n", $1 / kib }' "$outdir/$slot.rss" > "$outdir/$slot.mib"
    if grep -qv '^-' "$outdir/$slot.rss"; then live="$live $slot"; fi
  done <<EOF
$slots
EOF

  # No live slot means there is nothing to sum. Writing blank lines here would
  # inflate completeTicks and produce a series of nulls, i.e. a sum that looks
  # measured while measuring nothing.
  : > "$outdir/sum.mib"
  if [ -n "$live" ]; then
    tick=1
    while [ "$tick" -le "$tick_count" ]; do
      total=""
      complete="yes"
      for slot in $live; do
        rss_kib=$(sed -n "${tick}p" "$outdir/$slot.rss")
        if [ -z "$rss_kib" ] || [ "$rss_kib" = "-" ]; then
          complete="no"
          break
        fi
        total=$(awk -v t="$total" -v v="$rss_kib" -v kib="$BENCH_KIB_PER_MIB" 'BEGIN { printf "%.6f", (t == "" ? 0 : t) + v / kib }')
      done
      if [ "$complete" = "yes" ]; then printf '%s\n' "$total" >> "$outdir/sum.mib"; fi
      tick=$((tick + 1))
    done
  fi

  _bench_json_open "  "
  _bench_json_field schema "\"$(bench_json_escape aibridge.bench.mem)/1\""
  _bench_json_field generatedAt "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  _bench_json_field host "$(printf '{ "os": %s, "arch": %s, "kernel": %s, "cpus": %s }' \
    "$(_bench_json_str "$(uname -s)")" "$(_bench_json_str "$(uname -m)")" \
    "$(_bench_json_str "$(uname -sr)")" "$(_bench_json_str "$(sysctl -n hw.ncpu 2>/dev/null || echo unknown)")")"
  _bench_json_field units '{"rssSource": "ps -o rss= -p <pid> (KiB on macOS and Linux)", "reported": "MiB", "conversion": "MiB = KiB / 1024", "quantity": "absolute level, never a delta"}'
  _bench_json_field measurementRule "\"median and p95 of absolute RSS levels; >=1 Hz for >=60 s; never a difference between two samples (ADR 0008 section 1)\""
  _bench_json_field sampling "$(printf '{ "intervalSeconds": %s, "requestedSamples": %s, "ticksObserved": %s, "durationSeconds": %.1f, "shortSample": %s, "minimum": { "samples": %s, "intervalSeconds": %s, "durationSeconds": %s } }' \
    "$BENCH_INTERVAL" "$BENCH_SAMPLES" "$tick_count" \
    "$(awk -v i="$BENCH_INTERVAL" -v s="$BENCH_SAMPLES" 'BEGIN { printf "%.1f", i * s }')" \
    "$(bench_sampling_short "$BENCH_INTERVAL" "$BENCH_SAMPLES")" \
    "$BENCH_MIN_SAMPLES" "$BENCH_MIN_INTERVAL_SECONDS" "$BENCH_MIN_DURATION_SECONDS")"
  _bench_json_field commandLine "$(_bench_json_str "$BENCH_COMMAND_LINE")"

  _bench_json_field processes '{'
  first_process=1
  while IFS="$(printf '\t')" read -r slot matcher; do
    [ -n "$slot" ] || continue
    observed=$(grep -c -v '^-' "$outdir/$slot.rss" || true)
    [ -n "$observed" ] || observed=0
    absent=$((tick_count - observed))
    last_pids="-" last_kind="-" last_cnt=0
    if [ -f "$outdir/$slot.last" ]; then
      # The RSS column is read and discarded: it is only there to keep the PID,
      # kind and count in the right positions.
      IFS="$(printf '\t')" read -r _ last_pids last_kind last_cnt < "$outdir/$slot.last"
    fi
    if [ "$last_pids" = "-" ]; then last_pids=""; last_kind="none"; fi
    if [ "$first_process" -eq 0 ]; then printf ',\n'; fi
    first_process=0
    printf '\n      "%s": {' "$(bench_json_escape "$slot")"
    printf '\n        "matcher": %s,' "$(_bench_json_str "$matcher")"
    printf '\n        "pids": %s,' "$(_bench_json_pids "$last_pids")"
    printf '\n        "pidCount": %s,' "$last_cnt"
    printf '\n        "matchKind": %s,' "$(_bench_json_str "$last_kind")"
    printf '\n        "observedTicks": %s,' "$observed"
    printf '\n        "absentTicks": %s,' "$absent"
    printf '\n        "absent": %s,' "$([ "$observed" -eq 0 ] && printf 'true' || printf 'false')"
    printf '\n        "rssMib": '
    _bench_series_stats_json "$outdir/$slot.mib" "        "
    printf '\n      }'
  done < "$outdir/slot-matcher"
  printf '\n    }'

  _bench_json_field sum "$(printf '{ "primary": true, "definition": "per-tick sum over slots that were alive in at least one tick, summed at a single instant", "slotsIncluded": [%s], "completeTicks": %s, "ticksObserved": %s, "rssMib": ' \
    "$(printf '%s' "$live" | awk '{ for (i = 1; i <= NF; i++) printf "%s\"%s\"", (i > 1 ? ", " : ""), $i }')" \
    "$(wc -l < "$outdir/sum.mib" | tr -d ' ')" "$tick_count")"
  _bench_series_stats_json "$outdir/sum.mib" "    "
  printf ' }'

  # Read with a here-doc, not a pipe: a piped `while` runs in a subshell, and the
# JSON comma state that _bench_json_field keeps in the parent would reset,
# producing a document that is missing separators.
# The raw per-tick series live under their slot name (and "sum") so a later run
  # can be classified against this file without re-deriving anything:
  # bench_compare extracts exactly this "key": [ ... ] shape.
  printf ',\n  "series": {\n'
  first_series=1
  while IFS="$(printf '\t')" read -r slot matcher; do
    [ -n "$slot" ] || continue
    if [ "$first_series" -eq 0 ]; then printf ',\n'; fi
    first_series=0
    printf '    "%s": %s' "$(bench_json_escape "$slot")" "$(_bench_series_array_json "$outdir/$slot.mib")"
  done < "$outdir/slot-matcher"
  printf ',\n    "sum": %s' "$(_bench_series_array_json "$outdir/sum.mib")"
  printf '\n  }'

  if [ -n "$extra" ]; then
    while IFS= read -r pair; do
      [ -n "$pair" ] || continue
      _bench_json_field "$(printf '%s' "$pair" | cut -d= -f1)" "$(_bench_json_str "$(printf '%s' "$pair" | cut -d= -f2-)")"
    done <<EOF_ANNOTATIONS
$extra
EOF_ANNOTATIONS
  fi

  local compare_rc=0
  if [ -n "$baseline" ]; then
    bench_compare "$outdir" "$baseline" || compare_rc=$?
  fi

  _bench_json_close ""
  printf '\n'
  return "$compare_rc"
}

# bench_compare OUTDIR BASELINE_JSON
# Classifies this run's series against a previously captured baseline. Exits
# non-zero (3) if ANY comparison could not be decided, so an inconclusive
# comparison can never be read as a pass.
bench_compare() {
  local outdir="$1" baseline="$2"
  local slot verdict rc=0 first=1 series_file baseline_series verdict_kv bm cm rel reason
  local subjects
  subjects=$(cat "$outdir/slots"; printf 'sum\n')
  {
    printf '{\n'
    while IFS= read -r slot; do
      [ -n "$slot" ] || continue
      if [ "$slot" = "sum" ]; then series_file="$outdir/sum.mib"; else series_file="$outdir/$slot.mib"; fi
      if [ ! -s "$series_file" ]; then continue; fi
      baseline_series="$outdir/baseline-$slot.series"
      bench_json_series "$baseline" "$slot" > "$baseline_series"
      if [ ! -s "$baseline_series" ]; then
        verdict="no-baseline-series"
        reason="baseline file has no \"$slot\" series to compare against; nothing was decided."
        bm="" cm="" rel=""
      else
        verdict_kv=$(bench_classify "$baseline_series" "$series_file")
        verdict=$(printf '%s\n' "$verdict_kv" | stats_get verdict)
        reason=$(printf '%s\n' "$verdict_kv" | stats_get reason)
        bm=$(printf '%s\n' "$verdict_kv" | stats_get baselineMedian)
        cm=$(printf '%s\n' "$verdict_kv" | stats_get candidateMedian)
        rel=$(printf '%s\n' "$verdict_kv" | stats_get relativeChangePct)
      fi
      case "$verdict" in
        improve) marker="PASS (improved beyond the noise floor)" ;;
        regress) marker="FAIL (regressed beyond the noise floor)" ;;
        insufficient-samples) marker="INCONCLUSIVE (insufficient samples)" ;;
        no-baseline-series) marker="INCONCLUSIVE (no baseline series)" ;;
        *) marker="INCONCLUSIVE (noise)" ;;
      esac
      printf '%s\n' "  $slot: $marker -- median ${bm:-n/a} -> ${cm:-n/a} MiB (${rel:-n/a}% change)" \
        "     $reason" >&2
      if [ "$verdict" = "regress" ] || [ "$verdict" = "insufficient-samples" ]; then
        rc=1
      fi
      if [ "$first" -eq 0 ]; then printf ',\n'; fi
      first=0
      printf '\n    "%s": { "verdict": %s, "baselineMedianMib": %s, "candidateMedianMib": %s, "relativeChangePct": %s, "reason": %s }' \
        "$(bench_json_escape "$slot")" "$(_bench_json_str "$verdict")" "${bm:-null}" "${cm:-null}" "${rel:-null}" "$(_bench_json_str "$reason")"
    done <<EOF
$subjects
EOF
    printf '\n  }'
  } > "$outdir/comparison.json"
  _bench_json_field comparison "$(cat "$outdir/comparison.json")"
  return "$rc"
}

# bench_print_summary OUTDIR
bench_print_summary() {
  local outdir="$1"
  local slot
  printf '%s\n' "process                  median MiB   p95 MiB     p5 MiB      n     absent"
  while IFS= read -r slot; do
    [ -n "$slot" ] || continue
    local stats
    stats=$(stats_compute < "$outdir/$slot.mib")
    observed=$(grep -c -v '^-' "$outdir/$slot.rss" || true)
    [ -n "$observed" ] || observed=0
    if [ "${observed:-0}" -eq 0 ]; then
      printf '%-24s %10s %10s %10s %6s %6s\n' "$slot" "absent" "absent" "absent" "0" \
        "$(wc -l < "$outdir/ticks" | tr -d ' ')"
      continue
    fi
    printf '%-24s %10s %10s %10s %6s %6s\n' "$slot" \
      "$(printf '%s\n' "$stats" | stats_get median)" \
      "$(printf '%s\n' "$stats" | stats_get p95)" \
      "$(printf '%s\n' "$stats" | stats_get p5)" \
      "$(printf '%s\n' "$stats" | stats_get n)" \
      "$(( $(wc -l < "$outdir/ticks" | tr -d ' ') - observed ))"
  done < "$outdir/slots"
  local sumstats
  sumstats=$(stats_compute < "$outdir/sum.mib")
  if [ "${sumstats:-}" = "" ] || [ "$(printf '%s\n' "$sumstats" | stats_get n)" = "0" ]; then
    printf '%s\n' "---------------------------------------------------------------"
    printf '%-24s %10s\n' "SUM (primary)" "absent"
    return
  fi
  printf '%s\n' "---------------------------------------------------------------"
  printf '%-24s %10s %10s %10s %6s\n' "SUM (primary)" \
    "$(printf '%s\n' "$sumstats" | stats_get median)" \
    "$(printf '%s\n' "$sumstats" | stats_get p95)" \
    "$(printf '%s\n' "$sumstats" | stats_get p5)" \
    "$(printf '%s\n' "$sumstats" | stats_get n)"
}