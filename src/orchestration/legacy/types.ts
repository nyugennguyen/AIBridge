import type { z } from "zod"
import type {
  legacyAgentMappingSchema,
  legacyAllowedSourceSchema,
  legacyAuthorizationEvidenceSchema,
  legacyBridgeConfigSchema,
  legacyCallbackDeliverySchema,
  legacyConfigurationMigrationSchema,
  legacyDecisionSchema,
  legacyHandoffSchema,
  legacyJobMigrationSchema,
  legacyJobRecordSchema,
  legacyJobStatusSchema,
  legacyMemoryDataSchema,
  legacyMigrationContextSchema,
  legacyMigrationDryRunSchema,
  legacyMigrationSourceSchema,
  legacyPlanMetadataSchema,
  legacyProjectMappingSchema,
  legacyTaskEntrySchema,
  legacyTaskMigrationSchema,
  migrationDiagnosticSchema,
} from "./schemas.js"

export type LegacyAllowedSource = z.infer<typeof legacyAllowedSourceSchema>
export type LegacyPlanMetadata = z.infer<typeof legacyPlanMetadataSchema>
export type LegacyBridgeConfig = z.infer<typeof legacyBridgeConfigSchema>
export type LegacyJobStatus = z.infer<typeof legacyJobStatusSchema>
export type LegacyCallbackDelivery = z.infer<typeof legacyCallbackDeliverySchema>
export type LegacyJobRecord = z.infer<typeof legacyJobRecordSchema>
export type LegacyTaskEntry = z.infer<typeof legacyTaskEntrySchema>
export type LegacyDecision = z.infer<typeof legacyDecisionSchema>
export type LegacyHandoff = z.infer<typeof legacyHandoffSchema>
export type LegacyMemoryData = z.infer<typeof legacyMemoryDataSchema>
export type LegacyMigrationSource = z.infer<typeof legacyMigrationSourceSchema>
export type LegacyAgentMapping = z.infer<typeof legacyAgentMappingSchema>
export type LegacyProjectMapping = z.infer<typeof legacyProjectMappingSchema>
export type LegacyMigrationContext = z.infer<typeof legacyMigrationContextSchema>
export type MigrationDiagnostic = z.infer<typeof migrationDiagnosticSchema>
export type LegacyAuthorizationEvidence = z.infer<typeof legacyAuthorizationEvidenceSchema>
export type LegacyJobMigration = z.infer<typeof legacyJobMigrationSchema>
export type LegacyTaskMigration = z.infer<typeof legacyTaskMigrationSchema>
export type LegacyConfigurationMigration = z.infer<typeof legacyConfigurationMigrationSchema>
export type LegacyMigrationDryRun = z.infer<typeof legacyMigrationDryRunSchema>
