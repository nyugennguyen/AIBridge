/**
 * Unit tests for Orchestration Command and Capability Preview Routes.
 *
 * Exercises route-level contract, error status mapping, payload validation,
 * and capability preview computation.
 */

import { describe, expect, it } from "vitest"
import { buildTestApp } from "../../integration/fixtures.js"
import { computeCapabilityEnvelope } from "../../../src/runtime/opencode-adapter.js"

describe("Orchestration Route Unit Tests", () => {
  describe("POST /orchestration/capability-preview unit behavior", () => {
    it("computes envelope with default empty permissionEnvelope when omitted", async () => {
      const { app } = await buildTestApp()

      const payload = {
        requestedCapabilities: ["filesystem.read", "process.exec"],
        roles: [
          {
            roleId: "developer",
            permissionRestrictions: {
              allowedCapabilities: ["filesystem.read", "process.exec"],
              deniedCapabilities: [],
            },
          },
        ],
      }

      const res = await app.inject({
        method: "POST",
        url: "/orchestration/capability-preview",
        headers: { authorization: "Bearer secret" },
        payload,
      })

      expect(res.statusCode).toBe(200)
      const data = res.json()
      expect(data.allowed).toEqual(["filesystem.read", "process.exec"])
      expect(data.denied).toEqual([])
    })

    it("accepts flat role permission shapes with allowedCapabilities directly", async () => {
      const { app } = await buildTestApp()

      const payload = {
        requestedCapabilities: ["filesystem.read", "network.external"],
        roles: [
          {
            roleId: "worker",
            allowedCapabilities: ["filesystem.read"],
            deniedCapabilities: ["network.external"],
          },
        ],
      }

      const res = await app.inject({
        method: "POST",
        url: "/orchestration/capability-preview",
        headers: { authorization: "Bearer secret" },
        payload,
      })

      expect(res.statusCode).toBe(200)
      const data = res.json()
      expect(data.allowed).toEqual(["filesystem.read"])
      expect(data.denied).toContain("network.external")
      expect(data.tools.webfetch).toBe(false)
    })

    it("matches computeCapabilityEnvelope for 3 intersecting roles", async () => {
      const { app } = await buildTestApp()

      const role1 = {
        roleId: "r1",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "filesystem.write", "process.exec"],
          deniedCapabilities: [],
        },
      }
      const role2 = {
        roleId: "r2",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "process.exec"],
          deniedCapabilities: [],
        },
      }
      const role3 = {
        roleId: "r3",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "network.external"],
          deniedCapabilities: [],
        },
      }

      const payload = {
        requestedCapabilities: ["filesystem.read", "filesystem.write", "process.exec", "network.external"],
        roles: [role1, role2, role3],
      }

      const res = await app.inject({
        method: "POST",
        url: "/orchestration/capability-preview",
        headers: { authorization: "Bearer secret" },
        payload,
      })

      expect(res.statusCode).toBe(200)
      const data = res.json()

      const expected = computeCapabilityEnvelope({
        requestedCapabilities: payload.requestedCapabilities,
        permissionEnvelope: {
          allowedCapabilities: payload.requestedCapabilities,
          deniedCapabilities: [],
        },
        roles: [role1, role2, role3],
      })

      expect(data.allowed).toEqual(expected.allowed)
      expect(data.allowed).toEqual(["filesystem.read"])
      expect(data.denied).toEqual(expected.denied)
      expect(data.tools).toEqual(expected.tools)
    })
  })

  describe("POST /orchestration/commands unit behavior", () => {
    it("returns 503 with coordinator_unavailable when coordinator dependency is missing", async () => {
      const { app } = await buildTestApp({
        orchestration: undefined,
      })

      const res = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer secret" },
        payload: {
          schemaVersion: 1,
          commandId: "cmd-test-1",
          projectId: "app",
          runId: "run-001",
          actor: { kind: "session", sessionId: "sess-unit-1" },
          controllerNodeId: "node-chair",
          controllerEpoch: 1,
          leaseId: "lease-1",
          issuedAt: "2026-10-14T10:00:00.000Z",
          expiresAt: "2026-10-14T11:00:00.000Z",
          correlationId: "corr-1",
          causation: null,
          type: "run.pause",
          payload: { reason: "test pause" },
        },
      })

      expect(res.statusCode).toBe(503)
      expect(res.json().ok).toBe(false)
      expect(res.json().error.code).toBe("coordinator_unavailable")
    })

    it("returns 400 when invalid command JSON is posted", async () => {
      const { app } = await buildTestApp()

      const res = await app.inject({
        method: "POST",
        url: "/orchestration/commands",
        headers: { authorization: "Bearer secret" },
        payload: {
          type: "unknown.command",
        },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe("Invalid command payload")
    })
  })
})
