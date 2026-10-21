import * as z from 'zod';
import { CONFIGURATION_SET_PATTERN, findLane, SES_TAG_PATTERN, type LaneEntry, type LaneMap } from './lanes.js';
import type { ScenarioTagKind, StepPlanEntry } from './scenarios.js';

// The account's send rate is 1 per second (re-read by the command); 1,250 ms keeps every step at
// 0.8 per second across all lanes, since the rate is per account and not per configuration set.
export const MIN_SEND_GAP_MS = 1250;

export interface LiveRunTag {
  name: string;
  value: string;
}

export interface LiveRunRequest {
  from: string;
  to: string;
  subject: string;
  text: string;
  configurationSetName: string;
  tags: LiveRunTag[];
}

const TAG_KEY_FIELD = {
  batch: 'batchTagKey',
  campaign: 'campaignTagKey',
  template: 'templateTagKey',
} as const satisfies Record<ScenarioTagKind, keyof LaneEntry>;

/** The stream tag is the lane's own declared stream, so ingest files every message under the lane it was sent on. */
export function buildLiveRunRequest(entry: StepPlanEntry, laneMap: LaneMap, runId: string, from: string): LiveRunRequest {
  const lane = findLane(laneMap, entry.lane);
  const stream = lane?.declaredStreams[0];
  if (lane === undefined || stream === undefined) throw new RangeError(`lane ${entry.lane} is not in the lane map`);
  return {
    from,
    to: entry.recipient,
    subject: `Fothering live run ${runId}, step ${entry.step}, message ${entry.counter}`,
    text: `Measurement message ${entry.counter} of step ${entry.step} in live run ${runId}, sent to the SES mailbox simulator.`,
    configurationSetName: lane.configurationSet,
    tags: [
      { name: lane.streamTagKey, value: stream },
      { name: lane[TAG_KEY_FIELD[entry.tagKind]], value: entry.tagValue },
      { name: laneMap.runIdTagKey, value: runId },
    ],
  };
}

export const LIVE_RUN_REFUSALS = [
  'usage',
  'switch-not-live',
  'unknown-scenario',
  'unknown-step',
  'run-id-invalid',
  'empty-step',
  'recipient-not-simulator',
  'tag-invalid',
  'rate-too-high',
  'output-not-ignored',
  'output-outside-root',
  'step-already-run',
  'lock-held',
  'lane-profile-missing',
  'caller-not-role',
  'caller-shared',
  'account-mismatch',
  'send-rate-low',
] as const;
export type LiveRunRefusalCode = (typeof LIVE_RUN_REFUSALS)[number];

export interface LiveRunRefusal {
  code: LiveRunRefusalCode;
  subject?: string;
}

export const MAX_RATE_MILLI = 800;

export function refusalMessage(code: LiveRunRefusalCode, _subject?: string): string {
  return `refused ${code}`;
}

export function parseRunId(_runId: string): { date: string; run: number; attempt: number } | undefined {
  return undefined;
}

export function parseRate(_text: string): number | undefined {
  return undefined;
}

export function sendGapMs(_rateMilli: number): number {
  return MIN_SEND_GAP_MS;
}

export function spacingViolations(_startsMs: readonly number[], _minGapMs: number): number[] {
  return [];
}

export function isSimulatorRecipient(_address: string): boolean {
  return true;
}

export function planRequests(
  entries: readonly StepPlanEntry[],
  laneMap: LaneMap,
  runId: string,
  from: string,
): { ok: true; requests: LiveRunRequest[] } | { ok: false; refusal: LiveRunRefusal } {
  return { ok: true, requests: entries.map((entry) => buildLiveRunRequest(entry, laneMap, runId, from)) };
}

const ASSUMED_ROLE_ARN =/^arn:aws[a-z-]*:sts::\d{12}:assumed-role\/([^/]+)\/[^/]+$/;

/** SES records a role sender's caller identity as the role name, so two sessions of one role are one caller. */
export function callerKeyOf(arn: string): string | undefined {
  return ASSUMED_ROLE_ARN.exec(arn)?.[1];
}

const ISO_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const tagSchema = z.strictObject({ name: z.string().regex(SES_TAG_PATTERN), value: z.string().regex(SES_TAG_PATTERN) });

const attemptFields = {
  lane: z.string().regex(CONFIGURATION_SET_PATTERN),
  tags: z.array(tagSchema).min(1),
  recipient: z.string().min(1),
  startUtc: z.string().regex(ISO_UTC_MILLIS),
  endUtc: z.string().regex(ISO_UTC_MILLIS),
};

export const attemptRecordSchema = z.union([
  z.strictObject({ ...attemptFields, messageId: z.string().min(1), requestId: z.string().min(1) }),
  z.strictObject({ ...attemptFields, errorName: z.string().regex(ERROR_NAME_PATTERN) }),
]);

export type AttemptRecord = z.infer<typeof attemptRecordSchema>;
