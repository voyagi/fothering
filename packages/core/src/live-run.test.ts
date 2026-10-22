import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseLaneMap } from './lanes.js';
import {
  LIVE_RUN_REFUSALS,
  MAX_RATE_MILLI,
  MIN_SEND_GAP_MS,
  accountVerdict,
  callerKeyOf,
  checkCallers,
  isSimulatorRecipient,
  parseRate,
  parseRunId,
  planRequests,
  refusalMessage,
  sendGapMs,
  spacingViolations,
} from './live-run.js';
import { stepPlan, type ScenarioSource } from './scenarios.js';
import { propertySeed } from './test/property-seed.js';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import scenariosJson from '../../../docs/measurement-scenarios.json' with { type: 'json' };

const LANES = parseLaneMap(lanesJson);
const RUN_ID = 'live-20261022-s1-1';
const FROM = 'sender@example.com';

function committedSource(): ScenarioSource {
  return structuredClone(scenariosJson) as ScenarioSource;
}

describe('parseRunId', () => {
  it('reads the date, the run number and the attempt number', () => {
    expect(parseRunId('live-20261022-s1-1')).toEqual({ date: '20261022', run: 1, attempt: 1 });
    expect(parseRunId('live-20261023-s3-12')).toEqual({ date: '20261023', run: 3, attempt: 12 });
  });

  it.each(['', 'live', 'live-2026102-s1-1', 'live-20261022-s4-1', 'live-20261022-s0-1', 'live-20261022-s1-', 'live-20261022-s1-1 ', ' live-20261022-s1-1', 'LIVE-20261022-s1-1', 'live-20261022-s1-1/..'])(
    'refuses %j',
    (runId) => {
      expect(parseRunId(runId)).toBeUndefined();
    },
  );
});

describe('parseRate and the gap it sets', () => {
  it('reads a decimal with up to three fraction digits as integer thousandths', () => {
    expect(parseRate('0.8')).toBe(800);
    expect(parseRate('0.800')).toBe(800);
    expect(parseRate('0.81')).toBe(810);
    expect(parseRate('1')).toBe(1000);
    expect(parseRate('0.5')).toBe(500);
  });

  it.each(['', 'fast', '.8', '0.8001', '-1', '0', '0.000', '1e3', '0,8', ' 0.8'])('reads %j as malformed', (text) => {
    expect(parseRate(text)).toBeUndefined();
  });

  it('caps the rate at 0.8 per second, so 0.8 is accepted and 0.81 is above the cap', () => {
    expect(MAX_RATE_MILLI).toBe(800);
    expect(800 <= MAX_RATE_MILLI).toBe(true);
    expect(810 > MAX_RATE_MILLI).toBe(true);
  });

  it('never spaces sends closer than 1,250 ms, and slower rates space them further', () => {
    expect(MIN_SEND_GAP_MS).toBe(1250);
    expect(sendGapMs(800)).toBe(1250);
    expect(sendGapMs(500)).toBe(2000);
    expect(sendGapMs(300)).toBe(3334);
  });
});

describe('spacingViolations', () => {
  it('passes a gap of exactly 1,250 ms and names the start of a gap of 1,249 ms', () => {
    expect(spacingViolations([0, 1250], MIN_SEND_GAP_MS)).toEqual([]);
    expect(spacingViolations([0, 1249], MIN_SEND_GAP_MS)).toEqual([1]);
    expect(spacingViolations([0, 1250, 2499, 5000], MIN_SEND_GAP_MS)).toEqual([2]);
    expect(spacingViolations([], MIN_SEND_GAP_MS)).toEqual([]);
  });
});

describe('isSimulatorRecipient', () => {
  it('accepts the simulator domain in any case', () => {
    expect(isSimulatorRecipient('success+run-001@simulator.amazonses.com')).toBe(true);
    expect(isSimulatorRecipient('bounce@SIMULATOR.AMAZONSES.COM')).toBe(true);
  });

  it.each([
    'success@example.com',
    'success@simulator.amazonses.com.example.com',
    'success@sub.simulator.amazonses.com',
    'success@simulator.amazonses.co',
    'simulator.amazonses.com',
    'success@',
  ])('refuses %j', (address) => {
    expect(isSimulatorRecipient(address)).toBe(false);
  });

  it('reads only the text after the last at sign', () => {
    expect(isSimulatorRecipient('a@simulator.amazonses.com@example.com')).toBe(false);
    expect(isSimulatorRecipient('a@example.com@simulator.amazonses.com')).toBe(true);
  });
});

describe('planRequests', () => {
  it('builds one request per entry of the committed spike', () => {
    const result = planRequests(stepPlan(committedSource(), 'bulk-stale-import', 'spike', RUN_ID), LANES, RUN_ID, FROM);
    expect(result.ok && result.requests.length).toBe(132);
  });

  it('refuses a recipient outside the simulator, naming the lane only', () => {
    const source = committedSource();
    source.recipientDomain = 'example.com';
    const result = planRequests(stepPlan(source, 'bulk-stale-import', 'spike', RUN_ID), LANES, RUN_ID, FROM);
    expect(result).toEqual({ ok: false, refusal: { code: 'recipient-not-simulator', subject: 'fothering-bulk' } });
  });

  it('refuses a tag value outside the SES tag rule, naming its lane', () => {
    const source = committedSource();
    const group = source.scenarios[0]?.steps[0]?.groups[2];
    if (group === undefined) throw new Error('the committed spike has no third group');
    group.tag.value = 'order receipt';
    const result = planRequests(stepPlan(source, 'bulk-stale-import', 'spike', RUN_ID), LANES, RUN_ID, FROM);
    expect(result).toEqual({ ok: false, refusal: { code: 'tag-invalid', subject: 'fothering-transactional' } });
  });

  it('refuses a lane the lane map does not hold, naming it', () => {
    const source = committedSource();
    const group = source.scenarios[0]?.steps[0]?.groups[0];
    if (group === undefined) throw new Error('the committed spike has no first group');
    group.lane = 'fothering-elsewhere';
    const result = planRequests(stepPlan(source, 'bulk-stale-import', 'spike', RUN_ID), LANES, RUN_ID, FROM);
    expect(result).toEqual({ ok: false, refusal: { code: 'tag-invalid', subject: 'fothering-elsewhere' } });
  });
});

describe('refusalMessage', () => {
  it('names every refusal code it is given', () => {
    for (const code of LIVE_RUN_REFUSALS) expect(refusalMessage(code)).toContain(`(${code})`);
  });

  it('carries a lane or a repo-relative file as its subject', () => {
    expect(refusalMessage('lock-held', 'reports/live-runs/.lock')).toContain('reports/live-runs/.lock');
    expect(refusalMessage('caller-shared', 'fothering-bulk')).toContain('fothering-bulk');
  });

  it('never carries an at sign, whatever the subject', () =>
    fc.assert(
      fc.property(fc.string(), (subject) => {
        expect(refusalMessage('unknown-scenario', subject)).not.toContain('@');
      }),
      { seed: propertySeed() },
    ));

  it.each(['someone@example.com', '../outside', 'two words', ''])('drops the subject %j', (subject) => {
    expect(refusalMessage('unknown-scenario', subject)).toBe(refusalMessage('unknown-scenario'));
  });
});

// Built at run time so no twelve-digit literal sits in the file.
const ACCOUNT = '0'.repeat(12);
const OTHER_ACCOUNT = '1'.repeat(12);

function roleArn(role: string, session: string, account = ACCOUNT): string {
  return `arn:aws:sts::${account}:assumed-role/${role}/${session}`;
}

describe('callerKeyOf', () => {
  it('reads the role name of an assumed-role caller, the identity SES records for a role sender', () => {
    expect(callerKeyOf(roleArn('live-run-bulk', 'session-1'))).toBe('live-run-bulk');
    expect(callerKeyOf(roleArn('live-run-bulk', 'another-session'))).toBe('live-run-bulk');
  });

  it.each([
    ['an IAM user', `arn:aws:iam::${ACCOUNT}:user/operator`],
    ['a federated user', `arn:aws:sts::${ACCOUNT}:federated-user/operator`],
    ['the root user', `arn:aws:iam::${ACCOUNT}:root`],
    ['an assumed role with no session name', `arn:aws:sts::${ACCOUNT}:assumed-role/live-run-bulk`],
  ])('reads no key for %s', (_label, arn) => {
    expect(callerKeyOf(arn)).toBeUndefined();
  });
});

describe('checkCallers', () => {
  const accountCaller = { arn: roleArn('live-run-account', 'session-1'), account: ACCOUNT };
  const lane = (name: string, arn: string, account = ACCOUNT) => ({ lane: name, arn, account });

  it('passes two lanes on two different roles in one account', () => {
    expect(
      checkCallers([lane('fothering-bulk', roleArn('live-run-bulk', 's1')), lane('fothering-transactional', roleArn('live-run-transactional', 's1'))], accountCaller),
    ).toBeUndefined();
  });

  it('refuses two sessions of one role behind two lanes, naming the second lane', () => {
    expect(
      checkCallers([lane('fothering-bulk', roleArn('live-run-shared', 's1')), lane('fothering-transactional', roleArn('live-run-shared', 's2'))], accountCaller),
    ).toEqual({ code: 'caller-shared', subject: 'fothering-transactional' });
  });

  it('compares role names byte for byte, so names differing only in case are two callers', () => {
    expect(
      checkCallers([lane('fothering-bulk', roleArn('Live-Run', 's1')), lane('fothering-transactional', roleArn('live-run', 's1'))], accountCaller),
    ).toBeUndefined();
  });

  it('refuses a lane whose caller is not an assumed role, naming it', () => {
    expect(
      checkCallers([lane('fothering-bulk', `arn:aws:iam::${ACCOUNT}:user/operator`), lane('fothering-transactional', roleArn('live-run-transactional', 's1'))], accountCaller),
    ).toEqual({ code: 'caller-not-role', subject: 'fothering-bulk' });
  });

  it('refuses a lane in another account than the account profile, naming it', () => {
    expect(
      checkCallers(
        [lane('fothering-bulk', roleArn('live-run-bulk', 's1')), lane('fothering-transactional', roleArn('live-run-transactional', 's1', OTHER_ACCOUNT), OTHER_ACCOUNT)],
        accountCaller,
      ),
    ).toEqual({ code: 'account-mismatch', subject: 'fothering-transactional' });
  });
});

describe('accountVerdict', () => {
  it.each([1, 0.8, 14])('accepts a MaxSendRate of %s', (maxSendRate) => {
    expect(accountVerdict({ maxSendRate })).toBeUndefined();
  });

  it.each([0.5, 0.79, Number.NaN, 'absent' as const])('refuses a MaxSendRate of %s', (maxSendRate) => {
    expect(accountVerdict({ maxSendRate })).toEqual({ code: 'send-rate-low' });
  });
});
