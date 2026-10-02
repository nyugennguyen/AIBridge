/**
 * M6.9 — the no-secret audit and the payload schema.
 *
 * ADR 0007 section 12: rendered explanations, traces, disclosures, and notification
 * payloads "contain identifiers, enum values, numbers, digests, rule metadata, and
 * reason strings authored by a user for the purpose of explaining a decision" and
 * "never contain: prompt text, task descriptions, context manifest item content,
 * memory record content, capability payload bytes, terminal output, environment
 * values, bearer tokens, or provider credentials."
 *
 * # Two assertions, and the second is the real control
 *
 * **1. THE AUDIT FINDS CANARIES.** A canary is seeded into every field a caller
 * might plausibly reach for — the summary, and each of five content-shaped fields
 * that do not exist on the schema at all (`prompt`, `description`, `contextContent`,
 * `token`, `env`). Each is checked in the raw form, in five encodings, and against the
 * credential-shape detectors. This proves the AUDIT works.
 *
 * **2. THE SCHEMA REFUSES THEM.** `notificationEnvelopeSchema` is `.strict()`, so an
 * envelope carrying `prompt` does not parse at all. This is the real control, because
 * it means there is no code path on which the payload reaches disk-shaped memory with
 * the canary in it. The first assertion exists so that the second is not the only thing
 * standing between a canary and a report — a schema is a type, and a type is not a
 * scanner.
 *
 * # Why the audit does not reuse `src/context/redaction/`
 *
 * It cannot, and the reason is the module boundary rather than an oversight.
 * `src/context/isolation.ts` imports `src/memory/ontology.js` and
 * `src/orchestration/identifiers.js`, so importing anything from `src/context/` would
 * put an upward edge under N1 — exactly the edge ADR 0007 section 17 exists to prevent.
 * (`src/rules` is allowed `rules -> memory/ontology`; this module is allowed nothing.)
 * The scanning is therefore implemented directly in `types.ts`, with the same five
 * encodings and the added shape detectors. `barrel.test.ts` asserts that
 * `src/notifications/` imports nothing upward, so this cannot quietly become an edge.
 *
 * # The structural audit input (types.ts S3)
 *
 * `NotificationAuditInput` declares every payload field as `unknown` and declares the
 * rendered view as `{ title?, lines }`. It does NOT import `NotificationEnvelope` or
 * `NotificationTuiViewModel`. So this test feeds the audit deliberately malformed
 * values — which it must be able to do, because a schema-derived type would have thrown
 * before the audit could look at the thing it exists to look at.
 */

import { describe, expect, it } from "vitest"
import {
  MAX_NOTIFICATION_SUMMARY_CHARACTERS,
  NOTIFICATION_EGRESS_PATHS,
  auditNotificationPayload,
  buildNotificationTuiView,
  createNotificationStore,
  describeNotificationAudit,
  findSeededNotificationSecret,
  initialNotificationTuiState,
  loadNotificationTuiEntries,
  notificationEnvelopeSchema,
  notificationNoticeLine,
  reduceNotificationTui,
  routeNotificationKey,
  type NotificationAuditResult,
} from "../../../src/notifications/index.js"
import {
  ALL_NOTIFICATION_CANARIES,
  FIXED_NOW,
  NOTIFICATION_CANARIES,
  createTestClock,
  notificationRequest,
  rawEnvelope,
  testHarness,
} from "./fixtures.js"

/** Every content-shaped key a caller might plausibly attach to a notification. */
const CONTENT_FIELD_NAMES = [
  "prompt",
  "description",
  "contextContent",
  "token",
  "env",
  "taskDescription",
  "instructions",
  "diff",
  "output",
  "memoryContent",
  "apiKey",
  "transcript",
] as const

/** The audit findings for one result, filtered to the kind under test. */
function blockerKinds(result: NotificationAuditResult): readonly string[] {
  return result.findings.filter((finding) => finding.severity === "blocker").map((finding) => finding.kind)
}

describe("M6.9 the audit finds a canary in every field a caller might plausibly populate", () => {
  it("finds a prompt-text canary in the summary", () => {
    const result = auditNotificationPayload({
      seededSecrets: [NOTIFICATION_CANARIES.prompt],
      envelopes: [rawEnvelope({ summary: NOTIFICATION_CANARIES.prompt })],
    })
    expect(blockerKinds(result)).toContain("secret_material")
    expect(result.passed).toBe(false)
  })

  it("finds a prompt-text canary in a `prompt` field", () => {
    const result = auditNotificationPayload({
      seededSecrets: [NOTIFICATION_CANARIES.prompt],
      envelopes: [rawEnvelope({ prompt: NOTIFICATION_CANARIES.prompt })],
    })
    expect(blockerKinds(result)).toContain("unauthorized_content")
    expect(blockerKinds(result)).toContain("secret_material")
  })

  it("finds a task-description canary in a `description` field", () => {
    const result = auditNotificationPayload({
      seededSecrets: [NOTIFICATION_CANARIES.taskDescription],
      envelopes: [rawEnvelope({ description: NOTIFICATION_CANARIES.taskDescription })],
    })
    expect(blockerKinds(result)).toContain("unauthorized_content")
  })

  it("finds a context-content canary in a `contextContent` field", () => {
    const result = auditNotificationPayload({
      seededSecrets: [NOTIFICATION_CANARIES.contextContent],
      envelopes: [rawEnvelope({ contextContent: NOTIFICATION_CANARIES.contextContent })],
    })
    expect(blockerKinds(result)).toContain("secret_material")
  })

  it("finds a token-shaped canary in a `token` field", () => {
    const result = auditNotificationPayload({
      seededSecrets: [NOTIFICATION_CANARIES.token],
      envelopes: [rawEnvelope({ token: NOTIFICATION_CANARIES.token })],
    })
    expect(blockerKinds(result)).toContain("secret_material")
    // And the shape detector catches it too, with no seed involved — which is the
    // property that makes the audit more than a grep for what the test planted.
    expect(blockerKinds(result)).toContain("credential_shape")
  })

  it("finds an env-var-shaped canary in an `env` field", () => {
    const result = auditNotificationPayload({
      seededSecrets: [NOTIFICATION_CANARIES.envAssignment],
      envelopes: [rawEnvelope({ env: NOTIFICATION_CANARIES.envAssignment })],
    })
    expect(blockerKinds(result)).toContain("unauthorized_content")
    expect(blockerKinds(result)).toContain("credential_shape")
  })

  it("finds a canary in every one of the twelve content-shaped field names", () => {
    // The exhaustive form, so a field added to `CONTENT_FIELD_NAMES` in the fixtures
    // cannot go untested.
    const result = auditNotificationPayload({
      seededSecrets: ALL_NOTIFICATION_CANARIES,
      envelopes: CONTENT_FIELD_NAMES.map((field, index) => rawEnvelope({ [field]: ALL_NOTIFICATION_CANARIES[index % ALL_NOTIFICATION_CANARIES.length]! })),
    })
    expect(result.findings.length).toBeGreaterThanOrEqual(CONTENT_FIELD_NAMES.length)
    expect(result.passed).toBe(false)
  })

  it("finds a canary in each of the five encodings a value could travel in", () => {
    const raw = NOTIFICATION_CANARIES.prompt
    const forms = [
      raw,
      Buffer.from(raw, "utf8").toString("base64"),
      Buffer.from(raw, "utf8").toString("base64url"),
      encodeURIComponent(raw),
      JSON.stringify(raw).slice(1, -1),
    ]
    for (const form of forms) {
      const result = auditNotificationPayload({
        seededSecrets: [raw],
        envelopes: [rawEnvelope({ summary: `notice: ${form}` })],
      })
      expect(result.passed).toBe(false)
    }
  })

  it("finds a canary base64-encoded inside a summary, which a raw grep would miss", () => {
    const encoded = Buffer.from(NOTIFICATION_CANARIES.prompt, "utf8").toString("base64")
    const result = auditNotificationPayload({
      seededSecrets: [NOTIFICATION_CANARIES.prompt],
      envelopes: [rawEnvelope({ summary: `run blocked: ${encoded}` })],
    })
    expect(findSeededNotificationSecret(`run blocked: ${encoded}`, [NOTIFICATION_CANARIES.prompt])).toBe(
      NOTIFICATION_CANARIES.prompt,
    )
    expect(result.passed).toBe(false)
  })

  it("finds a canary in the inbox at rest", () => {
    const result = auditNotificationPayload({
      seededSecrets: [NOTIFICATION_CANARIES.prompt],
      inboxEntries: [{ envelope: rawEnvelope({ summary: NOTIFICATION_CANARIES.prompt }) }],
    })
    expect(result.examinedPaths).toContain("inbox_at_rest")
    expect(result.passed).toBe(false)
  })

  it("finds a canary in the rendered TUI lines", () => {
    const result = auditNotificationPayload({
      seededSecrets: [NOTIFICATION_CANARIES.taskDescription],
      rendered: { title: "Notifications", lines: [`> !! [Run failed] ${NOTIFICATION_CANARIES.taskDescription}`] },
    })
    expect(result.examinedPaths).toContain("tui_render")
    expect(result.passed).toBe(false)
  })

  it("finds a canary in the one-line notice", () => {
    const result = auditNotificationPayload({
      seededSecrets: [NOTIFICATION_CANARIES.contextContent],
      notice: `Run failed: ${NOTIFICATION_CANARIES.contextContent}`,
    })
    expect(result.examinedPaths).toContain("notice_line")
    expect(result.passed).toBe(false)
  })

  it("reports a credential shape with NO canary seeded, so the audit is not only a grep", () => {
    const result = auditNotificationPayload({
      seededSecrets: [],
      envelopes: [rawEnvelope({ summary: "authorization rejected: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl" })],
    })
    expect(blockerKinds(result)).toContain("credential_shape")
  })

  it("reports every one of the five credential shapes", () => {
    const shapes = [
      "Bearer abcdefghijklmnop",
      "sk-live-abcdefghijklmnop",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl",
      "-----BEGIN RSA PRIVATE KEY-----",
      "DATABASE_PASSWORD=hunter2-not-a-real-password",
    ]
    for (const shape of shapes) {
      const result = auditNotificationPayload({ seededSecrets: [], envelopes: [rawEnvelope({ summary: shape })] })
      expect(blockerKinds(result), `shape: ${shape}`).toContain("credential_shape")
    }
  })

  it("passes a clean payload, so the audit is not vacuously failing", () => {
    // The control on the control: an audit that reports a finding for everything is
    // as useless as one that reports none.
    const result = auditNotificationPayload({
      seededSecrets: ALL_NOTIFICATION_CANARIES,
      envelopes: [rawEnvelope()],
      rendered: { title: "Notifications", lines: ["> !! [Run blocked] Run run-1 blocked by rule rule-1 [run-1 task-1 rule-1 policy_denied]"] },
      notice: "Run blocked: Run run-1 blocked by rule rule-1 (1 pending)",
    })
    expect(result.passed).toBe(true)
    expect(result.findings).toEqual([])
  })
})

describe("M6.9 the schema refuses every field the audit would have found", () => {
  it("refuses an envelope carrying a prompt field", () => {
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ prompt: NOTIFICATION_CANARIES.prompt })).success).toBe(false)
  })

  it("refuses an envelope carrying a description field", () => {
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ description: NOTIFICATION_CANARIES.taskDescription })).success).toBe(false)
  })

  it("refuses an envelope carrying a contextContent field", () => {
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ contextContent: NOTIFICATION_CANARIES.contextContent })).success).toBe(false)
  })

  it("refuses an envelope carrying a token field", () => {
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ token: NOTIFICATION_CANARIES.token })).success).toBe(false)
  })

  it("refuses an envelope carrying an env field", () => {
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ env: NOTIFICATION_CANARIES.envAssignment })).success).toBe(false)
  })

  it("refuses an envelope carrying ANY of the twelve content-shaped field names", () => {
    for (const field of CONTENT_FIELD_NAMES) {
      const parsed = notificationEnvelopeSchema.safeParse(rawEnvelope({ [field]: "anything" }))
      expect(parsed.success, `field: ${field}`).toBe(false)
    }
  })

  it("refuses an envelope whose summary is a full-length prompt, by the length bound", () => {
    // The summary is the ONE free-text field, and it is bounded at 200 characters. A
    // prompt pasted whole is far longer than that, so it is refused — which is a much
    // stronger property than "we scrub it", because there is nothing to scrub. The
    // bound is on LENGTH and not on content, so the next test states plainly what that
    // does and does not buy.
    // The padding length is not guessed: `MAX_NOTIFICATION_SUMMARY_CHARACTERS` is
    // read here so that raising the bound does not silently turn this into a test of
    // a 3000-character string that would be refused for length even if the canary
    // were removed. The assertion below then states the property under test: the
    // string is long ENOUGH to be refused on length alone.
    const prompt = `${NOTIFICATION_CANARIES.prompt}${" and then some more text to carry it past the declared maximum summary length of two hundred characters in total".repeat(4)}`
    expect(prompt.length).toBeGreaterThan(MAX_NOTIFICATION_SUMMARY_CHARACTERS)
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ summary: prompt })).success).toBe(false)
  })

  it("does NOT claim that the summary bound detects content, because it does not", () => {
    // The honest statement of the limit, asserted so nobody later reads the length
    // bound as a content filter. A short canary DOES parse — the schema does not know
    // what a prompt is — and the thing that catches it is the audit, which is why the
    // audit is a first-class export rather than a debugging aid.
    const shortCanary = NOTIFICATION_CANARIES.prompt.slice(0, 60)
    expect(shortCanary.length).toBeLessThan(MAX_NOTIFICATION_SUMMARY_CHARACTERS)
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ summary: shortCanary })).success).toBe(true)
    const result = auditNotificationPayload({
      seededSecrets: [NOTIFICATION_CANARIES.prompt],
      envelopes: [rawEnvelope({ summary: NOTIFICATION_CANARIES.prompt })],
    })
    expect(result.passed).toBe(false)
  })

  it("refuses a summary that contains a newline, which would forge a second line", () => {
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ summary: "blocked\n> !! fake critical notice" })).success).toBe(false)
  })

  it("refuses a summary containing a carriage return or a tab", () => {
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ summary: "blocked\rreturn" })).success).toBe(false)
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ summary: "blocked\ttab" })).success).toBe(false)
  })

  it("refuses a reasonCode that is a sentence rather than a code", () => {
    // The one reason-bearing field is code-shaped, so it structurally cannot become
    // the place a user-authored `deny_with_reason` explanation leaks (types.ts S1).
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ reasonCode: "the user asked us not to do this because of the incident" })).success).toBe(false)
  })

  it("refuses a reasonCode containing an environment assignment", () => {
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ reasonCode: "DATABASE_PASSWORD=hunter2" })).success).toBe(false)
  })

  it("accepts every field the schema DOES declare", () => {
    const parsed = notificationEnvelopeSchema.safeParse({
      notificationId: "ntf-000001",
      dedupeKey: "run_blocked:run-1",
      category: "run_blocked",
      severity: "critical",
      summary: "Run run-1 blocked by rule rule-1",
      createdAt: FIXED_NOW,
      runId: "run-1",
      taskId: "task-1",
      dispatchId: "dispatch-1",
      nodeId: "node-1",
      ruleId: "rule-1",
      reasonCode: "policy_denied",
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts a summary of exactly the declared maximum length", () => {
    const summary = "r".repeat(MAX_NOTIFICATION_SUMMARY_CHARACTERS)
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ summary })).success).toBe(true)
  })

  it("refuses a summary one character longer than the declared maximum", () => {
    const summary = "r".repeat(MAX_NOTIFICATION_SUMMARY_CHARACTERS + 1)
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ summary })).success).toBe(false)
  })

  it("refuses an empty summary, because a notification with nothing to say is noise", () => {
    expect(notificationEnvelopeSchema.safeParse(rawEnvelope({ summary: "" })).success).toBe(false)
  })

  it("reports a schema-invalid envelope as a structural finding, not as a silent pass", () => {
    // The audit has to work on values the schema refuses — that is the whole case it
    // exists for — and it says so rather than staying quiet.
    const result = auditNotificationPayload({
      seededSecrets: [],
      envelopes: [rawEnvelope({ prompt: "anything" })],
    })
    expect(result.findings.some((finding) => finding.kind === "structure")).toBe(true)
    expect(result.passed).toBe(false)
  })
})

describe("M6.9 the audit never reports the content it found", () => {
  it("names the forbidden FIELD rather than its value", () => {
    // The audit's strings end up in a reviewer's report and in a CI log. A finding
    // that quoted the leak would put the leak in the place that is read most widely,
    // which is the opposite of the point.
    const result = auditNotificationPayload({
      seededSecrets: [NOTIFICATION_CANARIES.prompt],
      envelopes: [rawEnvelope({ prompt: NOTIFICATION_CANARIES.prompt })],
    })
    for (const finding of result.findings) {
      expect(finding.detail).not.toContain(NOTIFICATION_CANARIES.prompt)
    }
  })

  it("names the credential SHAPE rather than the credential", () => {
    const result = auditNotificationPayload({
      seededSecrets: [],
      envelopes: [rawEnvelope({ summary: "rejected: Bearer abcdefghijklmnopqrst" })],
    })
    for (const finding of result.findings) {
      expect(finding.detail).not.toContain("abcdefghijklmnopqrst")
    }
  })

  it("names the subject by notificationId so two findings are distinguishable", () => {
    const result = auditNotificationPayload({
      seededSecrets: [],
      envelopes: [
        rawEnvelope({ notificationId: "ntf-000001", prompt: "a" }),
        rawEnvelope({ notificationId: "ntf-000002", prompt: "b" }),
      ],
    })
    const subjects = result.findings.map((finding) => finding.subjectId)
    expect(subjects).toContain("ntf-000001")
    expect(subjects).toContain("ntf-000002")
  })
})

describe("M6.9 the audit says which paths it examined", () => {
  it("examines all four paths when all four are supplied", () => {
    // `notice: null` is NOT a supplied notice — an absent notice is the absence of the
    // path, and the audit distinguishes "there was no notice" from "the notice was
    // checked and held nothing". A non-null notice is supplied here so all four paths
    // are genuinely examined.
    const result = auditNotificationPayload({
      seededSecrets: [],
      envelopes: [],
      inboxEntries: [],
      rendered: { lines: [] },
      notice: "no notifications",
    })
    expect(result.examinedPaths).toEqual([...NOTIFICATION_EGRESS_PATHS])
  })

  it("does not claim to have examined the notice path when the notice was null", () => {
    // The companion to the assertion above, and the reason it exists: an audit that
    // reported four of four paths when only three were supplied would report success
    // for a check it did not run (the `src/context/isolation.ts:343-351` lesson).
    const result = auditNotificationPayload({
      seededSecrets: [],
      envelopes: [],
      inboxEntries: [],
      rendered: { lines: [] },
      notice: null,
    })
    expect(result.examinedPaths).toEqual(["envelope_payload", "inbox_at_rest", "tui_render"])
    expect(result.passed).toBe(true)
  })

  it("examines only the paths the input supplies", () => {
    // "No leaks found" without "out of four" is indistinguishable from "no leaks,
    // because nothing was checked" (the `src/context/isolation.ts:518-527` lesson).
    const result = auditNotificationPayload({ seededSecrets: [], envelopes: [] })
    expect(result.examinedPaths).toEqual(["envelope_payload"])
  })

  it("reports a path count in its one-line disposition", () => {
    const result = auditNotificationPayload({ seededSecrets: [], envelopes: [] })
    expect(describeNotificationAudit(result)).toContain("1/4 paths examined")
    expect(describeNotificationAudit(result)).toContain("PASS")
  })

  it("reports FAIL in its disposition when a blocker was found", () => {
    const result = auditNotificationPayload({ seededSecrets: [], envelopes: [rawEnvelope({ prompt: "x" })] })
    expect(describeNotificationAudit(result)).toContain("FAIL")
  })
})

describe("M6.9 a notification the bus produced carries nothing an audit would flag", () => {
  it("audits clean across all four paths for a real emitted notification", async () => {
    const { bus, store } = testHarness()
    await bus.emit(notificationRequest())
    const state = loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)
    const view = buildNotificationTuiView(state)
    const result = auditNotificationPayload({
      seededSecrets: ALL_NOTIFICATION_CANARIES,
      envelopes: store.entries().map((entry) => entry.envelope),
      inboxEntries: store.entries(),
      rendered: { title: view.title, lines: view.lines },
      notice: notificationNoticeLine(state),
    })
    expect(result.findings).toEqual([])
    expect(result.passed).toBe(true)
  })

  it("audits clean for a notification carrying every declared identifier", async () => {
    const { bus, store } = testHarness()
    await bus.emit(
      notificationRequest({
        dedupeKey: "lease_expired:node-1:dispatch-1",
        category: "lease_expired",
        severity: "attention",
        summary: "Lease for node-1 expired for dispatch-1",
        dispatchId: "dispatch-1",
        nodeId: "node-1",
      }),
    )
    const state = loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)
    const view = buildNotificationTuiView(state)
    const result = auditNotificationPayload({
      seededSecrets: ALL_NOTIFICATION_CANARIES,
      envelopes: store.entries().map((entry) => entry.envelope),
      inboxEntries: store.entries(),
      rendered: { title: view.title, lines: view.lines },
      notice: notificationNoticeLine(state),
    })
    expect(result.passed).toBe(true)
  })

  it("audits clean when every pending entry has been acknowledged", async () => {
    const { bus, store } = testHarness()
    const [result] = await bus.emit(notificationRequest())
    store.acknowledge(result!.notificationId)
    const state = loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)
    expect(notificationNoticeLine(state)).toBeNull()
  })
})

describe("M6.9 a muted entry's subject is not rendered", () => {
  it("withholds the subject line of a muted row but keeps its severity", async () => {
    // A user who silenced a category asked not to be shown it; rendering the subject
    // one glance later is showing it anyway. Severity survives because hiding
    // "critical" would hide the reason to un-mute (tui-adapter.ts, `withheldDetail`).
    const { bus, store } = testHarness({ quieting: { categories: ["run_blocked"], severities: [], pairs: [] } })
    await bus.emit(notificationRequest({ runId: "run-secret-subject", ruleId: "rule-1" }))
    const state = loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)
    const view = buildNotificationTuiView(state)
    expect(view.rows[0]!.withheldDetail).toBe(true)
    const rendered = view.lines.join("\n")
    expect(rendered).not.toContain("run-secret-subject")
    expect(rendered).toContain("critical")
  })

  it("still renders the subject of an unmuted row", async () => {
    const { bus, store } = testHarness()
    await bus.emit(notificationRequest({ runId: "run-1" }))
    const state = loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)
    const view = buildNotificationTuiView(state)
    expect(view.rows[0]!.withheldDetail).toBe(false)
    expect(view.lines.join("\n")).toContain("run-1")
  })

  it("refuses pasted text on the notification screen rather than echoing it", () => {
    // A searchable notification list would be a place content could be echoed back, so
    // a paste is refused with a reason (N2, S13).
    const state = initialNotificationTuiState(FIXED_NOW)
    const intent = routeNotificationKey(state, { type: "paste", text: NOTIFICATION_CANARIES.prompt })
    expect(intent.type).toBe("reject")
    if (intent.type === "reject") expect(intent.reason).not.toContain(NOTIFICATION_CANARIES.prompt)
  })
})

describe("M6.9 the store refuses an envelope the schema rejects", () => {
  it("throws rather than storing a payload it cannot validate", () => {
    const store = createNotificationStore({ clock: createTestClock() })
    expect(() => store.publish(rawEnvelope({ prompt: "x" }))).toThrow()
  })

  it("leaves the inbox empty after refusing a payload", () => {
    const store = createNotificationStore({ clock: createTestClock() })
    try {
      store.publish(rawEnvelope({ prompt: "x" }))
    } catch {
      // The refusal is the assertion; this block exists so the next assertion is about
      // the store's state rather than about the throw.
    }
    expect(store.entries()).toEqual([])
  })
})

describe("M6.9 the reducer cannot be made to render content", () => {
  it("renders nothing from an entry that is not in the state", () => {
    const state = initialNotificationTuiState(FIXED_NOW)
    const next = reduceNotificationTui(state, { type: "entries-loaded", entries: [], now: FIXED_NOW })
    expect(buildNotificationTuiView(next).lines.join("\n")).not.toContain("run-1")
  })
})
