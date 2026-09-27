import { readFileSync as readFile } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { canonicalJson, digestJson } from "../../../src/orchestration/digest.js"
import {
  computeRoleSnapshotDigest,
  InvalidRoleVersionError,
  RoleNotFoundError,
  RoleRepository,
  RoleVersionConflictError,
  validateCompatibility,
  verifySnapshotDigest,
  type RoleSnapshot,
  type RoleTemplateInput,
} from "../../../src/orchestration/roles/index.js"
import { roleTemplateSchema } from "../../../src/orchestration/schemas.js"

function loadExampleRoleFixture(): unknown {
  const filepath = resolve(process.cwd(), "tests/contracts/examples/role.v1.json")
  return JSON.parse(readFile(filepath, "utf8"))
}

describe("RoleRepository and Role Versioning (M3.5)", () => {
  describe("Append-only version incrementing", () => {
    it("assigns version 1 on initial role registration", () => {
      const repo = new RoleRepository()
      const role = repo.registerRole({
        roleId: "developer",
        name: "Software Developer",
        description: "Develops application features",
        capabilities: ["code.read", "code.write"],
      })

      expect(role.roleId).toBe("developer")
      expect(role.version).toBe(1)
      expect(role.templateVersion).toBe(1)
      expect(role.capabilities).toEqual(["code.read", "code.write"])
      expect(role.requiredCapabilities).toEqual(["code.read", "code.write"])
      expect(repo.hasRole("developer", 1)).toBe(true)
      expect(repo.hasRole("developer")).toBe(true)
    })

    it("increments versions sequentially (v1 -> v2 -> v3) via updateRole", () => {
      const repo = new RoleRepository()
      const v1 = repo.registerRole({
        roleId: "reviewer",
        name: "Code Reviewer v1",
        description: "Reviews code changes",
        capabilities: ["code.read"],
      })
      expect(v1.version).toBe(1)

      const v2 = repo.updateRole("reviewer", {
        name: "Code Reviewer v2",
        capabilities: ["code.read", "pr.comment"],
      })
      expect(v2.version).toBe(2)
      expect(v2.capabilities).toEqual(["code.read", "pr.comment"])

      const v3 = repo.updateRole("reviewer", {
        name: "Code Reviewer v3",
        capabilities: ["code.read", "pr.comment", "pr.approve"],
      })
      expect(v3.version).toBe(3)
      expect(v3.capabilities).toEqual(["code.read", "pr.comment", "pr.approve"])

      const versions = repo.listVersions("reviewer")
      expect(versions).toHaveLength(3)
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3])

      expect(repo.getLatestRole("reviewer")?.version).toBe(3)
      expect(repo.getRole("reviewer", 1)?.name).toBe("Code Reviewer v1")
      expect(repo.getRole("reviewer", 2)?.name).toBe("Code Reviewer v2")
      expect(repo.getRole("reviewer", 3)?.name).toBe("Code Reviewer v3")
    })

    it("allows registering explicit sequential version numbers with registerRole", () => {
      const repo = new RoleRepository()
      const v1 = repo.registerRole({
        roleId: "tester",
        version: 1,
        name: "QA Tester",
        capabilities: ["test.run"],
      })
      expect(v1.version).toBe(1)

      const v2 = repo.registerRole({
        roleId: "tester",
        version: 2,
        name: "Senior QA Tester",
        capabilities: ["test.run", "test.write"],
      })
      expect(v2.version).toBe(2)
    })

    it("rejects version gaps when registering explicit versions", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "agent-x",
        version: 1,
        name: "Agent X",
        capabilities: ["read"],
      })

      expect(() => {
        repo.registerRole({
          roleId: "agent-x",
          version: 3,
          name: "Agent X v3 skipping v2",
          capabilities: ["read", "write"],
        })
      }).toThrow(InvalidRoleVersionError)
    })

    it("rejects non-positive and non-integer version numbers", () => {
      const repo = new RoleRepository()

      expect(() => {
        repo.registerRole({
          roleId: "bad-version",
          version: 0,
          name: "Bad Zero",
          capabilities: ["read"],
        })
      }).toThrow(InvalidRoleVersionError)

      expect(() => {
        repo.registerRole({
          roleId: "bad-version",
          version: -1,
          name: "Bad Negative",
          capabilities: ["read"],
        })
      }).toThrow(InvalidRoleVersionError)

      expect(() => {
        repo.registerRole({
          roleId: "bad-version",
          version: 1.5,
          name: "Bad Decimal",
          capabilities: ["read"],
        })
      }).toThrow(InvalidRoleVersionError)
    })

    it("throws RoleNotFoundError when updating a non-existent role", () => {
      const repo = new RoleRepository()
      expect(() => {
        repo.updateRole("non-existent", { name: "Ghost" })
      }).toThrow(RoleNotFoundError)
    })
  })

  describe("Overwrite prevention on existing version numbers", () => {
    it("throws RoleVersionConflictError when re-registering an existing version with different name", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "worker",
        version: 1,
        name: "Worker Initial",
        capabilities: ["task.execute"],
      })

      expect(() => {
        repo.registerRole({
          roleId: "worker",
          version: 1,
          name: "Worker Mutated",
          capabilities: ["task.execute"],
        })
      }).toThrow(RoleVersionConflictError)

      try {
        repo.registerRole({
          roleId: "worker",
          version: 1,
          name: "Worker Mutated",
          capabilities: ["task.execute"],
        })
      } catch (err) {
        expect(err).toBeInstanceOf(RoleVersionConflictError)
        const conflictErr = err as RoleVersionConflictError
        expect(conflictErr.code).toBe("role.version_conflict")
        expect(conflictErr.category).toBe("conflict")
        expect(conflictErr.roleId).toBe("worker")
        expect(conflictErr.version).toBe(1)
        expect(conflictErr.toContractError()).toEqual({
          schemaVersion: 1,
          category: "conflict",
          code: "role.version_conflict",
          message: expect.stringContaining("role.version_conflict"),
          retryable: false,
        })
      }
    })

    it("throws RoleVersionConflictError when re-registering an existing version with different capabilities", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "worker",
        version: 1,
        name: "Worker",
        capabilities: ["read"],
      })

      expect(() => {
        repo.registerRole({
          roleId: "worker",
          version: 1,
          name: "Worker",
          capabilities: ["read", "write"],
        })
      }).toThrow("role.version_conflict")
    })

    it("throws RoleVersionConflictError when re-registering an existing version with different rules or metadata", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "worker",
        version: 1,
        name: "Worker",
        capabilities: ["read"],
        rules: ["rule-a"],
        metadata: { env: "prod" },
      })

      expect(() => {
        repo.registerRole({
          roleId: "worker",
          version: 1,
          name: "Worker",
          capabilities: ["read"],
          rules: ["rule-b"],
          metadata: { env: "prod" },
        })
      }).toThrow("role.version_conflict")

      expect(() => {
        repo.registerRole({
          roleId: "worker",
          version: 1,
          name: "Worker",
          capabilities: ["read"],
          rules: ["rule-a"],
          metadata: { env: "staging" },
        })
      }).toThrow("role.version_conflict")
    })

    it("succeeds idempotently when registering identical content for an existing version", () => {
      const repo = new RoleRepository()
      const role1 = repo.registerRole({
        roleId: "idempotent-role",
        version: 1,
        name: "Idempotent Role",
        description: "Always the same",
        capabilities: ["read", "write"],
        rules: ["rule-1"],
        metadata: { tier: 1 },
        createdAt: "2026-09-28T00:00:00.000Z",
      })

      const role2 = repo.registerRole({
        roleId: "idempotent-role",
        version: 1,
        name: "Idempotent Role",
        description: "Always the same",
        capabilities: ["read", "write"],
        rules: ["rule-1"],
        metadata: { tier: 1 },
        createdAt: "2026-09-28T00:00:00.000Z",
      })

      expect(role2).toBe(role1)
      expect(repo.listVersions("idempotent-role")).toHaveLength(1)
    })
  })

  describe("Deterministic snapshot creation and digest verification", () => {
    it("produces a valid RoleSnapshot with canonical digest format sha256:...", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "analyst",
        version: 1,
        name: "Data Analyst",
        description: "Analyzes datasets",
        capabilities: ["data.read", "report.generate"],
        rules: [],
        createdAt: "2026-09-28T01:00:00.000Z",
      })

      const snapshot = repo.createSnapshot("analyst", 1)
      expect(snapshot.roleId).toBe("analyst")
      expect(snapshot.version).toBe(1)
      expect(snapshot.capabilities).toEqual(["data.read", "report.generate"])
      expect(snapshot.rules).toEqual([])
      expect(snapshot.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(snapshot.capturedAt).toBe("2026-09-28T01:00:00.000Z")
    })

    it("produces identical digests when creating snapshots repeatedly", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "builder",
        version: 1,
        name: "System Builder",
        capabilities: ["build.compile", "build.package"],
        rules: ["no-root"],
        metadata: { isolated: true },
        createdAt: "2026-09-28T00:00:00.000Z",
      })

      const snap1 = repo.createSnapshot("builder", 1)
      const snap2 = repo.createSnapshot("builder", 1)

      expect(snap1.snapshotDigest).toBe(snap2.snapshotDigest)
      expect(verifySnapshotDigest(snap1)).toBe(true)
      expect(verifySnapshotDigest(snap2)).toBe(true)
      expect(repo.verifySnapshot(snap1)).toBe(true)
    })

    it("computes digest matching computeRoleSnapshotDigest exactly", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "coder",
        version: 1,
        name: "Coder",
        capabilities: ["read", "write"],
      })

      const snapshot = repo.createSnapshot("coder", 1)
      const expectedDigest = computeRoleSnapshotDigest({
        roleId: snapshot.roleId,
        version: snapshot.version,
        capabilities: snapshot.capabilities,
        rules: snapshot.rules,
      })

      expect(snapshot.snapshotDigest).toBe(expectedDigest)
    })

    it("fails digest verification if snapshot data is tampered with", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "secure-role",
        version: 1,
        name: "Secure Role",
        capabilities: ["read"],
      })

      const genuine = repo.createSnapshot("secure-role", 1)
      expect(verifySnapshotDigest(genuine)).toBe(true)

      const tamperedCaps: RoleSnapshot = {
        ...genuine,
        capabilities: ["read", "escalate-privilege"],
      }
      expect(verifySnapshotDigest(tamperedCaps)).toBe(false)
      expect(repo.verifySnapshot(tamperedCaps)).toBe(false)

      const tamperedVersion: RoleSnapshot = {
        ...genuine,
        version: 2,
      }
      expect(verifySnapshotDigest(tamperedVersion)).toBe(false)

      const tamperedDigest: RoleSnapshot = {
        ...genuine,
        snapshotDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as any,
      }
      expect(verifySnapshotDigest(tamperedDigest)).toBe(false)
    })

    it("creates snapshot of the latest version when version parameter is omitted", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "poly",
        name: "Poly v1",
        capabilities: ["c1"],
      })
      repo.updateRole("poly", {
        name: "Poly v2",
        capabilities: ["c1", "c2"],
      })

      const latestSnap = repo.createSnapshot("poly")
      expect(latestSnap.version).toBe(2)
      expect(latestSnap.capabilities).toEqual(["c1", "c2"])
    })
  })

  describe("Immutability proof: creating v2 does not mutate v1 snapshot or change v1 canonical digest", () => {
    it("ensures v1 snapshot remains immutable and byte-for-byte identical after v2 and v3 are created", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "immutable-check",
        version: 1,
        name: "Original Role",
        description: "Initial role specifications",
        capabilities: ["read.only"],
        rules: ["rule-v1"],
        metadata: { versionTag: "1.0.0" },
        createdAt: "2026-09-28T01:00:00.000Z",
      })

      const v1Snapshot = repo.createSnapshot("immutable-check", 1)
      const v1Digest = v1Snapshot.snapshotDigest
      const v1CanonicalBefore = canonicalJson(v1Snapshot)

      expect(Object.isFrozen(v1Snapshot)).toBe(true)
      expect(Object.isFrozen(v1Snapshot.capabilities)).toBe(true)
      expect(Object.isFrozen(v1Snapshot.rules)).toBe(true)

      expect(() => {
        ;(v1Snapshot.capabilities as string[]).push("unauthorized.write")
      }).toThrow(TypeError)

      expect(() => {
        ;(v1Snapshot as any).version = 99
      }).toThrow(TypeError)

      const v2 = repo.updateRole("immutable-check", {
        name: "Evolved Role v2",
        description: "Added write operations",
        capabilities: ["read.only", "write.permitted"],
        rules: ["rule-v1", "rule-v2"],
        metadata: { versionTag: "2.0.0" },
        createdAt: "2026-09-28T02:00:00.000Z",
      })
      expect(v2.version).toBe(2)

      const v3 = repo.updateRole("immutable-check", {
        name: "Evolved Role v3",
        capabilities: ["read.only", "write.permitted", "admin.privilege"],
        rules: ["rule-v1", "rule-v2", "rule-v3"],
        metadata: { versionTag: "3.0.0" },
        createdAt: "2026-09-28T03:00:00.000Z",
      })
      expect(v3.version).toBe(3)

      expect(v1Snapshot.version).toBe(1)
      expect(v1Snapshot.capabilities).toEqual(["read.only"])
      expect(v1Snapshot.rules).toEqual(["rule-v1"])
      expect(v1Snapshot.snapshotDigest).toBe(v1Digest)
      expect(canonicalJson(v1Snapshot)).toBe(v1CanonicalBefore)

      const v1FreshSnapshot = repo.createSnapshot("immutable-check", 1)
      expect(v1FreshSnapshot.snapshotDigest).toBe(v1Digest)
      expect(v1FreshSnapshot.capabilities).toEqual(["read.only"])
      expect(v1FreshSnapshot.version).toBe(1)
      expect(canonicalJson(v1FreshSnapshot)).toBe(v1CanonicalBefore)

      const v2Snapshot = repo.createSnapshot("immutable-check", 2)
      expect(v2Snapshot.version).toBe(2)
      expect(v2Snapshot.snapshotDigest).not.toBe(v1Digest)
      expect(v2Snapshot.capabilities).toEqual(["read.only", "write.permitted"])
      expect(verifySnapshotDigest(v2Snapshot)).toBe(true)

      const v3Snapshot = repo.createSnapshot("immutable-check", 3)
      expect(v3Snapshot.version).toBe(3)
      expect(v3Snapshot.snapshotDigest).not.toBe(v2Snapshot.snapshotDigest)
      expect(v3Snapshot.snapshotDigest).not.toBe(v1Digest)
      expect(verifySnapshotDigest(v3Snapshot)).toBe(true)
    })
  })

  describe("Compatibility validation with permission and capability requirements", () => {
    it("validates when all required capabilities are satisfied", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "worker",
        version: 1,
        name: "Worker",
        capabilities: ["read", "write", "execute"],
      })
      const snapshot = repo.createSnapshot("worker", 1)

      const result = validateCompatibility(snapshot, ["read", "write"])
      expect(result.compatible).toBe(true)
      expect(result.ok).toBe(true)
      expect(result.satisfiedCapabilities).toEqual(["read", "write"])
      expect(result.missingCapabilities).toEqual([])
      expect(result.prohibitedCapabilities).toEqual([])
      expect(result.reasons).toEqual([])
      expect(result.errors).toEqual([])
    })

    it("reports missing capabilities when role lacks required capabilities", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "readonly-worker",
        version: 1,
        name: "ReadOnly Worker",
        capabilities: ["read"],
      })
      const snapshot = repo.createSnapshot("readonly-worker", 1)

      const result = validateCompatibility(snapshot, {
        requiredCapabilities: ["read", "write", "network.outbound"],
      })
      expect(result.compatible).toBe(false)
      expect(result.ok).toBe(false)
      expect(result.satisfiedCapabilities).toEqual(["read"])
      expect(result.missingCapabilities).toEqual(["write", "network.outbound"])
      expect(result.reasons).toContain("Missing required capability: 'write'")
      expect(result.reasons).toContain("Missing required capability: 'network.outbound'")
    })

    it("rejects when role possesses capabilities prohibited by deniedCapabilities constraint", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "privileged-worker",
        version: 1,
        name: "Privileged Worker",
        capabilities: ["read", "filesystem.write", "destructive.delete"],
      })
      const snapshot = repo.createSnapshot("privileged-worker", 1)

      const result = validateCompatibility(snapshot, {
        requiredCapabilities: ["read"],
        deniedCapabilities: ["destructive.delete"],
      })
      expect(result.compatible).toBe(false)
      expect(result.prohibitedCapabilities).toEqual(["destructive.delete"])
      expect(result.reasons).toContain("Role grants prohibited capability: 'destructive.delete'")
    })

    it("enforces allowedCapabilities ceiling: rejects role capabilities exceeding ceiling", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "broad-role",
        version: 1,
        name: "Broad Role",
        capabilities: ["read", "write", "network.send"],
      })
      const snapshot = repo.createSnapshot("broad-role", 1)

      const resultBlocked = validateCompatibility(snapshot, {
        requiredCapabilities: ["read"],
        allowedCapabilities: ["read", "write"],
      })
      expect(resultBlocked.compatible).toBe(false)
      expect(resultBlocked.prohibitedCapabilities).toContain("network.send")
      expect(resultBlocked.reasons).toContain("Role capability 'network.send' exceeds allowed capability ceiling")

      const resultAllowed = validateCompatibility(snapshot, {
        requiredCapabilities: ["read"],
        allowedCapabilities: ["read", "write", "network.send", "network.receive"],
      })
      expect(resultAllowed.compatible).toBe(true)
    })

    it("enforces role restrictive rules (canonical ruleSchema with effect: restrict)", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "restricted-worker",
        version: 1,
        name: "Restricted Worker",
        capabilities: ["code.read", "code.write", "network.outbound"],
        rules: [
          {
            schemaVersion: 1,
            ruleId: "deny-network-rule",
            templateVersion: 1,
            projectId: "proj-1",
            enabled: true,
            match: {},
            effect: {
              kind: "restrict",
              deniedCapabilities: ["network.outbound"],
              requireApprovalForDestructiveEffects: true,
              requireApprovalForExternalEffects: true,
            },
            author: { kind: "system", name: "policy-engine" },
            createdAt: "2026-09-28T00:00:00.000Z",
          },
        ],
      })
      const snapshot = repo.createSnapshot("restricted-worker", 1)

      const result = repo.validateCompatibility(snapshot, {
        requiredCapabilities: ["code.read", "network.outbound"],
      })
      expect(result.compatible).toBe(false)
      expect(result.missingCapabilities).toContain("network.outbound")
      expect(result.reasons).toContain("Capability 'network.outbound' is restricted by role rule 'deny-network-rule'")
    })

    it("enforces string deny rules (deny:<capability>)", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "string-ruled",
        version: 1,
        name: "String Ruled",
        capabilities: ["read", "deploy"],
        rules: ["deny:deploy"],
      })
      const snapshot = repo.createSnapshot("string-ruled", 1)

      const result = validateCompatibility(snapshot, ["read", "deploy"])
      expect(result.compatible).toBe(false)
      expect(result.missingCapabilities).toContain("deploy")
      expect(result.reasons).toContain("Capability 'deploy' is denied by string rule 'deny:deploy'")
    })
  })

  describe("Contract example integration & role filtering", () => {
    it("loads, stores, and snapshots canonical role.v1.json contract fixture", () => {
      const fixtureRaw = loadExampleRoleFixture()
      const canonicalRole = roleTemplateSchema.parse(fixtureRaw)

      const repo = new RoleRepository()
      const registered = repo.registerRole(canonicalRole as any)

      expect(registered.roleId).toBe("role-contract")
      expect(registered.version).toBe(1)
      expect(registered.templateVersion).toBe(1)
      expect(registered.name).toBe("Contract implementer")
      expect(registered.capabilities).toEqual(["read"])
      expect(registered.requiredCapabilities).toEqual(["read"])

      const snapshot = repo.createSnapshot("role-contract", 1)
      expect(snapshot.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(verifySnapshotDigest(snapshot)).toBe(true)

      const compatRead = validateCompatibility(snapshot, ["read"])
      expect(compatRead.compatible).toBe(true)

      const compatWrite = validateCompatibility(snapshot, ["write"])
      expect(compatWrite.compatible).toBe(false)
      expect(compatWrite.missingCapabilities).toEqual(["write"])
    })

    it("filters roles by roleId, capability, name, and latestOnly", () => {
      const repo = new RoleRepository()
      repo.registerRole({
        roleId: "dev",
        name: "Fullstack Developer",
        capabilities: ["git", "node", "docker"],
      })
      repo.updateRole("dev", {
        name: "Senior Fullstack Developer",
        capabilities: ["git", "node", "docker", "k8s"],
      })
      repo.registerRole({
        roleId: "qa",
        name: "QA Specialist",
        capabilities: ["git", "testing"],
      })

      expect(repo.count()).toBe(3)
      expect(repo.roleCount()).toBe(2)
      expect(repo.listRoleIds()).toEqual(["dev", "qa"])

      const gitRoles = repo.listRoles({ capability: "git" })
      expect(gitRoles).toHaveLength(3)

      const latestOnly = repo.listRoles({ latestOnly: true })
      expect(latestOnly).toHaveLength(2)
      expect(latestOnly.find((r) => r.roleId === "dev")?.name).toBe("Senior Fullstack Developer")

      const k8sRoles = repo.listRoles({ capability: "k8s" })
      expect(k8sRoles).toHaveLength(1)
      expect(k8sRoles[0]?.roleId).toBe("dev")

      const searchSpecialist = repo.listRoles({ query: "specialist" })
      expect(searchSpecialist).toHaveLength(1)
      expect(searchSpecialist[0]?.roleId).toBe("qa")
    })
  })
})
