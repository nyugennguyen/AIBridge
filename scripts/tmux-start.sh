#!/usr/bin/env bash
set -euo pipefail

: "${AIBRIDGE_AGENT_ID:?AIBRIDGE_AGENT_ID is required}"
: "${AIBRIDGE_CONFIG:?AIBRIDGE_CONFIG is required}"
: "${OPENCODE_SERVER_PASSWORD:?OPENCODE_SERVER_PASSWORD is required}"

SESSION_NAME="aibridge-${AIBRIDGE_AGENT_ID}"

if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  echo "tmux session already exists: ${SESSION_NAME}"
  exit 0
fi

tmux new-session -d -s "${SESSION_NAME}" -n opencode \
  "OPENCODE_SERVER_PASSWORD='${OPENCODE_SERVER_PASSWORD}' opencode serve --port 4096 --hostname 0.0.0.0"

tmux new-window -t "${SESSION_NAME}" -n aibridge \
  "AIBRIDGE_CONFIG='${AIBRIDGE_CONFIG}' bun run dev"

echo "Started ${SESSION_NAME}"
echo "Attach with: tmux attach -t ${SESSION_NAME}"
