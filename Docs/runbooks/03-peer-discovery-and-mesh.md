# Operational Guide 03: Peer Discovery & Mesh Networking

> **Topic:** Tailscale peer discovery, identity boundaries, dual-enrolment, and cross-host authentication.  
> **Source of Truth:** `src/host/tailscale-discovery.ts`, `src/cli/discover.ts`, `src/server/routes/health.ts`.

---

## 1. Tailscale Peer Discovery Overview

AIBridge leverages private Tailscale networks (`100.64.0.0/10`) to connect distributed agent nodes. The discovery subsystem provides dynamic visibility into available peers without central brokers or open ports to the Internet.

### 1.1 Inviolable Security Boundary
> **Reachability is not authentication. It never confers trust.**
* **Local Daemon Source:** Discovery enumerates the tailnet via the local `tailscale status --json` daemon.
* **Non-Authoritative:** A peer replying to `/health` demonstrates network reachability only. It does not establish identity, group membership, or permissions.
* **Zero Credential Disclosure:** Node enrollment keys (`tskey-`) and bearer tokens are never printed or accepted as proofs of identity.

---

## 2. Querying Peers (`aibr discover`)

`aibr discover` is a **read-only, state-free command**. It writes nothing to disk, starts no services, and exits `0` on empty tailnets.

### 2.1 Human-Readable Discovery
```bash
aibr discover --profile dev-main
```

Output details:
* Lists all active Tailscale peers.
* Displays daemon online state, HTTP reachability on port 8787, agent ID, and capabilities.
* Indicates whether each peer is enrolled in the local profile.

### 2.2 Machine-Readable Discovery (`--json`)
For automation, scripts, and Herdr plugin consumption, `--json` emits a single byte-stable JSON document to stdout:

```bash
aibr discover --profile dev-main --json
```

```json
{
  "schemaVersion": 1,
  "ok": true,
  "enrolledSource": "dev-main",
  "peersFound": 2,
  "reachableCount": 1,
  "enrolledCount": 1,
  "peers": [
    {
      "ip": "100.64.0.9",
      "hostname": "test-vps",
      "os": "linux",
      "online": true,
      "bridgeUrl": "http://100.64.0.9:8787",
      "reachable": true,
      "agentId": "test-vps",
      "capabilities": ["code", "review", "test"],
      "opencodeReachable": true,
      "enrolled": true
    }
  ],
  "notice": "Reachability is not authentication..."
}
```

---

## 3. The Dual-Enrolment Rule

When configuring distributed agents, an external node must be authorized in **two distinct halves** of the configuration:

```
                  Peer Configuration
                 ┌──────────────────┐
                 │  Target Peer     │
                 │  ID: test-vps    │
                 └────────┬─────────┘
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
  [agents[]]                     [security.allowed_sources[]]
  • Outbound routing             • Inbound authorization
  • Who THIS node can call       • Who can trigger THIS node
  • Defines target bridgeUrl     • Enforces capability bounds
```

### 3.1 Failure Mode: Asymmetric Enrolment
* If peer is in `agents[]` but not in `allowed_sources[]`: The local host can call the peer, but incoming requests or callbacks from that peer will fail with `HTTP 403 Forbidden`.
* `aibr setup` Step 4 enforces dual-enrolment automatically from a single user selection to eliminate this drift.

---

## 4. The Discovery Endpoint (`GET /health`)

The `/health` endpoint is **intentionally unauthenticated** to allow peer discovery across the tailnet before tokens are exchanged.

```bash
curl -s http://100.64.0.9:8787/health | jq .
```

### 4.1 Response Envelope
```json
{
  "ok": true,
  "opencode": true,
  "agent_id": "test-vps",
  "capabilities": ["code", "test"]
}
```

* `capabilities`: Extracted exclusively from the flattened, deduplicated union of `security.allowed_sources[].capabilities`.
* **Topology Privacy:** `/health` deliberately conceals caller IDs, project paths, plan review requirements, and the `agents[]` registry.

---

## 5. Cross-Host Authentication Verification

To safely test that two machines share the identical bearer token without logging secrets to bash history or triggering task execution:

```bash
read -rs TOK; printf '\n'
curl -i -X POST http://<peer-ip>:8787/trigger \
  -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{}'
unset TOK
```

### 5.1 Result Diagnosis
* **`HTTP 400 Bad Request`:** **Success.** Authentication passed; the server rejected only the empty payload body.
* **`HTTP 401 Unauthorized`:** **Failure.** The token is missing, malformed, or differs from the peer's `bearer_token` file.
