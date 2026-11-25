/**
 * scripts/smoke/two-profile.ts — two profiles on one machine: init → pair → ping.
 *
 * The closest thing to "a new user installs AIBridge for the first time" that
 * CI can run (Docs/implementation-plans/installation-ux-review.md §5):
 *
 *   1. `aibr init` a Claude worker ("smoke-w") as a new network; it prints a
 *      pairing code.
 *   2. Run its bridge (`aibr serve`).
 *   3. `aibr init` a second node ("smoke-o", role both) that joins with the code.
 *   4. Run its bridge.
 *   5. `aibr ping smoke-w` from smoke-o: a signed no-op job, accepted and
 *      completed by smoke-w, whose /report callback must arrive back at smoke-o.
 *   6. `aibr doctor` on smoke-o must pass; `aibr logs` on smoke-w must show the
 *      /trigger.
 *
 * Nothing here touches the real machine: HOME is a temporary directory, the
 * bridges bind 127.0.0.1 on free ports, and `tailscale`, `claude` and `tmux`
 * are stubs on PATH (the stub `tailscale status --json` reports 127.0.0.1 as
 * this node's tailnet address). No user service is installed (`--no-start`);
 * the bridges run as child processes of this script. No production code knows
 * it is being tested.
 *
 * Usage: bun scripts/smoke/two-profile.ts   (exit 0 = pass)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const CLI = join(ROOT, "src", "cli.ts")
const work = mkdtempSync(join(tmpdir(), "aibr-smoke-"))
const home = join(work, "home")
const bin = join(work, "bin")
const children: ChildProcess[] = []

function stub(name: string, script: string): void {
  const path = join(bin, name)
  writeFileSync(path, `#!/bin/sh\n${script}\n`)
  chmodSync(path, 0o755)
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

const env: Record<string, string> = {
  PATH: `${bin}:${process.env.PATH ?? ""}`,
  HOME: home,
  USER: process.env.USER ?? "smoke",
  LANG: "C",
}

function aibr(args: readonly string[]): { code: number; out: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 120_000 })
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

function step(title: string): void {
  process.stdout.write(`\n── ${title}\n`)
}

function fail(message: string, output?: string): never {
  process.stdout.write(`\nSMOKE FAILED: ${message}\n${output !== undefined ? `${output}\n` : ""}`)
  cleanup()
  process.exit(1)
}

function expectOk(label: string, result: { code: number; out: string }): string {
  process.stdout.write(result.out)
  if (result.code !== 0) fail(`${label} exited ${result.code}`)
  return result.out
}

function serve(profile: string): void {
  const child = spawn(process.execPath, [CLI, "serve", "--profile", profile], { env, stdio: ["ignore", "inherit", "inherit"] })
  children.push(child)
}

async function waitHealthy(port: number): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  fail(`bridge on port ${port} did not answer /health within 30s`)
}

function cleanup(): void {
  for (const child of children) child.kill("SIGTERM")
  if (process.env.AIBR_SMOKE_KEEP !== "1") rmSync(work, { recursive: true, force: true })
}

async function main(): Promise<void> {
  mkdirSync(home, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const projectW = join(work, "projects", "app-w")
  const projectO = join(work, "projects", "app-o")
  mkdirSync(projectW, { recursive: true })
  mkdirSync(projectO, { recursive: true })

  // The tailnet, Claude Code and tmux, as far as this machine can tell.
  stub(
    "tailscale",
    `if [ "$1" = "status" ]; then echo '{"BackendState":"Running","Self":{"TailscaleIPs":["127.0.0.1"],"Online":true},"Peer":{}}'; fi\nexit 0`,
  )
  stub("claude", `echo "2.1.0 (Claude Code)"\nexit 0`)
  stub("tmux", `[ "$1" = "has-session" ] && exit 1\nexit 0`)

  const portW = await freePort()
  const portO = await freePort()

  step("init smoke-w (worker, new network)")
  const initW = expectOk(
    "init smoke-w",
    aibr(["init", "--profile", "smoke-w", "--role", "worker", "--runtime", "claude", "--project", projectW, "--port", String(portW), "--new", "--no-start"]),
  )
  const code = /aibr enroll join (\S+)/.exec(initW)?.[1]
  if (code === undefined) fail("init smoke-w printed no pairing code", initW)

  step("serve smoke-w")
  serve("smoke-w")
  await waitHealthy(portW)

  step("init smoke-o (both, joins with the code)")
  const initO = expectOk(
    "init smoke-o",
    aibr(["init", "--profile", "smoke-o", "--role", "both", "--runtime", "claude", "--project", projectO, "--port", String(portO), "--join", code, "--no-start"]),
  )
  if (!initO.includes("Paired with smoke-w")) fail("init smoke-o did not pair with smoke-w", initO)

  step("serve smoke-o")
  serve("smoke-o")
  await waitHealthy(portO)

  step("ping smoke-w from smoke-o")
  const ping = expectOk("ping", aibr(["ping", "smoke-w", "--profile", "smoke-o"]))
  if (!ping.includes("callback: delivered")) fail("the ping's /report callback was not delivered back to smoke-o", ping)

  step("doctor smoke-o")
  expectOk("doctor smoke-o", aibr(["doctor", "--profile", "smoke-o"]))

  step("logs smoke-w")
  const logs = expectOk("logs smoke-w", aibr(["logs", "--profile", "smoke-w", "-n", "50"]))
  if (!/POST \/trigger 202/.test(logs)) fail("smoke-w's log has no POST /trigger 202 line", logs)

  step("status smoke-w")
  const status = aibr(["status", "--profile", "smoke-w"])
  process.stdout.write(status.out)
  if (status.code !== 0 || !status.out.includes("healthy")) fail("status smoke-w is not healthy", status.out)

  cleanup()
  process.stdout.write("\nSMOKE PASSED: init → pair → ping → doctor across two profiles\n")
}

process.on("SIGINT", () => {
  cleanup()
  process.exit(130)
})

main().catch((error: unknown) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)))
