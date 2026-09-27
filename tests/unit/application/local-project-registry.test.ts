import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { ProfileLocalProjectRegistry } from "../../../src/application/local-project-registry.js"
import { bridgeConfigSchema } from "../../../src/config/schemas.js"

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

async function registry() {
  const root = await mkdtemp(join(tmpdir(), "aibr-m1-registry-"))
  temporary.push(root)
  const projectPath = join(root, "project")
  await mkdir(projectPath)
  const config = bridgeConfigSchema.parse({
    agent_id: "node-local",
    bridge: { host: "127.0.0.1", port: 8787, public_url: "http://127.0.0.1:8787" },
    opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096, username: "opencode", password_env: "OPENCODE_SERVER_PASSWORD" },
    security: { auth_mode: "bearer-token", allowed_sources: [] },
    permissions: { default_response: "reject", allow_tools: ["filesystem.read"], require_plan_approval_for_tools: ["filesystem.write"] },
    projects: [{ id: "project-local", path: projectPath, capabilities: ["filesystem.read", "filesystem.write"] }],
    agents: [],
    timeouts: { default_job_seconds: 900, callback_retry_attempts: 1 },
    planning: { plan_annotator_enabled: true, require_approval_for: ["filesystem.write"] },
  })
  return { root, projectPath, value: new ProfileLocalProjectRegistry(config, "2026-09-17T00:00:00.000Z") }
}

describe("ProfileLocalProjectRegistry", () => {
  it("maps profile projects to strict canonical local definitions", async () => {
    const { value } = await registry()
    const listed = await value.listAuthorizedProjects()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value).toHaveLength(1)
    expect(listed.value[0]).toMatchObject({
      project: { projectId: "project-local", pathBindings: [{ allowedCapabilities: ["filesystem.read", "filesystem.write"] }] },
      installation: { runtimeKind: "opencode" },
      permissionEnvelope: { approvalRequirements: { capabilities: ["filesystem.write"] } },
    })
  })

  it("re-resolves the exact allowlisted path for every launch", async () => {
    const { projectPath, value } = await registry()
    const listed = await value.listAuthorizedProjects()
    if (!listed.ok) throw new Error("fixture registry failed")
    const definition = listed.value[0]!
    const binding = definition.project.pathBindings[0]!
    const result = await value.authorizeLaunchPath({
      projectId: definition.project.projectId,
      projectPathId: binding.projectPathId,
      nodeId: binding.nodeId,
      configuredPath: binding.configuredPath,
    })
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ realPath: await realpath(projectPath) }) })
  })

  it("fails closed for changed bindings and unavailable paths", async () => {
    const { projectPath, value } = await registry()
    const listed = await value.listAuthorizedProjects()
    if (!listed.ok) throw new Error("fixture registry failed")
    const definition = listed.value[0]!
    const binding = definition.project.pathBindings[0]!
    const changed = await value.authorizeLaunchPath({
      projectId: definition.project.projectId,
      projectPathId: binding.projectPathId,
      nodeId: binding.nodeId,
      configuredPath: `${projectPath}-other`,
    })
    expect(changed).toMatchObject({ ok: false, error: { code: "application.project.path_binding_changed" } })
    await rm(projectPath, { recursive: true })
    const missing = await value.authorizeLaunchPath({
      projectId: definition.project.projectId,
      projectPathId: binding.projectPathId,
      nodeId: binding.nodeId,
      configuredPath: binding.configuredPath,
    })
    expect(missing).toMatchObject({ ok: false, error: { code: "application.project.path_unavailable" } })
  })

  it("rejects an allowlisted path that is retargeted after registry construction", async () => {
    const { root, projectPath, value } = await registry()
    const listed = await value.listAuthorizedProjects()
    if (!listed.ok) throw new Error("fixture registry failed")
    const binding = listed.value[0]!.project.pathBindings[0]!
    const replacement = join(root, "replacement")
    await mkdir(replacement)
    await rm(projectPath, { recursive: true })
    await symlink(replacement, projectPath)
    const result = await value.authorizeLaunchPath({
      projectId: listed.value[0]!.project.projectId,
      projectPathId: binding.projectPathId,
      nodeId: binding.nodeId,
      configuredPath: binding.configuredPath,
    })
    expect(result).toMatchObject({ ok: false, error: { code: "application.project.path_escape" } })
  })
})
