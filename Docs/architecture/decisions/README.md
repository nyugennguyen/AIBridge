# Architecture Decision Records (ADRs)

> **Status:** Current  
> **Applies to:** AIBridge Architecture Decisions  
> **Owner:** Maintainers  

This directory indexes all formal Architecture Decision Records (ADRs) governing the AIBridge platform. ADRs document the architectural context, evaluated alternatives, decision rationale, and operational consequences for significant design choices.

---

## Decision Index

| ADR | Title | Status | Date | Core Scope |
|---|---|:---:|:---:|---|
| [**ADR 0001**](../../adr/0001-canonical-domain-and-module-boundaries.md) | Canonical Domain & Module Boundaries | Accepted | 2026-09-28 | Establishes the bounded context between kernel orchestration, terminal backend, and host adapters. |
| [**ADR 0002**](../../adr/0002-versioned-contracts-and-adapter-boundaries.md) | Versioned Contracts & Adapter Boundaries | Accepted | 2026-09-28 | Versioned serialization contracts (`contracts/v1/`) and cross-language schema generation. |
| [**ADR 0003**](../../adr/0003-event-store-and-idempotency.md) | Event Store & Idempotency | Accepted | 2026-09-28 | SQLite append-only event store (`SqliteEventStore`), idempotency keys, and receipt deduplication. |
| [**ADR 0004**](../../adr/0004-controller-leases-and-recovery.md) | Controller Leases & Recovery | Accepted | 2026-09-28 | Durable leases, epoch progression, and failover boundaries for distributed controllers. |
| [**ADR 0005**](../../adr/0005-claude-code-runtime-adapter.md) | Claude Code Runtime Adapter | Accepted | 2026-09-29 | Non-interactive execution, hooks, prompt framing, and capability intersection for Claude Code. |
| [**ADR 0006**](../../adr/0006-codex-runtime-adapter.md) | Codex Runtime Adapter | Accepted | 2026-09-29 | Codex execution harness, JSON-RPC protocol mapping, and sub-agent coordination. |
| [**ADR 0007**](../../adr/0007-rule-language-and-evaluation.md) | Rule Language & Evaluation | Accepted | 2026-10-01 | Deterministic rule expressions, advisory notifications, and immutable safety floors. |
| [**ADR 0008**](../../adr/0008-polyglot-ingress-and-admission.md) | Polyglot Ingress & Durable Admission | Accepted | 2026-10-03 | Two-tier architecture: native Rust ingress router (`aibr-router`) with commit-before-202 WAL. |
| [**ADR 0009**](../../adr/0009-herdr-terminal-backend-evaluation.md) | Herdr Terminal Backend Evaluation | Deferred | 2026-10-06 | Initial spike evaluation of Herdr terminal primitives (partially superseded by ADR 0011). |
| [**ADR 0010**](../../adr/0010-tui-daemon-modernization.md) | TUI & Daemon Modernization | Superseded | 2026-10-07 | Terminal UI state machine and daemon communication (superseded by Herdr plugin in ADR 0011). |
| [**ADR 0011**](../../adr/0011-herdr-orchestration-architecture.md) | Herdr Orchestration Architecture | Accepted | 2026-10-08 | Definitive separation: Herdr owns terminal presentation; AIBridge kernel owns intent. |

---

## Contributing a New ADR

To propose a new architectural decision, follow the template at [`Docs/templates/adr.md`](../../templates/adr.md). Once agreed, assign the next sequential number and commit to `Docs/adr/`.
