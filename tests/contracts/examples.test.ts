import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { digestDispatchEnvelope } from "../../src/orchestration/digest.js"
import {
  approvalSchema,
  artifactSchema,
  controllerLeaseSchema,
  dispatchSchema,
  memoryRecordSchema,
  meshSchema,
  nodeSchema,
  orchestrationCommandSchema,
  orchestrationEventSchema,
  projectSchema,
  roleTemplateSchema,
  ruleSchema,
  runSchema,
  sessionSchema,
  taskSchema,
} from "../../src/orchestration/schemas.js"

const examplesDirectory = fileURLToPath(new URL("./examples/", import.meta.url))

const examples = [
  ["mesh", meshSchema],
  ["node", nodeSchema],
  ["project", projectSchema],
  ["run", runSchema],
  ["task", taskSchema],
  ["dispatch", dispatchSchema],
  ["approval", approvalSchema],
  ["session", sessionSchema],
  ["role", roleTemplateSchema],
  ["rule", ruleSchema],
  ["memory", memoryRecordSchema],
  ["artifact", artifactSchema],
  ["controller-lease", controllerLeaseSchema],
  ["event", orchestrationEventSchema],
  ["command", orchestrationCommandSchema],
] as const

async function readExample(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${examplesDirectory}${name}.v1.json`, "utf8"))
}

describe("canonical version-one examples", () => {
  it("contains the frozen complete set of exactly fifteen schema-valid JSON examples", async () => {
    expect(examples.map(([name]) => name)).toEqual([
      "mesh",
      "node",
      "project",
      "run",
      "task",
      "dispatch",
      "approval",
      "session",
      "role",
      "rule",
      "memory",
      "artifact",
      "controller-lease",
      "event",
      "command",
    ])

    for (const [name, schema] of examples) {
      const input = await readExample(name)
      const parsed = schema.parse(input)
      // JSON examples must remain a lossless wire-format round trip.
      expect(JSON.parse(JSON.stringify(parsed)), name).toEqual(input)
    }
  })

  it("binds dispatch, approval, and execution command to the canonical envelope digest", async () => {
    const dispatch = dispatchSchema.parse(await readExample("dispatch"))
    const approval = approvalSchema.parse(await readExample("approval"))
    const command = orchestrationCommandSchema.parse(await readExample("command"))

    expect(dispatch.envelopeDigest).toBe(digestDispatchEnvelope(dispatch.envelope))
    expect(approval.dispatchId).toBe(dispatch.envelope.dispatchId)
    expect(approval.envelopeDigest).toBe(dispatch.envelopeDigest)
    expect(command.type).toBe("dispatch.execute")
    if (command.type !== "dispatch.execute") throw new Error("Canonical command must execute the canonical dispatch")
    expect(command.payload.dispatch.envelopeDigest).toBe(dispatch.envelopeDigest)
    expect(command.payload.approval.envelopeDigest).toBe(dispatch.envelopeDigest)
    expect(command.payload.approval.dispatchId).toBe(dispatch.envelope.dispatchId)
  })

  it("keeps cross-record project, run, dispatch, and lease identities aligned", async () => {
    const [project, run, task, dispatch, session, lease, event] = await Promise.all([
      readExample("project"),
      readExample("run"),
      readExample("task"),
      readExample("dispatch"),
      readExample("session"),
      readExample("controller-lease"),
      readExample("event"),
    ])
    const parsedProject = projectSchema.parse(project)
    const parsedRun = runSchema.parse(run)
    const parsedTask = taskSchema.parse(task)
    const parsedDispatch = dispatchSchema.parse(dispatch)
    const parsedSession = sessionSchema.parse(session)
    const parsedLease = controllerLeaseSchema.parse(lease)
    const parsedEvent = orchestrationEventSchema.parse(event)

    expect(parsedProject.pathBindings[0]?.projectId).toBe(parsedRun.projectId)
    expect(parsedTask.projectId).toBe(parsedRun.projectId)
    expect(parsedTask.runId).toBe(parsedRun.runId)
    expect(parsedDispatch.envelope.projectId).toBe(parsedRun.projectId)
    expect(parsedDispatch.envelope.runId).toBe(parsedRun.runId)
    expect(parsedSession.dispatchId).toBe(parsedDispatch.envelope.dispatchId)
    expect(parsedLease.runId).toBe(parsedRun.runId)
    expect(parsedEvent.projectId).toBe(parsedRun.projectId)
    expect(parsedEvent.runId).toBe(parsedRun.runId)
  })
})
