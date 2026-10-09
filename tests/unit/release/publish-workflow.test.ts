import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const PUBLISH_WORKFLOW_PATH = new URL("../../../.github/workflows/publish.yml", import.meta.url)

describe("npm publish workflow", () => {
  it("publishes a GitHub Release only after validating its tag against the package version", async () => {
    // Given
    const workflow = await readFile(PUBLISH_WORKFLOW_PATH, "utf8")

    // When
    const publishContract = {
      hasReleasePublishedTrigger: /release:\s*\n\s*types:\s*\[published\]/.test(workflow),
      hasOidcPermission: /id-token:\s*write/.test(workflow),
      hasContentsReadPermission: /contents:\s*read/.test(workflow),
      checksOutReleaseTag: /ref:\s*\$\{\{\s*github\.event\.release\.tag_name\s*\}\}/.test(workflow),
      validatesReleaseTag: workflow.includes('github.event.release.tag_name != format(\'v{0}\', fromJSON(steps.package.outputs.manifest).version)'),
      // The pre-1.0 line ships under `beta` so `latest` stays on 2.1.x. A bare
      // `npm publish` here would move `latest` backwards to a lower version.
      publishesToNpm: /npm publish\s+--access public --tag "\$DIST_TAG"/.test(workflow),
      publishesPlatformPackagesUnderSameTag: /npm publish --access public --tag "\$DIST_TAG"/.test(workflow),
      declaresBetaDistTag: /DIST_TAG:\s*beta/.test(workflow),
      printsInstallCommand: workflow.includes('@$DIST_TAG'),
    }

    // Then
    expect(publishContract).toEqual({
      hasReleasePublishedTrigger: true,
      hasOidcPermission: true,
      hasContentsReadPermission: true,
      checksOutReleaseTag: true,
      validatesReleaseTag: true,
      publishesToNpm: true,
      publishesPlatformPackagesUnderSameTag: true,
      declaresBetaDistTag: true,
      printsInstallCommand: true,
    })
  })
})
