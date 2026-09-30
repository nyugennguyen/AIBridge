import { describe, expect, it } from "vitest"
import { openInMemoryDriver } from "../../../../src/orchestration/event-store/sqlite-driver.js"
import { meshHeartbeatSchema } from "../../../../src/mesh/protocol/heartbeat.js"
import { safeParseMeshEnvelope } from "../../../../src/mesh/protocol/registry.js"
import {
  capabilityRequestSchema,
  capabilitySnapshotSchema,
  nodeRecordSchema,
  parseNodeRecord,
  registryRevocationSchema,
} from "../../../../src/mesh/registry/index.js"
import { runMeshRegistryMigrations } from "../../../../src/mesh/registry/migrations.js"
import { CURRENT_SCHEMA_VERSION } from "../../../../src/orchestration/identifiers.js"
import { MESH_ID, WORKER_ID, WORKER_KEY_ID, TestClock, at, heartbeatEnvelope, iso } from "./fixtures.js"

/**
 * Milestone 3's R5 and R6, enforced STRUCTURALLY.
 *
 * R5: cross-agent dependencies have no canonical equivalent. They survive only as
 * compatibility references, and M4.3's capability model must not imply they have
 * become canonical scheduling edges.
 *
 * R6: `taskSchema.failurePolicy` and per-task retry eligibility are PROJECTION
 * facts. Nothing else may infer them.
 *
 * Both are unreachable BY CONSTRUCTION here, not by the discipline of whoever adds
 * the next field, and this file is what makes that claim checkable:
 *
 *   - every shape in the directory is `.strict()`, so a member that could express a
 *     dependency or a retry decision would have to be NAMED, and the name is what
 *     these tests forbid;
 *   - a record that tries to carry one anyway is REFUSED, at the wire and at the
 *     store, so the property is not merely "the schema has no such key" but "no
 *     value carrying one is ever accepted";
 *   - the physical SQLite columns are checked too, because a column that the Zod
 *     shape does not know about is exactly how a shape-level guarantee quietly stops
 *     being one.
 *
 * The forbidden vocabulary is expressed as a pattern rather than a list so a rename
 * cannot slip past. `depend*` and `block*` cover the dependency family; `retry*`,
 * `failure*` and `eligible*` cover the retry family. A name that matched none of
 * these would need a deliberate decision to be allowed through, which is the
 * direction the checks should fail.
 */
const SCHEDULING_EDGE_VOCABULARY =
  /(depend|block|prereq|precondition|retry|retries|failure|backoff|reschedul|eligible|eligib|waits?_for|upstream|downstream|critical_?path)/i

const FORBIDDEN_MEMBER_NAMES = [
  // R5 — cross-agent dependency.
  "dependencies",
  "dependsOn",
  "dependsOnNodeIds",
  "blockedBy",
  "blockingTaskIds",
  "prerequisites",
  // R6 — per-task retry eligibility.
  "retryEligible",
  "retryPolicy",
  "failurePolicy",
  "maxAttempts",
  "backoffMs",
]

function objectShapeKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape).sort()
}

describe("R5/R6: no member of any registry shape can express a cross-agent dependency or a retry decision", () => {
  it("the stored node record has no member that could hold either", () => {
    const members = objectShapeKeys(nodeRecordSchema)
    for (const member of members) {
      expect(SCHEDULING_EDGE_VOCABULARY.test(member), `nodeRecordSchema.${member} is a scheduling edge`).toBe(false)
    }
    // Spelled out as well as pattern-matched, so the failure message when someone
    // adds one of THESE names is the name and not a regex the reader has to decode.
    for (const forbidden of FORBIDDEN_MEMBER_NAMES) {
      expect(members).not.toContain(forbidden)
    }
    expect(members).toEqual([
      "capability",
      "displayName",
      "enrolledAt",
      "meshId",
      "nodeId",
      "nodeKeyId",
      "revocation",
      "schemaVersion",
    ])
  })

  it("the capability snapshot has no member that could hold either", () => {
    const members = objectShapeKeys(capabilitySnapshotSchema)
    for (const member of members) {
      expect(SCHEDULING_EDGE_VOCABULARY.test(member), `capabilitySnapshotSchema.${member} is a scheduling edge`).toBe(false)
    }
    expect(members).toEqual([
      "agentCount",
      "capabilities",
      "load",
      "maxConcurrentSessions",
      "negotiatedProtocolVersion",
      "observedAt",
      "offeredProtocolVersions",
      "projectPathIds",
      "runtimeKinds",
      "sequence",
    ])
  })

  it("the revocation record and the capability request have neither", () => {
    for (const [name, schema] of [
      ["registryRevocationSchema", registryRevocationSchema],
      ["capabilityRequestSchema", capabilityRequestSchema],
    ] as const) {
      for (const member of objectShapeKeys(schema)) {
        expect(SCHEDULING_EDGE_VOCABULARY.test(member), `${name}.${member} is a scheduling edge`).toBe(false)
      }
    }
  })

  it("the WIRE heartbeat has neither, so the registry cannot be handed one", () => {
    // The registry's input is a wire record, so the guarantee has to start there. If
    // a future protocol version added a `dependsOnNodeIds` to the heartbeat, this
    // test is what makes it a decision rather than a field.
    for (const member of objectShapeKeys(meshHeartbeatSchema)) {
      expect(SCHEDULING_EDGE_VOCABULARY.test(member), `meshHeartbeatSchema.${member} is a scheduling edge`).toBe(false)
    }
  })

  it("a heartbeat carrying a cross-agent dependency is REFUSED, not ignored", async () => {
    const withDependency = {
      ...heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }),
      payload: {
        ...(heartbeatEnvelope().payload as Record<string, unknown>),
        dependsOnNodeIds: ["node-other"],
      },
    }
    const parsed = safeParseMeshEnvelope(withDependency)
    // `.strict()` turns an unknown field into a rejection. An ignored field is how a
    // future field that changes meaning gets silently dropped by an old reader — and
    // then a dependency written by a new node becomes a node that merely looks
    // capable, with the edge stored nowhere.
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toContain("dependsOnNodeIds")
  })

  it("a heartbeat carrying a retry-eligibility claim is REFUSED", () => {
    const withRetry = {
      ...heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }),
      payload: {
        ...(heartbeatEnvelope().payload as Record<string, unknown>),
        retryEligible: true,
      },
    }
    const parsed = safeParseMeshEnvelope(withRetry)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    // R6 in one assertion: per-task retry eligibility is a projection fact read from
    // the recorded event log. Nothing a node says about itself may stand in for it,
    // and the cheapest way to guarantee that is for the wire to have nowhere to put
    // the claim.
    expect(parsed.error.message).toContain("retryEligible")
  })

  it("a stored node record carrying a dependency is refused on read, not partially loaded", () => {
    const record = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      nodeId: WORKER_ID,
      meshId: MESH_ID,
      nodeKeyId: WORKER_KEY_ID,
      displayName: "worker-1",
      enrolledAt: at(0),
      capability: null,
      revocation: null,
      dependencies: [{ taskId: "task-1" }],
    }
    const parsed = parseNodeRecord(record)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    // Reading it partially would mean honouring a record whose shape this build does
    // not recognise — and a partially-read node record is a node whose dependency
    // edges have silently become scheduling facts.
    expect(parsed.error.code).toBe("registry.node_record_unreadable")
  })

  it("the physical SQLite columns hold neither, in any table", () => {
    const clock = new TestClock(at(0))
    const driver = openInMemoryDriver()
    runMeshRegistryMigrations(driver, { now: clock.now })
    try {
      for (const table of ["mesh_registry_nodes", "mesh_registry_revocations", "mesh_registry_heartbeat_gaps"]) {
        const columns = driver.all<{ name: string }>(`PRAGMA table_info(${table})`)
        expect(columns.length).toBeGreaterThan(0)
        for (const column of columns.map((c) => c.name)) {
          expect(
            SCHEDULING_EDGE_VOCABULARY.test(column),
            `${table}.${column} is a scheduling edge`,
          ).toBe(false)
        }
      }
      // Also the JSON columns' contents, which is where a Zod-shape guarantee would
      // otherwise be the only thing standing between a node and a canonical edge.
      const nodeColumns = driver
        .all<{ name: string }>("PRAGMA table_info(mesh_registry_nodes)")
        .map((c) => c.name)
        .sort()
      expect(nodeColumns).toEqual([
        "capability_json",
        "display_name",
        "enrolled_at",
        "last_heartbeat_sequence",
        "mesh_id",
        "node_id",
        "node_key_id",
        "schema_version",
      ])
      // No liveness column: liveness is derived at read time from the injected clock,
      // and a stored liveness needs a sweeper whose failure mode is "every node on
      // the mesh claims to be live forever".
      expect(nodeColumns).not.toContain("liveness")
    } finally {
      driver.close()
    }
  })

  it("the capability request cannot be widened into an authorization by an extra member", () => {
    const parsed = capabilityRequestSchema.safeParse({
      runtimeKind: "opencode",
      requestedCapabilities: ["fs.read"],
      projectPathId: "path-release-1",
      permissionEnvelope: {
        allowedCapabilities: ["fs.read"],
        deniedCapabilities: [],
        approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
      },
      projectPathAllowedCapabilities: null,
      // A caller trying to smuggle a grant in beside the authorities this registry
      // actually consults.
      grantFromNodeAdvertisement: true,
    })
    expect(parsed.success).toBe(false)
  })
})
