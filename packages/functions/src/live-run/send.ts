import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLiveRunRequest, callerKeyOf, MIN_SEND_GAP_MS, type AttemptRecord } from '@fothering/core/live-run';
import { findStep, stepPlan, type Scenario } from '@fothering/core/scenarios';
import type { LiveRunPortFactory, LiveRunSesPort } from '@fothering/providers/live-run-port-types';
import type { LiveRunDeps } from './root.js';

export interface SendStepRequest {
  runId: string;
  scenarioName: string;
  stepName: string;
  from: string;
  accountProfile: string;
  laneProfiles: ReadonlyMap<string, string>;
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

export async function runSendStep(deps: LiveRunDeps, request: SendStepRequest): Promise<number> {
  const found = findStep(deps.scenarios, request.scenarioName, request.stepName);
  if (found === undefined) return 1;
  const plan = stepPlan(deps.scenarios, request.scenarioName, request.stepName, request.runId);
  const requests = plan.map((entry) => buildLiveRunRequest(entry, deps.laneMap, request.runId, request.from));
  const folder = join(deps.repoRoot, 'reports', 'live-runs', request.runId, 'run');
  mkdirSync(folder, { recursive: true });

  const factory = deps.portFactory();
  const callers = await readCallers(factory, scenarioLanes(found.scenario), request);
  const account = await factory.ses(request.accountProfile).getAccount();
  writeFileSync(join(folder, `${request.stepName}.callers.json`), `${JSON.stringify(callers, null, 2)}\n`);
  writeFileSync(join(folder, `${request.stepName}.account.json`), `${JSON.stringify(account, null, 2)}\n`);

  const attemptsFile = join(folder, `${request.stepName}.attempts.jsonl`);
  const ports = new Map<string, LiveRunSesPort>();
  let previousStart: number | undefined;
  for (const [index, entry] of plan.entries()) {
    const sendRequest = requests[index];
    if (sendRequest === undefined) break;
    const profile = request.laneProfiles.get(entry.lane) ?? '';
    const port = ports.get(profile) ?? factory.ses(profile);
    ports.set(profile, port);
    previousStart = await waitForGap(deps, previousStart, MIN_SEND_GAP_MS);
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
    appendFileSync(attemptsFile, `${JSON.stringify(record)}\n`);
  }
  return 0;
}
