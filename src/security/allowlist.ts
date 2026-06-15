import { resolve } from "node:path"
import type { ProjectConfig } from "../config/types.js"

export function assertProjectAllowed(projectDir: string, projects: ProjectConfig[]): ProjectConfig {
  const requested = resolve(projectDir)
  const project = projects.find((candidate) => resolve(candidate.path) === requested)
  if (!project) throw new Error(`Project directory is not allowlisted: ${projectDir}`)
  return project
}
