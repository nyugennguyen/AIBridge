import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const ROOT = new URL("../../../", import.meta.url).pathname
const SCRIPT = `${ROOT}scripts/install.sh`
const script = readFileSync(SCRIPT, "utf8")
const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as { version: string }

/** Source the script without running main, then run `body` (stubs go first). */
function sourced(body: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", `source "${SCRIPT}"\n${body}`], {
    encoding: "utf8",
    env: { ...process.env, AIBRIDGE_INSTALL_NO_MAIN: "1", ...env },
    timeout: 15_000,
  })
}

describe("install.sh — /dev/tty prompts (C1)", () => {
  it("never reads from bare stdin", () => {
    const reads = script.split("\n").filter((l) => /\bread\s+-r\b/.test(l))
    expect(reads.length).toBeGreaterThan(0)
    for (const l of reads) expect(l).toContain("< /dev/tty")
  })

  it("the bun prompt goes through confirm so --yes applies", () => {
    expect(script).toContain('confirm "Install bun now?"')
    expect(script).not.toMatch(/printf "Install bun now/)
  })

  it("aborts with guidance when there is no tty and no --yes", () => {
    // detached => new session => no controlling terminal => /dev/tty unusable
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      input: "",
      timeout: 15_000,
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("--yes")
    expect(r.stderr).toContain("download the script")
  })

  it("does not hang when piped through stdin (curl | bash style)", () => {
    const r = spawnSync("bash", [], {
      encoding: "utf8",
      input: script,
      env: { ...process.env, AIBRIDGE_INSTALL_NO_MAIN: "1" },
      timeout: 15_000,
    })
    expect(r.status).toBe(0)
    const help = spawnSync("bash", ["-s", "--", "--help"], { encoding: "utf8", input: script, timeout: 15_000 })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain("--role")
  })
})

describe("install.sh — role and runtime prereqs", () => {
  const stub = (present: string[]) =>
    `has_cmd() { case " ${present.join(" ")} " in *" $1 "*) return 0;; *) return 1;; esac; }\n`

  it("worker needs tailscale, tmux and opencode (auto, nothing installed)", () => {
    const r = sourced(`${stub([])}ROLE=worker RUNTIME=auto; required_tools`)
    expect(r.stdout.trim()).toBe("tailscale tmux opencode")
  })

  it("auto prefers opencode when both runtimes exist, claude when only it exists", () => {
    expect(sourced(`${stub(["opencode", "claude"])}ROLE=worker; required_tools`).stdout.trim()).toBe(
      "tailscale tmux opencode",
    )
    expect(sourced(`${stub(["claude"])}ROLE=worker; required_tools`).stdout.trim()).toBe("tailscale tmux claude")
  })

  it("--runtime forces the choice", () => {
    expect(sourced(`${stub(["opencode"])}ROLE=worker RUNTIME=claude; required_tools`).stdout.trim()).toBe(
      "tailscale tmux claude",
    )
  })

  it("orchestrator needs tailscale and claude only (no opencode, no tmux)", () => {
    const out = sourced(`${stub([])}ROLE=orchestrator; required_tools`).stdout.trim()
    expect(out).toBe("tailscale claude")
  })

  it("both needs tmux, the worker runtime and claude", () => {
    expect(sourced(`${stub([])}ROLE=both; required_tools`).stdout.trim()).toBe("tailscale tmux opencode claude")
  })

  it("reports a missing runtime in the final summary with the install hint", () => {
    const r = sourced(`${stub(["tailscale", "tmux"])}ROLE=orchestrator; check_prereqs >/dev/null; print_summary`)
    expect(r.stdout).toContain("Still missing (role: orchestrator)")
    expect(r.stdout).toContain("claude")
    expect(r.stdout).toContain("claude.ai/install.sh")
    const w = sourced(`${stub(["tailscale", "tmux"])}ROLE=worker; check_prereqs >/dev/null; print_summary`)
    expect(w.stdout).toContain("bun install -g opencode-ai")
  })

  it("rejects bad --role / --runtime values", () => {
    expect(spawnSync("bash", [SCRIPT, "--role", "nope"], { encoding: "utf8" }).status).toBe(1)
    expect(spawnSync("bash", [SCRIPT, "--runtime", "nope"], { encoding: "utf8" }).status).toBe(1)
  })
})

describe("install.sh — tailscale install (H2)", () => {
  it("uses the official installer, not the bogus install-from-source", () => {
    expect(script).not.toContain("install-from-source")
    expect(script).toContain("https://tailscale.com/install.sh | sh")
    expect(script).toContain("sudo tailscale up")
  })
  it("actually calls install_missing_prereqs", () => {
    const calls = script.split("\n").filter((l) => /^\s+install_missing_prereqs\s*$/.test(l))
    expect(calls.length).toBe(1)
  })
})

describe("install.sh — version, router text, units", () => {
  it("--version equals package.json version", () => {
    const r = spawnSync("bash", [SCRIPT, "--version"], { encoding: "utf8" })
    expect(r.stdout.trim()).toBe(pkg.version)
  })

  it("prints nothing about the router by default", () => {
    const r = sourced(
      `bun() { :; }; aibr() { :; }; has_cmd() { return 0; }; YES=1; INGRESS=default
       install_aibridge; ROLE=worker; print_summary; print_next_steps`,
    )
    expect(r.status).toBe(0)
    expect(r.stdout.toLowerCase()).not.toContain("router")
    expect(r.stdout.toLowerCase()).not.toContain("ingress")
  })

  it("mentions the router only with --ingress router", () => {
    const r = sourced(
      `bun() { :; }; aibr() { :; }; has_cmd() { [ "$1" != aibr-router ]; }; YES=1; INGRESS=router
       install_aibridge`,
      { HOME: "/nonexistent-home" },
    )
    expect(r.stdout).toContain("aibr-router not found")
  })

  it("--with-units outside a checkout fails clearly (piped script)", () => {
    const r = spawnSync("bash", ["-s", "--", "--with-units", "--yes"], {
      encoding: "utf8",
      input: script,
      timeout: 15_000,
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("needs a repository checkout")
    expect(r.stderr).not.toContain("cannot stat")
  })
})

describe("install.sh — next steps and PATH", () => {
  it("worker next steps list setup, start, status", () => {
    const r = sourced(`ROLE=worker PROFILE=dev; print_next_steps`)
    expect(r.stdout).toContain("aibr setup --profile dev")
    expect(r.stdout).toContain("aibr start --profile dev")
    expect(r.stdout).toContain("aibr status --profile dev")
  })
  it("orchestrator next steps mention setup and the Claude Code plugin, not start", () => {
    const r = sourced(`ROLE=orchestrator; print_next_steps`)
    expect(r.stdout).toContain("aibr setup --profile <name>")
    expect(r.stdout).toContain("Claude Code plugin")
    expect(r.stdout).not.toContain("aibr start")
  })

  it("appends the PATH export to the shell rc idempotently", () => {
    const home = `${ROOT}node_modules/.cache/installer-home-${process.pid}`
    const body = `mkdir -p "${home}"; has_cmd() { return 1; }; bun_bin_dir() { echo /opt/bunbin; }
       YES=1; SHELL=/bin/zsh; ensure_aibr_on_path; ensure_aibr_on_path
       grep -c 'export PATH="/opt/bunbin:' "${home}/.zshrc"; rm -rf "${home}"`
    const r = sourced(body, { HOME: home })
    expect(r.stdout.trim().split("\n").pop()).toBe("1")
  })

  it("warns when treating a non-Debian Linux as Ubuntu", () => {
    expect(script).toContain("treating it as Ubuntu-compatible")
  })
})
