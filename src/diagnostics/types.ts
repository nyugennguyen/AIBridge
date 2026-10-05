/**
 * Diagnostics Support Bundle types and schemas (M8.4, M7-C3).
 */

import { z } from "zod"

export const supportBundleDatabaseReportSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["healthy", "corrupt", "unsupported_version"]),
  userVersion: z.number(),
  tablesCount: z.number(),
  pragmaResult: z.string(),
  errors: z.array(z.string()),
  outboxStats: z
    .object({
      total: z.number(),
      pending: z.number(),
      sending: z.number(),
      delivered: z.number(),
      failed: z.number(),
      terminalEvidenceRows: z.number(),
    })
    .optional(),
})

export const supportBundleSchema = z.object({
  bundleVersion: z.literal("1.0.0"),
  generatedAt: z.string(),
  profile: z.string(),
  host: z.object({
    platform: z.string(),
    arch: z.string(),
    nodeVersion: z.string(),
    bunVersion: z.string(),
    uptimeSeconds: z.number(),
  }),
  versions: z.object({
    npmPackageVersion: z.string(),
    routerVersion: z.string().nullable(),
    contractVersion: z.string(),
    eventStoreVersion: z.number(),
  }),
  configShape: z.object({
    agentId: z.string(),
    ingressMode: z.string(),
    tailscaleBindHost: z.string(),
    bindPort: z.number(),
    agentsCount: z.number(),
    projectRootsCount: z.number(),
    timeouts: z.record(z.string(), z.number()),
  }),
  health: z.object({
    overallOk: z.boolean(),
    bindPreflight: z.object({
      ok: z.boolean(),
      address: z.string().nullable(),
      error: z.string().nullable(),
    }),
    routerHealth: z
      .object({
        ok: z.boolean(),
        queueDepth: z.number().optional(),
        terminalRows: z.number().optional(),
      })
      .nullable(),
  }),
  integrity: z.object({
    databases: z.record(z.string(), supportBundleDatabaseReportSchema),
  }),
  recentRedactedErrors: z.array(
    z.object({
      timestamp: z.string(),
      level: z.string(),
      event: z.string(),
      correlationId: z.string().optional(),
      jobId: z.string().optional(),
      runId: z.string().optional(),
      nodeId: z.string().optional(),
      errorCode: z.string().optional(),
      durationMs: z.number().optional(),
      attributes: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
})

export type SupportBundle = z.infer<typeof supportBundleSchema>
export type SupportBundleDatabaseReport = z.infer<typeof supportBundleDatabaseReportSchema>

export interface GenerateBundleOptions {
  readonly profile: string
  readonly configPath?: string
  readonly stateDir?: string
  readonly routerBinPath?: string
  readonly customSecrets?: readonly string[]
  readonly previewOnly?: boolean
}
