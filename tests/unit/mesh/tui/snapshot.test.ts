import { describe, expect, it } from "vitest"
import { SCHEMA_VERSIONS } from "../../../../src/orchestration/identifiers.js"
import { buildMeshTuiView, initialMeshTuiState, parseMeshTuiSnapshot, reduceMeshTui, type MeshTuiSnapshot } from "../../../../src/mesh/tui/index.js"
import { LEASE_1, LOCAL, OTHER_RUN, PROJECT, RUN, WORKER_1, aHealthyNode, aLeaseRecord, aSessionSnapshot, aSnapshot } from "./fixtures.js"

/**
 * The snapshot parse site, and M4-V applied to a screen.
 *
 * A presentation layer is still a reader of untrusted records: the rows it shows
 * were written by M4.3, M4.4, M4.5 and M4.6, possibly by builds this one cannot
 * understand, and M4-V's rule — a record whose shape is not understood is refused,
 * never partially read — does not stop applying because the reader draws boxes
 * instead of authorizing commands.
 *
 * The two refusals here are the ones a TUI is uniquely able to get wrong, and
 * both are about INCOHERENCE rather than about an unknown field:
 *
 *   1. **A scope that disagrees with the lease it carries.** Every action this view
 *      emits is addressed with the snapshot's scope, so a confirmation presented
 *      for one run beside a lease belonging to another would be asking an operator
 *      to fence a lease they were never shown. `MeshControllerLease` refuses the
 *      same shape with `lease_scope_mismatch`; the screen has to refuse it too,
 *      earlier, because a screen that displays it is the mechanism.
 *   2. **A capability snapshot this build cannot validate.** A node advertising a
 *      capability name, a project path id or a runtime kind the registry never
 *      validated is a row the view would render as a schedulable machine.
 */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meshId: "mesh-release",
    localNodeId: LOCAL,
    scope: { projectId: PROJECT, runId: RUN },
    lease: { kind: "absent" },
    network: "up",
    nodes: [aHealthyNode({ nodeId: LOCAL })],
    sessions: [],
    unreconciled: [],
    outbox: [],
    ...overrides,
  }
}

describe("M4.8 a snapshot is validated once, and refused rather than partially read", () => {
  it("accepts a well-formed snapshot and returns it frozen", () => {
    const parsed = parseMeshTuiSnapshot(raw())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(Object.isFrozen(parsed.value)).toBe(true)
    // And the parsed value is what the view builds from, so the parse is on the
    // path rather than beside it.
    expect(buildMeshTuiView(reduceMeshTui(initialMeshTuiState(), { type: "snapshot-loaded", snapshot: parsed.value }).state)!.nodes).toHaveLength(1)
  })

  it("refuses a scope that disagrees with the lease it carries, and says both", () => {
    const parsed = parseMeshTuiSnapshot(
      raw({
        scope: { projectId: PROJECT, runId: RUN },
        lease: { kind: "held", permitsNewWork: true, record: aLeaseRecord({ runId: OTHER_RUN }) },
      }),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.code).toBe("mesh.tui_snapshot_unreadable")
    expect(parsed.error.message).toContain(RUN)
    expect(parsed.error.message).toContain(OTHER_RUN)
    expect(parsed.error.message).toMatch(/fence a lease the operator was never shown/)
  })

  it("refuses an unknown member rather than ignoring it", () => {
    // `.strict()` on the outer object, so a future member that a caller adds lands
    // here rather than being silently dropped — which is how a caller would
    // believe the view was showing something it is not.
    const parsed = parseMeshTuiSnapshot(raw({ extraMember: "should not be ignored" }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toMatch(/extraMember/)
  })

  it("refuses a node record whose capability snapshot this build cannot validate", () => {
    // The registry validates the advertisement on the ingest path, and
    // `nodeRecordSchema` is composed here rather than restated — so the second
    // refusal is the SAME schema, and a widening in one place widens both.
    const parsed = parseMeshTuiSnapshot(
      raw({
        nodes: [{ ...aHealthyNode({ nodeId: WORKER_1 }), negotiatedProtocolVersion: 0 }],
      }),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toMatch(/negotiatedProtocolVersion/)
  })

  it("refuses a lease record that its own stored schema rejects", () => {
    // A takeover missing its fence fields. `leaseRecordSchema`'s `superRefine`
    // refuses it, and the reason it matters here is that a half-written takeover
    // read as a fact about who superseded whom.
    const broken = aLeaseRecord()
    const parsed = parseMeshTuiSnapshot(
      raw({
        lease: {
          kind: "superseded",
          permitsNewWork: false,
          record: { ...broken, operation: "takeover", predecessorLeaseId: null, predecessorEpoch: null, takeoverReason: null },
        },
      }),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toMatch(/predecessorLeaseId|takeover/i)
  })

  it("refuses an unreconciled reason the protocol's closed vocabulary does not contain", () => {
    // The reasons are a closed set because a human cannot act on a vocabulary a
    // peer invented, and an open one would be a channel for arbitrary text into an
    // operator-facing view.
    const parsed = parseMeshTuiSnapshot(
      raw({ unreconciled: [{ nodeId: WORKER_1, reason: "looks_fine_to_me", detail: "invented" }] }),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toMatch(/unreconciled/)
  })

  it("refuses a network state the view has no reading for", () => {
    // Three network states are the vocabulary, and a fourth — "sort of connected" —
    // has no set of actions behind it, so accepting it would mean rendering a
    // status line with nothing to say about what may be done.
    const parsed = parseMeshTuiSnapshot(raw({ network: "flaky" }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toMatch(/network/)
  })

  it("refuses a session whose two axes contradict each other", () => {
    // `sessionSchema`'s own refinement, reached through composition. A finished
    // session cannot be reporting that it is working, and a view that rendered
    // that pair would claim a live session and a terminal dispatch at once.
    const parsed = parseMeshTuiSnapshot({
      meshId: "mesh-release",
      localNodeId: LOCAL,
      scope: { projectId: PROJECT, runId: RUN },
      lease: { kind: "absent" },
      network: "up",
      nodes: [],
      sessions: [
        {
          session: {
            schemaVersion: 1,
            sessionId: "session-1",
            projectId: PROJECT,
            runId: RUN,
            taskId: "task-1",
            dispatchId: "dispatch-1",
            nodeId: WORKER_1,
            installationId: "install-1",
            runtimeKind: "opencode",
            lifecycleState: "completed",
            observedState: "working",
          },
          launchOutcome: null,
          terminal: null,
        },
      ],
      unreconciled: [],
      outbox: [],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toMatch(/observedState/)
  })

  it("refuses an unknown launch outcome, so M4.5's versioned vocabulary is honoured here too", () => {
    // `MESH_LAUNCH_OUTCOMES` is read off the M4.5 module's own array. A launch
    // outcome recorded by a build this one predates is reported UNREADABLE rather
    // than mapped onto a member it happens to recognise by name.
    const parsed = parseMeshTuiSnapshot(
      raw({ sessions: [{ ...aSessionSnapshot(), launchOutcome: "started_by_vibes" }] }),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toMatch(/launchOutcome/)
  })
})

describe("M4.8 the parse composes the owners' schemas rather than restating them", () => {
  it("a stored record at a schema version this build cannot read is refused", () => {
    // M4-V, through the composed `nodeRecordSchema`. A version outside
    // `SCHEMA_VERSIONS` is never coerced, because the milestone's whole failure
    // mode is a shape that could not be named when it changed.
    for (const version of [0, 3, 99, "2", null]) {
      const parsed = parseMeshTuiSnapshot(
        raw({ nodes: [{ ...aHealthyNode({ nodeId: LOCAL }), node: { ...aHealthyNode({ nodeId: LOCAL }).node, schemaVersion: version } }] }),
      )
      expect(parsed.ok, String(version)).toBe(false)
    }
    // And every version this build DOES read parses, so the refusal above is the
    // version and not the shape.
    for (const version of SCHEMA_VERSIONS) {
      const parsed = parseMeshTuiSnapshot(
        raw({ nodes: [{ ...aHealthyNode({ nodeId: LOCAL }), node: { ...aHealthyNode({ nodeId: LOCAL }).node, schemaVersion: version } }] }),
      )
      expect(parsed.ok, String(version)).toBe(true)
    }
  })

  it("a lease at a readable version is accepted, so the refusals above are specific", () => {
    const snapshot: MeshTuiSnapshot = aSnapshot({ leaseKind: "held" })
    expect(parseMeshTuiSnapshot(snapshot).ok).toBe(true)
    expect(snapshot.lease.kind === "absent" ? null : snapshot.lease.record.leaseId).toBe(LEASE_1)
  })
})
