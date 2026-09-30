/**
 * Bounds the reconciler states, and each one says what it is defending against.
 */

/**
 * The most ids one resend list may carry.
 *
 * 128, and it is the protocol's own `ARRAY_MAX` rather than a number picked here:
 * `meshReconciliationResponseSchema` bounds both lists at that value, so a higher
 * limit would be a number the wire refuses for a reason that reads as a protocol
 * defect rather than as a policy. The bound exists because the list crosses a wire
 * to a peer that is, by definition at this point, not known to be in sync.
 */
export const RECONCILE_RESEND_LIMIT = 128
