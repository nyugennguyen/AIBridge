import { describe, expect, it } from "vitest"
import { computeCapabilityEnvelope, CAPABILITY_TOOLS_MAP, OpencodeAdapter } from "../../../src/runtime/opencode-adapter.js"
import { digestDispatchEnvelope } from "../../../src/orchestration/digest.js"
import { permissionEnvelopeSchema } from "../../../src/orchestration/schemas.js"
import { launchAgentRequestSchema, runtimeOperationContextSchema } from "../../../src/runtime/schemas.js"
import type { OpencodeClient } from "../../../src/opencode/types.js"

describe("Capability envelope for multi-role (plan §7.2)", () => {
  const basePermissionEnvelope = {
    allowedCapabilities: ["filesystem.read", "filesystem.write", "process.exec", "network.external"],
    deniedCapabilities: [],
  }

  describe("Single-role baseline behavior (regression test)", () => {
    it("computes envelope identically for a single assigned role", () => {
      const result = computeCapabilityEnvelope({
        requestedCapabilities: ["filesystem.read", "filesystem.write"],
        permissionEnvelope: {
          allowedCapabilities: ["filesystem.read", "filesystem.write", "process.exec"],
          deniedCapabilities: ["process.exec"],
        },
        roles: [
          {
            roleId: "implementer",
            permissionRestrictions: {
              allowedCapabilities: ["filesystem.read", "filesystem.write"],
              deniedCapabilities: ["network.external"],
            },
          },
        ],
      })

      expect(result.allowed).toEqual(["filesystem.read", "filesystem.write"])
      expect(result.denied).toContain("process.exec")
      expect(result.denied).toContain("network.external")

      // Tools check: filesystem tools allowed, process and network tools false
      expect(result.tools["read"]).toBeUndefined()
      expect(result.tools["write"]).toBeUndefined()
      expect(result.tools["bash"]).toBe(false)
      expect(result.tools["webfetch"]).toBe(false)
      expect(result.tools["websearch"]).toBe(false)
    })
  })

  describe("Multi-role default is INTERSECTION", () => {
    it("only capabilities permitted by BOTH roles survive in the envelope", () => {
      // Role 1: implementer allows fs.read and fs.write
      const role1 = {
        roleId: "implementer",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "filesystem.write"],
          deniedCapabilities: [],
        },
      }

      // Role 2: release-manager allows fs.read and process.exec
      const role2 = {
        roleId: "release-manager",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "process.exec"],
          deniedCapabilities: [],
        },
      }

      const result = computeCapabilityEnvelope({
        requestedCapabilities: ["filesystem.read", "filesystem.write", "process.exec"],
        permissionEnvelope: basePermissionEnvelope,
        roles: [role1, role2],
      })

      // Only filesystem.read is allowed by BOTH roles
      expect(result.allowed).toEqual(["filesystem.read"])

      // Tools check
      expect(result.tools["read"]).toBeUndefined()
      expect(result.tools["glob"]).toBeUndefined()
      expect(result.tools["write"]).toBe(false)
      expect(result.tools["patch"]).toBe(false)
      expect(result.tools["bash"]).toBe(false)
    })

    it("produces empty allowed list when role allowed sets are disjoint", () => {
      const role1 = {
        roleId: "writer",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.write"],
          deniedCapabilities: [],
        },
      }
      const role2 = {
        roleId: "reader",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read"],
          deniedCapabilities: [],
        },
      }

      const result = computeCapabilityEnvelope({
        requestedCapabilities: ["filesystem.read", "filesystem.write"],
        permissionEnvelope: basePermissionEnvelope,
        roles: [role1, role2],
      })

      expect(result.allowed).toEqual([])
      expect(result.tools["read"]).toBe(false)
      expect(result.tools["write"]).toBe(false)
    })
  })

  describe("Denied capabilities take precedence across all roles", () => {
    it("a capability denied by either role is out even if the other role explicitly allows it", () => {
      // Role 1 allows fs.read and fs.write
      const role1 = {
        roleId: "implementer",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "filesystem.write"],
          deniedCapabilities: [],
        },
      }

      // Role 2 also allows fs.read and fs.write, but explicitly DENIES fs.write
      const role2 = {
        roleId: "auditor",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "filesystem.write"],
          deniedCapabilities: ["filesystem.write"],
        },
      }

      const result = computeCapabilityEnvelope({
        requestedCapabilities: ["filesystem.read", "filesystem.write"],
        permissionEnvelope: basePermissionEnvelope,
        roles: [role1, role2],
      })

      // fs.write is denied by Role 2, so it CANNOT survive
      expect(result.allowed).toEqual(["filesystem.read"])
      expect(result.denied).toContain("filesystem.write")
      expect(result.tools["write"]).toBe(false)
    })

    it("rule denial excludes capability even when all roles permit it", () => {
      const role1 = {
        roleId: "role1",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "process.exec"],
          deniedCapabilities: [],
        },
      }
      const role2 = {
        roleId: "role2",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "process.exec"],
          deniedCapabilities: [],
        },
      }

      const result = computeCapabilityEnvelope({
        requestedCapabilities: ["filesystem.read", "process.exec"],
        permissionEnvelope: basePermissionEnvelope,
        roles: [role1, role2],
        ruleSnapshots: [
          {
            enabled: true,
            effect: {
              kind: "restrict",
              deniedCapabilities: ["process.exec"],
            },
          },
        ],
      })

      expect(result.allowed).toEqual(["filesystem.read"])
      expect(result.denied).toContain("process.exec")
      expect(result.tools["bash"]).toBe(false)
    })
  })

  describe("Per-role permissionRestrictions union opt-in", () => {
    it("widens capabilities when secondary role opts in via compositionMode: 'union'", () => {
      const primaryRole = {
        roleId: "implementer",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "filesystem.write"],
          deniedCapabilities: [],
        },
      }

      const secondaryRole = {
        roleId: "deployer",
        permissionRestrictions: {
          allowedCapabilities: ["network.external"],
          deniedCapabilities: [],
          compositionMode: "union",
        },
      }

      const result = computeCapabilityEnvelope({
        requestedCapabilities: ["filesystem.read", "filesystem.write", "network.external"],
        permissionEnvelope: basePermissionEnvelope,
        roles: [primaryRole, secondaryRole],
      })

      // deployer's union opt-in widens the base intersection with network.external
      expect(result.allowed).toContain("filesystem.read")
      expect(result.allowed).toContain("filesystem.write")
      expect(result.allowed).toContain("network.external")
      expect(result.tools["webfetch"]).toBeUndefined()
    })

    it("refuses removed synonym fields under strict schema parsing", () => {
      expect(() =>
        permissionEnvelopeSchema.parse({
          allowedCapabilities: ["filesystem.read"],
          deniedCapabilities: [],
          approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
          compositionMode: "intersection",
          allowUnion: true,
        }),
      ).toThrow(/Unrecognized key.*allowUnion/)

      expect(() =>
        permissionEnvelopeSchema.parse({
          allowedCapabilities: ["filesystem.read"],
          deniedCapabilities: [],
          approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
          compositionMode: "intersection",
          unionOptIn: true,
        }),
      ).toThrow(/Unrecognized key.*unionOptIn/)
    })

    it("unions all roles when both roles opt into union", () => {
      const role1 = {
        roleId: "reader",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read"],
          deniedCapabilities: [],
          compositionMode: "union",
        },
      }

      const role2 = {
        roleId: "writer",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.write"],
          deniedCapabilities: [],
          compositionMode: "union",
        },
      }

      const result = computeCapabilityEnvelope({
        requestedCapabilities: ["filesystem.read", "filesystem.write"],
        permissionEnvelope: basePermissionEnvelope,
        roles: [role1, role2],
      })

      expect(result.allowed).toEqual(["filesystem.read", "filesystem.write"])
    })

    it("union opt-in NEVER overrides explicit denials from any role", () => {
      // Role 1 opts into union with fs.read and network.external
      const role1 = {
        roleId: "role1",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "network.external"],
          deniedCapabilities: [],
          compositionMode: "union",
        },
      }

      // Role 2 denies network.external
      const role2 = {
        roleId: "role2",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read"],
          deniedCapabilities: ["network.external"],
          compositionMode: "union",
        },
      }

      const result = computeCapabilityEnvelope({
        requestedCapabilities: ["filesystem.read", "network.external"],
        permissionEnvelope: basePermissionEnvelope,
        roles: [role1, role2],
      })

      // network.external is explicitly denied by role2, so union cannot grant it
      expect(result.allowed).toEqual(["filesystem.read"])
      expect(result.denied).toContain("network.external")
      expect(result.tools["webfetch"]).toBe(false)
    })
  })

  describe("Determinism: same assignment set + roles → identical envelope", () => {
    it("produces identical capability envelope regardless of role order", () => {
      const roleA = {
        roleId: "role-a",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "filesystem.write"],
          deniedCapabilities: ["network.external"],
        },
      }
      const roleB = {
        roleId: "role-b",
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "process.exec"],
          deniedCapabilities: ["filesystem.write"],
        },
      }

      const result1 = computeCapabilityEnvelope({
        requestedCapabilities: ["filesystem.read", "filesystem.write", "process.exec"],
        permissionEnvelope: basePermissionEnvelope,
        roles: [roleA, roleB],
      })

      const result2 = computeCapabilityEnvelope({
        requestedCapabilities: ["filesystem.read", "filesystem.write", "process.exec"],
        permissionEnvelope: basePermissionEnvelope,
        roles: [roleB, roleA],
      })

      expect(result1.allowed).toEqual(result2.allowed)
      expect(result1.denied).toEqual(result2.denied)
      expect(result1.tools).toEqual(result2.tools)
    })
  })

  describe("OpencodeAdapter integration with multi-role dispatch", () => {
    function createMockClient(): OpencodeClient & { promptCalls: unknown[] } {
      const promptCalls: unknown[] = []
      return {
        promptCalls,
        createSession: async () => ({ id: "opencode-session-1" }),
        sendPromptAsync: async (
          _sessionId: string,
          _prompt: string,
          _directory: string,
          policy?: unknown,
        ) => {
          promptCalls.push(policy)
        },
      } as unknown as OpencodeClient & { promptCalls: unknown[] }
    }

    it("launches agent with multi-role envelope intersecting permissions and applying secondary addenda", async () => {
      const client = createMockClient()
      const resolver = { resolve: async () => ({ ok: true as const, value: "/tmp/project" }) }
      const adapter = new OpencodeAdapter({
        baseUrl: "http://127.0.0.1:4096",
        nodeId: "node-1",
        installationId: "install-1",
        client,
        projects: resolver,
      })

      const primaryRole = {
        schemaVersion: 1 as const,
        roleId: "implementer",
        templateVersion: 1,
        projectId: "project-1",
        name: "Implementer",
        purpose: "Write features",
        instructions: "Follow TDD",
        requiredCapabilities: ["filesystem.read"],
        preferredRuntimeKinds: ["opencode"],
        contextSelectionPolicyReference: { namespace: "test", id: "p1" },
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "filesystem.write"],
          deniedCapabilities: [],
          approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
        },
        author: { kind: "system" as const, name: "test" },
        createdAt: "2026-09-17T00:00:00.000Z",
      }

      const secondaryRole = {
        schemaVersion: 1 as const,
        roleId: "release-manager",
        templateVersion: 1,
        projectId: "project-1",
        name: "Release Manager",
        purpose: "Manage release",
        instructions: "Enforce release checklist",
        requiredCapabilities: ["filesystem.read"],
        preferredRuntimeKinds: ["opencode"],
        contextSelectionPolicyReference: { namespace: "test", id: "p2" },
        permissionRestrictions: {
          allowedCapabilities: ["filesystem.read", "process.exec"],
          deniedCapabilities: [],
          approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
        },
        author: { kind: "system" as const, name: "test" },
        createdAt: "2026-09-17T00:00:00.000Z",
      }

      const envelope = {
        schemaVersion: 1 as const,
        dispatchId: "dispatch-1",
        attempt: 1,
        projectId: "project-1",
        runId: "run-1",
        taskId: "task-1",
        targetNodeId: "node-1",
        installationId: "install-1",
        runtimeKind: "opencode",
        projectPathId: "path-1",
        prompt: "Build release",
        roleSnapshot: primaryRole,
        roleSnapshots: [primaryRole, secondaryRole],
        roleAssignments: [
          { roleId: "implementer", primary: true },
          { roleId: "release-manager", primary: false, addendum: "Verify semver tags before commit" },
        ],
        ruleSnapshots: [],
        contextManifest: { references: [], manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
        requestedCapabilities: ["filesystem.read", "filesystem.write", "process.exec"],
        permissionEnvelope: {
          allowedCapabilities: ["filesystem.read", "filesystem.write", "process.exec"],
          deniedCapabilities: [],
          approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
        },
        dependencies: [],
        timeoutSeconds: 30,
        controllerEpoch: 1,
      }

      const request = launchAgentRequestSchema.parse({
        schemaVersion: 1,
        operation: runtimeOperationContextSchema.parse({
          schemaVersion: 1,
          commandId: "cmd-1",
          correlationId: "corr-1",
          projectId: "project-1",
          runId: "run-1",
          dispatchId: "dispatch-1",
          nodeId: "node-1",
          controllerNodeId: "node-1",
          controllerEpoch: 1,
          leaseId: "lease-1",
        }),
        dispatchEnvelope: envelope,
        dispatchEnvelopeDigest: digestDispatchEnvelope(envelope),
        approvalId: "appr-1",
      })

      const launchResult = await adapter.launch(request)
      expect(launchResult.ok).toBe(true)

      expect(client.promptCalls).toHaveLength(1)
      const promptPolicy = client.promptCalls[0] as { system: string; tools: Record<string, boolean> }

      // Intersected allowed capability is filesystem.read only
      expect(promptPolicy.system).toContain("Approved capability envelope: filesystem.read")
      // Secondary addendum included
      expect(promptPolicy.system).toContain("Verify semver tags before commit")
      // Both roles mentioned in header
      expect(promptPolicy.system).toContain("Roles: Implementer, Release Manager")
      // Tools: write and bash are disabled because they were not in the intersection
      expect(promptPolicy.tools["write"]).toBe(false)
      expect(promptPolicy.tools["bash"]).toBe(false)
      expect(promptPolicy.tools["read"]).toBeUndefined()
    })
  })
})
