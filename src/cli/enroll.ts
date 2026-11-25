/**
 * `aibr enroll issue|join|list|revoke` — pairing two nodes without copying a
 * bearer token by hand (Phase 3, ADR 0012, Docs/guides/pairing.md).
 *
 * Registered in src/cli.ts as an own-argv command (like `mcp` / `plugin`).
 * Every subcommand works on a profile's files directly; none needs a running
 * local bridge (`join` in particular runs on orchestrators, which have none).
 * The bearer token received by `join` is written 0600 and never printed.
 */
import { userInfo } from "node:os"
import { bridgeConfigSchema } from "../config/schemas.js"
import type { BridgeConfig } from "../config/types.js"
import { resolveProfilePaths, validateProfileName, type ProfilePaths } from "../host/paths.js"
import { readConfig } from "../host/profile-store.js"
import { FilePairingCodeStore } from "../pairing/code-store.js"
import { loadNodeKey } from "../pairing/files.js"
import { parseTtl } from "../pairing/pairing-code.js"
import { FilePeerStore } from "../pairing/peer-store.js"
import {
  PairingError,
  applyJoinToProfile,
  issuePairingCode,
  joinWithPairingCode,
  revokePeer,
  type FetchLike,
} from "../pairing/service.js"

export interface EnrollCliDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly fetch: FetchLike
  readonly now: () => number
  readonly write: (text: string) => void
}

export function defaultEnrollDeps(): EnrollCliDeps {
  return {
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    write: (text) => {
      process.stdout.write(text)
    },
  }
}

export const ENROLL_HELP = [
  "aibr enroll — pair nodes with a one-time code (no manual token copying)",
  "",
  "Usage:",
  "  aibr enroll issue  [--profile <p>] [--capabilities a,b] [--ttl 10m]   on the WORKER",
  "  aibr enroll join   <code> [--profile <p>]                            on the ORCHESTRATOR",
  "  aibr enroll list   [--profile <p>]",
  "  aibr enroll revoke <agent_id> [--profile <p>]",
  "",
  "issue prints a one-time code (default TTL 10m, max 24h) that grants the joining",
  "node the listed capabilities. join redeems it over the tailnet: both nodes pin",
  "each other's ed25519 key, the worker adds security.allowed_sources[], the",
  "orchestrator adds agents[] and stores the worker's bearer token (0600, never",
  "printed). One code pairs one node; an expired or used code is refused.",
  "revoke removes the peer's pinned key (effective immediately for signed requests)",
  "and its agents[]/allowed_sources[] entries (restart the bridge to drop those).",
  "--profile defaults to AIBR_PROFILE, then \"default\".",
  "",
].join("\n")

interface ParsedEnrollArgs {
  readonly sub: string | undefined
  readonly positional: readonly string[]
  readonly flags: ReadonlyMap<string, string>
  readonly error?: string
}

const VALUE_FLAGS = new Set(["--profile", "-p", "--capabilities", "--ttl"])

export function parseEnrollArgs(argv: readonly string[]): ParsedEnrollArgs {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const eq = arg.indexOf("=")
    const name = arg.startsWith("-") && eq > 0 ? arg.slice(0, eq) : arg
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 && arg.startsWith("-") ? arg.slice(eq + 1) : argv[++i]
      if (value === undefined || value === "") return { sub: undefined, positional, flags, error: `${name} needs a value` }
      flags.set(name === "-p" ? "--profile" : name, value)
    } else if (arg.startsWith("-")) {
      return { sub: undefined, positional, flags, error: `unknown flag ${arg}` }
    } else {
      positional.push(arg)
    }
  }
  return { sub: positional[0], positional: positional.slice(1), flags }
}

export async function runEnrollCommand(argv: readonly string[], deps: EnrollCliDeps = defaultEnrollDeps()): Promise<number> {
  const args = parseEnrollArgs(argv)
  if (args.error !== undefined) {
    deps.write(`Error: ${args.error}\n`)
    return 64
  }
  let profile: string
  try {
    profile = validateProfileName(args.flags.get("--profile") ?? deps.env.AIBR_PROFILE ?? "default")
  } catch (error) {
    deps.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 64
  }
  const paths = resolveProfilePaths(profile, deps.env)
  const configPath = `${paths.configDir}/config.json`

  try {
    switch (args.sub) {
      case "issue":
        return await issue(args, paths, configPath, deps)
      case "join":
        return await join(args, paths, configPath, deps)
      case "list":
        return await list(paths, configPath, deps)
      case "revoke":
        return await revoke(args, paths, configPath, deps)
      default:
        deps.write(`Error: unknown enroll subcommand "${args.sub ?? ""}" (expected issue, join, list or revoke)\n\n${ENROLL_HELP}`)
        return 64
    }
  } catch (error) {
    deps.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    return error instanceof PairingError ? 1 : 70
  }
}

async function loadProfileConfig(configPath: string, profileLabel: string): Promise<BridgeConfig> {
  const raw = await readConfig(configPath)
  if (raw === null) {
    throw new PairingError(`Profile "${profileLabel}" has no config at ${configPath}. Run \`aibr setup --profile ${profileLabel}\` first.`, "no_profile")
  }
  const parsed = bridgeConfigSchema.safeParse(raw)
  if (!parsed.success) throw new PairingError(`${configPath} is not a valid AIBridge config: ${parsed.error.issues[0]?.message ?? "invalid"}`, "invalid_config")
  return parsed.data
}

function profileOf(paths: ProfilePaths): string {
  return paths.configDir.split("/").pop() ?? "default"
}

async function issue(args: ParsedEnrollArgs, paths: ProfilePaths, configPath: string, deps: EnrollCliDeps): Promise<number> {
  const config = await loadProfileConfig(configPath, profileOf(paths))
  const ttlRaw = args.flags.get("--ttl") ?? "10m"
  const ttlMs = parseTtl(ttlRaw)
  if (ttlMs === null) throw new PairingError(`--ttl "${ttlRaw}" is not a duration (e.g. 10m, 1h, 90s).`, "invalid_ttl")
  const capabilities = args.flags.get("--capabilities")?.split(",")
  const issued = await issuePairingCode({
    config,
    stateDir: paths.stateDir,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ttlMs,
    issuedBy: `${safeUser()}@aibr-cli`,
    now: deps.now,
  })
  const minutes = Math.max(1, Math.round((issued.expiresAt - deps.now()) / 60_000))
  deps.write(
    [
      `Pairing code for ${config.agent_id} (${issued.url}), grants [${issued.capabilities.join(", ")}], valid ${minutes} min, one use:`,
      "",
      `  ${issued.code}`,
      "",
      `On the orchestrator run:  aibr enroll join ${issued.code}`,
      `Worker key: ${issued.keyId}. The bridge must be running here (aibr start) for the join to succeed.`,
      config.security.request_signing === "required"
        ? ""
        : `Note: security.request_signing is "${config.security.request_signing ?? "off"}"; set it to "required" once your peers are paired.`,
      "",
    ].join("\n"),
  )
  return 0
}

async function join(args: ParsedEnrollArgs, paths: ProfilePaths, configPath: string, deps: EnrollCliDeps): Promise<number> {
  const code = args.positional[0]
  if (code === undefined) throw new PairingError("Usage: aibr enroll join <code> [--profile <p>]", "usage")
  const config = await loadProfileConfig(configPath, profileOf(paths))
  const runsBridge = config.role !== "orchestrator"
  const joined = await joinWithPairingCode({
    code,
    agentId: config.agent_id,
    stateDir: paths.stateDir,
    displayName: config.agent_id,
    ...(runsBridge ? { callbackUrl: config.bridge.public_url } : {}),
    fetch: deps.fetch,
    now: deps.now,
  })
  const applied = await applyJoinToProfile({ paths, configPath, join: joined })
  deps.write(
    [
      `Paired with ${joined.agent.id} at ${joined.agent.url}; capabilities [${joined.agent.capabilities.join(", ")}].`,
      `Pinned worker key ${joined.workerKeyId}; this node signs as ${config.agent_id} with key ${joined.ownKeyId}.`,
      joined.bearerToken === null
        ? "The worker runs without a bearer token; requests are authenticated by signature."
        : `Stored the worker's bearer token in ${paths.secretsDir}/peers/${joined.agent.id}.bearer_token (0600, not shown).`,
      `Wrote agents[] in ${configPath}.`,
      ...applied.notes,
      `Try it: ask Claude Code to dispatch to "${joined.agent.id}", or check with \`aibr enroll list --profile ${profileOf(paths)}\`.`,
      "",
    ].join("\n"),
  )
  return 0
}

async function list(paths: ProfilePaths, configPath: string, deps: EnrollCliDeps): Promise<number> {
  const config = await loadProfileConfig(configPath, profileOf(paths))
  const key = await loadNodeKey(paths.stateDir).catch(() => null)
  const peers = await new FilePeerStore(paths.stateDir).listPeers()
  if (!peers.ok) throw new PairingError(peers.error.message, peers.error.code)
  const now = deps.now()
  const codes = (await new FilePairingCodeStore(paths.stateDir).list()).filter((c) => c.redeemedNodeId === undefined && c.expiresAt > now)
  const lines = [
    `Profile ${profileOf(paths)} (${config.agent_id}); request_signing: ${config.security.request_signing ?? "off"}; node key: ${key?.keyId ?? "none"}`,
  ]
  if (peers.value.length === 0) lines.push("No paired peers.")
  for (const peer of peers.value) {
    const asSource = config.security.allowed_sources.find((s) => s.source_agent_id === peer.agentId)
    const asAgent = config.agents.find((a) => a.id === peer.agentId)
    const roles = [
      asSource ? `may call us [${asSource.capabilities.join(", ")}]` : null,
      asAgent ? `we call it at ${asAgent.url} [${asAgent.capabilities.join(", ")}]` : null,
    ].filter((r) => r !== null)
    lines.push(`  ${peer.agentId}  ${peer.nodeKeyId}  paired ${new Date(peer.pinnedAt).toISOString()}  ${roles.join("; ") || "(not in config)"}`)
  }
  if (codes.length > 0) {
    lines.push(`${codes.length} unused pairing code(s) outstanding:`)
    for (const c of codes) lines.push(`  ${c.enrollmentId} [${c.capabilities.join(", ")}] expires ${new Date(c.expiresAt).toISOString()}`)
  }
  deps.write(lines.join("\n") + "\n")
  return 0
}

async function revoke(args: ParsedEnrollArgs, paths: ProfilePaths, configPath: string, deps: EnrollCliDeps): Promise<number> {
  const agentId = args.positional[0]
  if (agentId === undefined) throw new PairingError("Usage: aibr enroll revoke <agent_id> [--profile <p>]", "usage")
  const outcome = await revokePeer({ paths, configPath, agentId, by: `${safeUser()}@aibr-cli`, now: deps.now })
  if (!outcome.pinRemoved && !outcome.configChanged) {
    deps.write(`Nothing to revoke: "${agentId}" is neither paired nor in this profile's config.\n`)
    return 1
  }
  deps.write(
    [
      `Revoked ${agentId}: ${outcome.pinRemoved ? "pinned key removed (signed requests are refused now)" : "no pinned key"}` +
        `${outcome.configChanged ? "; removed from agents[]/allowed_sources[]" : ""}.`,
      outcome.configChanged ? "Restart the bridge (aibr start) so bearer-only requests from it are refused too." : "",
      "",
    ].join("\n"),
  )
  return 0
}

function safeUser(): string {
  try {
    return userInfo().username || "operator"
  } catch {
    return "operator"
  }
}
