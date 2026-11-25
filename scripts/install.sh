#!/usr/bin/env bash
set -euo pipefail

CLI_VERSION="3.0.0"

YES=0
WITH_UNITS=0
ROLE="worker"
RUNTIME="auto"
INGRESS="default"
PROFILE=""
WITH_PLUGIN=-1 # -1 = decide by role, 0 = off, 1 = on
OS=""
ARCH="$(uname -m)"
MISSING_SUMMARY=()

usage() {
  cat <<'USAGE'
Usage: install.sh [options]
  curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash -s -- --yes

Options:
  --yes, -y              answer yes to every prompt (required when there is no terminal)
  --role ROLE            worker (default) | orchestrator | both
  --runtime RT           opencode | claude | auto (default: whichever is on PATH, opencode first)
  --profile NAME         profile name used in the printed next steps
  --with-claude-plugin   install the Claude Code plugin after installing aibr
  --without-claude-plugin
  --ingress router       also look for aibr-router and provision its admission store
  --with-units           install router and worker supervision units (systemd/launchd).
                         Requires root and a repository checkout; off by default.
  --without-units        leave supervision alone (the default)
  --help, -h             show this help
  --version              print the installer version

Environment:
  AIBRIDGE_VERSION        npm version/tag to install (default: latest)
  AIBRIDGE_ROUTER_BIN     path to an aibr-router binary (with --ingress router)
  AIBRIDGE_INGRESS_OUTBOX absolute path of the admission store (with --ingress router)
USAGE
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y) YES=1 ;;
      --with-units) WITH_UNITS=1 ;;
      --without-units) WITH_UNITS=0 ;;
      --with-claude-plugin) WITH_PLUGIN=1 ;;
      --without-claude-plugin) WITH_PLUGIN=0 ;;
      --role) shift; ROLE="${1:-}" ;;
      --role=*) ROLE="${1#--role=}" ;;
      --runtime) shift; RUNTIME="${1:-}" ;;
      --runtime=*) RUNTIME="${1#--runtime=}" ;;
      --ingress) shift; INGRESS="${1:-}" ;;
      --ingress=*) INGRESS="${1#--ingress=}" ;;
      --profile) shift; PROFILE="${1:-}" ;;
      --profile=*) PROFILE="${1#--profile=}" ;;
      --help|-h) usage; exit 0 ;;
      --version) echo "$CLI_VERSION"; exit 0 ;;
      *) echo "Unknown flag: $1" >&2; exit 1 ;;
    esac
    shift
  done
  case "$ROLE" in worker|orchestrator|both) ;; *) echo "Error: --role must be worker, orchestrator or both (got '$ROLE')" >&2; exit 1 ;; esac
  case "$RUNTIME" in opencode|claude|auto) ;; *) echo "Error: --runtime must be opencode, claude or auto (got '$RUNTIME')" >&2; exit 1 ;; esac
  case "$INGRESS" in default|router) ;; *) echo "Error: --ingress must be 'router' (or omitted)" >&2; exit 1 ;; esac
}

# --- interactive input ---
# The primary path is `curl ... | bash`, where stdin IS the script. Every prompt
# therefore reads from the controlling terminal and never from stdin.
has_tty() { (: < /dev/tty) 2>/dev/null; }

require_tty_or_yes() {
  if [ "$YES" -eq 1 ] || has_tty; then return 0; fi
  echo "Error: no terminal available for prompts (stdin is not a terminal and /dev/tty cannot be opened)." >&2
  echo "  Re-run with --yes to accept every prompt, or download the script first:" >&2
  echo "    curl -fsSLO https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh && bash install.sh" >&2
  exit 1
}

confirm() {
  if [ "$YES" -eq 1 ]; then return 0; fi
  if ! has_tty; then return 1; fi
  local ans=""
  printf "%s (y/n) " "$1" > /dev/tty
  read -r ans < /dev/tty || ans=""
  case "$ans" in y|Y) return 0 ;; *) return 1 ;; esac
}

ask_line() { # ask_line <prompt> <default>
  local ans=""
  if [ "$YES" -eq 1 ] || ! has_tty; then echo "$2"; return 0; fi
  printf "%s [%s]: " "$1" "$2" > /dev/tty
  read -r ans < /dev/tty || ans=""
  echo "${ans:-$2}"
}

as_root() { if [ "${EUID:-$(id -u)}" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# --- platform detect (mirrors src/host/preflight.ts detectOs) ---
detect_os() {
  local uname_s
  uname_s="$(uname -s)"
  case "$uname_s" in
    Darwin*) OS="macos" ;;
    Linux*)
      if [ -f /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        # parse ID= field (ID=debian / ID=ubuntu)
        case "${ID:-}" in
          debian) OS="debian" ;;
          ubuntu) OS="ubuntu" ;;
          *)
            OS="ubuntu"
            echo "⚠ Linux distribution '${ID:-unknown}' is not Debian/Ubuntu; treating it as Ubuntu-compatible (apt-get)." >&2
            ;;
        esac
      else
        OS="ubuntu"
        echo "⚠ /etc/os-release not found; treating this Linux as Ubuntu-compatible (apt-get)." >&2
      fi
      ;;
    *) echo "Error: Unsupported platform: $uname_s" >&2; exit 1 ;;
  esac
  echo "Detected OS: $OS ($ARCH)"
}

# --- prereq check (mirrors src/host/preflight.ts checkPrereqs) ---
has_cmd() { command -v "$1" >/dev/null 2>&1; }

install_cmd_for() {
  local tool="$1"
  case "$OS:$tool" in
    macos:tmux) echo "brew install tmux" ;;
    macos:tailscale) echo "brew install tailscale" ;;
    debian:tmux|ubuntu:tmux) echo "apt-get install -y tmux" ;;
    debian:tailscale|ubuntu:tailscale) echo "Tailscale's official installer (https://tailscale.com/install.sh)" ;;
    *) echo "" ;;
  esac
}

# Runtime binary a worker will use. auto: opencode if present, else claude if
# present, else opencode (the historical default) so the report names something.
worker_runtime_tool() {
  case "$RUNTIME" in
    opencode|claude) echo "$RUNTIME" ;;
    *)
      if has_cmd opencode; then echo opencode
      elif has_cmd claude; then echo claude
      else echo opencode; fi
      ;;
  esac
}

# Tools required for the selected role (space separated).
required_tools() {
  local rt
  rt="$(worker_runtime_tool)"
  case "$ROLE" in
    worker) echo "tailscale tmux $rt" ;;
    orchestrator) echo "tailscale claude" ;;
    both)
      if [ "$rt" = "claude" ]; then echo "tailscale tmux claude"; else echo "tailscale tmux $rt claude"; fi
      ;;
  esac
}

is_runtime_tool() { [ "$1" = "opencode" ] || [ "$1" = "claude" ]; }

check_prereqs() {
  local tool cmd
  for tool in $(required_tools); do
    if has_cmd "$tool"; then
      echo "✓ $tool installed"
    elif is_runtime_tool "$tool"; then
      echo "✗ $tool missing — not auto-installed; install with: $(runtime_hint "$tool")"
      MISSING_SUMMARY+=("$tool (agent runtime) is missing — install with: $(runtime_hint "$tool")")
    else
      cmd="$(install_cmd_for "$tool")"
      echo "✗ $tool missing${cmd:+ — will offer to install via: $cmd}"
    fi
  done
}

runtime_hint() {
  case "$1" in
    opencode) echo "bun install -g opencode-ai   (https://opencode.ai)" ;;
    claude) echo "curl -fsSL https://claude.ai/install.sh | bash   or   npm install -g @anthropic-ai/claude-code" ;;
    *) echo "" ;;
  esac
}

install_tailscale() {
  if [ "$OS" = "macos" ]; then
    brew install tailscale
  else
    # Plain `apt-get install tailscale` fails without Tailscale's apt repo; the
    # official installer script sets the repo up. Only ever run after confirmation.
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  echo "  Next: sudo tailscale up   (log in to your tailnet)"
}

# Offer to install the missing system prerequisites this role needs; prompt confirm gates every install.
install_missing_prereqs() {
  local tool
  for tool in $(required_tools); do
    if has_cmd "$tool"; then continue; fi
    case "$tool" in
      tmux)
        if [ "$OS" = "macos" ] && ! has_cmd brew; then
          echo "✗ Homebrew not found; install tmux manually (https://brew.sh then brew install tmux)"
          MISSING_SUMMARY+=("tmux is missing and Homebrew is unavailable")
        elif confirm "Install tmux? Run: $(install_cmd_for tmux)"; then
          if [ "$OS" = "macos" ]; then brew install tmux; else as_root apt-get install -y tmux; fi
        else
          MISSING_SUMMARY+=("tmux is missing — install with: $(install_cmd_for tmux)")
        fi
        ;;
      tailscale)
        if [ "$OS" = "macos" ] && ! has_cmd brew; then
          echo "✗ Homebrew not found; install Tailscale manually (https://tailscale.com/download)"
          MISSING_SUMMARY+=("tailscale is missing and Homebrew is unavailable")
        elif confirm "Install tailscale? Run: $(install_cmd_for tailscale)"; then
          install_tailscale
        else
          MISSING_SUMMARY+=("tailscale is missing — see https://tailscale.com/download, then run: sudo tailscale up")
        fi
        ;;
    esac
  done
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
    if confirm "Install bun now?"; then
      curl -fsSL https://bun.sh/install | bash
    else
      echo "Aborted: bun is required" >&2; exit 1
    fi
    export PATH="$HOME/.bun/bin:$PATH"
  fi
}

bun_bin_dir() { bun pm bin -g 2>/dev/null || echo "$HOME/.bun/bin"; }

shell_rc_file() {
  case "$(basename "${SHELL:-}")" in
    zsh) echo "$HOME/.zshrc" ;;
    *) echo "$HOME/.bashrc" ;;
  esac
}

# M6: make `aibr` reachable, persistently (with consent) and for this script.
ensure_aibr_on_path() {
  if has_cmd aibr; then return 0; fi
  local dir rc line
  dir="$(bun_bin_dir)"
  rc="$(shell_rc_file)"
  line="export PATH=\"$dir:\$PATH\""
  if confirm "aibr is not on PATH. Append '$line' to $rc?"; then
    touch "$rc"
    if grep -qxF "$line" "$rc" 2>/dev/null; then
      echo "✓ $rc already contains the PATH entry"
    else
      printf '\n# added by the AIBridge installer\n%s\n' "$line" >> "$rc"
      echo "✓ added PATH entry to $rc (open a new shell or run: source $rc)"
    fi
  else
    echo "Add to PATH yourself: $line   (in $rc)"
  fi
  export PATH="$dir:$PATH"
}

install_aibridge() {
  # bun install -g @nyugennguyen/aibridge
  VER="${AIBRIDGE_VERSION:-latest}"
  PKG="@nyugennguyen/aibridge"
  if [ "$VER" != "latest" ]; then PKG="${PKG}@${VER}"; fi
  echo "Installing $PKG via bun..."
  bun install -g "$PKG"
  ensure_aibr_on_path
  aibr --version || true
  if [ "$INGRESS" = "router" ]; then install_router_binary; fi
}

# --- Claude Code plugin ---
install_claude_plugin() {
  if ! has_cmd claude; then
    echo "⚠ claude is not installed; skipping the Claude Code plugin."
    MISSING_SUMMARY+=("Claude Code plugin not installed (claude missing): $(runtime_hint claude)")
    return 0
  fi
  if has_cmd aibr && aibr plugin --help >/dev/null 2>&1; then
    aibr plugin install claude --scope user
  else
    echo "plugin installer not available in this aibr version"
    echo "  Manual steps (from an AIBridge checkout that contains the plugin):"
    echo "    claude plugin marketplace add <path-to-checkout>"
    echo "    claude plugin install aibridge@aibridge"
  fi
}

maybe_install_claude_plugin() {
  case "$WITH_PLUGIN" in
    1) install_claude_plugin ;;
    0) return 0 ;;
    *)
      if [ "$ROLE" != "worker" ] && has_cmd claude && confirm "Install the AIBridge Claude Code plugin?"; then
        install_claude_plugin
      fi
      ;;
  esac
}

find_router_bin() {
  # No download URL is constructed here, and that is deliberate rather than
  # pending: no router artifact has been published, so any release-asset URL
  # would be a 404 that looks like a network failure, on every install, forever.
  # A locally built binary is found instead, and its absence is reported as an
  # instruction rather than papered over.
  if [ -n "${AIBRIDGE_ROUTER_BIN:-}" ] && [ -x "$AIBRIDGE_ROUTER_BIN" ]; then
    echo "$AIBRIDGE_ROUTER_BIN"
    return 0
  fi
  if has_cmd aibr-router; then
    command -v aibr-router
    return 0
  fi
  local bin_dir
  bin_dir="$(bun_bin_dir)"
  if [ -x "${bin_dir}/aibr-router" ]; then
    echo "${bin_dir}/aibr-router"
    return 0
  fi
  return 1
}

install_router_binary() {
  local bin
  if ! bin="$(find_router_bin)"; then
    echo "⚠ aibr-router not found — the polyglot ingress router is not installed."
    echo "  Build it from a checkout (no Rust toolchain needed on the serving host once built):"
    echo "    cargo build --release --manifest-path router/Cargo.toml"
    echo "    # or, for the static Linux targets:  bash scripts/build-matrix.sh x86_64-unknown-linux-musl"
    echo "    install -m 0755 router/target/release/aibr-router /usr/local/bin/"
    echo "  Then re-run with AIBRIDGE_ROUTER_BIN=/usr/local/bin/aibr-router to provision the store."
    return 0
  fi
  echo "✓ aibr-router at $bin"
  provision_ingress_store "$bin"
}

provision_ingress_store() {
  local bin="${1:-}"
  if [ -z "$bin" ]; then
    echo "⚠ no aibr-router binary: skipping admission store provisioning."
    echo "  The router refuses to start without a provisioned store (exit 78), so run:"
    echo "    AIBRIDGE_INGRESS_OUTBOX=/absolute/path/ingress_outbox aibr-router --init-store"
    return 0
  fi
  if [ -z "${AIBRIDGE_INGRESS_OUTBOX:-}" ]; then
    echo "⚠ AIBRIDGE_INGRESS_OUTBOX is unset: skipping admission store provisioning."
    echo "  Set it to an absolute path and re-run, or provision by hand with:"
    echo "    AIBRIDGE_INGRESS_OUTBOX=/absolute/path/ingress_outbox aibr-router --init-store"
    return 0
  fi

  echo "Provisioning admission store at $AIBRIDGE_INGRESS_OUTBOX ..."
  local status=0
  "$bin" --init-store || status=$?
  if [ "$status" -ne 0 ]; then
    # A refusal here is information, not a nuisance: exit 78 means the path is not
    # a store this build speaks, and the units would refuse to start for the same
    # reason on every boot. Reported rather than swallowed.
    echo "⚠ aibr-router --init-store exited $status; the store was NOT provisioned." >&2
    return 0
  fi
  echo "✓ admission store ready"
}

# Echo the repository root when this script runs from a checkout (a packaging/
# directory next to scripts/); fail when piped from curl or copied elsewhere.
checkout_root() {
  local src="${BASH_SOURCE[0]:-}" root
  if [ -z "$src" ] || [ ! -f "$src" ]; then return 1; fi
  root="$(cd "$(dirname "$src")/.." && pwd)" || return 1
  if [ ! -d "$root/packaging" ]; then return 1; fi
  echo "$root"
}

units_need_checkout_msg() {
  echo "Error: --with-units needs a repository checkout (a packaging/ directory next to scripts/)." >&2
  echo "  This script was not run from a checkout (for example it was piped from curl)." >&2
  echo "  Clone the repository and run: sudo bash scripts/install.sh --with-units" >&2
}

install_supervision_units() {
  if [ "$WITH_UNITS" -eq 0 ]; then
    echo "Skipping supervision units (pass --with-units to install them)."
    return 0
  fi
  local repo_root
  if ! repo_root="$(checkout_root)"; then
    units_need_checkout_msg
    return 1
  fi
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    echo "Error: --with-units needs root (it writes /etc/systemd/system and /Library/LaunchDaemons)." >&2
    return 1
  fi

  if [ "$OS" = "macos" ]; then
    install -m 0755 "$repo_root/packaging/launchd/aibr-router.sh" /usr/local/bin/aibr-router.sh
    install -m 0755 "$repo_root/packaging/launchd/aibr-worker.sh" /usr/local/bin/aibr-worker.sh
    install -m 0644 "$repo_root/packaging/launchd/com.aibridge.router.plist" /Library/LaunchDaemons/com.aibridge.router.plist
    install -m 0644 "$repo_root/packaging/launchd/com.aibridge.worker.plist" /Library/LaunchDaemons/com.aibridge.worker.plist
    launchctl bootstrap system /Library/LaunchDaemons/com.aibridge.router.plist 2>/dev/null || true
    launchctl bootstrap system /Library/LaunchDaemons/com.aibridge.worker.plist 2>/dev/null || true
    echo "✓ launchd daemons installed"
  else
    install -m 0644 "$repo_root/packaging/systemd/aibr-router.service" /etc/systemd/system/aibr-router.service
    install -m 0644 "$repo_root/packaging/systemd/aibr-worker.service" /etc/systemd/system/aibr-worker.service
    systemctl daemon-reload
    systemctl enable aibr-router.service aibr-worker.service
    echo "✓ systemd units enabled (not started: they need /etc/aibridge/router.env)"
  fi

  echo ""
  echo "Still yours to do by hand:"
  echo "  1. Create /etc/aibridge/router.env (mode 0600) with:"
  echo "       AIBRIDGE_CONFIG=/absolute/path/config.json"
  echo "       AIBRIDGE_BEARER_TOKEN=<the shared secret>"
  echo "       AIBRIDGE_INGRESS_OUTBOX=/absolute/path/ingress_outbox"
  echo "     AIBRIDGE_WORKER_PROFILE is required by the worker unit only."
  echo "  2. systemctl start aibr-router aibr-worker   (or: sudo launchctl kickstart -k system/com.aibridge.router)"
}

verify_tailscale() {
  if ! has_cmd tailscale; then
    echo "⚠ tailscale not installed — see https://tailscale.com/download, then run: sudo tailscale up"
    return 0
  fi
  if ! tailscale status >/dev/null 2>&1; then
    echo "⚠ Tailscale not active — run: sudo tailscale up (BackendState not Running)" >&2
  else
    echo "✓ tailscale status ok"
    tailscale ip -4 2>/dev/null | head -n1 | xargs -I{} echo "  Tailscale IP: {}"
  fi
}

print_summary() {
  if [ "${#MISSING_SUMMARY[@]}" -gt 0 ]; then
    echo ""
    echo "⚠ Still missing (role: $ROLE):"
    local m
    for m in "${MISSING_SUMMARY[@]}"; do echo "  - $m"; done
  fi
}

print_next_steps() {
  local p="${PROFILE:-<name>}"
  echo ""
  echo "✓ Installed. Next:"
  case "$ROLE" in
    orchestrator)
      echo "  aibr setup --profile $p   # interactive host setup"
      echo "  Then use the AIBridge Claude Code plugin from Claude Code (install it with --with-claude-plugin)."
      ;;
    *)
      echo "  aibr setup --profile $p   # interactive host setup"
      echo "  aibr start --profile $p   # start tmux session"
      echo "  aibr status --profile $p  # verify bridge health"
      if [ "$ROLE" = "both" ]; then echo "  Also use the AIBridge Claude Code plugin from Claude Code."; fi
      ;;
  esac
  echo ""
  echo "Bridge binds Tailscale-only (never public Internet). opencode on 127.0.0.1 only."
  echo "Private network via Tailscale — no public exposure."
}

offer_setup() {
  if [ "$YES" -eq 1 ] || ! has_tty || ! has_cmd aibr; then return 0; fi
  if confirm "Run 'aibr setup' now?"; then
    local p
    p="$(ask_line "Profile name" "${PROFILE:-default}")"
    PROFILE="$p"
    aibr setup --profile "$p" < /dev/tty || echo "⚠ aibr setup did not finish; re-run: aibr setup --profile $p"
  fi
}

main() {
  parse_args "$@"
  echo "AIBridge installer — https://github.com/nyugennguyen/AIBridge"
  require_tty_or_yes
  if [ "$WITH_UNITS" -eq 1 ] && ! checkout_root >/dev/null; then
    units_need_checkout_msg
    exit 1
  fi
  detect_os
  check_prereqs
  install_missing_prereqs
  ensure_bun
  verify_tailscale
  install_aibridge
  maybe_install_claude_plugin
  install_supervision_units
  print_summary
  print_next_steps
  offer_setup
}

if [ "${AIBRIDGE_INSTALL_NO_MAIN:-}" != "1" ]; then
  main "$@"
fi
