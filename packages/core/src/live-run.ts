import * as z from 'zod';
import { CONFIGURATION_SET_PATTERN, findLane, SES_TAG_PATTERN, type LaneEntry, type LaneMap } from './lanes.js';
import { LIVE_SWITCH } from './mode.js';
import {
  findStep,
  SIMULATOR_DOMAIN,
  stepPlan,
  type Scenario,
  type ScenarioSource,
  type ScenarioTagKind,
  type StepPlanEntry,
} from './scenarios.js';

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

/** The highest requested rate, in sends per thousand seconds, so 0.8 per second compares as an integer. */
export const MAX_RATE_MILLI = 800;

const REFUSAL_TEXT: Readonly<Record<LiveRunRefusalCode, string>> = {
  usage: 'the arguments do not match the usage',
  'switch-not-live': `${LIVE_SWITCH} is not exactly live, so nothing is sent`,
  'unknown-scenario': 'the scenario source names no such scenario',
  'unknown-step': 'the scenario names no such step',
  'run-id-invalid': "the run id must read live-YYYYMMDD-s<run>-<attempt> with the scenario's run number",
  'empty-step': 'the step has no messages',
  'recipient-not-simulator': `a recipient is outside ${SIMULATOR_DOMAIN}`,
  'tag-invalid': 'a tag value is outside the SES message tag rule, or its lane is not in the lane map',
  'rate-too-high': 'the requested rate is above 0.8 sends per second',
  'output-not-ignored': 'git does not read the run folder as ignored, or could not be asked',
  'output-outside-root': 'the run folder resolves outside reports/live-runs/',
  'step-already-run': 'the step already has an attempts file',
  'lock-held': 'another live run holds the lock; a stale lock is removed only by hand',
  'lane-profile-missing': 'a lane the scenario sends on has no --lane-profile',
  'caller-not-role': 'a lane caller is not an assumed role',
  'caller-shared': 'two lanes resolve to one caller',
  'account-mismatch': 'the callers are not all in one account',
  'send-rate-low': 'the account MaxSendRate is below 0.8 per second, or absent',
};

// A subject is a lane name or a repo-relative file and nothing else, so neither an address, a
// profile value nor a path climbing out of the tree can ride into a refusal line.
const SAFE_SUBJECT = /^[A-Za-z0-9._/-]{1,200}$/;

export function refusalMessage(code: LiveRunRefusalCode, subject?: string): string {
  const named = subject !== undefined && SAFE_SUBJECT.test(subject) && !subject.includes('..') ? `: ${subject}` : '';
  return `live-run refused (${code}): ${REFUSAL_TEXT[code]}${named}`;
}

const RUN_ID_PATTERN = /^live-(\d{8})-s([1-3])-(\d+)$/;

export function parseRunId(runId: string): { date: string; run: number; attempt: number } | undefined {
  const match = RUN_ID_PATTERN.exec(runId);
  if (match === null) return undefined;
  const [, date = '', run = '', attempt = ''] = match;
  return { date, run: Number(run), attempt: Number(attempt) };
}

const RATE_PATTERN = /^(\d+)(?:\.(\d{1,3}))?$/;

/** A positive decimal with at most three fraction digits, read into integer thousandths. */
export function parseRate(text: string): number | undefined {
  const match = RATE_PATTERN.exec(text);
  if (match === null) return undefined;
  const [, whole = '', fraction = ''] = match;
  const milli = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
  return milli > 0 ? milli : undefined;
}

export function sendGapMs(rateMilli: number): number {
  return Math.max(MIN_SEND_GAP_MS, Math.ceil(1_000_000 / rateMilli));
}

/** The index of every start that came less than minGapMs after the one before it. */
export function spacingViolations(startsMs: readonly number[], minGapMs: number): number[] {
  return startsMs.flatMap((start, index) => {
    const previous = startsMs[index - 1];
    return previous !== undefined && start - previous < minGapMs ? [index] : [];
  });
}

/** The whole domain after the last at sign, compared without case: a longer host that merely begins with it is outside. */
export function isSimulatorRecipient(address: string): boolean {
  const at = address.lastIndexOf('@');
  return at > 0 && address.slice(at + 1).toLowerCase() === SIMULATOR_DOMAIN;
}

/** The scenario, step and run id checks, in the command's refusal order, ending with the step's plan. */
export function resolveStep(
  source: ScenarioSource,
  scenarioName: string,
  stepName: string,
  runId: string,
): { ok: true; scenario: Scenario; entries: StepPlanEntry[] } | { ok: false; refusal: LiveRunRefusal } {
  const scenario = source.scenarios.find((candidate) => candidate.name === scenarioName);
  if (scenario === undefined) return { ok: false, refusal: { code: 'unknown-scenario', subject: scenarioName } };
  if (findStep(source, scenarioName, stepName) === undefined) return { ok: false, refusal: { code: 'unknown-step', subject: stepName } };
  if (parseRunId(runId)?.run !== scenario.run) return { ok: false, refusal: { code: 'run-id-invalid' } };
  const entries = stepPlan(source, scenarioName, stepName, runId);
  if (entries.length === 0) return { ok: false, refusal: { code: 'empty-step' } };
  return { ok: true, scenario, entries };
}

/** Every recipient and every tag of the step is checked before the first request may be sent. */
export function planRequests(
  entries: readonly StepPlanEntry[],
  laneMap: LaneMap,
  runId: string,
  from: string,
): { ok: true; requests: LiveRunRequest[] } | { ok: false; refusal: LiveRunRefusal } {
  const outside = entries.find((entry) => !isSimulatorRecipient(entry.recipient));
  if (outside !== undefined) return { ok: false, refusal: { code: 'recipient-not-simulator', subject: outside.lane } };
  const unmapped = entries.find((entry) => findLane(laneMap, entry.lane) === undefined);
  if (unmapped !== undefined) return { ok: false, refusal: { code: 'tag-invalid', subject: unmapped.lane } };
  const requests = entries.map((entry) => buildLiveRunRequest(entry, laneMap, runId, from));
  const badTag = requests.find((request) => request.tags.some((tag) => !SES_TAG_PATTERN.test(tag.value)));
  if (badTag !== undefined) return { ok: false, refusal: { code: 'tag-invalid', subject: badTag.configurationSetName } };
  return { ok: true, requests };
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
