#!/usr/bin/env bash
# bench/latency.sh -- HTTP request latency against a URL, with a warmup phase.
#
# Measures wall-clock time of a complete request/response round trip (curl's
# time_total: from request start to the last byte of the body) and reports the
# distribution of per-request latencies in milliseconds.
#
# WARMUP IS EXCLUDED, VISIBLY. Docs/implementation-plans/milestone-7-polyglot-ingress.md
# section 5.1 rule 2: JIT allocation is lazy, so a sample taken immediately
# after start under-reports. The warmup requests are issued first, their
# distribution is still measured and reported, and the reported distribution
# contains only post-warmup samples. A reader comparing two runs must be able to
# see that both used the same rule, so the warmup count and the exclusion are
# recorded in the output rather than left implicit in the sample count.
#
# Requests are issued SEQUENTIALLY. This measures service time, not concurrency
# behaviour; a concurrency benchmark is a different tool and is out of scope here.
#
# Usage: bench/latency.sh --url URL --requests N --warmup N --out FILE \
#                        [--method M] [--header 'K: V'] \
#                        [--expect-p50-ms MS] [--expect-p99-ms MS]
#
# EXIT CODES
#   0  measured, and every supplied threshold met
#   1  runtime error (curl failed, --url missing)
#   2  usage error
#   3  measured, but a threshold was violated

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/stats.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/stats.sh"

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then usage; exit 0; fi

URL=""
REQUESTS=100
WARMUP=10
OUT=""
METHOD="GET"
HEADERS=""
EXPECT_P50=""
EXPECT_P99=""

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --requests) REQUESTS="${2:-}"; shift 2 ;;
    --warmup) WARMUP="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --method) METHOD="${2:-}"; shift 2 ;;
    --header) HEADERS="${HEADERS}${2}
"; shift 2 ;;
    --expect-p50-ms) EXPECT_P50="${2:-}"; shift 2 ;;
    --expect-p99-ms) EXPECT_P99="${2:-}"; shift 2 ;;
    *) printf '%s\n' "bench/latency.sh: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$URL" ]; then
  printf '%s\n' "bench/latency.sh: --url is required" >&2
  exit 2
fi
for value in "$REQUESTS" "$WARMUP"; do
  if ! printf '%s' "$value" | grep -Eq '^[0-9]+$'; then
    printf '%s\n' "bench/latency.sh: --requests and --warmup must be non-negative integers, got '$value'" >&2
    exit 2
  fi
done
if [ "$REQUESTS" -lt 1 ]; then
  printf '%s\n' "bench/latency.sh: --requests must be at least 1" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  printf '%s\n' "bench/latency.sh: curl is required" >&2
  exit 1
fi

WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/aibr-bench-lat.XXXXXX")
trap 'rm -rf "$WORKDIR"' EXIT

# Headers go through a curl config file rather than unquoted word splitting: a
# header value legitimately contains spaces ("Authorization: Bearer ...") and
# bash 3.2 has no array to hold them safely.
curl_config="$WORKDIR/curlrc"
: > "$curl_config"
while IFS= read -r header; do
  [ -n "$header" ] || continue
  if printf '%s' "$header" | grep -q '"'; then
    printf '%s\n' "bench/latency.sh: --header value must not contain a double quote" >&2
    exit 2
  fi
  printf 'header = "%s"\n' "$header" >> "$curl_config"
done <<EOF
$HEADERS
EOF

# -o /dev/null keeps the response body out of the timing path; time_total is
# still reported. A failed request prints 0.000000, which would silently become
# the best sample in the distribution, so non-2xx/3xx responses are counted and
# reported rather than averaged in.
LAT_FAILED=0
LAT_LAST_STATUS="000"
measure_one() {
  local code
  code=$(curl -s -o /dev/null -K "$curl_config" -X "$METHOD" -w '%{http_code} %{time_total}' \
    "$URL" 2>/dev/null) || code="000 0.000000"
  case "$code" in
    2*|3*) printf '%s\n' "$code" | awk '{ printf "%.6f\n", $2 * 1000 }' ;;
    *)
      # One count at the end, not a line per request: a fully failing endpoint
      # would otherwise bury the summary under 500 identical warnings.
      LAT_FAILED=$((LAT_FAILED + 1))
      LAT_LAST_STATUS=$(printf '%s\n' "$code" | awk '{ print $1 }')
      printf '\n'
      ;;
  esac
}

i=0
while [ "$i" -lt "$WARMUP" ]; do
  i=$((i + 1))
  measure_one >> "$WORKDIR/warmup.ms"
done
i=0
while [ "$i" -lt "$REQUESTS" ]; do
  i=$((i + 1))
  measure_one >> "$WORKDIR/measured.ms"
done

measured_n=$(grep -c . "$WORKDIR/measured.ms" || true)
if [ "${LAT_FAILED:-0}" -gt 0 ]; then
  printf '%s\n' "bench/latency.sh: $LAT_FAILED of $((WARMUP + REQUESTS)) requests did not return 2xx/3xx (last status: $LAT_LAST_STATUS); those samples are excluded from the distribution" >&2
fi
if [ "$measured_n" -eq 0 ]; then
  printf '%s\n' "bench/latency.sh: every request failed; no distribution can be reported" >&2
  exit 1
fi

stats_field() {
  stats_compute < "$WORKDIR/measured.ms" | stats_get "$1"
}

P50=$(stats_field median)
P95=$(stats_field p95)
P99=$(stats_compute < "$WORKDIR/measured.ms" | stats_get p99)
P5=$(stats_field p5)
MEAN=$(stats_field mean)
MAX=$(stats_field max)
MIN=$(stats_field min)
STDEV=$(stats_field stdev)
WARMUP_N=$(grep -c . "$WORKDIR/warmup.ms" || true)
WARMUP_MEDIAN=$(stats_compute < "$WORKDIR/warmup.ms" | stats_get median)

json_num() { if [ -z "$1" ]; then printf 'null'; else printf '%s' "$1"; fi; }
json_str() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"; }

violations=""
if [ -n "$EXPECT_P50" ] && awk -v v="$P50" -v t="$EXPECT_P50" 'BEGIN { exit !(v + 0 > t + 0) }'; then
  violations="${violations}p50 ${P50}ms exceeds --expect-p50-ms ${EXPECT_P50}ms
"
fi
if [ -n "$EXPECT_P99" ] && awk -v v="$P99" -v t="$EXPECT_P99" 'BEGIN { exit !(v + 0 > t + 0) }'; then
  violations="${violations}p99 ${P99}ms exceeds --expect-p99-ms ${EXPECT_P99}ms
"
fi

violations_json=$(printf '%s' "$violations" | awk '
  BEGIN { printf "[" }
  NF { if (seen++) printf ", "; printf "\"%s\"", $0 }
  END { printf "]" }
')

{
  printf '{\n'
  printf '  "schema": "aibridge.bench.latency/1",\n'
  printf '  "generatedAt": %s,\n' "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  printf '  "url": %s,\n' "$(json_str "$URL")"
  printf '  "method": %s,\n' "$(json_str "$METHOD")"
  printf '  "concurrency": 1,\n'
  printf '  "quantity": "wall-clock round trip per request (curl time_total), milliseconds; a LEVEL per request, not a delta",\n'
  printf '  "percentileMethod": "nearest rank, 1-based index ceil(p/100 * n), no interpolation",\n'
  printf '  "warmup": {\n'
  printf '    "requests": %s,\n' "$WARMUP"
  printf '    "excludedFromReportedDistribution": true,\n'
  printf '    "reason": "JIT allocation is lazy; post-start samples under-report (milestone 7 section 5.1 rule 2)",\n'
  printf '    "successfulSamples": %s,\n' "${WARMUP_N:-0}"
  printf '    "medianMs": %s\n' "$(json_num "$WARMUP_MEDIAN")"
  printf '  },\n'
  printf '  "samples": %s,\n' "$measured_n"
  printf '  "requestedRequests": %s,\n' "$REQUESTS"
  printf '  "failedRequests": %s,\n' "$((REQUESTS - measured_n))"
  printf '  "latencyMs": {\n'
  printf '    "min": %s,\n' "$(json_num "$MIN")"
  printf '    "p5": %s,\n' "$(json_num "$P5")"
  printf '    "p50": %s,\n' "$(json_num "$P50")"
  printf '    "p95": %s,\n' "$(json_num "$P95")"
  printf '    "p99": %s,\n' "$(json_num "$P99")"
  printf '    "max": %s,\n' "$(json_num "$MAX")"
  printf '    "mean": %s,\n' "$(json_num "$MEAN")"
  printf '    "stdev": %s\n' "$(json_num "$STDEV")"
  printf '  },\n'
  printf '  "thresholds": {\n'
  printf '    "p50Ms": %s,\n' "$(json_num "$EXPECT_P50")"
  printf '    "p99Ms": %s\n' "$(json_num "$EXPECT_P99")"
  printf '  },\n'
  printf '  "violations": %s,\n' "$violations_json"
  printf '  "pass": %s\n' "$(if [ -z "$violations" ]; then printf 'true'; else printf 'false'; fi)"
  printf '}\n'
} > "$WORKDIR/output.json"

printf 'latency %s %s: p50=%s ms p95=%s ms p99=%s ms (n=%s measured, %s warmup excluded)\n' \
  "$METHOD" "$URL" "$P50" "$P95" "$P99" "$measured_n" "${WARMUP_N:-0}" >&2
if [ -n "$violations" ]; then
  printf '%s\n' "THRESHOLD FAIL:" "$violations" >&2
fi

if [ -n "$OUT" ]; then cp "$WORKDIR/output.json" "$OUT"; fi

if [ -n "$violations" ]; then exit 3; fi
exit 0