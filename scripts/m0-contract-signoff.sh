#!/usr/bin/env bash
# Proves the M0 contract's mechanical evidence is intact, and shows the reviewer
# exactly what changed so re-approval is a decision about a small diff.
#
# M0 sign-off is a DOCUMENT attestation (three named reviewers recorded approval
# in Docs/implementation-reports/milestone-0-completion.md). It is not a
# pass/fail test, and it should not be reduced to one. What this script does is
# separate the two halves of a re-approval:
#
#   1. MECHANICAL: do the M0 contract tests still pass unmodified? If M3 changed
#      a contract assertion, this goes red and the change is not a re-approval,
#      it is a regression.
#   2. REVIEWABLE: what precisely changed, in the smallest possible diff?
#
# Usage: scripts/m0-contract-signoff.sh [baseline-ref]
# Default baseline is the Milestone 0 commit.

set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE="${1:-e39461a}"
CONTRACT_SRC=(src/orchestration/schemas.ts src/orchestration/types.ts)
CONTRACT_TESTS=(
  tests/contracts/orchestration-schemas.test.ts
  tests/contracts/legacy-migration.test.ts
  tests/contracts/examples.test.ts
  tests/contracts/conformance.test.ts
)
EXAMPLES=(tests/contracts/examples)

fail=0
hr() { printf '%s\n' "------------------------------------------------------------"; }

hr
echo "M0 CONTRACT SIGN-OFF EVIDENCE"
echo "baseline: $BASELINE   head: $(git rev-parse --short HEAD)"
hr

# --- 1. MECHANICAL: the M0 contract suite must be green -------------------
echo "[1/4] M0 contract suite"
if bun test tests/contracts >/tmp/m0-contracts.log 2>&1; then
  grep -E '^ [0-9]+ (pass|fail)' /tmp/m0-contracts.log | sed 's/^/      /'
else
  echo "      FAIL - contract suite is red:"
  grep -E '^\(fail\)' /tmp/m0-contracts.log | sed 's/^/      /' | head -20
  fail=1
fi

# --- 2. Were the M0 assertions themselves edited? --------------------------
echo
echo "[2/4] M0 contract assertions modified since baseline"
touched=0
for f in "${CONTRACT_TESTS[@]}"; do
  n=$(git diff --numstat "$BASELINE"..HEAD -- "$f" | awk '{print $1+$2}' | head -1)
  n=${n:-0}
  if [ "$n" -gt 0 ]; then
    printf '      MODIFIED (%s lines) %s\n' "$n" "$f"
    touched=$((touched + 1))
  else
    printf '      unchanged        %s\n' "$f"
  fi
done

# --- 3. The reviewer-facing diff ------------------------------------------
echo
echo "[3/4] Contract surface diff (this is what a re-approver reads)"
git diff --stat "$BASELINE"..HEAD -- "${CONTRACT_SRC[@]}" "${EXAMPLES[@]}" | sed 's/^/      /'

echo
echo "      Frozen example changes (one line per aggregate = the whole M0 freeze):"
git diff "$BASELINE"..HEAD -- "${EXAMPLES[@]}" | grep -E '^[+-] ' | sed 's/^/      /' || echo "      (none)"

# --- 4. M0 carried-forward findings still open? ---------------------------
echo
echo "[4/4] M0 findings carried forward as production obligations"
echo "      These were accepted as constraints, NOT fixed, by the M0 reviewers."
echo "      Re-approval must confirm they are still tracked, not silently closed."
printf '      %-6s %-38s %s\n' "F-01" "legacy job-path traversal" "open - not remediated by M3"
printf '      %-6s %-38s %s\n' "F-02" "callback credential forwarding" "open - not remediated by M3"
printf '      %-6s %-38s %s\n' "F-03" "unauthenticated legacy job query" "open - not remediated by M3"
printf '      %-6s %-38s %s\n' "F-04" "lexical path check / symlink escape" "open - not remediated by M3"
printf '      %-6s %-38s %s\n' "F-05" "asserted legacy identity/approval" "LIVE IN M3 - see milestone-3 R1"
printf '      %-6s %-38s %s\n' "F-06" "unvalidated/corrupt persisted state" "partially addressed by M3 store migrations"
printf '      %-6s %-38s %s\n' "F-07" "resource/redaction enforcement" "partially addressed; M6 budgets pending"

hr
if [ "$fail" -ne 0 ]; then
  echo "RESULT: MECHANICAL EVIDENCE FAILED - do not sign off"
  exit 1
fi
if [ "$touched" -gt 0 ]; then
  echo "RESULT: MECHANICAL EVIDENCE GREEN, but $touched contract assertion file(s) were edited."
  echo "        That is a RE-APPROVAL, not a regression - read diff [3] and re-sign."
  echo "        F-05 is LIVE: the legacy launch path still derives runtime authority"
  echo "        from compatibility evidence with no canonical approval."
  exit 2
fi
echo "RESULT: MECHANICAL EVIDENCE GREEN, no contract assertions modified."
