import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import {
  accountVerdict,
  attemptErrorName,
  callerKeyOf,
  checkCallers,
  isSimulatorRecipient,
  MAX_RATE_MILLI,
  planRequests,
  refusalMessage,
  resolveStep,
  sendGapMs,
  type AttemptRecord,
  type LaneCaller,
  type LiveRunRefusal,
  type LiveRunRequest,
} from '@fothering/core/live-run';
import type { Scenario, StepPlanEntry } from '@fothering/core/scenarios';
import type { CallerIdentity, LiveRunAccount, LiveRunPortFactory, LiveRunSesPort } from '@fothering/providers/live-run-port-types';
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
  const unprofiled = scenarioLanes(step.scenario).find((lane) => !request.laneProfiles.has(lane));
  if (unprofiled !== undefined) return { code: 'lane-profile-missing', subject: unprofiled };
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

interface CallersFile {
  lanes: { lane: string; roleName: string | undefined; account: string; arn: string }[];
  account: { account: string; arn: string };
}

async function resolveCaller(factory: LiveRunPortFactory, profile: string): Promise<CallerIdentity | undefined> {
  try {
    return await factory.callerIdentity(profile).getCallerIdentity();
  } catch {
    return undefined;
  }
}

// One GetCallerIdentity per distinct profile, so a profile named for two lanes is read once and
// then refused as one caller behind both.
async function checkedCallers(factory: LiveRunPortFactory, lanes: readonly string[], request: SendStepRequest): Promise<CallersFile | LiveRunRefusal> {
  const byProfile = new Map<string, Promise<CallerIdentity | undefined>>();
  const callerFor = (profile: string): Promise<CallerIdentity | undefined> => {
    const pending = byProfile.get(profile) ?? resolveCaller(factory, profile);
    byProfile.set(profile, pending);
    return pending;
  };
  const laneCallers: LaneCaller[] = [];
  for (const lane of lanes) {
    const caller = await callerFor(request.laneProfiles.get(lane) ?? '');
    if (caller === undefined) return { code: 'caller-unresolved', subject: lane };
    laneCallers.push({ lane, arn: caller.arn, account: caller.account });
  }
  const accountCaller = await callerFor(request.accountProfile);
  if (accountCaller === undefined) return { code: 'caller-unresolved' };
  const refusal = checkCallers(laneCallers, accountCaller);
  if (refusal !== undefined) return refusal;
  return {
    lanes: laneCallers.map((caller) => ({ lane: caller.lane, roleName: callerKeyOf(caller.arn), account: caller.account, arn: caller.arn })),
    account: { account: accountCaller.account, arn: accountCaller.arn },
  };
}

// Only the four fields the measurement needs are kept; whatever else an account answer holds is
// never written.
async function checkedAccount(factory: LiveRunPortFactory, profile: string): Promise<LiveRunAccount | LiveRunRefusal> {
  let answer: LiveRunAccount;
  try {
    answer = await factory.ses(profile).getAccount();
  } catch {
    return { code: 'account-unreadable' };
  }
  const { vdmEnabled, productionAccessEnabled, maxSendRate, requestId } = answer;
  return accountVerdict(answer) ?? { vdmEnabled, productionAccessEnabled, maxSendRate, requestId };
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

function endsWithoutNewline(file: string): boolean {
  if (!existsSync(file)) return false;
  const { size } = statSync(file);
  if (size === 0) return false;
  const last = Buffer.alloc(1);
  const handle = openSync(file, 'r');
  try {
    readSync(handle, last, 0, 1, size - 1);
  } finally {
    closeSync(handle);
  }
  return last[0] !== 0x0a;
}

// Exclusive create: the empty attempts file is the step's claim, made before the callers and account
// files are written and before the first send. The local check for it ran before the lock, so another
// process can have finished the step since; and a crash after SES accepted a message but before its
// line was appended must still leave the step marked run.
function claimStep(paths: StepPaths): boolean {
  try {
    closeSync(openSync(paths.attempts, 'wx'));
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
}

/** A crash can leave a torn last line with no newline; appending straight after it would fuse the two records. */
export function appendAttempt(file: string, record: AttemptRecord): void {
  appendFileSync(file, `${endsWithoutNewline(file) ? '\n' : ''}${JSON.stringify(record)}\n`);
}

async function sendStep(deps: LiveRunDeps, request: SendStepRequest, step: CheckedStep): Promise<number> {
  const factory = deps.portFactory();
  const callers = await checkedCallers(factory, scenarioLanes(step.scenario), request);
  if ('code' in callers) return refuse(deps, callers);
  const account = await checkedAccount(factory, request.accountProfile);
  if ('code' in account) return refuse(deps, account);
  mkdirSync(step.paths.folder, { recursive: true });
  if (!claimStep(step.paths)) return refuse(deps, { code: 'step-already-run', subject: step.paths.attemptsRelative });
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
    let outcome: { messageId: string; requestId: string } | { errorName: string };
    try {
      const result = await port.sendEmail(sendRequest);
      outcome = { messageId: result.messageId, requestId: result.requestId };
    } catch (error) {
      // A paused lane or a throttle is a result to record, never a reason to retry or stop.
      outcome = { errorName: attemptErrorName(error) };
    }
    appendAttempt(step.paths.attempts, { lane: entry.lane, tags: sendRequest.tags, recipient: entry.recipient, startUtc, endUtc: utc(deps.nowUtc()), ...outcome });
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
