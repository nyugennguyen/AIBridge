import { describe, expect, it } from "vitest"
import {
  TEXT_MAX,
  roleAssignmentSchema,
  roleAssignmentsSchema,
  roleAssignmentSetSchema,
  assertExactlyOnePrimaryRole,
  validateRoleAssignments,
  canonicalizeRoleAssignments,
  computeRoleAssignmentsDigest,
  RoleAssignmentError,
  type RoleAssignment,
} from "../../../src/orchestration/schemas.js"
import type { Digest } from "../../../src/orchestration/identifiers.js"

describe("RoleAssignment schema and invariants (plan §6.2)", () => {
  describe("individual roleAssignmentSchema", () => {
    it("accepts valid primary role without addendum", () => {
      const parsed = roleAssignmentSchema.parse({
        roleId: "implementer",
        primary: true,
      })
      expect(parsed.roleId).toBe("implementer")
      expect(parsed.primary).toBe(true)
      expect(parsed.addendum).toBeUndefined()
    })

    it("accepts valid primary role with version and snapshotDigest", () => {
      const parsed = roleAssignmentSchema.parse({
        roleId: "implementer",
        primary: true,
        version: 1,
        snapshotDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      })
      expect(parsed.version).toBe(1)
      expect(parsed.snapshotDigest).toBe("sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
    })

    it("refuses primary role carrying an addendum", () => {
      expect(() =>
        roleAssignmentSchema.parse({
          roleId: "implementer",
          primary: true,
          addendum: "Instructions that should be in the role template",
        }),
      ).toThrow(/Primary role must not specify an addendum/)
    })

    it("accepts valid secondary role without addendum", () => {
      const parsed = roleAssignmentSchema.parse({
        roleId: "release-manager",
        primary: false,
      })
      expect(parsed.roleId).toBe("release-manager")
      expect(parsed.primary).toBe(false)
      expect(parsed.addendum).toBeUndefined()
    })

    it("accepts valid secondary role with bounded addendum", () => {
      const parsed = roleAssignmentSchema.parse({
        roleId: "release-manager",
        primary: false,
        addendum: "Always sign release artifacts before publishing.",
      })
      expect(parsed.addendum).toBe("Always sign release artifacts before publishing.")
    })

    it("accepts secondary addendum exactly at the TEXT_MAX byte cap boundary", () => {
      const exactCap = "a".repeat(TEXT_MAX)
      expect(Buffer.byteLength(exactCap, "utf8")).toBe(TEXT_MAX)

      const parsed = roleAssignmentSchema.parse({
        roleId: "reviewer",
        primary: false,
        addendum: exactCap,
      })
      expect(parsed.addendum).toBe(exactCap)
    })

    it("refuses secondary addendum exceeding the TEXT_MAX byte cap by 1 byte", () => {
      const overCap = "a".repeat(TEXT_MAX + 1)
      expect(Buffer.byteLength(overCap, "utf8")).toBe(TEXT_MAX + 1)

      expect(() =>
        roleAssignmentSchema.parse({
          roleId: "reviewer",
          primary: false,
          addendum: overCap,
        }),
      ).toThrow()
    })

    it("refuses secondary addendum where UTF-8 byte count exceeds TEXT_MAX despite character length being under", () => {
      // 3-byte unicode character: '€' takes 3 bytes in UTF-8
      // 1400 characters * 3 bytes = 4200 bytes > 4096 (TEXT_MAX), but 1400 < 4096 characters
      const multibyteOverCap = "€".repeat(1400)
      expect(multibyteOverCap.length).toBeLessThan(TEXT_MAX)
      expect(Buffer.byteLength(multibyteOverCap, "utf8")).toBeGreaterThan(TEXT_MAX)

      expect(() =>
        roleAssignmentSchema.parse({
          roleId: "reviewer",
          primary: false,
          addendum: multibyteOverCap,
        }),
      ).toThrow(/Addendum must not exceed 4096 bytes/)
    })
  })

  describe("assignment set validation: exactly-one-primary invariant", () => {
    it("refuses an empty assignment set with zero primaries", () => {
      expect(() => roleAssignmentsSchema.parse([])).toThrow(
        /Role assignments must contain exactly one primary role; found 0/,
      )

      expect(() => assertExactlyOnePrimaryRole([])).toThrow(RoleAssignmentError)
      expect(() => assertExactlyOnePrimaryRole([])).toThrow(
        /Role assignments must contain exactly one primary role; found 0/,
      )

      const res = validateRoleAssignments([])
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.code).toBe("role_assignment.invalid_primary_count")
      }
    })

    it("refuses an assignment set with all secondary roles (zero primaries)", () => {
      const assignments: RoleAssignment[] = [
        { roleId: "sec-1", primary: false, addendum: "note 1" },
        { roleId: "sec-2", primary: false, addendum: "note 2" },
      ]

      expect(() => roleAssignmentsSchema.parse(assignments)).toThrow(
        /Role assignments must contain exactly one primary role; found 0/,
      )
      expect(() => assertExactlyOnePrimaryRole(assignments)).toThrow(RoleAssignmentError)

      const res = validateRoleAssignments(assignments)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.message).toContain("found 0")
      }
    })

    it("refuses an assignment set with two primary roles", () => {
      const assignments: RoleAssignment[] = [
        { roleId: "lead", primary: true },
        { roleId: "implementer", primary: true },
      ]

      expect(() => roleAssignmentsSchema.parse(assignments)).toThrow(
        /Role assignments must contain exactly one primary role; found 2/,
      )
      expect(() => assertExactlyOnePrimaryRole(assignments)).toThrow(RoleAssignmentError)
      expect(() => assertExactlyOnePrimaryRole(assignments)).toThrow(
        /Role assignments must contain exactly one primary role; found 2/,
      )

      const res = validateRoleAssignments(assignments)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.message).toContain("found 2")
      }
    })

    it("refuses an assignment set with three primary roles", () => {
      const assignments: RoleAssignment[] = [
        { roleId: "role-1", primary: true },
        { roleId: "role-2", primary: true },
        { roleId: "role-3", primary: true },
      ]

      expect(() => roleAssignmentsSchema.parse(assignments)).toThrow(
        /Role assignments must contain exactly one primary role; found 3/,
      )
      expect(() => assertExactlyOnePrimaryRole(assignments)).toThrow(RoleAssignmentError)
      expect(() => assertExactlyOnePrimaryRole(assignments)).toThrow(
        /Role assignments must contain exactly one primary role; found 3/,
      )
    })

    it("accepts an assignment set with exactly one primary and no secondaries", () => {
      const assignments: RoleAssignment[] = [
        { roleId: "implementer", primary: true },
      ]

      const parsed = roleAssignmentsSchema.parse(assignments)
      expect(parsed).toHaveLength(1)
      expect(parsed[0].roleId).toBe("implementer")
      expect(parsed[0].primary).toBe(true)

      expect(() => assertExactlyOnePrimaryRole(assignments)).not.toThrow()
      const res = validateRoleAssignments(assignments)
      expect(res.ok).toBe(true)
    })

    it("accepts an assignment set with exactly one primary and multiple secondaries", () => {
      const assignments: RoleAssignment[] = [
        { roleId: "implementer", primary: true },
        { roleId: "reviewer", primary: false, addendum: "Check code style" },
        { roleId: "release-manager", primary: false, addendum: "Verify semantic version" },
      ]

      const parsed = roleAssignmentsSchema.parse(assignments)
      expect(parsed).toHaveLength(3)
      expect(() => assertExactlyOnePrimaryRole(assignments)).not.toThrow()
      const res = validateRoleAssignments(assignments)
      expect(res.ok).toBe(true)
    })

    it("refuses an assignment set with duplicate role IDs", () => {
      const assignments: RoleAssignment[] = [
        { roleId: "implementer", primary: true },
        { roleId: "implementer", primary: false, addendum: "duplicate" },
      ]

      expect(() => roleAssignmentsSchema.parse(assignments)).toThrow(
        /Role assignments must have unique role IDs/,
      )

      const res = validateRoleAssignments(assignments)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.code).toBe("role_assignment.duplicate_role_id")
      }
    })

    it("roleAssignmentSetSchema is an alias of roleAssignmentsSchema", () => {
      const valid = [{ roleId: "solo", primary: true }]
      expect(roleAssignmentSetSchema.parse(valid)).toEqual(roleAssignmentsSchema.parse(valid))
    })
  })

  describe("RoleBinder stamping support and determinism (plan §7.1)", () => {
    it("canonicalizeRoleAssignments places primary first, then sorts secondaries by roleId", () => {
      const assignments: RoleAssignment[] = [
        { roleId: "zeta", primary: false, addendum: "z" },
        { roleId: "alpha", primary: false, addendum: "a" },
        { roleId: "mid-primary", primary: true },
      ]

      const canonical = canonicalizeRoleAssignments(assignments)
      expect(canonical).toHaveLength(3)
      expect(canonical[0].roleId).toBe("mid-primary")
      expect(canonical[0].primary).toBe(true)
      expect(canonical[1].roleId).toBe("alpha")
      expect(canonical[2].roleId).toBe("zeta")
    })

    it("computeRoleAssignmentsDigest produces identical digest regardless of input order", () => {
      const setA: RoleAssignment[] = [
        { roleId: "lead", primary: true, version: 1, snapshotDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111" as Digest },
        { roleId: "auditor", primary: false, addendum: "audit checks", version: 2 },
        { roleId: "deployer", primary: false, addendum: "deploy checks", version: 1 },
      ]

      const setB: RoleAssignment[] = [
        { roleId: "deployer", primary: false, addendum: "deploy checks", version: 1 },
        { roleId: "lead", primary: true, version: 1, snapshotDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111" as Digest },
        { roleId: "auditor", primary: false, addendum: "audit checks", version: 2 },
      ]

      const digestA = computeRoleAssignmentsDigest(setA)
      const digestB = computeRoleAssignmentsDigest(setB)

      expect(digestA).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(digestA).toBe(digestB)
    })
  })
})
