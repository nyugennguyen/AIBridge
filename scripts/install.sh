#!/usr/bin/env bash
set -euo pipefail

# --- platform detect (mirrors src/host/preflight.ts detectOs) ---
OS=""
ARCH="$(uname -m)"
UNAME_S="$(uname -s)"
case "$(uname -s)" in
  Darwin*) OS="macos" ;;
  Linux*)
    if [ -f /etc/os-release ]; then
      # shellcheck disable=SC1091
      . /etc/os-release
      # parse ID= field (ID=debian / ID=ubuntu)
      case "${ID:-}" in
        debian) OS="debian" ;;
        ubuntu) OS="ubuntu" ;;
        *) OS="ubuntu" ;; # ubuntu superset for apt commands
      esac
    else
      OS="ubuntu"
    fi
    ;;
  *) echo "Error: Unsupported platform: $UNAME_S" >&2; exit 1 ;;
esac

echo "Detected OS: $OS ($ARCH)"

# --- prereq check (mirrors src/host/preflight.ts checkPrereqs) ---
has_cmd() { command -v "$1" >/dev/null 2>&1; }

install_cmd_for() {
  local tool="$1"
  case "$OS:$tool" in
    macos:tmux) echo "brew install tmux" ;;
    macos:tailscale) echo "brew install tailscale" ;;
    debian:tmux|ubuntu:tmux) echo "apt-get install -y tmux" ;;
    debian:tailscale|ubuntu:tailscale) echo "tailscale install-from-source --confirm --prefix=/usr/local" ;;
    *) echo "" ;;
  esac
}

check_prereqs() {
  # opencode manual fallback is intentional — no auto-install for opencode
  for tool in tmux opencode tailscale; do
    if has_cmd "$tool"; then
      echo "✓ $tool installed"
    else
      cmd="$(install_cmd_for "$tool")"
      if [ -n "$cmd" ]; then
        echo "✗ $tool missing — install with: $cmd"
      else
        echo "✗ $tool missing — install manually: bun install -g opencode-ai (see https://opencode.ai)"
      fi
    fi
  done
}
