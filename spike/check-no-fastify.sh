#!/usr/bin/env bash
# SPIKE CODE -- NOT PRODUCTION. M7.1.
#
# The whole point of spike/worker-no-fastify.ts is that its import closure
# contains no Fastify and no src/server/. If that ever stops being true, its RSS
# number silently becomes a measurement of something else and every downstream
# claim built on it is wrong. Reading the entrypoint is not enough: the Fastify
# import can arrive transitively, which is exactly how src/bridge.ts gets it
# (src/bridge.ts:13 -> src/server/app.ts:1).
#
# So: walk the closure, then refuse. Static resolution of relative .js -> .ts
# specifiers, which is all the spike entrypoints use.
#
# Usage: spike/check-no-fastify.sh [ENTRYPOINT...]

set -euo pipefail

SPIKE_DIR=$(cd "$(dirname "$0")" && pwd)

ENTRIES=("$@")
if [ ${#ENTRIES[@]} -eq 0 ]; then
  ENTRIES=("$SPIKE_DIR/worker-no-fastify.ts")
fi

status=0
for entry in "${ENTRIES[@]}"; do
  printf 'spike/check-no-fastify.sh: import closure of %s\n' "$(basename "$entry")"
  seen_file=$(mktemp "${TMPDIR:-/tmp}/aibr-spike-closure.XXXXXX")
  : > "$seen_file"
  queue=("$entry")

  # Backstop, not a budget: an unbounded walk here is a bug in this script, and a
  # bug that hangs the checker is a checker that stops being run.
  budget=5000
  while [ ${#queue[@]} -gt 0 ] && [ "$budget" -gt 0 ]; do
    budget=$((budget - 1))
    current="${queue[0]}"
    queue=("${queue[@]:1}")
    [ -f "$current" ] || continue
    case " $(tr '\n' ' ' < "$seen_file") " in
      *" $current "*) continue ;;
    esac
    printf '%s\n' "$current" >> "$seen_file"

    # Only local relative specifiers are followed; node_modules and the SDK are
    # external and cannot import this repository's src/server/.
    sed -n 's/.*from "\(\.[^"]*\)".*/\1/p' "$current" | while read -r spec; do
      candidate="${current%/*}/$spec"
      candidate="${candidate%.js}.ts"
      [ -f "$candidate" ] || continue
      # Normalised, because the seen-check compares strings: `../server/app.js`
      # and `app.js` are one file and two entries, and an unnormalised walk loops
      # forever on the first `..` it meets.
      printf '%s/%s\n' "$(cd "$(dirname "$candidate")" && pwd)" "$(basename "$candidate")"
    done > "${seen_file}.next"

    while read -r next; do
      [ -n "$next" ] && queue+=("$next")
    done < "${seen_file}.next"
    rm -f "${seen_file}.next"
  done
  [ "$budget" -gt 0 ] || { printf '  FAIL: import walk exceeded its budget\n' >&2; status=1; }

  files=$(sort "$seen_file")
  count=$(printf '%s\n' "$files" | grep -c .)
  printf '  %s modules reachable\n' "$count"

  # `import type {} from "@fastify/websocket"` is present in the mesh gateway and
  # is type-only, but this check is deliberately textual and refuses it too: a
  # type-only edge costs nothing at runtime but makes the closure hard to review,
  # and the spike has no reason to accept one.
  if printf '%s\n' "$files" | grep -q '/src/server/'; then
    printf '  FAIL: the closure includes src/server/\n' >&2
    status=1
  fi
  # `xargs` rather than unquoted word splitting: a closure path containing a space
  # would otherwise be silently truncated into a filename that does not exist,
  # turning a check into a no-op.
  # shellcheck disable=SC2086
  printf '%s\n' "$files" | grep . | tr '\n' '\0' | xargs -0 grep -l 'from "fastify"\|from "@fastify/' \
    >/dev/null 2>&1 && {
    printf '  FAIL: the closure imports fastify or @fastify/*\n' >&2
    status=1
  }
  [ "$status" -eq 0 ] && printf '  OK: no fastify, no @fastify/*, no src/server/\n'
  rm -f "$seen_file"
done

exit "$status"