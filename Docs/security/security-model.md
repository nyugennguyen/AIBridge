# Security Model & Architecture

> **Status:** Current  
> **Applies to:** AIBridge 3.0.0  
> **Owner:** Maintainers  

AIBridge implements a layered, fail-closed security architecture designed for coordinating untrusted and semi-autonomous AI agents across private Tailscale networks.

---

## 1. Core Security Invariants

AIBridge enforces eight inviolable security invariants across all execution modes:

1. **Tailnet Network Boundary:** Ingress endpoints (`bridge.host`:`bridge.port`, default 8787) bind exclusively to provisioned Tailscale IPv4 addresses (`100.64.0.0/10`). Layer-1 bind preflight inspects OS network interfaces and terminates immediately with exit code 78 (`EX_CONFIG`) if wildcard (`0.0.0.0`, `::`) or public interfaces are targeted.
2. **Loopback Execution Boundary:** The local language-model agent runtime (`opencode serve`) is bound strictly to `127.0.0.1:4096`. It is never accessible from the physical LAN or Tailscale mesh.
3. **Two-Tier Polyglot Validation:** The native Rust ingress router (`aibr-router`) serves strictly as a structural gate and admission queue. The execution worker daemon (`aibr worker`) independently parses and enforces all semantic authorization checks, project allowlists, and plan approvals.
4. **Commit Before 202 (`SF-08`):** An `HTTP 202 Accepted` response is emitted **only** after the admitted request has been committed to disk in SQLite write-ahead logging (`ingress_outbox.db`, `synchronous=FULL`). No in-memory buffering or lossy drop-paths exist.
5. **The Immutable Core Safety Floor:** The kernel enforces non-overridable constraints via `assertCharterDoesNotRelaxCore`. Dynamic charters, runtime policies, or agent prompts cannot relax project allowlists, input fencing, budget ceilings, or kernel authority.
6. **Constant-Time Bearer Verification:** Bearer token authentication compares tokens using constant-time comparison (`subtle.timingSafeEqual` in TypeScript, `subtle::ConstantTimeEq` in Rust) to eliminate timing side-channel attacks.
7. **Automated Secret Redaction:** Prompts, transcripts, raw memory, bearer credentials, and private paths are automatically scrubbed by default across all logs, telemetry, and diagnostic bundles (`aibr bundle`).
8. **Project Filesystem Containment:** Target paths must match canonical entries in `config.projects`. The runtime resolves directory paths at startup via `realpath` and rejects traversal outside designated roots.

---

## 2. Trust Boundaries & Assumptions

```
                    ┌────────────────────────────────────────────────┐
                    │       Tailnet Private Mesh (WireGuard)         │
                    └───────────────────────┬────────────────────────┘
                                            │
                       HTTP/JSON POST /trigger (Bearer Auth)
                                            ▼
                    ┌────────────────────────────────────────────────┐
                    │        Tier 1: Ingress Router (Rust)           │
                    │        - Structural parsing & limits           │
                    │        - Constant-time Bearer auth             │
                    │        - Commit to SQLite outbox               │
                    └───────────────────────┬────────────────────────┘
                                            │ Commit WAL
                                            ▼
                    ┌────────────────────────────────────────────────┐
                    │        Durable Ingress Queue (SQLite)          │
                    └───────────────────────┬────────────────────────┘
                                            │ Claim Lease (30s)
                                            ▼
                    ┌────────────────────────────────────────────────┐
                    │        Tier 2: Ingress Worker (TypeScript)     │
                    │        - Semantic authorization                │
                    │        - Project path containment              │
                    │        - Plan approval verification            │
                    │        - Secret redaction                      │
                    └───────────────────────┬────────────────────────┘
                                            │ Loopback only (127.0.0.1:4096)
                                            ▼
                    ┌────────────────────────────────────────────────┐
                    │        Local Agent Runtime (OpenCode)          │
                    └────────────────────────────────────────────────┘
```

### Reachability vs. Authentication
> **Reachability is not authentication. Reachability confers zero trust.**

A Tailscale network connection proves that packets can route to a given IP address. It does **not** prove identity, enrollment, project authorization, or approval.
- An unauthenticated `/health` probe only verifies that an HTTP listener answered.
- The `agent_id` returned by a peer on `/health` is a self-reported label, never proof of identity.
- Inbound requests on `/trigger` and `/report` require a matching cryptographic bearer token and an explicit entry in `security.allowed_sources`.

---

## 3. Secret Isolation & Profile Permissions

AIBridge strictly separates configuration files from secret credentials:
- **`config.json` (`0600`)**: Contains topology and allowlists; contains no tokens.
- **`bearer_token` (`0600`)**: Generated using CSPRNG (`openssl rand -hex 16`), stored in owner-only directory (`0700`), and loaded securely into memory at startup.

---

## 4. Historical Security References

For the initial threat model and contract audit prepared during Milestone 0, refer to:
- [`Docs/security/milestone-0-threat-model.md`](milestone-0-threat-model.md)
