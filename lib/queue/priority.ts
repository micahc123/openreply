/**
 * Job priorities for the dm-processing queue.
 *
 * BullMQ treats a LOWER number as higher priority. Both job kinds set an
 * explicit priority so ordering is well defined: jobs added without one go to
 * the plain wait list rather than the prioritized set, and mixing the two makes
 * the effective order depend on BullMQ internals.
 *
 * Why this matters: a postback is a human waiting. Someone tapped "Send me the
 * link" and is staring at Instagram until the reveal message arrives. A comment
 * job is a background send nobody is watching, and comment jobs arrive in
 * bursts — a viral reel can queue hundreds, each retried up to 3 times with
 * backoff. Without priorities the tap waits behind that entire backlog, which
 * turns a sub-second interaction into minutes.
 */

/** Button taps from opening DMs. A person is actively waiting. */
export const PRIORITY_POSTBACK = 1;

/** Comment-triggered sends. Bursty, and nobody is watching in real time. */
export const PRIORITY_COMMENT = 5;
