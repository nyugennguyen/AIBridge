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
