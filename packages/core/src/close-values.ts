// Every value the close, the hold check, the reopen and the operator email read, declared once (D-97).
// The action and reopen stacks import the two timeouts from here, as detection imports its own, so a
// function's timeout and the claim rule that reads it cannot drift apart. None of these is a page
// number and no email quotes one (AC-P10).

/** R2: sends accepted in the first minute after the put are SES draining what it had already taken. */
export const HOLD_MS = 60_000;

/** R2: the hold check waits five minutes past the hold end, so late Send records have landed. */
export const HOLD_CHECK_DELAY_MS = 300_000;

/** R3: an evidence record older than an hour no longer describes the lane it would pause. */
export const RECORD_MAX_AGE_MS = 3_600_000;

/**
 * D-98: pause and reopen attempts together per lane per UTC clock hour. Two full pause-and-reopen
 * cycles fit, so live session B has room for one retry each, and a flapping bug stops at its third pause.
 */
export const LANE_HOUR_ATTEMPT_CAP = 4;

/** AC-E29: one operator email, tried at most this many times before it is marked failed. */
export const EMAIL_SEND_ATTEMPTS = 3;

/**
 * D-97: readSesFacts at one read a second with up to 50 identity reads and one destination read per
 * lane is about 55 s, plus the hold-check fold, the put, the read-back and one send. The same headroom
 * reasoning as detection's timeout, not a measurement. A closure claim younger than this is a run
 * still acting (D-91).
 */
export const ACTION_FUNCTION_TIMEOUT_MS = 300_000;

/** D-97: a few reads, one put and one read-back. */
export const REOPEN_FUNCTION_TIMEOUT_MS = 30_000;
