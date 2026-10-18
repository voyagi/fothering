import * as z from 'zod';
import { LATENESS_HORIZON_MS } from './buckets.js';
import { REOPEN_FUNCTION_TIMEOUT_MS } from './close-values.js';
import { PAUSE_MAY_HOLD_OUTCOMES, type Closure, type ClosureOutcome, type REOPEN_REFUSALS, type REOPEN_RESULTS } from './closure.js';
import { CONFIGURATION_SET_PATTERN } from './lanes.js';

export type ReopenRefusal = (typeof REOPEN_REFUSALS)[number];
export type ReopenResult = (typeof REOPEN_RESULTS)[number];

export const REOPEN_USAGE = 'usage: pass a JSON payload holding one "configurationSet" field naming one configuration set from lanes.json, and nothing else';

// Strict, as forget's payload is: a second field would be a request this command silently ignores.
export const reopenPayloadSchema = z.strictObject({ configurationSet: z.string().regex(CONFIGURATION_SET_PATTERN) });

export class ReopenUsageError extends Error {
  constructor() {
    super(REOPEN_USAGE);
    this.name = 'ReopenUsageError';
  }
}

export const REOPEN_FUNCTION_NAME_SLOT = '<ReopenFunctionName stack output>';

const SET_SLOT = '{set}';

function shellLines(lines: readonly string[]): string {
  return lines.join(' \\\n  ');
}

// D-117: 60 s is above the function's 30 s limit plus up to 10 s of cold start, so the CLI never
// gives up and retries on its own, which would start a second run of the command.
export const REOPEN_COMMAND_TEMPLATE = shellLines([
  'aws lambda invoke',
  '--region eu-central-1',
  `--function-name ${REOPEN_FUNCTION_NAME_SLOT}`,
  '--cli-binary-format raw-in-base64-out',
  '--cli-read-timeout 60',
  `--payload '{"configurationSet":"${SET_SLOT}"}'`,
  'result.json',
]);

export const FIND_REOPEN_FUNCTION_COMMAND = shellLines([
  'aws cloudformation describe-stacks',
  '--region eu-central-1',
  '--stack-name FotheringAction',
  `--query "Stacks[0].Outputs[?OutputKey=='ReopenFunctionName'].OutputValue"`,
  '--output text',
]);

// The set lands inside a shell-quoted JSON payload, so a name outside the pattern never reaches it.
export function reopenCommandFor(configurationSet: string): string {
  if (!CONFIGURATION_SET_PATTERN.test(configurationSet)) throw new RangeError('a configuration set name holds only letters, digits, hyphens and underscores');
  return REOPEN_COMMAND_TEMPLATE.replace(SET_SLOT, configurationSet);
}

export function reputationResetSentence(configurationSet: string): string {
  return `Reopening a configuration set resets its SES reputation metrics, so the history SES keeps for ${configurationSet} starts again.`;
}

const INCIDENT_LIMIT_HOURS = LATENESS_HORIZON_MS / 3_600_000;

// The incident lifecycle is phase 2's, unchanged (decided 2026-10-16): an incident stays open until a
// quiet window plus the lateness horizon completes, and while it is open detection stores no second
// record or decision. This sentence states that limit; it never says the lane is closed (D-112).
export function incidentLimitSentence(configurationSet: string): string {
  return (
    `Fothering pauses a lane at most once per incident, and an incident stays open while ${configurationSet} keeps spiking and for at least ${INCIDENT_LIMIT_HOURS} hours after it goes quiet, since SES can still report bounces from deliveries it retried for that long. ` +
    `If you reopen ${configurationSet} inside that time and it spikes again, Fothering makes no new evidence record or decision, does not pause it again and sends no new email, so watch ${configurationSet} yourself until then.`
  );
}

export type ReopenAcceptance = 'accept' | Extract<ReopenRefusal, 'not-reopenable' | 'already-reopened' | 'reopen-in-progress'>;

const REOPENABLE: ReadonlySet<ClosureOutcome> = new Set(PAUSE_MAY_HOLD_OUTCOMES);

/**
 * D-93: the pause outcome is never overwritten by a reopen, so a reopen-failed or reopen-unknown
 * closure, or one whose reopen claim went stale, is accepted again and the operator reruns the command.
 */
export function reopenAcceptance(closure: Closure, nowMs: number): ReopenAcceptance {
  if (closure.outcome === null || !REOPENABLE.has(closure.outcome)) return 'not-reopenable';
  const { reopen } = closure;
  if (reopen === null) return 'accept';
  if (reopen.outcome === 'reopened') return 'already-reopened';
  const claimLive = reopen.outcome === null && reopen.claimedAtMs !== null && nowMs < reopen.claimedAtMs + REOPEN_FUNCTION_TIMEOUT_MS;
  return claimLive ? 'reopen-in-progress' : 'accept';
}
