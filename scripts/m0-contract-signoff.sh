#!/usr/bin/env bash
# Proves the M0 contract's mechanical evidence is intact, reports whether a
# recorded re-approval covers the current contract surface, and shows a
# reviewer exactly what changed.
#
# M0 sign-off is a DOCUMENT attestation (three named reviewers recorded
# approval in Docs/implementation-reports/milestone-0-completion.md). It is
# not a pass/fail test and should not be reduced to one. This script separates
# the two halves of a re-approval:
#
#   1. MECHANICAL: do the M0 contract tests still pass unmodified? If M3 changed
#      a contract assertion, that is a re-approval, not a regression.
#   2. RECORDED: has a human signed off on THIS EXACT contract surface?
#
# The approval is bound to a digest of the contract surface. If anyone edits
# the contract again, the digest changes and the recorded approval stops
# applying, so a signature can never silently outlive what it signed.
#
# Usage: scripts/m0-contract-signoff.sh [baseline-ref]
# Default baseline is the Milestone 0 commit.
#
# Exit: 0 = green (unmodified, or drift covered by a recorded approval)
#       2 = re-approval required (drift present, no valid recorded approval)
#       1 = the contract suite is red (a regression, not a re-approval)

set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE="${1:-e39461a}"
APPROVAL_DOC="Docs/implementation-reports/m0-contract-reapproval.md"
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

# Digest of exactly the surface a re-approver judges. Includes the contract
# source, the frozen examples, and the M0 assertions themselves.
contract_digest() {
  {
    for f in "${CONTRACT_SRC[@]}"; do printf 'src %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)"; done
    for f in "${EXAMPLES[@]}"/*.json; do printf 'ex  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)"; done
    for f in "${CONTRACT_TESTS[@]}"; do printf 'tst %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)"; done
  } | shasum -a 256 | cut -d' ' -f1
}

CURRENT_DIGEST=$(contract_digest)
RECORDED_DIGEST=""
if [ -f "$APPROVAL_DOC" ]; then
  RECORDED_DIGEST=$(grep -ioE 'contract-surface-digest[^0-9a-f]*`?([0-9a-f]{64})' "$APPROVAL_DOC" | grep -oE '[0-9a-f]{64}' | head -1)
fi

hr
echo "M0 CONTRACT SIGN-OFF EVIDENCE"
echo "baseline:  $BASELINE"
echo "head:      $(git rev-parse --short HEAD)"
echo "digest:    $CURRENT_DIGEST"
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

# --- 3. Recorded approval coverage ----------------------------------------
echo
echo "[3/4] Recorded re-approval"
approval_state="none"
if [ "$fail" -ne 0 ]; then
  approval_state="contract-red"
  echo "      not evaluated - the contract suite is red"
elif [ "$touched" -eq 0 ]; then
  approval_state="unmodified"
  echo "      no drift; M0's original sign-off still applies"
elif [ -z "$RECORDED_DIGEST" ]; then
  approval_state="pending"
  echo "      NO RECORDED APPROVAL - re-approval required"
elif [ "$RECORDED_DIGEST" = "$CURRENT_DIGEST" ]; then
  approval_state="approved"
  echo "      APPROVED - $APPROVAL_DOC"
  echo "      the recorded digest matches the current contract surface"
else
  approval_state="stale"
  echo "      STALE - $APPROVAL_DOC approves a DIFFERENT contract surface:"
  echo "        recorded: $RECORDED_DIGEST"
  echo "        current:  $CURRENT_DIGEST"
  echo "      the contract changed after sign-off; the approval no longer applies"
fi

# --- 4. The reviewer-facing diff ------------------------------------------
echo
echo "[4/4] Contract surface diff"
git diff --stat "$BASELINE"..HEAD -- "${CONTRACT_SRC[@]}" "${EXAMPLES[@]}" | sed 's/^/      /'
echo
echo "      Frozen example changes (the whole M0 freeze):"
git diff "$BASELINE"..HEAD -- "${EXAMPLES[@]}" | grep -E '^[+-] ' | sed 's/^/      /' || echo "      (none)"

hr
case "$approval_state" in
  unmodified)
    echo "RESULT: GREEN - M0 contract unmodified; original sign-off applies." ;;
  approved)
    echo "RESULT: GREEN - contract drifted but a recorded re-approval covers it."
    echo "        Carried-forward findings are NOT closed by this; see F-01..F-07." ;;
  contract-red)
    echo "RESULT: MECHANICAL EVIDENCE FAILED - do not sign off"; exit 1 ;;
  *)
    echo "RESULT: RE-APPROVAL REQUIRED - contract drifted with no valid recorded approval."
    echo "        Read diff [4], then record an approval in $APPROVAL_DOC"
    exit 2 ;;
esac
