# Architecture Decision Records (ADRs)

> **Status:** Current  
> **Applies to:** AIBridge Architecture Decisions  
> **Owner:** Maintainers  

This directory is the canonical repository for all formal Architecture Decision Records (ADRs) governing the AIBridge platform. ADRs document architectural context, evaluated alternatives, decision rationale, and operational consequences for significant design choices.

---

## Decision Index

| ADR | Title | Status | Date | Core Scope |
|---|---|:---:|:---:|---|
| [**ADR 0001**](0001-canonical-domain-and-module-boundaries.md) | Canonical Domain & Module Boundaries | Accepted | 2026-09-28 | Establishes the bounded context between kernel orchestration, terminal backend, and host adapters. |
| [**ADR 0002**](0002-versioned-contracts-and-adapter-boundaries.md) | Versioned Contracts & Adapter Boundaries | Accepted | 2026-09-28 | Versioned serialization contracts (`contracts/v1/`) and cross-language schema generation. |
| [**ADR 0003**](0003-event-store-and-idempotency.md) | Event Store & Idempotency | Accepted | 2026-09-28 | SQLite append-only event store (`SqliteEventStore`), idempotency keys, and receipt deduplication. Not yet wired, deadline 3.3.0. |
| [**ADR 0004**](0004-controller-leases-and-recovery.md) | Controller Leases & Recovery | Superseded by 0016 | 2026-09-28 | Durable leases, epoch progression, and failover boundaries for distributed controllers. |
| [**ADR 0005**](0005-claude-code-runtime-adapter.md) | Claude Code Runtime Adapter | Accepted | 2026-09-29 | Non-interactive execution, hooks, prompt framing, and capability intersection for Claude Code. |
| [**ADR 0006**](0006-codex-runtime-adapter.md) | Codex Runtime Adapter | Accepted | 2026-09-29 | Codex execution harness, JSON-RPC protocol mapping, and sub-agent coordination. |
| [**ADR 0007**](0007-rule-language-and-evaluation.md) | Rule Language & Evaluation | Superseded by 0016 | 2026-10-01 | Deterministic rule expressions, advisory notifications, and immutable safety floors. |
| [**ADR 0008**](0008-polyglot-ingress-and-admission.md) | Polyglot Ingress & Durable Admission | Accepted | 2026-10-03 | Two-tier architecture: native Rust ingress router (`aibr-router`) with commit-before-202 WAL. |
| [**ADR 0009**](0009-herdr-terminal-backend-evaluation.md) | Herdr Terminal Backend Evaluation | Superseded by 0014 | 2026-10-06 | Initial spike evaluation of Herdr terminal primitives (partially superseded by ADR 0011). |
| [**ADR 0010**](0010-tui-daemon-modernization.md) | TUI & Daemon Modernization | Superseded by 0014 | 2026-10-07 | Terminal UI state machine and daemon communication (superseded by Herdr plugin in ADR 0011). |
| [**ADR 0011**](0011-herdr-orchestration-architecture.md) | Herdr Orchestration Architecture | Superseded by 0014 | 2026-10-08 | Definitive separation: Herdr owns terminal presentation; AIBridge kernel owns intent. |
| [**ADR 0012**](0012-request-signing-and-pairing.md) | Request Signing & Pairing | Accepted | 2026-11-25 | ed25519 node signatures on `/trigger` and `/report` (`security.request_signing`) and `aibr enroll` pairing; refused in router mode. |
| [**ADR 0013**](0013-operator-approval-ledger.md) | Operator Approval Ledger | Accepted | 2026-11-25 | Approval-gated jobs (every runtime since the 3.1.2 amendment) held as `awaiting_approval`; operator-only, same-host approve/reject; hash-chained local approval ledger instead of kernel dispatch approval. |
| [**ADR 0014**](0014-claude-is-the-operator-interface.md) | Claude Is the Operator Interface | Accepted; amended by 0015 | 2026-11-26 | Claude Code with the AIBridge plugin is the main interface; human-only actions stay in the `aibr` CLI; TUI, Herdr, terminal gateway and IPC bus removed in 3.1.1. |
| [**ADR 0015**](0015-orchestrator-is-chosen-per-project.md) | Orchestrator Is Chosen per Project | Accepted | 2026-11-26 | Each project names its orchestrator (Claude, Codex or OpenCode) over MCP; human-only actions unchanged; every node runs `aibr serve`, node `role` dropped. Amends 0014. |
| [**ADR 0016**](0016-keep-selected-unwired-code-with-deadlines.md) | Keep Selected Unwired Code With Deadlines | Accepted | 2026-11-26 | Remove the unwired kernel, mesh, rules and the rest; keep memory, event store, Codex adapter, context and notifications with wire and delete deadlines; reachability check. Supersedes 0004 and 0007. |

---

## Contributing a New ADR

To propose a new architectural decision, follow the template at [`Docs/templates/adr.md`](../templates/adr.md). Once agreed, assign the next sequential number and commit to `Docs/adr/`.
