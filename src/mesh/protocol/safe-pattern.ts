import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { MAX_RULE_PATTERN_LENGTH } from "./bounds.js"

/**
 * R7 — the `taskTitlePattern` ReDoS decision.
 *
 * The finding this closes: `ruleMatchSchema.taskTitlePattern` is a regex matched
 * against task titles with only a length bound, and a rule author on the mesh
 * can supply the pattern. A catastrophic-backtracking pattern from a
 * lower-privileged node would therefore be a remote denial of service against
 * the controller's policy evaluation. It fails CLOSED today, which is not
 * closure — "the node hangs rather than letting me in" is still a hang.
 *
 * THE DECISION: the pattern is compiled at rule-WRITE time into a `SafePattern`
 * and stored with the rule; matching only ever runs against the compiled form.
 * Compiling at write time rather than at match time is the whole point: the
 * expensive, failure-prone question ("is this pattern pathological?") is asked
 * once, by the node that has `policy.ruleAuthor`, and the hot path — matching
 * against a 256-character title — is left as a plain `RegExp.test`.
 *
 * WHAT IS REFUSED, precisely:
 *
 *   1. longer than `MAX_RULE_PATTERN_LENGTH` (128, down from the 256 that let a
 *      pattern be twice as complex as the title it matches);
 *   2. does not compile;
 *   3. a NESTED UNBOUNDED QUANTIFIER: a quantified group whose body is itself
 *      quantified without an upper bound, or which contains a backreference.
 *      `(a+)+`, `(a*)*`, `([a-z]+)*`, `(\w+\s?)*` — the shapes whose failure is
 *      exponential in the SUBJECT length, not linear. Nesting that IS bounded
 *      (`(\d{1,3}\.){3}`, the IP-address shape) is deliberately NOT a refusal
 *      unless it is nested deeper than {@link MAX_BOUNDED_NESTING_DEPTH}: with
 *      every repetition capped, the work is a polynomial of degree equal to the
 *      nesting depth in the subject length, and at depth 2 over a 256-character
 *      title that is under 2^16 steps. Refusing it would have refused a
 *      perfectly ordinary title pattern on the theory that a bound is not a
 *      bound — which is the same over-refusal that makes an analyser unusable.
 *   4. a LOOKBEHIND, which with a bounded subject is a known quadratic shape and
 *      buys almost nothing for a task-title match;
 *   5. a repetition of something that can match the EMPTY string. This is
 *      narrower than "refuse every empty-matching quantifier", and the
 *      distinction is load-bearing: `^task-\d*$` quantifies `\d*`, which CAN
 *      match empty, and it is an entirely ordinary title pattern -- refusing
 *      every empty-matching quantifier would refuse the vocabulary this field
 *      exists for. What is refused is repeating something that can consume
 *      NOTHING (`(?:)*`, `(?=x)*`, `(?:^|\s)*`), because an unbounded repetition
 *      that never advances the position is unbounded WORK over a bounded SUBJECT.
 *   6. a quantified body with AMBIGUOUS TOP-LEVEL ALTERNATION whose branches
 *      can start with the same character. `(a|a)*` has no nested quantifier at
 *      all and is still catastrophic, so rule 3 alone does not catch it;
 *      `(a|b)*` is unambiguous and linear, and refusing it would refuse an
 *      ordinary pattern. `(?:^|\s)*` lands here too -- one branch matches empty,
 *      so the engine retries the other at every position.
 *
 * RESIDUAL RISK, STATED HONESTLY: rules 3–6 are structural heuristics, not a
 * proof. A pattern can be pathological without tripping them — exponential
 * behaviour can be built from constructs this parser does not model, and
 * JavaScript's engine may itself introduce a shape later. The plan requires "a
 * bound OR a timeout", and what is supplied here is a bound: 128 pattern
 * characters × 256 subject characters × linear matching, with the known
 * catastrophic shapes refused at compile time. A future replacement can swap in
 * an RE2-style engine; the seam is `SafePattern`, and nothing outside this file
 * touches `RegExp`.
 */

// --- A small, honest regex parser ---------------------------------------

type Node =
  | { readonly kind: "empty" }
  | { readonly kind: "literal"; readonly char: string }
  | { readonly kind: "any" }
  | { readonly kind: "escape"; readonly name: string }
  | { readonly kind: "class"; readonly text: string }
  | { readonly kind: "anchor"; readonly text: string }
  | { readonly kind: "backref" }
  | { readonly kind: "group"; readonly groupKind: GroupKind; readonly body: Node[] }
  | { readonly kind: "alternate"; readonly branches: Node[][] }
  | { readonly kind: "repeat"; readonly body: Node; readonly min: number; readonly max: number | null }

type GroupKind = "capture" | "noncapture" | "lookahead" | "negated-lookahead" | "lookbehind" | "negated-lookbehind" | "named" | "atomic"

class PatternSyntaxError extends Error {}

const CLASS_ESCAPES: Record<string, string> = {
  d: "0-9",
  w: "0-9,A-Z,a-z,_",
  s: " ,\\t,\\n,\\r,\\f,\\v",
}

/**
 * Escapes that name exactly one character.
 *
 * Only these are resolved to a literal. Everything else — `\D`, `\W`, `\S`, `\p`,
 * an escape this parser does not decode — resolves to "unknown", which the caller
 * treats as overlapping with everything. The direction matters: a wrong first-set
 * can make two genuinely ambiguous branches look disjoint, and a false accept is
 * the failure this whole file exists to prevent.
 */
const ESCAPE_LITERALS: Record<string, string> = {
  ".": ".",
  $: "$",
  "^": "^",
  "\\": "\\",
  "/": "/",
  "(": "(",
  ")": ")",
  "[": "[",
  "]": "]",
  "{": "{",
  "}": "}",
  "|": "|",
  "+": "+",
  "*": "*",
  "?": "?",
  "-": "-",
  n: "\n",
  r: "\r",
  t: "\t",
  f: "\f",
  v: "\v",
  "0": "\0",
}

class Parser {
  #source: string
  #index = 0

  constructor(source: string) {
    this.#source = source
  }

  parse(): Node[] {
    const body = this.#parseAlternation()
    if (this.#index < this.#source.length) {
      throw new PatternSyntaxError(`Unexpected '${this.#source[this.#index]}' at index ${this.#index}`)
    }
    return body
  }

  #peek(): string | undefined {
    return this.#source[this.#index]
  }

  #parseAlternation(): Node[] {
    const branches: Node[][] = [this.#parseConcat()]
    while (this.#peek() === "|") {
      this.#index += 1
      branches.push(this.#parseConcat())
    }
    return branches.length === 1 ? branches[0] : [{ kind: "alternate", branches }]
  }

  #parseConcat(): Node[] {
    const nodes: Node[] = []
    while (this.#index < this.#source.length) {
      const char = this.#source[this.#index]
      if (char === "|" || char === ")") break
      const atom = this.#parseAtom()
      nodes.push(this.#parseQuantifier(atom))
    }
    return nodes
  }

  #parseQuantifier(atom: Node): Node {
    const char = this.#peek()
    let min: number
    let max: number | null
    if (char === "*") {
      this.#index += 1
      min = 0
      max = null
    } else if (char === "+") {
      this.#index += 1
      min = 1
      max = null
    } else if (char === "?") {
      this.#index += 1
      min = 0
      max = 1
    } else if (char === "{") {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(this.#source.slice(this.#index))
      if (match === null) {
        // A `{` that does not open a valid bound is a literal brace in JS regex,
        // so it is consumed as a character by the caller's next iteration rather
        // than as an unterminated quantifier.
        return atom
      }
      this.#index += match[0].length
      min = Number(match[1])
      max = match[2] === undefined ? min : match[3] === "" ? null : Number(match[3])
    } else {
      return atom
    }

    // A trailing `?` (or `+` for a possessive read) adjusts greediness only. It
    // does not change the shape's backtracking behaviour for our purposes: a
    // lazy quantifier explores the SAME state space as a greedy one, just in a
    // different order, so it is consumed and discarded.
    if (this.#peek() === "?") this.#index += 1
    return { kind: "repeat", body: atom, min, max }
  }

  #parseAtom(): Node {
    const char = this.#source[this.#index]
    if (char === undefined) throw new PatternSyntaxError("Unexpected end of pattern")
    if (char === "(") return this.#parseGroup()
    if (char === "[") return this.#parseClass()
    if (char === "\\") return this.#parseEscape()
    if (char === ".") {
      this.#index += 1
      return { kind: "any" }
    }
    if (char === "^" || char === "$") {
      this.#index += 1
      return { kind: "anchor", text: char }
    }
    this.#index += 1
    return { kind: "literal", char }
  }

  /**
   * Parses one `(`-introduced group.
   *
   * The prefix length is decided here and passed explicitly rather than being
   * assumed to be two characters, because it is not: a plain capture consumes
   * one character, `(?<name>` consumes up to `>`, and `(?<=` consumes three.
   * Assuming a uniform two is the kind of off-by-one that makes `(a+)+` parse as
   * a group containing the literal `+` — which then sails straight through the
   * nested-quantifier check that exists to refuse it.
   */
  #parseGroup(): Node {
    const rest = this.#source.slice(this.#index)
    if (!rest.startsWith("(?", this.#index)) return this.#parseGroupWithKind("capture", 1)

    if (rest.startsWith("(?<=")) return this.#parseGroupWithKind("lookbehind", 3)
    if (rest.startsWith("(?<!")) return this.#parseGroupWithKind("negated-lookbehind", 3)
    if (rest.startsWith("(?<")) {
      const close = this.#source.indexOf(">", this.#index)
      if (close === -1) throw new PatternSyntaxError("Unterminated named group")
      const prefixLength = close + 1 - this.#index
      return this.#parseGroupWithKind("named", prefixLength)
    }
    if (rest.startsWith("(?=")) return this.#parseGroupWithKind("lookahead", 3)
    if (rest.startsWith("(?!")) return this.#parseGroupWithKind("negated-lookahead", 3)
    if (rest.startsWith("(?>")) return this.#parseGroupWithKind("atomic", 3)
    if (rest.startsWith("(?")) return this.#parseGroupWithKind("noncapture", 3)
    if (rest.startsWith("(?#")) {
      const end = this.#source.indexOf(")", this.#index)
      if (end === -1) throw new PatternSyntaxError("Unterminated comment group")
      this.#index = end + 1
      return { kind: "empty" }
    }
    const inline = /^\(\?([imsuxy]+)\)/.exec(rest)
    if (inline !== null) return this.#parseGroupWithKind("noncapture", inline[0].length)
    throw new PatternSyntaxError(`Unsupported group construct '${rest.slice(0, 6)}'`)
  }

  #parseGroupWithKind(groupKind: GroupKind, prefixLength: number): Node {
    this.#index += prefixLength
    const body = this.#parseAlternation()
    if (this.#source[this.#index] !== ")") throw new PatternSyntaxError("Unterminated group")
    this.#index += 1
    return { kind: "group", groupKind, body }
  }

  #parseClass(): Node {
    const start = this.#index
    this.#index += 1 // consume '['
    if (this.#peek() === "^") this.#index += 1
    if (this.#peek() === "]") this.#index += 1
    while (this.#index < this.#source.length && this.#source[this.#index] !== "]") {
      if (this.#source[this.#index] === "\\") this.#index += 1
      this.#index += 1
    }
    if (this.#source[this.#index] !== "]") throw new PatternSyntaxError("Unterminated character class")
    this.#index += 1
    return { kind: "class", text: this.#source.slice(start + 1, this.#index - 1) }
  }

  #parseEscape(): Node {
    this.#index += 1 // consume '\'
    const char = this.#source[this.#index]
    if (char === undefined) throw new PatternSyntaxError("Pattern ends with a backslash")
    if (/[1-9]/.test(char)) {
      this.#index += 1
      return { kind: "backref" }
    }
    this.#index += 1
    if (char === "b" || char === "B") return { kind: "anchor", text: `\\${char}` }
    if (char === "k" && this.#peek() === "<") {
      const end = this.#source.indexOf(">", this.#index)
      if (end === -1) throw new PatternSyntaxError("Unterminated named backreference")
      this.#index = end + 1
      return { kind: "backref" }
    }
    if (char === "p" || char === "P") {
      const brace = this.#source.indexOf("}", this.#index)
      if (brace === -1) throw new PatternSyntaxError("Unterminated unicode property escape")
      this.#index = brace + 1
      return { kind: "class", text: this.#source.slice(this.#index, brace) }
    }
    return { kind: "escape", name: char }
  }
}

// --- Structural analysis -------------------------------------------------

function concatIsNullable(nodes: readonly Node[]): boolean {
  return nodes.length === 0 || nodes.every(nodeIsNullable)
}

function nodeIsNullable(node: Node): boolean {
  switch (node.kind) {
    case "empty":
    case "anchor":
      // `^`, `$` and `\b` all match the empty string at some position, which is
      // why `^` inside a quantifier is one of the shapes rule 5 refuses.
      return true
    case "literal":
      return false
    case "any":
    case "escape":
    case "class":
      return false
    case "backref":
      // Conservative. A backreference matches whatever the group matched, and
      // a group that matched nothing makes this empty.
      return true
    case "group":
      if (node.groupKind === "lookahead" || node.groupKind === "lookbehind") return true
      return concatIsNullable(node.body)
    case "alternate":
      return node.branches.every(concatIsNullable)
    case "repeat":
      return node.min === 0 || nodeIsNullable(node.body)
  }
}

function containsBackref(node: Node): boolean {
  switch (node.kind) {
    case "backref":
      return true
    case "group":
      return node.body.some(containsBackref)
    case "alternate":
      return node.branches.some((branch) => branch.some(containsBackref))
    default:
      return false
  }
}

/** Any repetition in the subtree with no upper bound. */
function containsUnboundedQuantifier(node: Node): boolean {
  switch (node.kind) {
    case "repeat":
      return node.max === null || containsUnboundedQuantifier(node.body)
    case "group":
      return node.body.some(containsUnboundedQuantifier)
    case "alternate":
      return node.branches.some((branch) => branch.some(containsUnboundedQuantifier))
    default:
      return false
  }
}

/**
 * The longest chain of quantifiers wrapping quantifiers inside a subtree.
 *
 * 1 for a lone repetition, 0 for a subtree with none. This is the quantity that
 * makes a NESTED quantifier safe: when every repetition in the chain has a
 * finite maximum, the engine's work is a polynomial of that degree in the
 * subject length, so depth 2 over a 256-character title is under 2^16 steps and
 * depth 4 is over 2^32. It is the number, not the presence, that decides.
 */
function quantifierNestingDepth(node: Node): number {
  switch (node.kind) {
    case "repeat":
      return 1 + childDepth(node.body)
    case "group":
      return childDepth(node)
    case "alternate":
      return childDepth(node)
    default:
      return 0
  }
}

function childDepth(node: Node): number {
  switch (node.kind) {
    case "group":
      return node.body.reduce((deepest, child) => Math.max(deepest, quantifierNestingDepth(child)), 0)
    case "alternate":
      return node.branches.reduce(
        (deepest, branch) => Math.max(deepest, branch.reduce((inner, child) => Math.max(inner, quantifierNestingDepth(child)), 0)),
        0,
      )
    default:
      return 0
  }
}

/**
 * How deep BOUNDED quantifier nesting may go before it is refused.
 *
 * Two, because two is the deepest chain whose worst case over the 256-character
 * subject bound is still trivial, and because every ordinary shape that needs
 * nesting at all — a dotted version, a hyphen-separated id — nests exactly two
 * deep. Three would be 2^24 steps on a title an author typed, which is a
 * denial of service dressed as a title match.
 */
export const MAX_BOUNDED_NESTING_DEPTH = 2

function containsLookbehind(node: Node): boolean {
  switch (node.kind) {
    case "group":
      return (
        node.groupKind === "lookbehind" ||
        node.groupKind === "negated-lookbehind" ||
        node.body.some(containsLookbehind)
      )
    case "alternate":
      return node.branches.some((branch) => branch.some(containsLookbehind))
    default:
      return false
  }
}

/**
 * The first characters a node can consume, or `null` for "effectively
 * unbounded" (`.`, a negated class, a large positive class, an escape whose
 * character set is not enumerable here).
 *
 * `null` is treated as ambiguous against everything. That is the conservative
 * direction: a pattern this analyser cannot reason about is refused, and a
 * false refusal costs an author one alternative spelling while a false accept
 * costs the mesh a hung policy evaluation.
 */
function firstCharacters(node: Node): Set<string> | null {
  switch (node.kind) {
    case "empty":
    case "anchor":
      return new Set()
    case "literal":
      return new Set([node.char])
    case "any":
      return null
    case "escape": {
      const mapped = CLASS_ESCAPES[node.name]
      if (mapped !== undefined) return expandRange(mapped)
      const literal = ESCAPE_LITERALS[node.name]
      return literal === undefined ? null : new Set([literal])
    }
    case "class":
      return classFirstCharacters(node.text)
    case "backref":
      return null
    case "group": {
      if (node.groupKind === "lookahead" || node.groupKind === "lookbehind") return new Set()
      if (node.body.length === 0) return new Set()
      const union = new Set<string>()
      for (const child of node.body) {
        const first = firstCharacters(child)
        if (first === null) return null
        for (const char of first) union.add(char)
        // A nullable member means the group can match empty and the NEXT member
        // can therefore be first, so the search continues past it.
        if (!nodeIsNullable(child)) break
      }
      return union
    }
    case "alternate": {
      const union = new Set<string>()
      for (const branch of node.branches) {
        for (const child of branch) {
          const first = firstCharacters(child)
          if (first === null) return null
          for (const char of first) union.add(char)
          if (!nodeIsNullable(child)) break
        }
      }
      return union
    }
    case "repeat":
      return firstCharacters(node.body)
  }
}

function expandRange(spec: string): Set<string> | null {
  const out = new Set<string>()
  for (const part of spec.split(",")) {
    const range = /^([^-])-([^-])$/.exec(part)
    if (range !== null) {
      const start = range[1].charCodeAt(0)
      const end = range[2].charCodeAt(0)
      if (end - start > 512) return null
      for (let code = start; code <= end; code += 1) out.add(String.fromCharCode(code))
    } else {
      out.add(part)
    }
  }
  return out
}

function classFirstCharacters(text: string): Set<string> | null {
  const body = text.startsWith("^") ? text.slice(1) : text
  if (body.includes("\\p{") || body.includes("\\P{")) return null
  if (body.startsWith("\\")) {
    const escape = /^\\(\d)/.exec(body)
    if (escape !== null) {
      const mapped = CLASS_ESCAPES[escape[1]]
      return mapped === undefined ? null : expandRange(mapped)
    }
  }
  // A negated class matches almost everything, so it overlaps with any other
  // branch by definition.
  if (text.startsWith("^")) return null
  const out = new Set<string>()
  let index = 0
  while (index < body.length) {
    if (body[index] === "\\") {
      const escape = /^\\(\w)/.exec(body.slice(index))
      if (escape !== null) {
        const mapped = CLASS_ESCAPES[escape[1]]
        index += 2
        if (mapped === undefined) {
          out.add(escape[1])
          continue
        }
        const expanded = expandRange(mapped)
        if (expanded === null) return null
        for (const char of expanded) out.add(char)
        continue
      }
      index += 2
      continue
    }
    if (body[index + 1] === "-" && body[index + 2] !== undefined) {
      const start = body.charCodeAt(index)
      const end = body.charCodeAt(index + 2)
      if (end - start > 512) return null
      for (let code = start; code <= end; code += 1) out.add(String.fromCharCode(code))
      index += 3
      continue
    }
    out.add(body[index])
    index += 1
  }
  return out
}

function branchesOverlap(left: Node[], right: Node[]): boolean {
  const leftFirst = firstCharactersOfSequence(left)
  const rightFirst = firstCharactersOfSequence(right)
  if (leftFirst === null || rightFirst === null) return true
  if (leftFirst.size === 0 || rightFirst.size === 0) return true
  for (const char of leftFirst) if (rightFirst.has(char)) return true
  return false
}

function firstCharactersOfSequence(nodes: readonly Node[]): Set<string> | null {
  const union = new Set<string>()
  for (const node of nodes) {
    const first = firstCharacters(node)
    if (first === null) return null
    for (const char of first) union.add(char)
    if (!nodeIsNullable(node)) break
  }
  return union
}

/** The top-level alternation of a quantified body, if it has one. */
function topLevelAlternation(node: Node): Node[][] | null {
  if (node.kind === "alternate") return node.branches
  if (node.kind === "group" && node.groupKind !== "lookahead" && node.groupKind !== "lookbehind") {
    for (const child of node.body) {
      if (child.kind === "alternate") return child.branches
    }
  }
  return null
}

interface StructuralFinding {
  readonly rule: "too_long" | "does_not_compile" | "nested_quantifier" | "lookbehind" | "empty_matching_quantifier" | "ambiguous_alternation"
  readonly detail: string
}

function findStructuralProblems(nodes: readonly Node[]): StructuralFinding[] {
  const findings: StructuralFinding[] = []
  const visit = (node: Node): void => {
    switch (node.kind) {
      case "repeat": {
        if (containsUnboundedQuantifier(node.body)) {
          findings.push({
            rule: "nested_quantifier",
            detail: `a quantified sub-expression '${render(node.body)}' contains an UNBOUNDED repetition; this is the exponential-backtracking shape`,
          })
        }
        if (containsBackref(node.body)) {
          findings.push({
            rule: "nested_quantifier",
            detail: `a backreference appears inside the quantified sub-expression '${render(node.body)}'; backtracking through a backreference is unbounded`,
          })
        }
        const depth = quantifierNestingDepth(node)
        if (depth > MAX_BOUNDED_NESTING_DEPTH) {
          // Every repetition here has a finite maximum, so this is not the
          // exponential case — it is the polynomial one. Degree 3 over a
          // 256-character title is still ~2^24 steps, which is a denial of
          // service whatever its asymptotics say.
          findings.push({
            rule: "nested_quantifier",
            detail: `quantifiers nest ${depth} deep inside '${render(node)}'; bounded nesting deeper than ${MAX_BOUNDED_NESTING_DEPTH} makes the match polynomial of that degree in the subject length`,
          })
        }
        if (nodeIsNullable(node.body)) {
          findings.push({
            rule: "empty_matching_quantifier",
            detail: `'${render(node.body)}' can match the empty string while being repeated; an unbounded repetition of an empty match never advances`,
          })
        }
        const alternation = topLevelAlternation(node.body)
        if (alternation !== null && alternation.length > 1) {
          for (let i = 0; i < alternation.length; i += 1) {
            for (let j = i + 1; j < alternation.length; j += 1) {
              if (branchesOverlap(alternation[i], alternation[j])) {
                findings.push({
                  rule: "ambiguous_alternation",
                  detail: `branches '${renderSequence(alternation[i])}' and '${renderSequence(alternation[j])}' can start with the same character, so the engine retries both at every position`,
                })
              }
            }
          }
        }
        // Descending is what finds an ambiguous alternation nested one level
        // inside the quantified body, and what finds a lookbehind inside it.
        visit(node.body)
        return
      }
      case "group": {
        if (node.groupKind === "lookbehind" || node.groupKind === "negated-lookbehind") {
          findings.push({
            rule: "lookbehind",
            detail: `a lookbehind ('${node.groupKind}') is quadratic against a bounded subject and buys nothing for a title match`,
          })
        }
        for (const child of node.body) visit(child)
        return
      }
      case "alternate":
        for (const branch of node.branches) for (const child of branch) visit(child)
        return
      default:
        return
    }
  }
  for (const node of nodes) visit(node)
  return findings
}

function render(node: Node): string {
  switch (node.kind) {
    case "empty":
      return ""
    case "literal":
      return node.char
    case "any":
      return "."
    case "escape":
      return `\\${node.name}`
    case "class":
      return `[${node.text}]`
    case "anchor":
      return node.text
    case "backref":
      return "\\k<n>"
    case "group":
      return `(?:${node.body.map(render).join("")})`
    case "alternate":
      return node.branches.map(renderSequence).join("|")
    case "repeat":
      return `${render(node.body)}{${node.min},${node.max ?? ""}}`
  }
}

function renderSequence(nodes: readonly Node[]): string {
  return nodes.map(render).join("")
}

// --- The public seam -----------------------------------------------------

/**
 * A pattern that has been compiled and vetted.
 *
 * The compiled `RegExp` carries NO flags — in particular not `g` or `y`. A
 * sticky or global regexp advances `lastIndex` across calls, which would make
 * matching a function of what was matched before it rather than of
 * (pattern, subject). The whole point of `SafePattern` is that matching it is a
 * pure function, and the object is frozen so a caller cannot bolt a flag on
 * afterwards.
 */
export interface SafePattern {
  readonly source: string
  readonly regex: RegExp
  /** The declared length, for audit output. */
  readonly length: number
}

export type SafePatternRefusal =
  | "too_long"
  | "does_not_compile"
  | "nested_quantifier"
  | "lookbehind"
  | "empty_matching_quantifier"
  | "ambiguous_alternation"

export type SafePatternFailure = {
  readonly ok: false
  readonly refusal: SafePatternRefusal
  readonly detail: string
  readonly error: ContractError
}

/** Codes are stable so a rule-authoring UI can say something specific. */
const REFUSAL_CODES: Record<SafePatternRefusal, string> = {
  too_long: "rule.pattern_too_long",
  does_not_compile: "rule.pattern_does_not_compile",
  nested_quantifier: "rule.pattern_nested_quantifier",
  lookbehind: "rule.pattern_lookbehind",
  empty_matching_quantifier: "rule.pattern_empty_matching_quantifier",
  ambiguous_alternation: "rule.pattern_ambiguous_alternation",
}

/**
 * Compiles and vets a `taskTitlePattern`.
 *
 * Order is length → compile → structure. Length first because it is the bound
 * the plan asks for and it is free; compile second because there is no point
 * analysing a pattern that JavaScript will not run; structure last because it is
 * the most expensive and the most heuristic. A pattern that trips two rules
 * reports the FIRST in this order, so the message an author sees is the cheapest
 * thing they can act on.
 */
export function compileSafePattern(source: string): Result<SafePattern> {
  if (source.length === 0) {
    return refuse("does_not_compile", "An empty pattern matches every title, which is not a rule but a wildcard", "rule.pattern_empty")
  }
  if (source.length > MAX_RULE_PATTERN_LENGTH) {
    return refuse(
      "too_long",
      `Pattern is ${source.length} characters, over the ${MAX_RULE_PATTERN_LENGTH} character bound`,
    )
  }

  let regex: RegExp
  try {
    regex = new RegExp(source)
  } catch (error) {
    return refuse("does_not_compile", `Pattern does not compile: ${(error as Error).message}`)
  }

  let nodes: Node[]
  try {
    nodes = new Parser(source).parse()
  } catch (error) {
    if (error instanceof PatternSyntaxError) {
      return refuse(
        "does_not_compile",
        `Pattern uses a construct this safety analysis cannot model (${error.message}); it is refused rather than assumed safe`,
      )
    }
    throw error
  }

  const findings = findStructuralProblems(nodes)
  if (findings.length > 0) {
    const [first] = findings
    return refuse(first.rule, first.detail)
  }

  // A pattern is matched with `test`, which is a SEARCH, so an unanchored pattern
  // is not itself a problem. Anchoring advice belongs to the author, not here.
  return {
    ok: true,
    value: Object.freeze({
      source,
      regex: Object.freeze(regex) as RegExp,
      length: source.length,
    }),
  }
}

function refuse(refusal: SafePatternRefusal, detail: string, codeOverride?: string): { ok: false; error: ContractError } {
  return {
    ok: false,
    error: createContractError(
      "policy_denied",
      codeOverride ?? REFUSAL_CODES[refusal],
      detail,
    ),
  }
}

/** `Result` flavour that ALSO names the refusal, so a caller can branch on it. */
export function checkSafePattern(source: string): { ok: true; value: SafePattern } | SafePatternFailure {
  if (source.length > MAX_RULE_PATTERN_LENGTH) {
    const error = createContractError(
      "policy_denied",
      REFUSAL_CODES.too_long,
      `Pattern is ${source.length} characters, over the ${MAX_RULE_PATTERN_LENGTH} character bound`,
    )
    return { ok: false, refusal: "too_long", detail: error.message, error }
  }
  const compiled = compileSafePattern(source)
  if (compiled.ok) return compiled
  const refusal = refusalFromError(compiled.error.code)
  return { ok: false, refusal, detail: compiled.error.message, error: compiled.error }
}

function refusalFromError(code: string): SafePatternRefusal {
  for (const [refusal, refusalCode] of Object.entries(REFUSAL_CODES)) {
    if (refusalCode === code) return refusal as SafePatternRefusal
  }
  return "does_not_compile"
}

/** Matches a compiled pattern against a title. The only matching path. */
export function matchesSafePattern(pattern: SafePattern, subject: string): boolean {
  return pattern.regex.test(subject)
}

/**
 * The maximum subject length a `SafePattern` will ever be asked about.
 *
 * Duplicated as a constant rather than imported from `schemas.ts` because
 * `shortTextSchema` is module-private there. It is asserted equal to the kernel's
 * 256-character title bound by `safe-pattern.test.ts`, so the two cannot drift
 * apart silently: the ReDoS argument is "bounded pattern × bounded subject ×
 * linear matching", and the subject half of that product has to be a real
 * number, not an assumption.
 */
export const MAX_RULE_MATCH_SUBJECT_LENGTH = 256

/** Refuses a subject over the bound, so the argument above stays true. */
export function matchesBounded(pattern: SafePattern, subject: string): Result<boolean> {
  if (subject.length > MAX_RULE_MATCH_SUBJECT_LENGTH) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "rule.match_subject_too_long",
        `Match subject is ${subject.length} characters, over the ${MAX_RULE_MATCH_SUBJECT_LENGTH} character bound a SafePattern is argued to be safe within`,
      ),
    }
  }
  return { ok: true, value: matchesSafePattern(pattern, subject) }
}
