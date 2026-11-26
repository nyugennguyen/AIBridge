/**
 * Job ids: what a new one may look like, and which stored ones are safe to use as a filename.
 *
 * A job id becomes a file name (`<state>/jobs/<id>.json`, `JsonFileJobStore`)
 * and, for a pinned checkout, a directory name (`repo-workspace.ts`). Until
 * 3.2.0 the wire schema was `z.string().min(1)`, so a peer holding the bearer
 * could send `../x` and write outside the jobs directory.
 *
 * Two rules, on purpose:
 *
 * - `JOB_ID_PATTERN` is what a NEW id must match wherever one enters
 *   (`/trigger`, `/report`, remote `depends_on`, the router's ingress). It is
 *   the Rust router's charset (`router/src/validate.rs`, `valid_job_id`) with a
 *   leading letter or digit: no separator, no dot, nothing a filesystem treats
 *   specially, and no leading `-` that a command line could read as an option.
 *   Every id this project mints matches it: `job_<uuid>` (engine), `<uuid>`
 *   (`bridge_send`, `aibr send`), `ping-<uuid>` (`aibr ping`), 32 hex digits
 *   (router).
 *
 * - `isStorableJobId` is the looser rule for ids ALREADY in a store: a job
 *   written by an older release with an id such as `task.1` still loads, is
 *   still readable by the operator and can still change state. It only refuses
 *   what could leave the jobs directory (a separator or NUL) and names too long
 *   for a filename. The store additionally checks the resolved path.
 */
import { z } from "zod"

/** The longest job id, in bytes (ASCII). The same bound as the router's `JOB_ID_MAX_LEN`. */
export const JOB_ID_MAX_LENGTH = 128

/** A new job id: `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`. */
export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export const JOB_ID_RULE = "job_id must be 1-128 characters of A-Z, a-z, 0-9, '_' or '-', starting with a letter or digit"

export const jobIdSchema = z.string().regex(JOB_ID_PATTERN, JOB_ID_RULE)

export function isValidJobId(id: unknown): id is string {
  return typeof id === "string" && JOB_ID_PATTERN.test(id)
}

/**
 * Longest stored id: a filename is at most 255 bytes on APFS and ext4, and the
 * store adds `.json.tmp`. An older id longer than this could never have been written.
 */
const STORED_JOB_ID_MAX_BYTES = 240

/**
 * Whether an id may name a file in the jobs directory: not empty, no `/`, `\`
 * or NUL, not `.` or `..`, short enough for a filename. Accepts every
 * `JOB_ID_PATTERN` id and the older ids a store may still hold.
 */
export function isStorableJobId(id: unknown): id is string {
  if (typeof id !== "string" || id.length === 0) return false
  if (id === "." || id === "..") return false
  if (/[/\\\0]/.test(id)) return false
  return Buffer.byteLength(id, "utf8") <= STORED_JOB_ID_MAX_BYTES
}
