/**
 * How long to wait for a first answer.
 *
 * ## Why the window has to exceed the idle settle window
 *
 * Two separate timers guard the end of a turn, and they answer different
 * questions:
 *
 *   - `waitForIdle`'s settle window ("has it stopped?") settles a turn that is
 *     mid-flight but quiet.
 *   - the answer window ("did it say anything?") decides whether a settled turn
 *     produced output at all.
 *
 * A slow model spends the whole gap between the prompt and its first token
 * looking idle, so it trips the settle window and then has to survive the answer
 * window as well. Observed live with `opencode/big-pickle` on 2026-10-10: the job
 * was created at 17:45:58.700, aibr settled at 17:46:07.560 (3s idle settle plus
 * a 5s answer window), and the first assistant message arrived at 17:46:32.124 --
 * 33s in. The turn then produced a correct answer that was never recorded.
 *
 * The settle window is now itself sized from measured tool-call gaps (60s, after a
 * 47-second gap between two messages of one turn was misread as the end of that
 * turn), so the answer window has to clear that too: settling and answering are
 * not the same event, and a model that takes a minute to speak is not a failed
 * turn.
 */
export const ANSWER_GRACE_MS = 90_000

/**
 * Floor for the answer window.
 *
 * Kept above `DEFAULT_IDLE_SETTLE_MS` so the two cannot collapse into the same
 * instant: if the answer window were not materially longer than the settle
 * window, every slow model would be reported as having produced nothing.
 */
export const MIN_ANSWER_GRACE_MS = 30_000