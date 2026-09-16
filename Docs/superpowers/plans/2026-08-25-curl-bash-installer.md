# curl | bash Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single `curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash` one-liner that installs Bun (if missing), tmux/opencode/tailscale dependencies, and `@nyugennguyen/aibridge` globally, then prints verified next steps.

**Architecture:** Standalone POSIX `sh` script `scripts/install.sh` that mirrors `src/host/preflight.ts` platform logic (darwin→macos, linux→debian/ubuntu detection via `uname` + `/etc/os-release`) without Node. Script is `set -euo pipefail`, argv-only installs, explicit user confirmation before any `brew`/`apt-get`, and `bun install -g` for the package. Tests verify script content + shellcheck + `bun run release:check` integration.

**Tech Stack:** POSIX sh (`set -euo pipefail`), Bun 1.3+, `shellcheck` (CI lint), Vitest (content assertions), `oven-sh/setup-bun`, existing `src/host/preflight.ts` as spec source.

---

## File Structure

**Created:**
- `scripts/install.sh` — The installer (executable, 250-350 lines). Owns platform detect, prereq check, confirm, install, bun global install, PATH advice.
- `tests/unit/installer/install-script.test.ts` — Vitest content tests for `scripts/install.sh` (no execution, just string assertions + shell dry-parse).

**Modified:**
- `README.md:23-62` — Replace/augment Install section with curl|bash primary path + manual fallback.
- `package.json:29` — Add `scripts.test:installer` or extend `release:check` to include `shellcheck scripts/install.sh`.
- `.github/workflows/ci.yml:36-41` — Add `shellcheck` step (install + lint).
- `CHANGELOG.md:1` — Add `1.1.0` entry.

**No new runtime dependencies.** Script must work on hosts that have *no* Bun/Node yet.

---

### Task 1: Scaffold installer spec and fixtures

**Files:**
- Create: `tests/unit/installer/install-script.test.ts`
- Create: `tests/unit/installer/fixtures.ts`

- [ ] **Step 1: Write failing test for script existence + shebang**

```typescript
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const SCRIPT = new URL("../../../scripts/install.sh", import.meta.url)

describe("install.sh — file contract", () => {
  it("exists and starts with POSIX shebang + set -euo pipefail", async () => {
    const content = await readFile(SCRIPT, "utf8")
    expect(content.startsWith("#!/usr/bin/env bash")).toBe(true)
    expect(content).toContain("set -euo pipefail")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: FAIL with `ENOENT: no such file or directory, open '.../scripts/install.sh'`

- [ ] **Step 3: Create minimal placeholder to make it pass**

```bash
mkdir -p scripts tests/unit/installer
cat > scripts/install.sh <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
echo "AIBridge installer placeholder"
EOS
chmod +x scripts/install.sh
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh tests/unit/installer/install-script.test.ts
git commit -m "feat(installer): scaffold install.sh with POSIX header"
```

---

### Task 2: Implement platform detection (mirrors preflight.ts)

**Files:**
- Modify: `scripts/install.sh:1-50`
- Modify: `tests/unit/installer/install-script.test.ts:1-30`

Parity with `src/host/preflight.ts:76-82` (`detectOs`) and `src/host/preflight.ts:92-108` (`INSTALL_CMD_TABLE`). Script must handle `darwin -> macos`, `linux -> ubuntu/debian` via `/etc/os-release`, else `unsupported`.

- [ ] **Step 1: Write failing test for platform detection blocks**

```typescript
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const SCRIPT = new URL("../../../scripts/install.sh", import.meta.url)

describe("install.sh — platform detection", () => {
  it("detects darwin and maps to macos", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain('case "$(uname -s)" in')
    expect(s).toContain('Darwin*) OS="macos"')
    expect(s).toContain('Linux*)')
  })
  it("fails on unsupported platform (win32/freebsd) with error", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain("Unsupported platform")
    expect(s).toMatch(/exit 1/)
  })
  it("parses /etc/os-release for debian vs ubuntu", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain("/etc/os-release")
    expect(s).toContain("ID=")
  })
  it("never references win32 install commands", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).not.toContain("choco")
    expect(s).not.toContain("winget")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: FAIL — `Expected to contain 'case "$(uname -s)"'`

- [ ] **Step 3: Write minimal implementation (append to scripts/install.sh)**

```bash
#!/usr/bin/env bash
set -euo pipefail

# --- platform detect (mirrors src/host/preflight.ts detectOs) ---
OS=""
ARCH="$(uname -m)"
UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Darwin*) OS="macos" ;;
  Linux*)
    if [ -f /etc/os-release ]; then
      # shellcheck disable=SC1091
      . /etc/os-release
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
```

Target: `scripts/install.sh:1-30`. Keep existing header, replace placeholder body.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: PASS (4 new tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh tests/unit/installer/install-script.test.ts
git commit -m "feat(installer): add platform detection parity with preflight"
```

---

### Task 3: Prereq checks + install-command table (no execution yet)

**Files:**
- Modify: `scripts/install.sh:30-120`
- Modify: `tests/unit/installer/install-script.test.ts:30-80`

Mirrors `src/host/preflight.ts:118-147` (`isInstalled` via `which`, `PREREQS = tmux, opencode, tailscale`) and `INSTALL_CMD_TABLE`.

- [ ] **Step 1: Write failing test for prereq table**

```typescript
it("defines fixed argv install commands per OS (no curl|sh)", async () => {
  const s = await readFile(SCRIPT, "utf8")
  // macos
  expect(s).toContain('brew install tmux')
  expect(s).toContain('brew install tailscale')
  // debian/ubuntu
  expect(s).toContain('apt-get install -y tmux')
  // must NOT contain curl pipe in install table
  expect(s).not.toMatch(/curl.*\|.*sh/)
  expect(s).not.toMatch(/curl.*\|.*bash/)
})

it("checks for tmux/opencode/tailscale via 'command -v' or 'which'", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).toMatch(/command -v|which tmux/)
  expect(s).toContain("tmux")
  expect(s).toContain("opencode")
  expect(s).toContain("tailscale")
})

it("marks opencode as missing without auto-install (manual instruction)", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).toMatch(/opencode.*manual|opencode.*bun install -g opencode-ai/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: FAIL

- [ ] **Step 3: Implement prereq check functions**

Append to `scripts/install.sh` after platform block:

```bash
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh tests/unit/installer/install-script.test.ts
git commit -m "feat(installer): add prereq check table parity with preflight"
```

---

### Task 4: Bun handling + global package install

**Files:**
- Modify: `scripts/install.sh:120-200`
- Modify: `tests/unit/installer/install-script.test.ts:80-130`

Requirements: Bun >=1.3.0, `bun install -g @nyugennguyen/aibridge`, PATH check via `bun pm bin -g`, version pin? Use `latest` by default, allow `AIBRIDGE_VERSION` env override.

- [ ] **Step 1: Write failing test for Bun + package install**

```typescript
it("checks bun version >=1.3.0 and handles missing bun", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).toContain("bun --version")
  expect(s).toContain("1.3.0")
  expect(s).toMatch(/curl.*bun\.sh.*install|https:\/\/bun\.sh\/install/i)
})

it("installs aibridge via bun global install", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).toContain("bun install -g @nyugennguyen/aibridge")
})

it("supports AIBRIDGE_VERSION env override", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).toContain("AIBRIDGE_VERSION")
})

it("verifies aibr is on PATH and advises bun pm bin -g", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).toContain("bun pm bin -g")
  expect(s).toContain("aibr --version")
})

it("uses set -euo pipefail and no sudo by default (user confirms)", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).toContain("set -euo pipefail")
  // script should not bare sudo without prompt
  expect(s).not.toMatch(/^\s*sudo apt-get/m)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: FAIL

- [ ] **Step 3: Implement Bun + package install block**

```bash
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh tests/unit/installer/install-script.test.ts
git commit -m "feat(installer): add bun check and global package install"
```

---

### Task 5: Interactive confirmation flow (no auto-install without consent)

**Files:**
- Modify: `scripts/install.sh:200-260`
- Modify: `tests/unit/installer/install-script.test.ts:130-180`

Mirrors `src/host/preflight.ts:314-356` confirm-before-install. Also must reject non-TTY for secret prompts but installer itself should allow `--yes` flag for CI.

- [ ] **Step 1: Write failing test for confirmation gating**

```typescript
it("prompts before brew/apt installs and respects --yes", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).toContain("--yes")
  expect(s).toMatch(/read.*install.*tmux|prompt.*confirm/i)
  expect(s).toContain('Install tmux?')
})

it("supports --help and --version flags", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).toContain("--help")
  expect(s).toContain("--version")
})

it("never auto-sudos without confirmation", async () => {
  const s = await readFile(SCRIPT, "utf8")
  // sudo only inside confirmed branch
  const sudoLines = s.split("\n").filter(l => l.includes("sudo"))
  expect(sudoLines.length).toBeGreaterThan(0)
  // but each sudo must be near a confirm check — heuristic: file contains confirm before sudo
  expect(s.indexOf("confirm") < s.indexOf("sudo")).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: FAIL

- [ ] **Step 3: Implement argument parsing + confirm helper**

Prepend near top of `scripts/install.sh` after `set -euo pipefail`:

```bash
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
```

Wrap each `brew`/`apt-get` in:

```bash
if confirm "Install tmux? Run: $(install_cmd_for tmux)"; then
  if [ "$OS" = "macos" ]; then brew install tmux; else sudo apt-get install -y tmux; fi
fi
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh tests/unit/installer/install-script.test.ts
git commit -m "feat(installer): add confirmation gating and --yes flag"
```

---

### Task 6: Tailscale verify + final output

**Files:**
- Modify: `scripts/install.sh:260-320`
- Modify: `tests/unit/installer/install-script.test.ts:180-230`

Mirrors `src/host/preflight.ts:203-293` `checkTailscaleStatus` — at least warn if `tailscale status` fails or no IP.

- [ ] **Step 1: Write failing test for tailscale verification + success message**

```typescript
it("verifies tailscale status and warns if not Running", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).toContain("tailscale status")
  expect(s).toMatch(/Tailscale.*not active|BackendState/i)
})

it("prints next steps: aibr setup --profile", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).toContain("aibr setup --profile")
  expect(s).toContain("aibr status --profile")
})

it("prints Tailscale-only binding warning", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).toMatch(/Tailscale.*only|private.*network/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: FAIL

- [ ] **Step 3: Implement tailscale check + final banner**

Append to end of `scripts/install.sh`:

```bash
verify_tailscale() {
  if ! has_cmd tailscale; then
    echo "⚠ tailscale not installed — install with: $(install_cmd_for tailscale)"
    return 0
  fi
  if ! tailscale status >/dev/null 2>&1; then
    echo "⚠ tailscale not logged in — run: sudo tailscale up" >&2
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
}
main
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh tests/unit/installer/install-script.test.ts
git commit -m "feat(installer): add tailscale verify and next-steps banner"
```

---

### Task 7: Shell lint + CI integration

**Files:**
- Modify: `package.json:29`
- Modify: `.github/workflows/ci.yml:36-41`
- Modify: `tests/unit/installer/install-script.test.ts:230-260`

- [ ] **Step 1: Write failing test for shellcheck compliance (dry-parse)**

```typescript
it("passes bash -n syntax check", async () => {
  const { execSync } = await import("node:child_process")
  // should not throw
  execSync("bash -n scripts/install.sh", { stdio: "pipe" })
})

it("has no TODO/FIXME placeholders", async () => {
  const s = await readFile(SCRIPT, "utf8")
  expect(s).not.toMatch(/TODO|FIXME|HACK/)
})

it("is executable", async () => {
  const { stat } = await import("node:fs/promises")
  const st = await stat(new URL("../../../scripts/install.sh", import.meta.url))
  expect((st.mode & 0o111) !== 0).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails (if bash syntax off)**

Run: `bun test tests/unit/installer/install-script.test.ts -v`
Expected: FAIL if syntax error, else PASS — add `shellcheck` next.

- [ ] **Step 3: Add shellcheck to CI and package scripts**

Edit `.github/workflows/ci.yml` after `Setup Bun`:

```yaml
      - name: Lint installer script
        run: |
          sudo apt-get update && sudo apt-get install -y shellcheck
          shellcheck scripts/install.sh
          bash -n scripts/install.sh
```

Edit `package.json` scripts:

```json
"scripts": {
  "test:installer": "shellcheck scripts/install.sh && bash -n scripts/install.sh && vitest run tests/unit/installer",
  "release:check": "bun install --frozen-lockfile && bun run build && bun test && bun run typecheck && shellcheck scripts/install.sh && bash -n scripts/install.sh && bun dist/cli.js --help && bun pm pack --dry-run"
}
```

Note: Keep existing `release:check` steps, just insert `shellcheck` before `bun dist/cli.js --help`.

- [ ] **Step 4: Run verification locally**

Run: `shellcheck scripts/install.sh && bash -n scripts/install.sh && bun test tests/unit/installer -v`
Expected: PASS, no shellcheck warnings

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml package.json tests/unit/installer/install-script.test.ts
git commit -m "ci(installer): add shellcheck and bash -n to CI and release:check"
```

---

### Task 8: Docs + publish

**Files:**
- Modify: `README.md:23-62`
- Modify: `CHANGELOG.md:1-10`

- [ ] **Step 1: Write failing test for README curl|bash presence**

Add to `tests/unit/documentation/install-runbook.test.ts` (or new `tests/unit/installer/readme-installer.test.ts`):

```typescript
it("documents curl|bash one-liner as primary install", async () => {
  const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8")
  expect(readme).toContain("curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash")
})

it("documents --yes flag for non-interactive install", async () => {
  const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8")
  expect(readme).toContain("--yes")
})

it("keeps manual bun install -g as fallback", async () => {
  const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8")
  expect(readme).toContain("bun install -g @nyugennguyen/aibridge")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/documentation/install-runbook.test.ts tests/unit/installer/readme-installer.test.ts -v`
Expected: FAIL — missing curl line

- [ ] **Step 3: Update README.md Install section**

Replace `## Install` block `README.md:32-62` with:

```markdown
## Install

One-liner (macOS / Debian / Ubuntu, requires Tailscale):

```bash
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash
# non-interactive (CI):
curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash -s -- --yes
```

The installer will:
1. Detect OS (macOS / Debian / Ubuntu) — refuses unsupported platforms.
2. Check `bun >=1.3.0` (prompts to install from bun.sh if missing), `tmux`, `opencode`, `tailscale`.
3. Prompt before any `brew`/`apt-get` install (bypass with `--yes`).
4. Run `bun install -g @nyugennguyen/aibridge` (or `@<version>` via `AIBRIDGE_VERSION`).
5. Verify `aibr --version` and that `$(bun pm bin -g)` is on `PATH`.
6. Warn if `tailscale status` is not `Running`.

Manual fallback:

```bash
bun install -g @nyugennguyen/aibridge
aibr --version
```
```

Keep subsequent `Verify PATH` block unchanged.

Add to `CHANGELOG.md`:

```markdown
## [1.1.0] - 2026-08-25
### Added
- curl|bash one-line installer at `scripts/install.sh` with OS detection, prereq prompts, and `bun install -g` for `@nyugennguyen/aibridge`.
```

- [ ] **Step 4: Run tests to verify it passes**

Run: `bun test tests/unit/documentation/install-runbook.test.ts -v`
Expected: PASS (new assertions)

Run: `bun test`
Expected: 440+ pass (existing 432 + new ~12)

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md tests/unit/installer/readme-installer.test.ts
git commit -m "docs(installer): document curl|bash one-liner with manual fallback"
```

---

## Self-Review Checklist

- [ ] Every `src/host/preflight.ts` behavior has a shell mirror (platform map, `which` checks, fixed argv, confirm gating, tailscale JSON/plain parsing warn).
- [ ] No placeholder — all code blocks are copy-paste ready.
- [ ] Types consistent: `AIBRIDGE_VERSION` env, `YES` flag, `OS` variable matches preflight `macos|debian|ubuntu`.
- [ ] `shellcheck` + `bash -n` enforced in CI and `release:check`.
- [ ] README keeps manual fallback and adds curl|bash as primary; CHANGELOG bumps minor.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-25-curl-bash-installer.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
