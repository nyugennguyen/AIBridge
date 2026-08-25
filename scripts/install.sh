#!/usr/bin/env bash
set -euo pipefail

YES=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --help|-h) echo "Usage: install.sh [--yes] [--help] [--version]"; echo "  curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash -s -- --yes"; exit 0 ;;
    --version) echo "1.0.1"; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

confirm() {
  if [ "$YES" -eq 1 ]; then return 0; fi
  printf "%s (y/n) " "$1"
  read -r ans
  case "$ans" in y|Y) return 0 ;; *) return 1 ;; esac
}

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

# prompt confirm helper — read install tmux with confirmation gating
install_missing_prereqs() {
  if ! has_cmd tmux; then
    if confirm "Install tmux? Run: $(install_cmd_for tmux)"; then
      if [ "$OS" = "macos" ]; then brew install tmux; else sudo apt-get install -y tmux; fi
    fi
  fi
  if ! has_cmd tailscale; then
    if confirm "Install tailscale? Run: $(install_cmd_for tailscale)"; then
      if [ "$OS" = "macos" ]; then brew install tailscale; else sudo apt-get install -y tailscale || tailscale install-from-source --confirm --prefix=/usr/local; fi
    fi
  fi
}

# --- bun check (bun >=1.3.0 required, mirrors package.json engines) ---
ensure_bun() {
  if has_cmd bun; then
    BUN_VER="$(bun --version 2>/dev/null || echo 0.0.0)"
    echo "✓ bun $BUN_VER"
    # simple version check: require 1.3.x
    MAJOR="$(echo "$BUN_VER" | cut -d. -f1)"
    MINOR="$(echo "$BUN_VER" | cut -d. -f2)"
    if [ "$MAJOR" -lt 1 ] || { [ "$MAJOR" -eq 1 ] && [ "${MINOR:-0}" -lt 3 ]; }; then
      echo "Error: bun >=1.3.0 required, found $BUN_VER" >&2; exit 1
    fi
  else
    echo "✗ bun missing — install from https://bun.sh"
    printf "Install bun now? (y/n) "
    read -r ans
    case "$ans" in
      y|Y) curl -fsSL https://bun.sh/install | bash ;;
      *) echo "Aborted: bun is required" >&2; exit 1 ;;
    esac
    export PATH="$HOME/.bun/bin:$PATH"
  fi
}

install_aibridge() {
  # bun install -g @nyugennguyen/aibridge
  VER="${AIBRIDGE_VERSION:-latest}"
  PKG="@nyugennguyen/aibridge"
  if [ "$VER" != "latest" ]; then PKG="${PKG}@${VER}"; fi
  echo "Installing $PKG via bun..."
  bun install -g "$PKG"
  if ! command -v aibr >/dev/null 2>&1; then
    BIN_DIR="$(bun pm bin -g 2>/dev/null || echo "$HOME/.bun/bin")"
    echo "Add to PATH: export PATH=\"$BIN_DIR:\$PATH\" (add to ~/.bashrc or ~/.zshrc)"
  fi
  aibr --version || true
}

verify_tailscale() {
  if ! has_cmd tailscale; then
    echo "⚠ tailscale not installed — install with: $(install_cmd_for tailscale)"
    return 0
  fi
  if ! tailscale status >/dev/null 2>&1; then
    echo "⚠ Tailscale not active — run: sudo tailscale up (BackendState not Running)" >&2
  else
    echo "✓ tailscale status ok"
    tailscale ip -4 2>/dev/null | head -n1 | xargs -I{} echo "  Tailscale IP: {}"
  fi
}

main() {
  echo "AIBridge installer — https://github.com/nyugennguyen/AIBridge"
  check_prereqs
  ensure_bun
  verify_tailscale
  install_aibridge
  echo ""
  echo "✓ Installed. Next:"
  echo "  aibr setup --profile <name>   # interactive host setup"
  echo "  aibr start --profile <name>   # start tmux session"
  echo "  aibr status --profile <name>  # verify bridge health"
  echo ""
  echo "Bridge binds Tailscale-only (never public Internet). opencode on 127.0.0.1 only."
  echo "Private network via Tailscale — no public exposure."
}
main
