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
      publishesToNpm: workflow.includes("npm publish --access public"),
    }

    // Then
    expect(publishContract).toEqual({
      hasReleasePublishedTrigger: true,
      hasOidcPermission: true,
      hasContentsReadPermission: true,
      checksOutReleaseTag: true,
      validatesReleaseTag: true,
      publishesToNpm: true,
    })
  })

  it("preflights registry state per package and only skips a published version it can prove is this release", async () => {
    // Given
    const workflow = await readFile(PUBLISH_WORKFLOW_PATH, "utf8")

    // When
    const preflightContract = {
      // The three-way distinction of the release contract: publish, skip when
      // the registry artifact provably belongs to this release commit, fail
      // loudly otherwise. `gitHead` is the proof; without it a published
      // version is "cannot be verified" and must not be treated as success.
      hasPreflightStep: /id:\s*preflight/.test(workflow),
      verifiesArtifactsGitHead: workflow.includes("gitHead"),
      comparesAgainstThisReleaseCommit: workflow.includes("git rev-parse HEAD"),
      failsOnUnverifiableDuplicate: /::error::/.test(workflow) && workflow.includes("unverifiable"),
    }

    // Then
    expect(preflightContract).toEqual({
      hasPreflightStep: true,
      verifiesArtifactsGitHead: true,
      comparesAgainstThisReleaseCommit: true,
      failsOnUnverifiableDuplicate: true,
    })
  })

  it("validates before publishing and never swallows a platform-package publish failure", async () => {
    // Given
    const workflow = await readFile(PUBLISH_WORKFLOW_PATH, "utf8")

    // When
    const gateOrder = {
      validationPrecedesPublish: workflow.indexOf("bun run release:check") < workflow.indexOf("npm publish --access public"),
      // Platform packages are optionalDependencies at install time but REQUIRED
      // for a complete release: `|| true` here hides a half-published release.
      swallowsFailures: workflow.includes("|| true"),
    }

    // Then
    expect(gateOrder).toEqual({
      validationPrecedesPublish: true,
      swallowsFailures: false,
    })
  })
})
