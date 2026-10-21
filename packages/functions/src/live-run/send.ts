import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import {
  callerKeyOf,
  isSimulatorRecipient,
  MAX_RATE_MILLI,
  planRequests,
  refusalMessage,
  resolveStep,
  sendGapMs,
  type AttemptRecord,
  type LiveRunRefusal,
  type LiveRunRequest,
} from '@fothering/core/live-run';
import type { Scenario, StepPlanEntry } from '@fothering/core/scenarios';
import type { LiveRunPortFactory, LiveRunSesPort } from '@fothering/providers/live-run-port-types';
import type { LiveRunDeps } from './root.js';

export interface SendStepRequest {
  runId: string;
  scenarioName: string;
  stepName: string;
  from: string;
  accountProfile: string;
  laneProfiles: ReadonlyMap<string, string>;
  /** Sends per thousand seconds, already parsed from --rate (MAX_RATE_MILLI when the flag is absent). */
  rateMilli: number;
}

const LIVE_RUNS = 'reports/live-runs';
const LOCK_FILE = `${LIVE_RUNS}/.lock`;

interface StepPaths {
  liveRuns: string;
  folder: string;
  folderRelative: string;
  attempts: string;
  attemptsRelative: string;
  lock: string;
}

interface CheckedStep {
  scenario: Scenario;
  entries: StepPlanEntry[];
  requests: LiveRunRequest[];
  paths: StepPaths;
}

export function refuse(deps: LiveRunDeps, refusal: LiveRunRefusal): number {
  deps.io.err(refusalMessage(refusal.code, refusal.subject));
  return 1;
}

function stepPaths(repoRoot: string, request: SendStepRequest): StepPaths {
  const folderRelative = `${LIVE_RUNS}/${request.runId}/run`;
  const attemptsRelative = `${folderRelative}/${request.stepName}.attempts.jsonl`;
  return {
    liveRuns: join(repoRoot, ...LIVE_RUNS.split('/')),
    folder: join(repoRoot, ...folderRelative.split('/')),
    folderRelative,
    attempts: join(repoRoot, ...attemptsRelative.split('/')),
    attemptsRelative,
    lock: join(repoRoot, ...LOCK_FILE.split('/')),
  };
}

// The real path of the deepest part that exists, with the rest appended, so a junction or link
// anywhere under the root is followed before the containment test, not after the first write.
function resolvedPath(path: string): string {
  const rest: string[] = [];
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync.native(existing), ...rest);
}

function outputRefusal(deps: LiveRunDeps, paths: StepPaths): LiveRunRefusal | undefined {
  const fromRoot = relative(join(resolvedPath(deps.repoRoot), ...LIVE_RUNS.split('/')), resolvedPath(paths.folder));
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) return { code: 'output-outside-root', subject: paths.folderRelative };
  try {
    deps.gitCheckIgnore(paths.folder);
  } catch {
    return { code: 'output-not-ignored', subject: paths.folderRelative };
  }
  if (existsSync(paths.attempts)) return { code: 'step-already-run', subject: paths.attemptsRelative };
  return undefined;
}

/** Every check that needs no port, in the command's fixed order. */
function localChecks(deps: LiveRunDeps, request: SendStepRequest): CheckedStep | LiveRunRefusal {
  const step = resolveStep(deps.scenarios, request.scenarioName, request.stepName, request.runId);
  if (!step.ok) return step.refusal;
  const planned = planRequests(step.entries, deps.laneMap, request.runId, request.from);
  if (!planned.ok) return planned.refusal;
  if (request.rateMilli > MAX_RATE_MILLI) return { code: 'rate-too-high' };
  const paths = stepPaths(deps.repoRoot, request);
  const refusal = outputRefusal(deps, paths);
  if (refusal !== undefined) return refusal;
  return { scenario: step.scenario, entries: step.entries, requests: planned.requests, paths };
}

/** Exclusive create: a lock this run did not make is never removed, however old. */
function takeLock(paths: StepPaths): number | undefined {
  mkdirSync(paths.liveRuns, { recursive: true });
  try {
    return openSync(paths.lock, 'wx');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return undefined;
    throw error;
  }
}

/** Every lane any step of the scenario sends on, since each needs its own caller. */
function scenarioLanes(scenario: Scenario): string[] {
  return [...new Set(scenario.steps.flatMap((step) => step.groups.map((group) => group.lane)))].sort();
}

async function readCallers(factory: LiveRunPortFactory, lanes: readonly string[], request: SendStepRequest): Promise<unknown> {
  const laneCallers = [];
  for (const lane of lanes) {
    const caller = await factory.callerIdentity(request.laneProfiles.get(lane) ?? '').getCallerIdentity();
    laneCallers.push({ lane, roleName: callerKeyOf(caller.arn), account: caller.account, arn: caller.arn });
  }
  const accountCaller = await factory.callerIdentity(request.accountProfile).getCallerIdentity();
  return { lanes: laneCallers, account: { account: accountCaller.account, arn: accountCaller.arn } };
}

// Starts are spaced on the monotonic clock across every lane of the step, because the send rate
// is the account's; a sleep that wakes early is simply waited out again.
async function waitForGap(deps: LiveRunDeps, previousStart: number | undefined, gapMs: number): Promise<number> {
  if (previousStart !== undefined) {
    for (let now = deps.monotonicMs(); now - previousStart < gapMs; now = deps.monotonicMs()) {
      await deps.sleep(previousStart + gapMs - now);
    }
  }
  return deps.monotonicMs();
}

function utc(ms: number): string {
  return new Date(ms).toISOString();
}

export function appendAttempt(file: string, record: AttemptRecord): void {
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

async function sendStep(deps: LiveRunDeps, request: SendStepRequest, step: CheckedStep): Promise<number> {
  const factory = deps.portFactory();
  const callers = await readCallers(factory, scenarioLanes(step.scenario), request);
  const account = await factory.ses(request.accountProfile).getAccount();
  mkdirSync(step.paths.folder, { recursive: true });
  writeFileSync(join(step.paths.folder, `${request.stepName}.callers.json`), `${JSON.stringify(callers, null, 2)}\n`);
  writeFileSync(join(step.paths.folder, `${request.stepName}.account.json`), `${JSON.stringify(account, null, 2)}\n`);

  const gapMs = sendGapMs(request.rateMilli);
  const ports = new Map<string, LiveRunSesPort>();
  let previousStart: number | undefined;
  for (const [index, entry] of step.entries.entries()) {
    const sendRequest = step.requests[index];
    // Checked for the whole step already; checked again here so no mode can send off the simulator.
    if (sendRequest === undefined || !isSimulatorRecipient(sendRequest.to)) return refuse(deps, { code: 'recipient-not-simulator', subject: entry.lane });
    const profile = request.laneProfiles.get(entry.lane) ?? '';
    const port = ports.get(profile) ?? factory.ses(profile);
    ports.set(profile, port);
    previousStart = await waitForGap(deps, previousStart, gapMs);
    const startUtc = utc(deps.nowUtc());
    const result = await port.sendEmail(sendRequest);
    const record: AttemptRecord = {
      lane: entry.lane,
      tags: sendRequest.tags,
      recipient: entry.recipient,
      startUtc,
      endUtc: utc(deps.nowUtc()),
      messageId: result.messageId,
      requestId: result.requestId,
    };
    appendAttempt(step.paths.attempts, record);
  }
  return 0;
}

export async function runSendStep(deps: LiveRunDeps, request: SendStepRequest): Promise<number> {
  const step = localChecks(deps, request);
  if ('code' in step) return refuse(deps, step);
  const lock = takeLock(step.paths);
  if (lock === undefined) return refuse(deps, { code: 'lock-held', subject: LOCK_FILE });
  try {
    return await sendStep(deps, request, step);
  } finally {
    closeSync(lock);
    rmSync(step.paths.lock, { force: true });
  }
}
