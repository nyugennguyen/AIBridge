import { readFile, readdir } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const WORKFLOWS_DIR = new URL("../../../.github/workflows/", import.meta.url)

/**
 * Regression guard for the single-publisher invariant.
 *
 * CI and the release workflow used to BOTH publish to npm on a version
 * transition. Two writers of one immutable npm version raced, and a publish
 * failure turned a passing code-verification run red. The split is now:
 * `ci.yml` validates, `publish.yml` publishes. This test fails if a second
 * publisher -- or the credentials that make one possible -- is reintroduced
 * into the validation workflow.
 */
describe("release authority — exactly one workflow may publish", () => {
  it("ci.yml is validation-only: no publish commands, no npm credentials", async () => {
    // Given
    const ci = await readFile(new URL("ci.yml", WORKFLOWS_DIR), "utf8")

    // When
    const violations = {
      publishesToNpm: /npm publish/.test(ci),
      referencesNpmToken: /NPM_TOKEN/.test(ci),
      referencesNodeAuthToken: /NODE_AUTH_TOKEN/.test(ci),
      requestsOidcPermission: /id-token:\s*write/.test(ci),
      writesContents: /contents:\s*write/.test(ci),
    }

    // Then
    expect(violations).toEqual({
      publishesToNpm: false,
      referencesNpmToken: false,
      referencesNodeAuthToken: false,
      requestsOidcPermission: false,
      writesContents: false,
    })
  })

  it("publish.yml is the only workflow that publishes or holds npm credentials", async () => {
    // Given
    const files = (await readdir(WORKFLOWS_DIR)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))

    // When
    const publishers: string[] = []
    for (const file of files) {
      const content = await readFile(new URL(file, WORKFLOWS_DIR), "utf8")
      if (/npm publish|NPM_TOKEN|NODE_AUTH_TOKEN/.test(content)) {
        publishers.push(file)
      }
    }

    // Then — anti-vacuity: the scan looks at real files and the publisher is among them.
    expect(files.length).toBeGreaterThan(0)
    expect(publishers).toEqual(["publish.yml"])
  })
})
