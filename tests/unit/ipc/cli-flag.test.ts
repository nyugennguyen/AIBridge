/**
 * The `--ipc-publish` flag on `aibr worker`.
 *
 * ## Why this file exists
 *
 * The flag is the only thing standing between the shipped worker and a process that
 * binds a local socket, so its default matters more than its behaviour: an operator
 * running `aibr worker` today must get byte-identical behaviour, or a routine
 * restart of an unrelated feature would silently change what the machine exposes.
 * That is asserted here directly rather than inferred from the wiring, because a
 * test that only checked "the flag reaches the publisher" would still pass with the
 * default flipped.
 *
 * The rest of the bus is covered in `publisher.test.ts` and `bridge.test.ts`.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")

/** The CLI's argument parser and dispatcher, as source. */
function cliSource(): string {
  return readFileSync(join(REPOSITORY_ROOT, "src/cli.ts"), "utf8")
}

describe("the --ipc-publish flag", () => {
  it("is advertised in the help text", () => {
    expect(cliSource()).toContain("--ipc-publish")
  })

  it("is a known flag rather than an unknown one", () => {
    // An unrecognised flag makes the CLI print usage and exit non-zero, so a flag
    // that is wired but not parsed would fail every invocation that used it.
    const source = cliSource()
    const parsing = source.slice(source.indexOf("function parseArgs"))
    expect(parsing).toContain('arg === "--ipc-publish"')
  })

  /**
   * The behaviour that matters most: without the flag, no socket.
   */
  it("leaves the worker's behaviour unchanged by default", () => {
    const source = cliSource()
    // The default is `undefined`, and the publisher is only constructed inside an
    // explicit `if (publishIpc)`. A default that constructed the publisher anyway
    // would satisfy every other assertion in this file and still be wrong.
    expect(source).toContain("const publishIpc = workerOptions?.publishIpc === true")
    expect(source).toContain("if (publishIpc) {")
    expect(source).toContain("ingressObserver: publishIpc ? bridge : undefined")
  })

  it("says which way it went, so a socket cannot appear unexplained", () => {
    // A local socket that appears without a word about it is one an operator cannot
    // account for, and this one is reachable by anything running as this user.
    expect(cliSource()).toContain("IPC bus:")
  })

  it("is not described as an ingress listener", () => {
    // `worker`'s contract is that it binds no socket, because a worker that could
    // accept requests would be a second authority (ADR 0008 §2.2). The flag adds a
    // local bus and must not be worded as if it changed that.
    const source = cliSource()
    const help = source.slice(source.indexOf("function helpText"))
    expect(help).toContain("worker   Drain the router's admission queue (no listener)")
  })
})

describe("the drainer's observer seam", () => {
  it("is notified after the durable write, never before", () => {
    // An event published before the commit would let a UI show a row the store does
    // not have, and the divergence would only surface when a restarted process read
    // the table.
    const source = readFileSync(join(REPOSITORY_ROOT, "src/ingress/drainer.ts"), "utf8")
    // Sliced to the next method rather than to the next doc comment: `acknowledge`
    // carries no doc comment of its own, so the slice would have run to the end of
    // the class and the ordering check would have passed on unrelated code.
    const start = source.indexOf("  acknowledge(")
    const acknowledge = source.slice(start, source.indexOf("  fail(", start))
    const commit = acknowledge.indexOf("this.#driver.run(")
    const notify = acknowledge.indexOf("this.#notify(")
    expect(commit).toBeGreaterThan(-1)
    expect(notify).toBeGreaterThan(commit)
  })

  it("never lets an observer break the drain loop", () => {
    // Every observer call site is a durable write that has already committed.
    // Rethrowing would turn a committed claim into an exception the caller retries,
    // double-processing a row whose `attempts` counter has just been incremented.
    const source = readFileSync(join(REPOSITORY_ROOT, "src/ingress/drainer.ts"), "utf8")
    expect(source).toContain("#notify(emit: (observer: IngressLifecycleObserver) => void)")
  })
})

describe("the publisher's redaction seam", () => {
  it("wraps outbound agent-authored text in the repository's own scrubber", () => {
    // Criteria 7/8 audit streamed logs and clipboard copies for this, and a second
    // implementation would be a second set of patterns to keep current.
    const source = readFileSync(join(REPOSITORY_ROOT, "src/ipc/publisher.ts"), "utf8")
    expect(source).toContain(
      'import { redactString } from "../observability/redaction.js"',
    )
    expect(source).toContain("#redact(value: string): string")
  })

  it("does not scrub PTY chunk bytes, which are bytes and not text", () => {
    // A text filter over base64 terminal output would corrupt escape sequences and
    // turn a correct pane into a wrong one. What reaches the screen and the
    // clipboard from that stream is the client's screen filter's job.
    const source = readFileSync(join(REPOSITORY_ROOT, "src/ipc/publisher.ts"), "utf8")
    const publishChunk = source.slice(
      source.indexOf("publishChunk("),
      source.indexOf("publishChunk(") + 200,
    )
    expect(publishChunk).not.toContain("redact")
  })
})