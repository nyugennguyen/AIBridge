import { describe, expect, it } from "vitest"
import { canonicalJson } from "../../../src/orchestration/digest.js"
import type { Digest } from "../../../src/orchestration/identifiers.js"
import {
  CharterIntegrityError,
  CharterNotFoundError,
  CharterRepository,
  CharterVersionConflictError,
  InvalidCharterVersionError,
  UnsupportedCharterVersionError,
  type CharterInput,
} from "../../../src/orchestration/charter/repository.js"
import { SAFETY_FLOOR } from "../../../src/orchestration/policy/floor.js"
import { computeImmutableCoreDigest } from "../../../src/orchestration/policy/immutable-core.js"
import {
  computeCharterSnapshotDigest,
  verifyCharterSnapshotDigest,
} from "../../../src/orchestration/schemas.js"

function makeBaseCharterInput(charterId = "profile-prod"): CharterInput {
  return {
    charterId,
    purpose: "Governs autonomous engineering herd deliberation for production deployments",
    globalRules: [
      "Never mutate deployment configuration without approval",
      "All roundtables must reach recommendation before dispatch.execute",
    ],
    communicationPolicy: {
      turnTaking: "chair_ordered",
      objectionRequiredBefore: ["dispatch.execute", "security.elevate"],
      verbosity: "normal",
      mustStopAndAsk: ["schema_migration", "external_api_call"],
      objectionMustContain: ["rationale", "risk_severity"],
    },
    escalationPolicy: {
      maxRounds: 5,
      onDeadlock: "chair_decides",
      budgetScope: "shared",
    },
    roleCatalog: [
      { roleId: "lead-architect", version: 1 },
      { roleId: "security-reviewer", version: 2 },
    ],
    author: "human",
  }
}

describe("CharterRepository (Plan §10, §15)", () => {
  describe("Creation and Stamping (Version 1)", () => {
    it("stamps version 1, immutableCoreDigest, and snapshotDigest on initial create", () => {
      const repo = new CharterRepository()
      const input = makeBaseCharterInput("profile-alpha")

      const charter = repo.createCharter(input)

      expect(charter.charterId).toBe("profile-alpha")
      expect(charter.version).toBe(1)
      expect(charter.author).toBe("human")
      expect(typeof charter.capturedAt).toBe("string")

      // Immutable core stamped from SAFETY_FLOOR at creation time
      const expectedCoreDigest = computeImmutableCoreDigest(SAFETY_FLOOR)
      expect(charter.immutableCoreDigest).toBe(expectedCoreDigest)

      // Snapshot digest stamped and valid
      expect(charter.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(verifyCharterSnapshotDigest(charter)).toBe(true)
      expect(repo.verifyCharter(charter)).toBe(true)

      // Retrievable from repo
      const stored = repo.getCharter("profile-alpha")
      expect(stored).toBeDefined()
      expect(stored?.version).toBe(1)
      expect(stored?.snapshotDigest).toBe(charter.snapshotDigest)
      expect(repo.hasCharter("profile-alpha", 1)).toBe(true)
    })

    it("defaults version to 1 when calling registerCharter without explicit version", () => {
      const repo = new CharterRepository()
      const charter = repo.registerCharter(makeBaseCharterInput("profile-beta"))

      expect(charter.version).toBe(1)
      expect(repo.count()).toBe(1)
      expect(repo.charterCount()).toBe(1)
    })

    it("accepts custom safetyFloor at creation time to derive immutableCoreDigest", () => {
      const repo = new CharterRepository()
      const customFloor = {
        ...SAFETY_FLOOR,
        maximumTimeoutSeconds: 1800,
      }
      const charter = repo.createCharter({
        ...makeBaseCharterInput("profile-custom-floor"),
        safetyFloor: customFloor,
      })

      const expectedCoreDigest = computeImmutableCoreDigest(customFloor)
      expect(charter.immutableCoreDigest).toBe(expectedCoreDigest)
      expect(repo.verifyCharter(charter)).toBe(true)
    })

    it("refuses createCharter when an explicit version other than 1 is provided", () => {
      const repo = new CharterRepository()
      expect(() => {
        repo.createCharter({
          ...makeBaseCharterInput("profile-gamma"),
          version: 2,
        })
      }).toThrow(InvalidCharterVersionError)
    })
  })

  describe("Revisions and Snapshot Immutability (§7.1, §15)", () => {
    it("increments to version 2; version 1 remains retrievable byte-identical", () => {
      const repo = new CharterRepository()
      const v1 = repo.createCharter(makeBaseCharterInput("profile-main"))
      const v1Digest = v1.snapshotDigest
      const v1Json = canonicalJson(v1)

      // Revise purpose and add a global rule
      const v2 = repo.reviseCharter("profile-main", {
        purpose: "Updated purpose for production herd",
        globalRules: [
          ...v1.globalRules,
          "Third rule: enforce strict audit log retention",
        ],
      })

      expect(v2.version).toBe(2)
      expect(v2.charterId).toBe("profile-main")
      expect(v2.purpose).toBe("Updated purpose for production herd")
      expect(v2.globalRules).toHaveLength(3)

      // Invariant (§7.3): immutable core digest is retained from v1
      expect(v2.immutableCoreDigest).toBe(v1.immutableCoreDigest)
      // v2 has a different snapshot digest than v1
      expect(v2.snapshotDigest).not.toBe(v1Digest)
      expect(repo.verifyCharter(v2)).toBe(true)

      // Version 1 is still retrievable and exactly byte-identical
      const retrievedV1 = repo.requireCharter("profile-main", 1)
      expect(retrievedV1.version).toBe(1)
      expect(retrievedV1.snapshotDigest).toBe(v1Digest)
      expect(canonicalJson(retrievedV1)).toBe(v1Json)

      // Latest points to version 2
      const latest = repo.getLatestCharter("profile-main")
      expect(latest?.version).toBe(2)

      // Sequential revisions list
      const versions = repo.listVersions("profile-main")
      expect(versions).toHaveLength(2)
      expect(versions.map((c) => c.version)).toEqual([1, 2])
    })

    it("allows third sequential revision (v3) retaining creation core digest", () => {
      const repo = new CharterRepository()
      repo.createCharter(makeBaseCharterInput("profile-monotonic"))
      repo.reviseCharter("profile-monotonic", { purpose: "Revision 2" })
      const v3 = repo.reviseCharter("profile-monotonic", { purpose: "Revision 3" })

      expect(v3.version).toBe(3)
      const v1 = repo.requireCharter("profile-monotonic", 1)
      expect(v3.immutableCoreDigest).toBe(v1.immutableCoreDigest)
      expect(repo.listVersions("profile-monotonic").map((c) => c.version)).toEqual([1, 2, 3])
    })

    it("refuses revision with non-sequential version jump", () => {
      const repo = new CharterRepository()
      repo.createCharter(makeBaseCharterInput("profile-seq"))

      expect(() => {
        repo.reviseCharter("profile-seq", {
          version: 4, // Next should be 2, not 4
          purpose: "Illegal jump",
        })
      }).toThrow(InvalidCharterVersionError)
    })

    it("refuses revision on non-existent charter", () => {
      const repo = new CharterRepository()
      expect(() => {
        repo.reviseCharter("does-not-exist", { purpose: "Update" })
      }).toThrow(CharterNotFoundError)
    })
  })

  describe("Conflict and Idempotence Discipline", () => {
    it("returns existing frozen document on idempotent re-registration", () => {
      const repo = new CharterRepository()
      const original = repo.createCharter(makeBaseCharterInput("profile-idem"))

      // Re-register exact same content at version 1
      const duplicate = repo.registerCharter({
        ...makeBaseCharterInput("profile-idem"),
        version: 1,
        capturedAt: original.capturedAt,
      })

      expect(duplicate).toBe(original)
      expect(repo.count()).toBe(1)
    })

    it("refuses conflicting write of an existing version with CharterVersionConflictError", () => {
      const repo = new CharterRepository()
      repo.createCharter(makeBaseCharterInput("profile-conflict"))

      // Attempt to overwrite version 1 with different purpose
      expect(() => {
        repo.registerCharter({
          ...makeBaseCharterInput("profile-conflict"),
          version: 1,
          purpose: "Conflicting different purpose",
        })
      }).toThrow(CharterVersionConflictError)

      // Contract error shape
      try {
        repo.registerCharter({
          ...makeBaseCharterInput("profile-conflict"),
          version: 1,
          purpose: "Conflicting different purpose",
        })
      } catch (err) {
        expect(err).toBeInstanceOf(CharterVersionConflictError)
        const conflictErr = err as CharterVersionConflictError
        expect(conflictErr.code).toBe("charter.version_conflict")
        expect(conflictErr.category).toBe("conflict")
        expect(conflictErr.charterId).toBe("profile-conflict")
        expect(conflictErr.version).toBe(1)
        expect(conflictErr.toContractError().code).toBe("charter.version_conflict")
      }
    })
  })

  describe("Tamper and Integrity Verification Discipline", () => {
    it("refuses read when purpose is tampered", () => {
      const repo = new CharterRepository()
      const original = repo.createCharter(makeBaseCharterInput("profile-tamper-1"))

      // Inject tampered copy with altered purpose
      repo._injectTamperedForTesting({
        ...original,
        purpose: "Tampered purpose payload",
      })

      expect(() => repo.getCharter("profile-tamper-1", 1)).toThrow(CharterIntegrityError)
      expect(() => repo.requireCharter("profile-tamper-1", 1)).toThrow(CharterIntegrityError)
      expect(() => repo.listVersions("profile-tamper-1")).toThrow(CharterIntegrityError)
    })

    it("refuses read when globalRules are tampered", () => {
      const repo = new CharterRepository()
      const original = repo.createCharter(makeBaseCharterInput("profile-tamper-2"))

      repo._injectTamperedForTesting({
        ...original,
        globalRules: ["Tampered rule"],
      })
      expect(() => repo.getCharter("profile-tamper-2", 1)).toThrow(CharterIntegrityError)
    })

    it("refuses read when immutableCoreDigest is tampered", () => {
      const repo = new CharterRepository()
      const original = repo.createCharter(makeBaseCharterInput("profile-tamper-3"))

      repo._injectTamperedForTesting({
        ...original,
        immutableCoreDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as Digest,
      })
      expect(() => repo.getCharter("profile-tamper-3", 1)).toThrow(CharterIntegrityError)
    })

    it("refuses read when communicationPolicy is tampered", () => {
      const repo = new CharterRepository()
      const original = repo.createCharter(makeBaseCharterInput("profile-tamper-4"))

      repo._injectTamperedForTesting({
        ...original,
        communicationPolicy: Object.freeze({
          ...original.communicationPolicy,
          turnTaking: "free_for_all",
        }),
      })

      expect(() => repo.getCharter("profile-tamper-4", 1)).toThrow(CharterIntegrityError)
    })

    it("refuses read when roleCatalog is tampered", () => {
      const repo = new CharterRepository()
      const original = repo.createCharter(makeBaseCharterInput("profile-tamper-5"))

      repo._injectTamperedForTesting({
        ...original,
        roleCatalog: [{ roleId: "injected-rogue-role", version: 1 }],
      })
      expect(() => repo.getCharter("profile-tamper-5", 1)).toThrow(CharterIntegrityError)
    })
  })

  describe("Unknown and Invalid Version Refusal", () => {
    it("returns undefined for non-existent charter or version on getCharter", () => {
      const repo = new CharterRepository()
      expect(repo.getCharter("does-not-exist")).toBeUndefined()

      repo.createCharter(makeBaseCharterInput("profile-exists"))
      expect(repo.getCharter("profile-exists", 99)).toBeUndefined()
    })

    it("throws CharterNotFoundError on requireCharter for missing charter or version", () => {
      const repo = new CharterRepository()
      expect(() => repo.requireCharter("does-not-exist")).toThrow(CharterNotFoundError)

      repo.createCharter(makeBaseCharterInput("profile-one"))
      expect(() => repo.requireCharter("profile-one", 99)).toThrow(CharterNotFoundError)
    })

    it("throws InvalidCharterVersionError (subclass of UnsupportedCharterVersionError) for non-positive or non-integer versions", () => {
      const repo = new CharterRepository()
      repo.createCharter(makeBaseCharterInput("profile-valid"))

      expect(() => repo.getCharter("profile-valid", 0)).toThrow(UnsupportedCharterVersionError)
      expect(() => repo.getCharter("profile-valid", 0)).toThrow(InvalidCharterVersionError)
      expect(() => repo.getCharter("profile-valid", -1)).toThrow(UnsupportedCharterVersionError)
      expect(() => repo.getCharter("profile-valid", 1.5)).toThrow(UnsupportedCharterVersionError)
      expect(() => repo.getCharter("profile-valid", NaN)).toThrow(UnsupportedCharterVersionError)
    })
  })

  describe("Deterministic Digest Computation and Freezing", () => {
    it("computes identical digests over identical charter documents", () => {
      const input = makeBaseCharterInput("profile-det")
      const fixedCapturedAt = "2026-10-13T12:00:00.000Z"
      const coreDigest = computeImmutableCoreDigest(SAFETY_FLOOR)

      const digest1 = computeCharterSnapshotDigest({
        ...input,
        version: 1,
        capturedAt: fixedCapturedAt,
        author: "human",
        immutableCoreDigest: coreDigest,
        globalRules: input.globalRules ?? [],
        roleCatalog: input.roleCatalog ?? [],
      })

      const digest2 = computeCharterSnapshotDigest({
        ...input,
        version: 1,
        capturedAt: fixedCapturedAt,
        author: "human",
        immutableCoreDigest: coreDigest,
        globalRules: input.globalRules ?? [],
        roleCatalog: input.roleCatalog ?? [],
      })

      expect(digest1).toBe(digest2)
      expect(digest1).toMatch(/^sha256:[a-f0-9]{64}$/)
    })

    it("deep freezes stored charters to prevent external mutation", () => {
      const repo = new CharterRepository()
      const charter = repo.createCharter(makeBaseCharterInput("profile-frozen"))

      expect(Object.isFrozen(charter)).toBe(true)
      expect(Object.isFrozen(charter.globalRules)).toBe(true)
      expect(Object.isFrozen(charter.communicationPolicy)).toBe(true)
      expect(Object.isFrozen(charter.escalationPolicy)).toBe(true)
      expect(Object.isFrozen(charter.roleCatalog)).toBe(true)

      // Strict mutation attempts fail
      expect(() => {
        charter.purpose = "Illegal mutate"
      }).toThrow()

      expect(() => {
        charter.globalRules.push("Illegal rule")
      }).toThrow()
    })
  })

  describe("Profile Scoping and Querying (§15)", () => {
    it("manages independent version sequences for separate profile charters", () => {
      const repo = new CharterRepository()
      repo.createCharter(makeBaseCharterInput("profile-dev"))
      repo.createCharter(makeBaseCharterInput("profile-prod"))

      repo.reviseCharter("profile-dev", { purpose: "Dev revision 2" })

      expect(repo.charterCount()).toBe(2)
      expect(repo.count()).toBe(3) // 2 for dev, 1 for prod

      expect(repo.getLatestCharter("profile-dev")?.version).toBe(2)
      expect(repo.getLatestCharter("profile-prod")?.version).toBe(1)

      expect(repo.listCharterIds()).toEqual(["profile-dev", "profile-prod"])
    })

    it("filters charters by author, query, and latestOnly", () => {
      const repo = new CharterRepository()
      repo.createCharter(makeBaseCharterInput("alpha-profile"))
      repo.createCharter({
        ...makeBaseCharterInput("beta-profile"),
        author: "agent",
        purpose: "Autonomous self-optimizing system",
      })

      const humanCharters = repo.listCharters({ author: "human" })
      expect(humanCharters).toHaveLength(1)
      expect(humanCharters[0].charterId).toBe("alpha-profile")

      const agentCharters = repo.listCharters({ author: "agent" })
      expect(agentCharters).toHaveLength(1)
      expect(agentCharters[0].charterId).toBe("beta-profile")

      const searchMatch = repo.listCharters({ query: "self-optimizing" })
      expect(searchMatch).toHaveLength(1)
      expect(searchMatch[0].charterId).toBe("beta-profile")
    })

    it("initializes from an array of initial charters and clears cleanly", () => {
      const c1 = makeBaseCharterInput("p1")
      const c2 = makeBaseCharterInput("p2")

      const repo = new CharterRepository([c1, c2])
      expect(repo.charterCount()).toBe(2)
      expect(repo.count()).toBe(2)

      repo.clear()
      expect(repo.charterCount()).toBe(0)
      expect(repo.count()).toBe(0)
      expect(repo.listCharterIds()).toEqual([])
    })
  })
})
