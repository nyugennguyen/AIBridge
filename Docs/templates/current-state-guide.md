# Current architecture guide template

> **Status:** Current
> **Applies to:** AIBridge vX.Y.Z / deployment mode
> **Last verified:** YYYY-MM-DD against `<commit-or-release>`
> **Owner:** `<team-or-role>`

## 1. Purpose and status
<!-- Summarize what this architecture guide describes, who should use it, and whether it represents current running code. -->

## 2. Component responsibilities and trust boundaries
<!-- List each component, its core responsibilities, network ports, and trust boundaries. -->

## 3. Deployment and topology
<!-- Detail the deployment topology, machine roles, network coordinates, and communication channels. -->

## 4. Request and event flow
<!-- Step through the end-to-end request, admission, and event streaming sequences. -->

## 5. Persistence, consistency, retries, and recovery boundaries
<!-- Detail durable stores, write-ahead logs, transaction invariants, retry schedules, and recovery semantics. -->

## 6. Authentication and authorization path
<!-- Explain credential validation, caller identity checks, role permissions, and secret redaction. -->

## 7. Supported limits and platform assumptions
<!-- Document numeric ceilings, timeouts, toolchain pins, supported OS/architecture targets, and prerequisites. -->

## 8. External dependencies and known limitations
<!-- List required external daemons, tooling dependencies, known operational gaps, and unverified edge cases. -->

## 9. Source files and tests validating each claim
<!-- Provide a markdown table mapping each architectural claim to its source file and validating automated test. -->
