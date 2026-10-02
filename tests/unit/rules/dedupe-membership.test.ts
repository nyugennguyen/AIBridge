/**
 * Set membership compares over DEDUPED members, on all three set-subject axes.
 *
 * THE DEFECT. `evaluateSetPredicate` built `present` by filtering the RAW
 * `predicate.value` array and then compared `present.length` to
 * `declared.size` — where `declared` is a `Set`, and so counts each member once.
 * The two disagreed about multiplicity, and the `all` branch's comparison
 * `present.length === declared.size` was therefore INVERTED by a duplicate:
 *
 *   declared `["fs.read", "net.fetch", "fs.read"]`, request for `["fs.read"]`
 *     -> present = ["fs.read", "fs.read"] (length 2), declared.size = 2
 *     -> SATISFIED. A conjunction needing both capabilities matched a dispatch
 *        that needs one.
 *
 *   declared `["fs.read", "net.fetch", "fs.read"]`, request for BOTH
 *     -> present = all three (length 3), declared.size = 2
 *     -> REFUSED. The request the rule was written for did not match.
 *
 * That is a fail-OPEN matcher bug on the object where an over-broad match is
 * most expensive — a pre-approval matcher — and it failed in the direction that
 * grants. It was reported as a disclosure mismatch first; the grant is the
 * substance.
 *
 * THE FIX. `present` and `missing` are built over the deduped `declared` set,
 * and the `all` branch tests `missing.length === 0`. A set is a set: writing a
 * member twice cannot make the conjunction weaker, and cannot make it
 * unsatisfiable either.
 *
 * WHY ALL THREE AXES. `capability`, `toolCategory` and `nodeAdvertisedCapability`
 * share `SET_SUBJECT` and `evaluateSetPredicate` exactly. Testing one axis
 * leaves the other two untested, and a future change that special-cased
 * `capability` would be invisible. The equality property — a duplicate form and
 * its deduped twin match EXACTLY the same dispatches — is therefore asserted
 * per axis, per operator, and per duplicate placement, rather than once.
 *
 * AND THE DIGEST. `normalizePredicateNode` renders a member list through
 * `sortedUnique`, so the duplicate form and its deduped twin already produce the
 * same normalized text and the same rule digest. Before the fix that was an
 * audit-integrity defect of its own: two rules the digest declared identical
 * were evaluated differently. It is asserted here so the digest and the
 * evaluator cannot drift apart again.
 *
 * EACH AXIS IS EXERCISED WITH ITS OWN TWO MEMBERS, because a table written once
 * against `fs.read`/`net.fetch` and replayed for `toolCategory` would be testing
 * `capability` three times.
 */

import { describe, expect, it } from "vitest"
import {
  compileRule,
  compileRuleSet,
  describePredicates,
  evaluateRules,
  type CompiledRuleSet,
} from "../../../src/rules/index.js"
import { rawRuleDocument, validContext } from "./fixtures.js"

/** A member no declared list names and no request carries in these tests. */
const ABSENT = "unlisted-capability"

/** The three axes `evaluateSetPredicate` answers for, and the context field each reads. */
const AXES = [
  { field: "capability", contextField: "requestedCapabilities", first: "fs.read", second: "net.fetch", nullable: false },
  { field: "toolCategory", contextField: "toolCategories", first: "shell", second: "fs", nullable: false },
  { field: "nodeAdvertisedCapability", contextField: "nodeAdvertisedCapabilities", first: "gpu", second: "fs.read", nullable: true },
] as const

type Operator = "any" | "all" | "none"

/** A deny rule carrying one set predicate. A deny is used because the ACTION cannot itself affect the match outcome. */
function setPredicateDocument(field: string, operator: Operator, declared: readonly string[]): Record<string, unknown> {
  return rawRuleDocument({
    ruleId: "rule-set",
    predicates: [{ field, operator, value: [...declared] }],
    actions: [{ kind: "deny_with_reason", reason: "x" }],
  })
}

function compileSet(document: Record<string, unknown>): CompiledRuleSet {
  const compiled = compileRuleSet([document])
  if (!compiled.ok) throw new Error(`fixture failed to compile: ${compiled.error.code} ${compiled.error.message}`)
  return compiled.value
}

/** The predicates the compiler kept on the compiled rule, which is what the disclosure renders. */
function sourcePredicatesOf(document: Record<string, unknown>): CompiledRuleSet["rules"][number]["source"]["predicates"] {
  const rule = compileSet(document).rules[0]
  if (rule === undefined) throw new Error("the compiled set carried no rule")
  return rule.source.predicates
}

/** The match outcome of the single rule in the set, for one request on one axis. */
function outcome(set: CompiledRuleSet, contextField: string, requested: readonly string[] | null): string | undefined {
  return evaluateRules(set, validContext({ [contextField]: requested === null ? null : [...requested] })).traces[0]?.matchOutcome
}

/** Every duplicate spelling of one axis's two members, in the order a test reads best. */
function declarationsOf(first: string, second: string): readonly { readonly label: string; readonly value: readonly string[] }[] {
  return [
    { label: "deduped", value: [first, second] },
    { label: "duplicated in blocks", value: [first, first, first, second, second, second] },
    { label: "duplicated leading", value: [first, first, second] },
    { label: "duplicated trailing", value: [first, second, second] },
    { label: "duplicated interleaved", value: [first, second, first] },
    { label: "both members tripled in reverse order", value: [second, second, second, first, first, first] },
  ]
}

/** Every request worth asking, for one axis. */
function requestsOf(first: string, second: string): readonly (readonly string[])[] {
  return [[first], [second], [first, second], [second, first], [ABSENT], [first, second, ABSENT], []]
}

/**
 * The truth table, written out by hand.
 *
 * Written from the MEANING of the operator rather than from the implementation,
 * which is the only way this table can catch an inverted comparison: a
 * reimplementation of the same expression would agree with the bug.
 */
const EXPECTED: Readonly<Record<Operator, (declared: readonly string[], requested: readonly string[]) => boolean>> = {
  any: (declared, requested) => declared.some((member) => requested.includes(member)),
  all: (declared, requested) => declared.every((member) => requested.includes(member)),
  none: (declared, requested) => !declared.some((member) => requested.includes(member)),
}

// ===========================================================================
// `all` — the operator the defect inverted
// ===========================================================================

describe("a set `all` is satisfied by a request carrying every declared member, and by nothing else", () => {
  it("does not accept a request for ONE member of a two-member conjunction, whatever the declaration's multiplicity", () => {
    // THE REGRESSION. Before the fix, `["fs.read", "net.fetch", "fs.read"]` was
    // SATISFIED by a request for `["fs.read"]` alone.
    for (const axis of AXES) {
      for (const declaration of declarationsOf(axis.first, axis.second)) {
        const set = compileSet(setPredicateDocument(axis.field, "all", declaration.value))
        expect(
          outcome(set, axis.contextField, [axis.first]),
          `${axis.field} all ${JSON.stringify(declaration.value)} (${declaration.label}) must not be satisfied by a request for ${axis.first} alone`,
        ).toBe("not_matched")
      }
    }
  })

  it("accepts a request carrying EVERY declared member, whatever the declaration's multiplicity", () => {
    // The other half. Before the fix this was REFUSED: a request carrying both
    // did not match a rule written for a request carrying both.
    for (const axis of AXES) {
      for (const declaration of declarationsOf(axis.first, axis.second)) {
        const set = compileSet(setPredicateDocument(axis.field, "all", declaration.value))
        expect(
          outcome(set, axis.contextField, [axis.first, axis.second]),
          `${axis.field} all ${JSON.stringify(declaration.value)} (${declaration.label}) must be satisfied by a request for both members`,
        ).toBe("matched")
      }
    }
  })

  it("refuses a request that names an unlisted member INSTEAD OF one it did, because the conjunction is about the members it named", () => {
    for (const axis of AXES) {
      for (const declaration of declarationsOf(axis.first, axis.second)) {
        const set = compileSet(setPredicateDocument(axis.field, "all", declaration.value))
        expect(
          outcome(set, axis.contextField, [ABSENT, axis.first]),
          `${axis.field} all ${JSON.stringify(declaration.value)} (${declaration.label}) must not be satisfied by ${ABSENT} plus one member`,
        ).toBe("not_matched")
      }
    }
  })

  it("treats a single-member declaration as a single-member conjunction, duplicated or not", () => {
    // `all` of one member is the case a duplicate most easily breaks: the whole
    // conjunction hinges on the one member, and a multiplicity error in either
    // direction is unmissable here.
    for (const axis of AXES) {
      for (const declared of [[axis.first], [axis.first, axis.first, axis.first]]) {
        const set = compileSet(setPredicateDocument(axis.field, "all", declared))
        expect(outcome(set, axis.contextField, [axis.first]), `${axis.field} all ${JSON.stringify(declared)} on its own member`).toBe("matched")
        expect(outcome(set, axis.contextField, [ABSENT]), `${axis.field} all ${JSON.stringify(declared)} on an absent member`).toBe("not_matched")
      }
    }
  })
})

// ===========================================================================
// `any` and `none`
// ===========================================================================

describe("a set `any` and a set `none` read the declared members as a set, so a duplicate changes nothing", () => {
  for (const operator of ["any", "none"] as const) {
    it(`answers \`${operator}\` from the MEANING of the operator, for every declaration and every request, on every axis`, () => {
      for (const axis of AXES) {
        for (const declaration of declarationsOf(axis.first, axis.second)) {
          for (const request of requestsOf(axis.first, axis.second)) {
            const set = compileSet(setPredicateDocument(axis.field, operator, declaration.value))
            expect(
              outcome(set, axis.contextField, request),
              `${axis.field} ${operator} ${JSON.stringify(declaration.value)} (${declaration.label}) against ${JSON.stringify(request)}`,
            ).toBe(EXPECTED[operator]([axis.first, axis.second], request) ? "matched" : "not_matched")
          }
        }
      }
    })
  }
})

// ===========================================================================
// The equality property, stated as one claim over the whole table
// ===========================================================================

describe("a duplicated declaration matches exactly the dispatches its deduped twin matches", () => {
  for (const operator of ["all", "any", "none"] as const) {
    it(`on every axis, for \`${operator}\`, over every duplicate placement and every request`, () => {
      for (const axis of AXES) {
        const declarations = declarationsOf(axis.first, axis.second)
        const reference = declarations[0]
        if (reference === undefined) return
        const referenceSet = compileSet(setPredicateDocument(axis.field, operator, reference.value))
        for (const declaration of declarations.slice(1)) {
          const duplicated = compileSet(setPredicateDocument(axis.field, operator, declaration.value))
          for (const request of requestsOf(axis.first, axis.second)) {
            expect(
              outcome(duplicated, axis.contextField, request),
              `${axis.field} ${operator}: ${JSON.stringify(declaration.value)} and ${JSON.stringify(reference.value)} must agree on ${JSON.stringify(request)}`,
            ).toBe(outcome(referenceSet, axis.contextField, request))
          }
        }
      }
    })
  }
})

// ===========================================================================
// The digest, the disclosure and the evaluator must agree
// ===========================================================================

describe("a duplicate in a declared member list changes neither the rule's digest nor its normalized predicate", () => {
  it("produces the same digest and the same normalized predicate for a duplicated member list as for its deduped twin, on every axis and every operator", () => {
    // `renderList` already went through `sortedUnique`, so the digest declared
    // these rules identical. Before the evaluator was fixed they were NOT
    // identical in behaviour — an audit defect on its own: a digest that says two
    // rules are the same while the engine treats them differently is a digest
    // nobody can use to reason about an approval taken against one of them.
    for (const axis of AXES) {
      for (const operator of ["all", "any", "none"] as const) {
        const deduped = compileRule(setPredicateDocument(axis.field, operator, [axis.first, axis.second]))
        const duplicated = compileRule(setPredicateDocument(axis.field, operator, [axis.first, axis.first, axis.second, axis.second]))
        expect(deduped.ok).toBe(true)
        expect(duplicated.ok).toBe(true)
        if (!deduped.ok || !duplicated.ok) return
        expect(duplicated.value.digest, `${axis.field} ${operator}: a duplicate must not move the digest`).toBe(deduped.value.digest)
        expect(duplicated.value.normalizedPredicate).toBe(deduped.value.normalizedPredicate)
      }
    }
  })

  it("renders the same canonical predicate text for a duplicated member list, because the disclosure is what an auditor reads", () => {
    for (const axis of AXES) {
      const duplicated = describePredicates(
        sourcePredicatesOf(setPredicateDocument(axis.field, "all", [axis.first, axis.first, axis.second, axis.second])),
      )
      const deduped = describePredicates(sourcePredicatesOf(setPredicateDocument(axis.field, "all", [axis.first, axis.second])))
      expect(duplicated, `${axis.field} all: the canonical text must not show a multiplicity the evaluator ignores`).toBe(deduped)
      // And each member is named exactly once in the disclosure.
      expect(duplicated.split(axis.first).length - 1).toBe(1)
      expect(duplicated.split(axis.second).length - 1).toBe(1)
    }
  })
})

// ===========================================================================
// The absent-snapshot and empty-request columns the fix must not have disturbed
// ===========================================================================

describe("the missing-snapshot column still resolves as documented, on the axis whose snapshot can be missing", () => {
  it("resolves a MISSING snapshot to unknown for `any` and `all`, and to satisfied for `none`", () => {
    // `evaluateSetPredicate` short-circuits on `actual === null` before it ever
    // reaches the deduped `present`/`missing` pair, so the fix cannot have moved
    // this column — and it must not have. A node whose capabilities are unknown
    // has, as far as an assertion of absence goes, none of them; a positive
    // assertion about them is `unknown`, and an `unknown` never matches.
    //
    // Only `nodeAdvertisedCapabilities` is nullable in the evaluation context —
    // a dispatch always names a capability set and always names a tool-category
    // set — so this column is reachable on exactly one axis, and asserting it on
    // the other two would be asserting a shape the schema does not admit.
    const axis = AXES.find((entry) => entry.field === "nodeAdvertisedCapability")
    if (axis === undefined) throw new Error("the nodeAdvertisedCapability axis is missing from the table")
    for (const operator of ["all", "any", "none"] as const) {
      const set = compileSet(setPredicateDocument(axis.field, operator, [axis.first, axis.first, axis.second]))
      const result = evaluateRules(set, validContext({ [axis.contextField]: null }))
      expect(result.traces[0]?.matchOutcome, `${axis.field} ${operator} with no snapshot`).toBe(
        operator === "none" ? "matched" : "not_matched",
      )
      expect(
        result.traces[0]?.predicateOutcomes[0]?.unevaluable,
        `${axis.field} ${operator}: only a positive operator is unevaluable without a snapshot, because \`none\` asserts an absence`,
      ).toBe(operator !== "none")
    }
  })

  it("resolves an EMPTY request to the same column, so a request naming nothing is not a request naming everything", () => {
    for (const axis of AXES) {
      for (const operator of ["all", "any", "none"] as const) {
        const set = compileSet(setPredicateDocument(axis.field, operator, [axis.first, axis.first, axis.second]))
        expect(outcome(set, axis.contextField, []), `${axis.field} ${operator} on an empty request`).toBe(
          operator === "none" ? "matched" : "not_matched",
        )
      }
    }
  })
})
