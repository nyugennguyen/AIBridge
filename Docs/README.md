# AIBridge Documentation

> **Status:** Current  
> **Applies to:** AIBridge 3.0.0  
> **Owner:** Maintainers  

Welcome to the AIBridge documentation hub. This index organizes documentation around user needs, establishing one canonical source of truth for each architectural, operational, and development topic.

---

## 1. Documentation Index by Need

```
Docs/
├── getting-started.md              # Installation, onboarding, and first cross-host trigger
├── architecture/
│   ├── current-state.md            # Canonical as-built architecture and trust boundaries
│   └── decisions/                  # Architecture Decision Records (ADRs 0001–0011)
├── guides/
│   ├── configuration.md            # Zod config schema, profile storage, and token rotation
│   ├── development.md              # Build, test, typecheck, contract parity, and release gate
│   └── integrations.md             # OpenCode, Claude Code, Codex, Herdr, and Tailscale
├── operations/
│   ├── deployment.md               # Tmux, macOS launchd, Linux systemd, and multi-node mesh
│   ├── monitoring.md               # Health probes, diagnostics bundles, and queue telemetry
│   └── troubleshooting.md          # Real triage ladder, HTTP error matrix, and recovery
├── security/
│   └── security-model.md           # Inviolable security invariants and threat boundaries
├── reference/
│   └── cli-reference.md            # Executable command reference generated from aibr --help
└── archive/
    └── README.md                   # Historical plans, brainstorming drafts, and design records
```

---

## 2. Navigating the Documentation

### Getting Started
- [**Getting Started Guide**](getting-started.md) — Prerequisites, automated installation, 5-step interactive onboarding wizard, starting services, and verifying cross-host task triggers.

### Architecture
- [**Current Architecture Guide**](architecture/current-state.md) — The authoritative description of the implemented system: components, trust boundaries, event stores, and polyglot ingress separation.
- [**Architecture Decision Records (ADRs)**](architecture/decisions/README.md) — Index of all 11 accepted and evaluated architectural decisions governing AIBridge.

### User & Developer Guides
- [**Configuration Guide**](guides/configuration.md) — Detailed reference for `config.json`, profile XDG paths, environment variables, and token management.
- [**Developer Guide**](guides/development.md) — Contributor instructions for building, running tests, regenerating contracts, and validating documentation.
- [**Integrations Guide**](guides/integrations.md) — Connecting with OpenCode, Claude Code, Codex, the Herdr presentation substrate, and Tailscale networking.

### Operations & Maintenance
- [**Deployment & Operations Guide**](operations/deployment.md) — Managing nodes via tmux, systemd, launchd, and multi-node mesh topologies.
- [**Monitoring & Diagnostics Guide**](operations/monitoring.md) — Probing node status, reading `/health`, generating redacted support bundles (`aibr bundle`), and tracking queues.
- [**Operational Troubleshooting Guide**](operations/troubleshooting.md) — Step-by-step triage ladder, root-cause fixes for HTTP 400/401/403/409/503 errors, and warnings on non-existent commands.

### Security
- [**Security Model & Architecture**](security/security-model.md) — The 8 core security invariants, commit-before-202 WAL, constant-time authentication, and project filesystem containment.

### Reference
- [**CLI Command Reference**](reference/cli-reference.md) — Complete executable reference for the `aibr` command, generated directly from `aibr --help`.

### Archive
- [**Historical Archive**](archive/README.md) — Preserved milestone completion reports, early brainstorms, and superseded recovery specifications.

---

## 3. Documentation Governance & Policies

Documentation in this repository is governed by the principles in [**CONTRIBUTING.md**](../CONTRIBUTING.md):
1. **One Canonical Source:** Each topic is explained once in its authoritative document; other documents link rather than duplicate.
2. **Code Authority:** Prose must match the executable source code.
3. **No Operational Confusion:** Historical and superseded materials are isolated under `archive/` with explicit status banners.
4. **Automated Verification:** All documentation is continuously verified using `bun run docs:check`.
