import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import {
  assembleEvidenceRecord,
  decideCycle,
  fixFor,
  isolationVerdict,
  questionFor,
  type CycleDecision,
  type DecisionOutcome,
  type DecisionReason,
  type FixKind,
  type LaneAnalysis,
  type SharedCause,
} from './decision.js';
import { FIX_KINDS, RECORD_BYTE_CEILING, canonicalJson, serializedRecordBytes, type EvidenceRecord } from './evidence-record.js';
import type { DnsTxtOutcome, IdentityAuthFacts } from './evidence-rows.js';
import { parseLaneMap, type LaneMap } from './lanes.js';
import { LANE_RATIO_LABELS, LANE_SHARE_LABEL } from './verdicts.js';
import { CYCLE_EXPIRES_AT, cycleOf, recordFor, type CycleStory } from './test/decision-cycle.js';
import { propertySeed } from './test/property-seed.js';

const BULK = 'fothering-bulk';
const DIGEST = 'fothering-digest';
const TRANSACTIONAL = 'fothering-transactional';
const ALERTS = 'fothering-alerts';

const COMMITTED = parseLaneMap(lanesJson);
// A second bulk lane, so a cause can be shared between two lanes that could each be paused.
const WITH_DIGEST = parseLaneMap({
  ...COMMITTED,
  lanes: [
    ...COMMITTED.lanes,
    {
      configurationSet: DIGEST,
      lane: DIGEST,
      criticality: 'bulk',
      declaredStreams: ['digest'],
      streamTagKey: 'stream',
      batchTagKey: 'batch',
      templateTagKey: 'template',
      campaignTagKey: 'campaign',
      operatorAlert: false,
    },
  ],
});

const NEWS = 'news.example.com';
const DMARC_MISSING: Readonly<Record<string, DnsTxtOutcome>> = { [`_dmarc.${NEWS}`]: { kind: 'missing' }, '_dmarc.example.com': { kind: 'missing' } };
const DKIM_SIGNING: IdentityAuthFacts = { identity: 'example.com', dkimStatus: 'SUCCESS', dkimSigningEnabled: true, identityType: 'DOMAIN' };
const AUTH_FAILED = 'smtp; 550 5.7.26 multiple authentication checks failed';
const SPAM_BLOCK = 'smtp; 550 5.7.1 message blocked as spam';
const SPF_FAILED = 'smtp; 550 5.7.23 SPF validation failed';

const QUIET_TRANSACTIONAL = { configurationSet: TRANSACTIONAL, fromDomain: 'receipts.example.com', groups: [{ bucketOffset: 1, count: 150 }] };
const ONE_BAD_BATCH = [
  { bucketOffset: 0, count: 40, batch: 'import-0915', permanentBounces: 15 },
  { bucketOffset: 1, count: 160, batch: 'import-0901' },
];

interface Expected {
  lane: string;
  outcome: DecisionOutcome;
  reason: DecisionReason;
  closeabilityReasons?: string[];
  sharedCause?: SharedCause | null;
  isolation?: CycleDecision['isolation'];
}

interface PairedCase {
  name: string;
  laneMap: LaneMap;
  story: CycleStory;
  expected: Expected;
}

const ISOLATING: PairedCase = {
  name: 'one bad batch on one bulk lane',
  laneMap: COMMITTED,
  story: { lanes: [{ configurationSet: BULK, fromDomain: NEWS, groups: ONE_BAD_BATCH }, QUIET_TRANSACTIONAL] },
  expected: { lane: BULK, outcome: 'approved', reason: 'approved', isolation: 'confined', sharedCause: null },
};

const TWINS: readonly PairedCase[] = [
  {
    name: 'two bad batches on that lane',
    laneMap: COMMITTED,
    story: {
      lanes: [
        {
          configurationSet: BULK,
          fromDomain: NEWS,
          groups: [
            { bucketOffset: 0, count: 40, batch: 'import-0915', permanentBounces: 15 },
            { bucketOffset: 0, count: 40, batch: 'import-0916', permanentBounces: 15 },
            { bucketOffset: 1, count: 160, batch: 'import-0901' },
          ],
        },
        QUIET_TRANSACTIONAL,
      ],
    },
    expected: { lane: BULK, outcome: 'unknown', reason: 'not-settled', sharedCause: null },
  },
  {
    name: 'the batch spread to a second lane',
    laneMap: WITH_DIGEST,
    story: {
      lanes: [
        { configurationSet: BULK, fromDomain: NEWS, groups: ONE_BAD_BATCH },
        {
          configurationSet: DIGEST,
          fromDomain: 'digest.example.com',
          groups: [
            { bucketOffset: 0, count: 20, batch: 'import-0915', permanentBounces: 3 },
            { bucketOffset: 1, count: 400, batch: 'digest-0901' },
          ],
        },
      ],
    },
    expected: {
      lane: BULK,
      outcome: 'refused',
      reason: 'not-lane-scoped',
      isolation: 'spread-account',
      sharedCause: { kind: 'batch', value: 'import-0915', lanes: [BULK, DIGEST] },
    },
  },
  {
    name: 'the same incident on a transactional lane',
    laneMap: COMMITTED,
    story: {
      lanes: [
        { configurationSet: TRANSACTIONAL, fromDomain: 'receipts.example.com', groups: ONE_BAD_BATCH },
        { configurationSet: BULK, fromDomain: NEWS, groups: [{ bucketOffset: 1, count: 150, batch: 'import-0901' }] },
      ],
    },
    expected: { lane: TRANSACTIONAL, outcome: 'unknown', reason: 'not-closeable', closeabilityReasons: ['transactional'], isolation: 'confined' },
  },
  {
    name: 'a provider elevated on two lanes',
    laneMap: WITH_DIGEST,
    story: {
      lanes: [
        {
          configurationSet: BULK,
          fromDomain: NEWS,
          groups: [
            { bucketOffset: 0, count: 40, receivingDomains: ['gmail.com'], permanentBounces: 15 },
            { bucketOffset: 1, count: 160, receivingDomains: ['outlook.com'] },
          ],
        },
        {
          configurationSet: DIGEST,
          fromDomain: 'digest.example.com',
          groups: [
            { bucketOffset: 0, count: 40, receivingDomains: ['gmail.com'], permanentBounces: 10 },
            { bucketOffset: 1, count: 160, receivingDomains: ['outlook.com'] },
          ],
        },
      ],
    },
    expected: {
      lane: BULK,
      outcome: 'refused',
      reason: 'not-lane-scoped',
      isolation: 'spread-provider',
      sharedCause: { kind: 'provider', value: 'Google', lanes: [BULK, DIGEST] },
    },
  },
  {
    name: 'a missing DMARC record on a shared from-domain',
    laneMap: WITH_DIGEST,
    story: {
      lanes: [
        {
          configurationSet: BULK,
          fromDomain: NEWS,
          groups: [
            { bucketOffset: 0, count: 40, batch: 'import-0915', permanentBounces: 15, diagnosticCode: AUTH_FAILED },
            { bucketOffset: 1, count: 160, batch: 'import-0901' },
          ],
        },
        { configurationSet: DIGEST, fromDomain: NEWS, groups: [{ bucketOffset: 1, count: 150, batch: 'digest-0901' }] },
      ],
      identities: [DKIM_SIGNING],
      txtAnswers: DMARC_MISSING,
    },
    expected: {
      lane: BULK,
      outcome: 'refused',
      reason: 'not-lane-scoped',
      isolation: 'spread-domain',
      sharedCause: { kind: 'from-domain', value: NEWS, lanes: [BULK, DIGEST] },
    },
  },
];

type DecideCycle = typeof decideCycle;

function decisionsOf(paired: PairedCase, decide: DecideCycle = decideCycle): ReadonlyMap<string, CycleDecision> {
  return decide(cycleOf(paired.laneMap, paired.story).analyses, paired.laneMap);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** What a decision function got wrong about one paired case; empty when it decided as named. */
function mismatches(paired: PairedCase, decide: DecideCycle): string[] {
  const decisions = decisionsOf(paired, decide);
  const { expected } = paired;
  const found: string[] = [];
  const approved = [...decisions].filter(([, decision]) => decision.outcome === 'approved').map(([set]) => set);
  if (!sameJson(approved, expected.outcome === 'approved' ? [expected.lane] : [])) found.push(`approved lanes: ${approved.join(' ') || 'none'}`);
  const decision = decisions.get(expected.lane);
  if (decision === undefined) return [...found, `no decision for ${expected.lane}`];
  if (decision.outcome !== expected.outcome || decision.reason !== expected.reason) found.push(`decided ${decision.outcome} ${decision.reason}`);
  if (expected.sharedCause !== undefined && !sameJson(decision.sharedCause, expected.sharedCause)) found.push(`shared cause ${canonicalJson(decision.sharedCause)}`);
  if (expected.isolation !== undefined && decision.isolation !== expected.isolation) found.push(`isolation ${decision.isolation}`);
  if (expected.closeabilityReasons !== undefined && !sameJson(decision.closeability.reasons, expected.closeabilityReasons)) {
    found.push(`closeability reasons ${decision.closeability.reasons.join(' ')}`);
  }
  return found;
}

function plantDecision(analysis: LaneAnalysis, outcome: DecisionOutcome, reason: DecisionReason): CycleDecision {
  const { closeability } = analysis;
  return {
    outcome,
    reason,
    closeability: { state: closeability.state, reasons: closeability.state === 'refused' ? [...closeability.reasons] : [] },
    configurationSet: analysis.lane.configurationSet,
    isolation: 'confined',
    noData: false,
    bound: null,
    otherSpikingLanes: [],
    sharedCause: null,
  };
}

function plant(outcome: DecisionOutcome, reason: DecisionReason): DecideCycle {
  return (analyses) =>
    new Map(analyses.filter((analysis) => analysis.spike.verdict === 'spike').map((analysis) => [analysis.lane.configurationSet, plantDecision(analysis, outcome, reason)]));
}

describe('the paired suite (AC-10)', () => {
  it('approves the one bad batch on one bulk lane', () => {
    const decisions = decisionsOf(ISOLATING);
    expect(decisions.get(BULK)?.outcome).toBe('approved');
    expect(mismatches(ISOLATING, decideCycle)).toEqual([]);
  });

  it.each(TWINS.map((twin) => [twin.name, twin] as const))('decides %s with no approved option and its reason named', (_name, twin) => {
    expect(mismatches(twin, decideCycle)).toEqual([]);
  });

  it('turns red for an always-unknown decision on the isolating case', () => {
    expect(mismatches(ISOLATING, plant('unknown', 'not-settled'))).not.toEqual([]);
  });

  it('turns red for an always-approve decision on every twin', () => {
    for (const twin of TWINS) expect(mismatches(twin, plant('approved', 'approved')), twin.name).not.toEqual([]);
  });
});

describe('only spiking lanes are decided (AC-E27)', () => {
  it('gives a lane that does not spike no decision', () => {
    expect([...decisionsOf(ISOLATING).keys()]).toEqual([BULK]);
  });
});

describe('a settled cause on a transactional lane (AC-11)', () => {
  it('reads unknown not-closeable, naming the lane and its refusal reasons', () => {
    const transactional = TWINS.find((twin) => twin.expected.lane === TRANSACTIONAL);
    if (transactional === undefined) throw new Error('the paired suite holds the transactional twin');
    const decision = decisionsOf(transactional).get(TRANSACTIONAL);
    expect(decision?.closeability).toEqual({ state: 'refused', reasons: ['transactional'] });
    expect(decision?.outcome).toBe('unknown');
    expect(decision?.reason).toBe('not-closeable');
  });
});

const TWO_CAUSES: PairedCase = {
  name: 'two lanes spiking with different causes',
  laneMap: WITH_DIGEST,
  story: {
    lanes: [
      { configurationSet: BULK, fromDomain: NEWS, groups: ONE_BAD_BATCH },
      {
        configurationSet: DIGEST,
        fromDomain: 'digest.example.com',
        groups: [
          { bucketOffset: 0, count: 40, batch: 'digest-0915', permanentBounces: 15 },
          { bucketOffset: 1, count: 160, batch: 'digest-0901' },
        ],
      },
    ],
  },
  expected: { lane: BULK, outcome: 'unknown', reason: 'spread', isolation: 'spread-account', sharedCause: null },
};

describe('two lanes spiking at once (AC-E29)', () => {
  it('reads both spread across account and unknown spread, each naming the other lane', () => {
    const decisions = decisionsOf(TWO_CAUSES);
    for (const [lane, other] of [[BULK, DIGEST], [DIGEST, BULK]] as const) {
      const decision = decisions.get(lane);
      expect(decision?.isolation).toBe('spread-account');
      expect(decision?.outcome).toBe('unknown');
      expect(decision?.reason).toBe('spread');
      expect(decision?.otherSpikingLanes).toEqual([other]);
      expect(decision?.sharedCause).toBeNull();
    }
  });
});

describe('the isolation verdict (D-63)', () => {
  it('reports domain before provider and account when several spread conditions hold', () => {
    const { analyses } = cycleOf(WITH_DIGEST, {
      lanes: [
        { configurationSet: BULK, fromDomain: NEWS, groups: [{ bucketOffset: 0, count: 40, batch: 'import-0915', receivingDomains: ['gmail.com'], permanentBounces: 15, diagnosticCode: AUTH_FAILED }, { bucketOffset: 1, count: 160, batch: 'import-0901', receivingDomains: ['outlook.com'] }] },
        { configurationSet: DIGEST, fromDomain: NEWS, groups: [{ bucketOffset: 0, count: 40, batch: 'import-0915', receivingDomains: ['gmail.com'], permanentBounces: 15 }, { bucketOffset: 1, count: 160, batch: 'digest-0901', receivingDomains: ['outlook.com'] }] },
      ],
      identities: [DKIM_SIGNING],
      txtAnswers: DMARC_MISSING,
    });
    const bulk = analyses.find((analysis) => analysis.lane.configurationSet === BULK);
    if (bulk === undefined) throw new Error('the cycle holds the bulk lane');
    expect(isolationVerdict(bulk, analyses)).toBe('spread-domain');
    expect(isolationVerdict({ ...bulk, configurationRows: [] }, analyses)).toBe('spread-provider');
    expect(isolationVerdict({ ...bulk, configurationRows: [], rows: bulk.rows.filter((row) => row.dimension !== 'provider') }, analyses)).toBe('spread-account');
  });
});

function dmarcStory(diagnosticCode: string): PairedCase {
  return {
    name: `a missing DMARC record with bounces carrying ${diagnosticCode}`,
    laneMap: COMMITTED,
    story: {
      lanes: [
        {
          configurationSet: BULK,
          fromDomain: NEWS,
          groups: [
            { bucketOffset: 0, count: 40, permanentBounces: 15, diagnosticCode },
            { bucketOffset: 1, count: 160 },
          ],
        },
        QUIET_TRANSACTIONAL,
      ],
      identities: [DKIM_SIGNING],
      txtAnswers: DMARC_MISSING,
    },
    expected: { lane: BULK, outcome: 'unknown', reason: 'not-settled' },
  };
}

describe('review-fold pins (2026-10-12, D-61 as amended)', () => {
  it('(a) settles and approves a bad batch sent with one template, its batch and template rows both cause', () => {
    const decision = decisionsOf({
      ...ISOLATING,
      story: {
        lanes: [
          {
            configurationSet: BULK,
            fromDomain: NEWS,
            groups: [
              { bucketOffset: 0, count: 40, batch: 'import-0915', template: 'winback', permanentBounces: 15 },
              { bucketOffset: 1, count: 160, batch: 'import-0901', template: 'weekly' },
            ],
          },
          QUIET_TRANSACTIONAL,
        ],
      },
    }).get(BULK);
    expect(decision?.outcome).toBe('approved');
  });

  it('(b) leaves a missing DMARC record behind 5.7.1 spam blocks elevated and the lane unknown not-settled', () => {
    const paired = dmarcStory(SPAM_BLOCK);
    const dmarc = cycleOf(paired.laneMap, paired.story).analyses[0]?.configurationRows.find((row) => row.record === 'dmarc');
    expect(dmarc?.verdict).toBe('elevated');
    expect(mismatches(paired, decideCycle)).toEqual([]);
  });

  it('(c) settles, confines and approves the same lane when the bounces carry 5.7.26', () => {
    const paired = dmarcStory(AUTH_FAILED);
    const dmarc = cycleOf(paired.laneMap, paired.story).analyses[0]?.configurationRows.find((row) => row.record === 'dmarc');
    expect(dmarc?.verdict).toBe('cause');
    expect(mismatches({ ...paired, expected: { lane: BULK, outcome: 'approved', reason: 'approved', isolation: 'confined' } }, decideCycle)).toEqual([]);
  });

  it('(d) leaves a failed DKIM behind 5.7.23 SPF bounces elevated and the lane unknown not-settled', () => {
    const paired: PairedCase = {
      ...dmarcStory(SPF_FAILED),
      story: {
        ...dmarcStory(SPF_FAILED).story,
        identities: [{ ...DKIM_SIGNING, dkimStatus: 'FAILED' }],
        txtAnswers: { [`_dmarc.${NEWS}`]: { kind: 'records', records: ['v=DMARC1; p=none'] } },
      },
    };
    const rows = cycleOf(paired.laneMap, paired.story).analyses[0]?.configurationRows ?? [];
    expect(rows.map((row) => `${row.record}:${row.verdict}`)).toEqual(['dkim:elevated', 'mail-from:not-applicable', 'dmarc:ruled-out', 'spf:not-applicable']);
    expect(mismatches(paired, decideCycle)).toEqual([]);
  });
});

describe('lanes that are never approved (AC-P10)', () => {
  it('never approves a transactional, operator-alert or NO DATA lane, whatever its evidence', () => {
    let approvals = 0;
    fc.assert(
      fc.property(
        fc.constantFrom(BULK, TRANSACTIONAL, ALERTS),
        fc.integer({ min: 20, max: 60 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 8 }),
        fc.constantFrom('none', 'coverage', 'closeability'),
        (set, rowSends, rowBounces, restBounces, noData) => {
          const { analyses } = cycleOf(COMMITTED, {
            lanes: [
              {
                configurationSet: set,
                fromDomain: NEWS,
                groups: [
                  { bucketOffset: 0, count: rowSends, batch: 'import-a', permanentBounces: Math.min(rowBounces, rowSends) },
                  { bucketOffset: 1, count: 160, batch: 'import-b', permanentBounces: restBounces },
                ],
              },
            ],
          });
          const forged = analyses.map((analysis): LaneAnalysis => {
            if (noData === 'coverage') return { ...analysis, coverage: 'no-data' };
            return noData === 'closeability' ? { ...analysis, closeability: { state: 'no-data' } } : analysis;
          });
          const decision = decideCycle(forged, COMMITTED).get(set);
          if (decision?.outcome === 'approved') approvals += 1;
          if (set !== BULK || noData !== 'none') expect(decision?.outcome).not.toBe('approved');
        },
      ),
      { seed: propertySeed(), numRuns: 80 },
    );
    // Without approvals somewhere the property would hold for a function that never approves.
    expect(approvals).toBeGreaterThan(0);
  });
});

describe('the decision ignores lane and record order (SPEC R7 backstop)', () => {
  it.each([ISOLATING, ...TWINS, TWO_CAUSES].map((paired) => [paired.name, paired] as const))('%s', (_name, paired) => {
    const reversedMap = parseLaneMap({ ...paired.laneMap, lanes: [...paired.laneMap.lanes].reverse() });
    const reversedStory: CycleStory = { ...paired.story, lanes: [...paired.story.lanes].reverse() };
    const reversed = decideCycle(cycleOf(reversedMap, reversedStory, { reverseRecords: true }).analyses, reversedMap);
    expect(canonicalJson(Object.fromEntries(reversed))).toBe(canonicalJson(Object.fromEntries(decisionsOf(paired))));
    expect(reversed.size).toBeGreaterThan(0);
  });
});

function twinNamed(name: string): PairedCase {
  const twin = TWINS.find((candidate) => candidate.name === name);
  if (twin === undefined) throw new Error(`the paired suite holds no twin named ${name}`);
  return twin;
}

function recordOf(paired: PairedCase, lane: string = paired.expected.lane): EvidenceRecord {
  return recordFor(paired.laneMap, paired.story, lane);
}

const PRINTABLE_TEXT = /^[\x20-\x7E]{1,1000}$/;

describe('the question names what code found (D-64, AC-E28)', () => {
  it('names every spiking lane by its committed configuration set', () => {
    const { analyses } = cycleOf(TWO_CAUSES.laneMap, TWO_CAUSES.story);
    const decision = decideCycle(analyses, TWO_CAUSES.laneMap).get(BULK);
    if (decision === undefined) throw new Error('the cycle decides the bulk lane');
    const question = questionFor(decision, analyses);
    expect(question).toContain(DIGEST);
    expect(question).toContain(BULK);
  });

  it('keeps a mixed-case set name byte for byte', () => {
    const bulkLane = COMMITTED.lanes.find((lane) => lane.configurationSet === BULK);
    if (bulkLane === undefined) throw new Error('the committed lane map holds the bulk lane');
    const mixed = 'News_Bulk-EU';
    const laneMap = parseLaneMap({ ...COMMITTED, lanes: [...COMMITTED.lanes.filter((lane) => lane !== bulkLane), { ...bulkLane, configurationSet: mixed, lane: 'News bulk EU' }] });
    const twoBatches = twinNamed('two bad batches on that lane');
    const story: CycleStory = { lanes: twoBatches.story.lanes.map((lane) => (lane.configurationSet === BULK ? { ...lane, configurationSet: mixed } : lane)) };
    const question = recordFor(laneMap, story, mixed).question ?? '';
    expect(question).toContain(mixed);
    expect(question).not.toContain(mixed.toLowerCase());
  });

  it('names both elevated batches of two bad batches on one lane', () => {
    const question = recordOf(twinNamed('two bad batches on that lane')).question;
    expect(question).toContain('batch import-0915');
    expect(question).toContain('batch import-0916');
  });

  it('names the elevated DMARC row behind 5.7.1 spam blocks (pin b)', () => {
    const record = recordOf(dmarcStory(SPAM_BLOCK));
    expect(record.question).toContain(`DMARC of ${NEWS}`);
    expect(record.approvedOptions).toEqual([]);
  });

  it('names the refusal reasons of a lane that is not closeable', () => {
    expect(recordOf(twinNamed('the same incident on a transactional lane')).question).toContain('transactional');
  });

  it('stays printable ASCII under 1,000 characters when the rows carry long values', () => {
    const longName = (index: number) => `${'long-batch-name-'.repeat(12)}${index}`;
    const record = recordFor(COMMITTED, {
      lanes: [
        {
          configurationSet: BULK,
          fromDomain: NEWS,
          groups: [
            ...Array.from({ length: 6 }, (_, index) => ({ bucketOffset: 0, count: 40, batch: longName(index), permanentBounces: 15 })),
            { bucketOffset: 1, count: 160, batch: 'import-0901' },
          ],
        },
      ],
    }, BULK);
    expect(record.decision.reason).toBe('not-settled');
    expect(record.question).toMatch(PRINTABLE_TEXT);
    expect(record.question).toContain(longName(0));
  });
});

describe('fix templates (D-64)', () => {
  const FIXES: Record<FixKind, { text: string; names: string[] }> = {
    'shared-tag-value': {
      text: fixFor('shared-tag-value', { dimension: 'batch', value: 'import-0915', lanes: [BULK, DIGEST] }).text,
      names: ['batch import-0915', BULK, DIGEST, 'Pausing one lane would not stop it'],
    },
    'shared-provider': {
      text: fixFor('shared-provider', { provider: 'Google', lanes: [BULK, DIGEST] }).text,
      names: ['Google', BULK, DIGEST, 'Pausing one lane would not stop it'],
    },
    'missing-dkim': {
      text: fixFor('missing-dkim', { fromDomain: NEWS, identity: 'example.com' }).text,
      names: [NEWS, 'SES identity example.com', 'DKIM'],
    },
    'failed-mail-from': {
      text: fixFor('failed-mail-from', { fromDomain: NEWS, identity: 'example.com', mailFromDomain: 'bounce.example.com' }).text,
      names: [NEWS, 'SES identity example.com', 'MX record', 'bounce.example.com'],
    },
    'missing-dmarc': {
      text: fixFor('missing-dmarc', { fromDomain: NEWS }).text,
      names: [`_dmarc.${NEWS}`, 'at least half', 'authentication-failure enhanced status codes'],
    },
    'missing-spf': {
      text: fixFor('missing-spf', { fromDomain: NEWS, mailFromDomain: 'bounce.example.com' }).text,
      names: [NEWS, 'TXT record', 'bounce.example.com'],
    },
  };

  it('has one template per fix kind', () => {
    expect(Object.keys(FIXES).sort()).toEqual([...FIX_KINDS].sort());
  });

  it.each(FIX_KINDS.map((kind) => [kind] as const))('%s names its closed values in printable ASCII', (kind) => {
    const fix = FIXES[kind];
    expect(fix.text).toMatch(PRINTABLE_TEXT);
    for (const name of fix.names) expect(fix.text).toContain(name);
  });

  it('words the DMARC corroboration without a status code or an RFC number', () => {
    const text = FIXES['missing-dmarc'].text;
    expect(text).not.toMatch(/\d/);
    expect(text).not.toMatch(/rfc/i);
  });

  it('returns the kind it was asked for', () => {
    expect(fixFor('missing-spf', { fromDomain: NEWS, mailFromDomain: 'bounce.example.com' }).kind).toBe('missing-spf');
  });
});

describe('the evidence record is assembled once with its question or fix (D-70)', () => {
  it('assembles the isolating incident approved with one option, its rows, totals and share', () => {
    const record = recordOf(ISOLATING);
    expect(record.decision.outcome).toBe('approved');
    expect(record.approvedOptions).toHaveLength(1);
    expect(record.question).toBeNull();
    expect(record.fix).toBeNull();
    expect(record.isolation).toBe('confined');
    expect(record.laneTotals).toMatchObject({ recipientSends: 200, permanentBounces: 15, hardBounceRatio: '7.50%', triggers: ['hard-bounce'] });
    expect(record.laneTotals.label).toEqual({ hardBounceRatio: LANE_RATIO_LABELS.hardBounce, complaintRatio: LANE_RATIO_LABELS.complaint });
    expect(record.share.label).toBe(LANE_SHARE_LABEL);
    expect(new Set(record.rows.map((row) => row.dimension))).toEqual(new Set(['batch', 'template', 'campaign', 'provider']));
    expect(record.expiresAt).toBe(CYCLE_EXPIRES_AT);
  });

  it.each([
    ['the batch spread to a second lane', 'shared-tag-value'],
    ['a provider elevated on two lanes', 'shared-provider'],
    ['a missing DMARC record on a shared from-domain', 'missing-dmarc'],
  ] as const)('refuses %s with the %s fix and no option or question', (name, kind) => {
    const record = recordOf(twinNamed(name));
    expect(record.fix?.kind).toBe(kind);
    expect(record.approvedOptions).toEqual([]);
    expect(record.question).toBeNull();
  });

  it('names _dmarc.<from-domain> in the shared DMARC fix', () => {
    expect(recordOf(twinNamed('a missing DMARC record on a shared from-domain')).fix?.text).toContain(`_dmarc.${NEWS}`);
  });

  it('asks a question and carries no fix or option for an unknown decision', () => {
    const record = recordOf(twinNamed('two bad batches on that lane'));
    expect(record.question).toMatch(PRINTABLE_TEXT);
    expect(record.fix).toBeNull();
    expect(record.approvedOptions).toEqual([]);
  });

  it('assembles a record past RECORD_BYTE_CEILING again as unknown record-too-large with no option (AC-E35)', () => {
    const { analyses } = cycleOf(ISOLATING.laneMap, ISOLATING.story);
    const decision = decideCycle(analyses, ISOLATING.laneMap).get(BULK);
    const bulk = analyses.find((analysis) => analysis.lane.configurationSet === BULK);
    if (decision === undefined || bulk === undefined) throw new Error('the cycle decides the bulk lane');
    const padded: LaneAnalysis = { ...bulk, rows: Array.from({ length: 60 }, () => bulk.rows).flat() };
    const record = assembleEvidenceRecord({ incidentId: '0'.repeat(32), analysis: padded, decision, analyses, expiresAt: CYCLE_EXPIRES_AT });
    expect(decision.outcome).toBe('approved');
    expect(serializedRecordBytes(record)).toBeGreaterThan(RECORD_BYTE_CEILING);
    expect(record.decision.outcome).toBe('unknown');
    expect(record.decision.reason).toBe('record-too-large');
    expect(record.approvedOptions).toEqual([]);
  });

  it('carries none of the SES-rate phrases in any assembled record (AC-4)', () => {
    for (const paired of [ISOLATING, ...TWINS, TWO_CAUSES]) {
      const lowered = canonicalJson(recordOf(paired)).toLowerCase();
      for (const phrase of ['ses bounce rate', 'ses complaint rate', 'your bounce rate']) expect(lowered, paired.name).not.toContain(phrase);
    }
  });
});
