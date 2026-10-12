/**
 * Tailscale peer discovery from the local daemon.
 *
 * Turns `tailscale status --json` into a flat, hostname-sorted list of the
 * other nodes on the tailnet.  Sibling bridges are configured by hand in a
 * config's `agents[]`; this is the counterpart for callers that would rather
 * have the host enumerate its own tailnet than maintain a list that silently
 * rots as machines come and go.
 *
 * Design invariants:
 * - One process call, fixed argv, never a shell string.  The runner is the
 *   same `ProcessRunner` abstraction preflight uses, so nothing here reaches
 *   for a platform global.
 * - This machine is never reported as a peer.  The `Self` node is the only
 *   authority on who we are, so it is matched by every IP and both name forms
 *   it publishes — a peer entry that echoes any of them is dropped rather
 *   than guessed at.
 * - Every failure mode degrades to an empty list (nonzero exit, malformed
 *   JSON, absent `Peer`, a peer with no usable IPv4).  Discovery is advisory:
 *   an empty peer list is a degraded feature, but a throw would take down a
 *   caller that only wanted to *offer* the option.
 * - Offline is only ever an explicit signal — `Online: false` in JSON, the
 *   word "offline" in plain text.  Both source formats mark it the same way
 *   and both omit it for reachable nodes, so silence means reachable in both
 *   paths and the two cannot disagree.
 */

import type { ProcessRunner } from "./types.js"
import { z } from "zod"

// ── Types ──────────────────────────────────────────────────────────────

export interface TailscalePeer {
  /** First IPv4 address from the peer's `TailscaleIPs`. */
  readonly ip: string
  /** `DNSName` with the trailing dot stripped; falls back to `HostName`. */
  readonly hostname: string
  /** Peer OS, lowercased; `null` when the daemon did not report one. */
  readonly os: string | null
  readonly online: boolean
}

// ── Wire schemas ───────────────────────────────────────────────────────

/**
 * Deliberately lax on shape: every field is optional because a peer entry
 * that is missing something is still a peer, and dropping the whole map
 * over one incomplete entry would cost us every discovery on that tailnet.
 * What is missing is handled per peer at projection time instead.
 *
 * `nullish` on `Peer` rather than `optional`: Go serialises an absent map as
 * `null` and an empty one as `{}`, so all three spellings of "no peers"
 * have to parse.
 */
const tailscalePeerSchema = z.object({
  HostName: z.string().optional(),
  DNSName: z.string().optional(),
  TailscaleIPs: z.array(z.string()).optional(),
  OS: z.string().optional(),
  Online: z.boolean().optional(),
})

const tailscaleSelfSchema = z.object({
  BackendState: z.string().optional(),
  DNSName: z.string().optional(),
  HostName: z.string().optional(),
  TailscaleIPs: z.array(z.string()).optional(),
})

const tailscaleStatusSchema = z.object({
  BackendState: z.string().optional(),
  Health: z.array(z.string()).optional(),
  Self: tailscaleSelfSchema.optional(),
  Peer: z.record(z.string(), tailscalePeerSchema).nullish(),
})

type PeerNode = z.infer<typeof tailscalePeerSchema>
type SelfNode = z.infer<typeof tailscaleSelfSchema>

// ── Shared parsing helpers ─────────────────────────────────────────────

/**
 * Loose IPv4 prefix test, mirroring the one in preflight.
 *
 * It is a column-identification heuristic, not address validation: it exists
 * to tell "this token is where an address goes" from "this is a hostname or
 * a status word".  Tightening it to reject `999.999.999.999` would make
 * malformed rows fail differently between the two code paths for no gain —
 * an address we could not reach is reported and then fails at connect time,
 * the same place any other unreachable address ends up.
 */
const IP_RE = /^\d+\.\d+\.\d+\.\d+/

/** Strip the FQDN's trailing dot, and any surrounding whitespace with it. */
function stripTrailingDot(value: string): string {
  return value.trim().replace(/\.$/, "")
}

function optionalName(schemaValue: string | undefined): string | null {
  if (schemaValue === undefined) return null
  const stripped = stripTrailingDot(schemaValue)
  return stripped === "" ? null : stripped
}

/**
 * Lowercase and trim the OS string; blank counts as absent.
 *
 * The daemon reports whatever the peer's kernel calls itself ("linux",
 * "darwin", "Windows"), and older builds have been seen emitting padding.
 * Normalising here means a caller can compare `os === "linux"` without
 * re-deriving that.
 */
function normalizeOs(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const normalized = value.trim().toLowerCase()
  return normalized === "" ? null : normalized
}

/** First entry that looks like an IPv4 address, or `null`. */
function firstIpv4(addresses: readonly string[]): string | null {
  for (const address of addresses) {
    if (IP_RE.test(address)) return address
  }
  return null
}

/**
 * Everything that identifies this node: every IP it publishes, plus both
 * name forms.
 *
 * Matching a peer against the union means a stale or short `HostName` on
 * either side cannot smuggle us back into our own peer list — the daemon is
 * free to publish either name, and neither one is more authoritative than
 * the other, so neither is enough on its own.
 */
function selfIdentifiers(self: SelfNode | undefined): ReadonlySet<string> {
  const identifiers = new Set<string>()
  if (self === undefined) return identifiers

  for (const address of self.TailscaleIPs ?? []) {
    identifiers.add(address)
  }
  const dnsName = optionalName(self.DNSName)
  if (dnsName !== null) identifiers.add(dnsName)
  const hostName = optionalName(self.HostName)
  if (hostName !== null) identifiers.add(hostName)

  return identifiers
}

function isSelf(peer: PeerNode, self: ReadonlySet<string>): boolean {
  if (self.size === 0) return false
  for (const address of peer.TailscaleIPs ?? []) {
    if (self.has(address)) return true
  }
  for (const name of [peer.DNSName, peer.HostName]) {
    const candidate = optionalName(name)
    if (candidate !== null && self.has(candidate)) return true
  }
  return false
}

/**
 * Order by hostname, case-insensitively, with the IP as tie-break.
 *
 * Compared as lowercased UTF-16 code units rather than with `localeCompare`:
 * discovery output feeds diffs and snapshots, and a collation order that
 * moves when the ambient locale changes is not a stable order.
 */
function comparePeers(a: TailscalePeer, b: TailscalePeer): number {
  const left = a.hostname.toLowerCase()
  const right = b.hostname.toLowerCase()
  if (left < right) return -1
  if (left > right) return 1
  if (a.ip < b.ip) return -1
  if (a.ip > b.ip) return 1
  return 0
}

// ── discoverTailscalePeers ─────────────────────────────────────────────

/**
 * Discover the other nodes on this tailnet.
 *
 * Returns `[]` when Tailscale is not running, when the daemon's answer cannot
 * be understood, or when it reports a tailnet with nothing else on it.  An
 * empty result is deliberately not distinguishable from "the daemon told us
 * there are no peers" — callers that need to tell the difference should ask
 * `checkTailscaleStatus`, which does return an error.
 *
 * Prefers `--json`, and falls back to parsing the human-readable listing for
 * a daemon too old to have it.  The two paths agree on peers, hostnames and
 * the offline marker; they differ only in how strictly they can tell us which
 * entry is the machine running this code.
 */
export async function discoverTailscalePeers(
  runner: ProcessRunner,
): Promise<readonly TailscalePeer[]> {
  const result = await runner.exec(["tailscale", "status", "--json"])

  if (result.exitCode !== 0) return []

  // Same sniff preflight uses: a `--json`-capable daemon starts with `{`,
  // anything else is the human-readable listing.
  if (result.stdout.trimStart().startsWith("{")) {
    return parseJsonPeers(result.stdout)
  }
  return parsePlainTextPeers(result.stdout)
}

// ── JSON path ──────────────────────────────────────────────────────────

function parseJsonPeers(stdout: string): readonly TailscalePeer[] {
  let decoded: unknown
  try {
    decoded = JSON.parse(stdout)
  } catch {
    // Untrusted output from a local daemon that may be mid-upgrade.  We
    // catch rather than propagate for the same reason preflight reports
    // instead of throwing: a peer listing is not worth failing a caller.
    return []
  }

  const parsed = tailscaleStatusSchema.safeParse(decoded)
  if (!parsed.success) return []

  const peerMap = parsed.data.Peer
  if (peerMap === undefined || peerMap === null) return []

  const self = selfIdentifiers(parsed.data.Self)

  const peers: TailscalePeer[] = []
  for (const peer of Object.values(peerMap)) {
    if (isSelf(peer, self)) continue
    const projected = projectJsonPeer(peer)
    if (projected !== null) peers.push(projected)
  }

  return peers.sort(comparePeers)
}

/**
 * Project one peer entry, or `null` when it cannot be addressed.
 *
 * "Cannot be addressed" means no IPv4 at all — an IPv6-only entry, or one
 * that forgot its address list.  Bridge URLs in this repo are IPv4 today,
 * so a v6-only peer is a peer we could not dial and would rather not print.
 */
function projectJsonPeer(peer: PeerNode): TailscalePeer | null {
  const ip = firstIpv4(peer.TailscaleIPs ?? [])
  if (ip === null) return null

  const hostname = optionalName(peer.DNSName) ?? optionalName(peer.HostName)
  if (hostname === null) return null

  return {
    ip,
    hostname,
    os: normalizeOs(peer.OS),
    online: peer.Online ?? true,
  }
}

// ── Plain-text fallback ────────────────────────────────────────────────

/**
 * Row shape of the human-readable `tailscale status` listing:
 *
 *   100.64.0.1  my-machine user@  linux   active; direct 10.0.0.1:41641
 *
 * Machine rows are identified by the `user@` owner token, exactly as
 * `checkTailscaleStatus` does — the `Key: value` trailer lines are skipped
 * because they never carry one.
 */
function parsePlainTextPeers(stdout: string): readonly TailscalePeer[] {
  const machines: PlainTextRow[] = []

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue

    const parts = trimmed.split(/\s+/)
    const hasUserField = parts.some((p) => p.includes("@"))
    if (!hasUserField || parts.length < 3) continue

    const candidateIp = parts[0] ?? ""
    // A machine row whose address column is not an address is malformed.
    // preflight can say so through its `error` field; discovery has no error
    // channel, so the row is dropped and the rest of the listing still
    // stands.
    if (!IP_RE.test(candidateIp)) continue

    machines.push({
      ip: candidateIp,
      hostname: parts[1] ?? "",
      os: parts[3] ?? null,
      // Columns 4+ are the status phrase: "active; direct …", "idle; …",
      // or "offline".
      status: parts.slice(4).join(" "),
    })
  }

  // The listing has no self marker, so this borrows preflight's assumption:
  // the daemon prints the local node first and the peers after it.  It is
  // the only signal available in this format, and it is why the JSON path is
  // the one to prefer — there, `Self` names us unambiguously.
  return machines
    .slice(1)
    .map((row) => ({
      ip: row.ip,
      hostname: row.hostname,
      os: normalizeOs(row.os),
      online: !/offline/i.test(row.status),
    }))
    .sort(comparePeers)
}

interface PlainTextRow {
  readonly ip: string
  readonly hostname: string
  readonly os: string | null
  readonly status: string
}
