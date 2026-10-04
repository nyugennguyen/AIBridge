/**
 * M7.4: Ingress Shadow Mode and Divergence Tracker.
 *
 * ADR 0008 §2.8 / M7.4:
 * When shadow mode is active, the engine HTTP ingress mirrors incoming
 * `/trigger` and `/report` requests through Tier 1 structural validation
 * to ensure that router ingress admission does not diverge from engine admission.
 *
 * Invariant: 72 h shadow divergence must be zero before router cutover.
 */

import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import {
  triggerRequestSchema,
  reportCallbackSchema,
} from "../config/schemas.js"
import type { BridgeConfig } from "../config/types.js"

export interface ShadowDivergence {
  readonly route: string
  readonly timestamp: number
  readonly engineAdmitted: boolean
  readonly shadowAdmitted: boolean
  readonly reason: string
}

export interface ShadowStats {
  readonly total: number
  readonly matches: number
  readonly divergences: number
  readonly divergenceRate: number
  readonly recentDivergences: readonly ShadowDivergence[]
}

/** Job ID charset enforced by router (F-01, M7.3): [A-Za-z0-9_-]{1,128} */
const JOB_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/

export class ShadowIngressMirror {
  private total = 0
  private matches = 0
  private divergences = 0
  private readonly recentDivergences: ShadowDivergence[] = []
  private readonly canonicalProjectRoots: readonly string[]

  constructor(config: BridgeConfig) {
    this.canonicalProjectRoots = config.projects.flatMap((project) => {
      try {
        return [realpathSync(resolve(project.path))]
      } catch {
        return []
      }
    })
  }

  /**
   * Evaluates Tier 1 structural gate identical to the Rust router:
   * 1. schemaVersion envelope check (F-06: must be "v1")
   * 2. schema parse (with unknown-key rejection)
   * 3. job_id charset (F-01)
   * 4. project containment (F-04)
   */
  evaluateTier1Trigger(payload: unknown): { readonly admitted: boolean; readonly reason?: string } {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return { admitted: false, reason: "PAYLOAD_NOT_OBJECT" }
    }

    const raw = payload as Record<string, unknown>

    // 1. schemaVersion envelope check (F-06 / validate.rs: must be "v1")
    if (raw.schemaVersion !== "v1") {
      return { admitted: false, reason: "UNKNOWN_OR_MISSING_SCHEMA_VERSION" }
    }

    // Strip envelope key to evaluate payload
    const { schemaVersion: _, ...inner } = raw

    const parseResult = triggerRequestSchema.safeParse(inner)
    if (!parseResult.success) {
      return { admitted: false, reason: "SCHEMA_VALIDATION_FAILED" }
    }

    const trigger = parseResult.data

    // 2. job_id charset check (F-01: [A-Za-z0-9_-]{1,128})
    if (trigger.job_id && !JOB_ID_REGEX.test(trigger.job_id)) {
      return { admitted: false, reason: "JOB_ID_TRAVERSAL_OR_INVALID_CHARSET" }
    }

    // 3. Project containment check (F-04: realpath containment)
    try {
      const canonicalDir = realpathSync(resolve(trigger.project_dir))
      const contained = this.canonicalProjectRoots.some(
        (root) => canonicalDir === root || canonicalDir.startsWith(`${root}/`),
      )
      if (!contained) {
        return { admitted: false, reason: "PROJECT_ROOT_ESCAPE" }
      }
    } catch {
      return { admitted: false, reason: "PROJECT_DIR_UNRESOLVABLE" }
    }

    return { admitted: true }
  }

  /**
   * Evaluates Tier 1 structural gate for reports.
   */
  evaluateTier1Report(payload: unknown): { readonly admitted: boolean; readonly reason?: string } {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return { admitted: false, reason: "PAYLOAD_NOT_OBJECT" }
    }

    const raw = payload as Record<string, unknown>

    if (raw.schemaVersion !== "v1") {
      return { admitted: false, reason: "UNKNOWN_OR_MISSING_SCHEMA_VERSION" }
    }

    const { schemaVersion: _, ...inner } = raw

    const parseResult = reportCallbackSchema.safeParse(inner)
    if (!parseResult.success) {
      return { admitted: false, reason: "SCHEMA_VALIDATION_FAILED" }
    }

    const report = parseResult.data

    if (report.job_id && !JOB_ID_REGEX.test(report.job_id)) {
      return { admitted: false, reason: "JOB_ID_TRAVERSAL_OR_INVALID_CHARSET" }
    }

    return { admitted: true }
  }

  /**
   * Mirror a trigger request and record comparison with engine admission.
   */
  mirrorTrigger(payload: unknown, engineAdmitted: boolean): void {
    this.total += 1
    const tier1 = this.evaluateTier1Trigger(payload)

    if (tier1.admitted === engineAdmitted) {
      this.matches += 1
    } else {
      this.divergences += 1
      this.recentDivergences.push({
        route: "POST /trigger",
        timestamp: Date.now(),
        engineAdmitted,
        shadowAdmitted: tier1.admitted,
        reason: tier1.reason ?? "Divergence between engine and shadow admission",
      })
    }
  }

  /**
   * Mirror a report request and record comparison with engine admission.
   */
  mirrorReport(payload: unknown, engineAdmitted: boolean): void {
    this.total += 1
    const tier1 = this.evaluateTier1Report(payload)

    if (tier1.admitted === engineAdmitted) {
      this.matches += 1
    } else {
      this.divergences += 1
      this.recentDivergences.push({
        route: "POST /report",
        timestamp: Date.now(),
        engineAdmitted,
        shadowAdmitted: tier1.admitted,
        reason: tier1.reason ?? "Divergence between engine and shadow admission",
      })
    }
  }

  getStats(): ShadowStats {
    return {
      total: this.total,
      matches: this.matches,
      divergences: this.divergences,
      divergenceRate: this.total === 0 ? 0 : this.divergences / this.total,
      recentDivergences: [...this.recentDivergences],
    }
  }
}
