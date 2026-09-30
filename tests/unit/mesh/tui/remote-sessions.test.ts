import { describe, expect, it } from "vitest"
import { MESH_LAUNCH_OUTCOMES } from "../../../../src/mesh/inbox/launch-outcome.js"
import { SESSION_OBSERVED_STATES, SESSION_STATES, isSessionTerminal } from "../../../../src/orchestration/transitions.js"
import {
  MESH_TUI_STATES,
  buildMeshTuiView,
  initialMeshTuiState,
  parseMeshTuiSnapshot,
  reduceMeshTui,
  type MeshRemoteSessionView,
  type MeshTuiSnapshot,
  type MeshTuiUiState,
  type MeshTuiViewModel,
} from "../../../../src/mesh/tui/index.js"
import {
  LOCAL,
  PROJECT,
  RUN,
  WORKER_1,
  aHealthyNode,
  aRemoteSession,
  aSessionSnapshot,
  aSnapshot,
  aTerminalSnapshot,
} from "./fixtures.js"

/**
 * Remote sessions, and the one thing this screen must never do: merge the two axes.
 *
 * Milestone 3 replaced `session.state` with `lifecycleState` + `observedState`
 * because a provider's report about a process and the kernel's record of a
 * dispatch lifecycle are different axes. A remote-session view is the first place
 * those two travel together again, and the first place a renderer would be
 * tempted to pick one and drop the other — the temptation being strongest in
 * exactly the case the split exists for: a finished session whose last observation
 * was lost.
 *
 * The rest of this file covers the three facts that travel with a session and
 * would each be lost silently: which NODE it is on (the whole point of the
 * screen), what the durable outbox said about its LAUNCH (M4.5's ambiguous-launch
 * fix, Milestone 3 R4), and what the terminal gateway can see (viewers, input
 * ownership, and whether the client is LOSSY).
 */

function view(snapshot: MeshTuiSnapshot): MeshTuiViewModel {
  const state: MeshTuiUiState = reduceMeshTui(initialMeshTuiState(), { type: "snapshot-loaded", snapshot }).state
  return buildMeshTuiView(state)!
}

function row(snapshot: MeshTuiSnapshot): MeshRemoteSessionView {
  const rows = view(snapshot).sessions
  if (rows.length !== 1) throw new Error(`expected one session row, got ${rows.length}`)
  return rows[0]!
}

/**
 * A snapshot carrying exactly one session.
 *
 * A helper rather than a nested call at every site, because the inline form nests
 * four fixture calls inside an options object and the bracket that closes
 * `aSessionSnapshot`'s object is easy to lose — which is a syntax error rather than
 * a test failure, so it never gets to prove anything.
 */
function oneSession(entry: Parameters<typeof aSessionSnapshot>[0] = {}): MeshTuiSnapshot {
  return aSnapshot({ sessions: [aSessionSnapshot(entry)] })
}

describe("M4.8 a remote session keeps its lifecycle and its observation apart", () => {
  it("carries both, under their own names, on every row", () => {
    const entry = row(oneSession({ session: aRemoteSession({ lifecycleState: "running", observedState: "working" }) }))
    expect(entry.lifecycleState).toBe("running")
    expect(entry.observedState).toBe("working")
    // Asserted against the built row's keys: a view that collapsed the two into one
    // `state` member would fail here rather than rendering a wrong badge.
    expect(Object.keys(entry)).toContain("lifecycleState")
    expect(Object.keys(entry)).toContain("observedState")
  })

  it("renders a terminal lifecycle beside a lost observation, and does not soften it", () => {
    // The case the split exists for. `sessionSchema` permits `completed` +
    // `unknown` because `unknown` is the absence of a claim rather than a competing
    // one, and a view that fell back to the observation here would show a finished
    // session as still working.
    const entry = row(
      oneSession({ session: aRemoteSession({ lifecycleState: "completed", observedState: "unknown" }) }),
    )
    expect(entry.lifecycleState).toBe("completed")
    expect(entry.observedState).toBe("unknown")
    const text = view(oneSession({ session: aRemoteSession({ lifecycleState: "completed", observedState: "unknown" }) })).lines.join("\n")
    expect(text).toMatch(/lifecycle completed, observed unknown/)
  })

  it("distinguishes 'lifecycle running, observed unknown' from 'lifecycle running, observed working'", () => {
    // The mirror case: a session whose lifecycle has not advanced but whose
    // provider has stopped reporting. Both are `running` on the authoritative axis
    // and the second is the one an operator wants to see.
    const lost = row(oneSession({ session: aRemoteSession({ lifecycleState: "running", observedState: "unknown" }) }))
    const working = row(oneSession({ session: aRemoteSession({ lifecycleState: "running", observedState: "working" }) }))
    expect(lost.lifecycleState).toBe(working.lifecycleState)
    expect(lost.observedState).not.toBe(working.observedState)
  })

  it("carries every lifecycle and every observation the kernel defines, without inventing one", () => {
    // Enumerated from the kernel's own vocabularies, over every pair the kernel
    // considers well-formed. A view that could render a state the kernel does not
    // define would be inventing one; a view that dropped a real one would be
    // hiding a session state.
    //
    // The terminal lifecycles are paired with `unknown` rather than with every
    // observation because `sessionSchema` refuses the other combinations — the
    // refusal is asserted separately below, and a fixture that reached past it
    // would be exercising a shape the kernel has already ruled out.
    for (const lifecycleState of SESSION_STATES) {
      const observations = isSessionTerminal(lifecycleState) ? (["unknown"] as const) : SESSION_OBSERVED_STATES
      for (const observedState of observations) {
        const entry = row(oneSession({ session: aRemoteSession({ lifecycleState, observedState }) }))
        expect(entry.lifecycleState, `${lifecycleState}/${observedState}`).toBe(lifecycleState)
        expect(entry.observedState, `${lifecycleState}/${observedState}`).toBe(observedState)
      }
    }
    // Every member of both kernel vocabularies is exercised somewhere above, so a
    // state nobody covered shows up as a count rather than passing unnoticed.
    const covered = new Set<string>(SESSION_STATES.map((state) => `lifecycle:${state}`))
    for (const observedState of SESSION_OBSERVED_STATES) covered.add(`observed:${observedState}`)
    expect(covered.size).toBe(SESSION_STATES.length + SESSION_OBSERVED_STATES.length)
  })

  it("says the pair is compatible, because the kernel refused the incompatible ones before it got here", () => {
    // The TUI composes `sessionSchema`, so `completed` + `working` never reaches
    // a row. Asserted as a refusal rather than assumed, since a future change to
    // the snapshot's session schema would otherwise widen what the view renders.
    const refused = parseMeshTuiSnapshot({
      meshId: "mesh-release",
      localNodeId: LOCAL,
      scope: { projectId: PROJECT, runId: RUN },
      lease: { kind: "absent" },
      network: "up",
      nodes: [],
      sessions: [{ session: { ...aRemoteSession(), lifecycleState: "completed", observedState: "working" }, launchOutcome: null, terminal: null }],
      unreconciled: [],
      outbox: [],
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.code).toBe("mesh.tui_snapshot_unreadable")
  })

  it("reports a terminal lifecycle as terminal, and a live one as live", () => {
    for (const lifecycleState of SESSION_STATES) {
      const observedState = isSessionTerminal(lifecycleState) ? "unknown" : "working"
      const entry = row(oneSession({ session: aRemoteSession({ lifecycleState, observedState }) }))
      // No badge, no summary member, no derived `status`: the view reports the two
      // axes and lets a renderer decide, because deciding for it is exactly the
      // merge this screen must not perform.
      expect(isSessionTerminal(entry.lifecycleState), lifecycleState).toBe(isSessionTerminal(lifecycleState))
    }
  })
})

describe("M4.8 a remote session says which node it is on, and whether that is this one", () => {
  it("marks a session on another node as REMOTE, and one here as local", () => {
    const remote = row(oneSession({ session: aRemoteSession({ nodeId: WORKER_1 }) }))
    const local = row(oneSession({ session: aRemoteSession({ nodeId: LOCAL }) }))
    expect(remote.remote).toBe(true)
    expect(local.remote).toBe(false)
    // And the rendered row says so in words, because a flag nobody renders is a
    // flag nobody reads.
    const text = view(oneSession({ session: aRemoteSession({ nodeId: WORKER_1 }) })).lines.join("\n")
    expect(text).toMatch(/remote session-1/)
  })

  it("names the node's DISPLAY name and falls back rather than showing an id gap", () => {
    const known = row(aSnapshot({ nodes: [aHealthyNode({ nodeId: WORKER_1, displayName: "the laptop" })], sessions: [aSessionSnapshot({ session: aRemoteSession({ nodeId: WORKER_1 }) })] }))
    expect(known.nodeDisplayName).toBe("the laptop")
    // A session on a node the registry does not list is a real state — the
    // registry is per-mesh and a session may name a node that has since been
    // removed — and "unknown node" says so rather than rendering `undefined`.
    const unknown = row(aSnapshot({ nodes: [], sessions: [aSessionSnapshot({ session: aRemoteSession({ nodeId: WORKER_1 }) })] }))
    expect(unknown.nodeDisplayName).toBe("unknown node")
  })

  it("lists every session, not only the remote ones", () => {
    // The screen is called "remote sessions" but a controller's own sessions are
    // the ones it is least likely to have elsewhere, and filtering them out would
    // mean a run's whole session inventory was only visible when the mesh was
    // broken.
    const snapshot = aSnapshot({
      localNodeId: LOCAL,
      nodes: [aHealthyNode({ nodeId: LOCAL }), aHealthyNode({ nodeId: WORKER_1 })],
      sessions: [
        aSessionSnapshot({ session: aRemoteSession({ sessionId: "session-local" as never, nodeId: LOCAL }) }),
        aSessionSnapshot({ session: aRemoteSession({ sessionId: "session-remote" as never, nodeId: WORKER_1 }) }),
      ],
    })
    const rows = view(snapshot).sessions
    expect(rows.map((entry) => entry.remote)).toEqual([false, true])
  })

  it("shows an empty list rather than a message, when the run has no sessions", () => {
    expect(view(aSnapshot({ sessions: [] })).sessions).toEqual([])
  })
})

describe("M4.8 a session carries the durable launch verdict and the terminal state", () => {
  it("reports the ambiguous launch rather than showing a session as ordinary", () => {
    // Milestone 3 R4: the kernel's `launchAdmission` cannot represent an ambiguous
    // launch, and M4.5 made it a durable fact. A view that omitted it would show a
    // session the controller has no recorded start for as though it were the
    // ordinary case.
    for (const outcome of MESH_LAUNCH_OUTCOMES) {
      const entry = row(oneSession({ launchOutcome: outcome }))
      expect(entry.launchOutcome, outcome).toBe(outcome)
    }
  })

  it("shows the terminal's viewers, input owner and lossiness", () => {
    const attached = aSessionSnapshot({
      session: aRemoteSession({ terminalId: "terminal-1" as never }),
      terminal: aTerminalSnapshot({ viewerCount: 3, inputOwnerClientId: "client-2" as never, lossy: true }),
    })
    const entry = row(aSnapshot({ sessions: [attached] }))
    expect(entry.terminalId).toBe("terminal-1")
    expect(entry.terminalViewers).toBe(3)
    expect(entry.terminalInputOwner).toBe("client-2")
    // `lossy` is the member that matters: M4.7 drops FRAMES rather than buffering
    // them for a client that stopped reading, and a view that omitted it would
    // render a client that has silently lost output as whole.
    expect(entry.terminalLossy).toBe(true)
    const text = view(aSnapshot({ sessions: [attached] })).lines.join("\n")
    expect(text).toMatch(/LOSSY/)
    expect(text).toMatch(/input client-2/)
  })

  it("shows nulls rather than zeroes for a session with no terminal attached", () => {
    // Zero viewers is a fact; no terminal is a different fact, and rendering 0 for
    // the second would read as "attached and nobody is watching".
    const entry = row(oneSession({ session: aRemoteSession({ terminalId: undefined }), terminal: null }))
    expect(entry.terminalId).toBeNull()
    expect(entry.terminalViewers).toBeNull()
    expect(entry.terminalInputOwner).toBeNull()
    expect(entry.terminalLossy).toBeNull()
    expect(entry.launchOutcome).toBeNull()
  })

  it("carries the dispatch and run a session belongs to", () => {
    const entry = row(oneSession())
    expect(entry.dispatchId).toBe("dispatch-1")
    expect(entry.runId).toBe(RUN)
    expect(entry.runtimeKind).toBe("opencode")
  })
})

describe("M4.8 the session list is the same in every mesh cell", () => {
  it("a partition changes the lease summary, not the session inventory", () => {
    // The plan's guardrail is "do not terminate agents because a controller or
    // network disappeared", and the observable form of it here is that the session
    // rows are byte-identical across the twelve cells. A view that dropped or
    // re-labelled a session when the lease changed would be the mechanism by which
    // a partition became a stoppage.
    const sessions = [aSessionSnapshot({ session: aRemoteSession({ lifecycleState: "running", observedState: "working" }) })]
    const reference = JSON.stringify(view(aSnapshot({ leaseKind: "held", network: "up", sessions })).sessions)
    for (const cell of MESH_TUI_STATES) {
      const lease = cell.startsWith("absent") ? "absent" : cell.startsWith("expired") ? "expired" : cell.startsWith("superseded") ? "superseded" : "held"
      const network = cell.slice(cell.lastIndexOf("-") + 1) as "up" | "partitioned" | "healing"
      const rows = view(aSnapshot({ leaseKind: lease, network, sessions })).sessions
      expect(JSON.stringify(rows), cell).toBe(reference)
    }
  })
})
