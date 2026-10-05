/**
 * Upgrade and Rollback framework types (M8.6).
 */

export const MIN_SUPPORTED_DATABASE_VERSION = 1
export const CURRENT_SUPPORTED_DATABASE_VERSION = 2

export const SUPPORTED_CONFIG_VERSIONS = ["v1"] as const
export const SUPPORTED_PROTOCOL_VERSIONS = ["v1"] as const

export interface UpgradePlan {
  readonly currentVersion: number
  readonly targetVersion: number
  readonly isDowngrade: boolean
  readonly isNoOp: boolean
  readonly pendingMigrations: readonly {
    readonly version: number
    readonly name: string
    readonly destructive: boolean
  }[]
  readonly preUpgradeBackupRequired: boolean
}

export interface UpgradePreflightResult {
  readonly ok: boolean
  readonly currentVersion: number
  readonly targetVersion: number
  readonly isDowngrade: boolean
  readonly canUpgrade: boolean
  readonly actionableMessage: string
  readonly errors: readonly string[]
}

export interface UpgradeOptions {
  readonly targetVersion?: number
  readonly allowDestructive?: boolean
  readonly backupDir?: string
  readonly dryRun?: boolean
}

export interface UpgradeResult {
  readonly success: boolean
  readonly previousVersion: number
  readonly newVersion: number
  readonly appliedCount: number
  readonly backupPath?: string
  readonly rollbackAvailable: boolean
  readonly errors: readonly string[]
}

export interface RollbackOptions {
  readonly backupPath?: string
}

export interface RollbackResult {
  readonly success: boolean
  readonly rolledBackToVersion: number
  readonly restoredFromBackup?: string
  readonly errors: readonly string[]
}
