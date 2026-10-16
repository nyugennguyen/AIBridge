# AIBridge Documentation Archive

> **Status:** Current  
> **Applies to:** Historical and superseded documentation  
> **Owner:** Maintainers  

This archive retains historical specifications, initial brainstorming drafts, pre-orchestration milestone inventories, and superseded operational proposals.

---

> [!CAUTION]
> **Do Not Use for Operational Procedures:**
> Documents in this directory are preserved strictly for historical, architectural evolution, and forensic context. They describe early conceptual prototypes, completed migration phases, or hypothetical commands that were never implemented.
> For current, verified operational guidance, refer to the canonical guides in [`Docs/`](../README.md):
> - Getting Started: [`Docs/getting-started.md`](../getting-started.md)
> - Operations & Deployment: [`Docs/operations/deployment.md`](../operations/deployment.md)
> - Troubleshooting: [`Docs/operations/troubleshooting.md`](../operations/troubleshooting.md)
> - CLI Reference: [`Docs/reference/cli-reference.md`](../reference/cli-reference.md)

---

## Archived Documents Index

| Document | Original Context | Lifecycle State | Current Replacement |
|---|---|:---:|---|
| [**failure-modes-and-recovery.md**](failure-modes-and-recovery.md) | Initial recovery surface proposal describing hypothetical operator commands (`aibr db`, `aibr sessions`, etc.). | Superseded | [`Docs/operations/troubleshooting.md`](../operations/troubleshooting.md) |
| [**aibridge-tui-agent-orchestrator-brainstorm.md**](aibridge-tui-agent-orchestrator-brainstorm.md) | Initial conceptual brainstorm envisioning the transition from a simple bridge to a multi-agent orchestrator. | Historical | [`Docs/architecture/current-state.md`](../architecture/current-state.md) |
| [**remote-opencode-agent-bridge.md**](remote-opencode-agent-bridge.md) | Earliest proof-of-concept draft design for the remote agent bridge. | Historical | [`Docs/architecture/current-state.md`](../architecture/current-state.md) |
| [**remote-opencode-agent-bridge-visualization.md**](remote-opencode-agent-bridge-visualization.md) | Visual sequence diagrams for the initial POC design. | Historical | [`Docs/architecture/current-state.md`](../architecture/current-state.md) |
| [**milestone-0-current-state-inventory.md**](milestone-0-current-state-inventory.md) | Pre-orchestration baseline inventory from Milestone 0.1. | Historical | [`Docs/architecture/current-state.md`](../architecture/current-state.md) |
| [**milestone-0-legacy-migration.md**](milestone-0-legacy-migration.md) | Legacy migration plan from v1 bridge contracts to v2 event store. | Historical | [`Docs/architecture/current-state.md`](../architecture/current-state.md) |
| [**milestone-1-ux-state-machine.md**](milestone-1-ux-state-machine.md) | Initial UX state machine specification for standalone TUI. | Superseded | [ADR 0011](../adr/0011-herdr-orchestration-architecture.md) |
| [**milestone-2-adapter-conformance.md**](milestone-2-adapter-conformance.md) | Initial runtime adapter conformance test requirements. | Historical | [`Docs/guides/integrations.md`](../guides/integrations.md) |

---

## Milestone Plans and Implementation Reports

Completed milestone execution plans and gate reports remain preserved in their respective directories:
- **Implementation Plans:** [`Docs/implementation-plans/`](../implementation-plans/README.md)
- **Implementation Reports:** [`Docs/implementation-reports/`](../implementation-reports/)
- **Architecture Spikes:** [`Docs/spikes/`](../spikes/)
