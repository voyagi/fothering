import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import {
  AGENT_UNAVAILABLE_REASONS,
  EXPLANATION_CHECKS,
  actionGate,
  type GateDecision,
  INVALID_CHECKS,
  RETRYABLE_UNAVAILABLE_REASONS,
  agentAnswerSchema,
  classifyRuntimeOutcome,
  runtimeResultSchema,
  validateDecision,
  validateExplanation,
  type ExplanationContext,
  type RuntimeOutcome,
  type RuntimeResult,
} from './agent-answer.js';
import { buildEvidenceRecord, canonicalJson, incidentIdFor, optionIdFor, recordHash, type EvidenceRecord } from './evidence-record.js';
import { parseLaneMap } from './lanes.js';
import { PINNED_MODEL_VALUES } from './model-values.js';
import { recordFor, type CycleStory } from './test/decision-cycle.js';
import { propertySeed } from './test/property-seed.js';

const BULK = 'fothering-bulk';
const TRANSACTIONAL = 'fothering-transactional';
const NEWS = 'news.example.com';
const CAUSE_BATCH = 'import-2026-10-01';

// Built from their code points so the file holds only printable text.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const WORD_JOINER = String.fromCharCode(0x2060);
const SOFT_HYPHEN = String.fromCharCode(0xad);

const COMMITTED = parseLaneMap(lanesJson);
const LANE_MAP_SETS = COMMITTED.lanes.map((lane) => lane.configurationSet);
const QUIET_TRANSACTIONAL = { configurationSet: TRANSACTIONAL, fromDomain: 'receipts.example.com', groups: [{ bucketOffset: 1, count: 150 }] };

function bulkStory(groups: CycleStory['lanes'][number]['groups']): CycleStory {
  return { lanes: [{ configurationSet: BULK, fromDomain: NEWS, groups }, QUIET_TRANSACTIONAL] };
}

const APPROVED = recordFor(
  COMMITTED,
  bulkStory([
    { bucketOffset: 0, count: 40, batch: CAUSE_BATCH, permanentBounces: 15 },
    { bucketOffset: 1, count: 160, batch: 'import-0901' },
  ]),
  BULK,
);

const UNSETTLED = recordFor(
  COMMITTED,
  bulkStory([
    { bucketOffset: 0, count: 40, batch: 'import-0915', permanentBounces: 15 },
    { bucketOffset: 0, count: 40, batch: 'import-0916', permanentBounces: 15 },
    { bucketOffset: 1, count: 160, batch: 'import-0901' },
  ]),
  BULK,
);

const DIGIT_BATCH = recordFor(
  COMMITTED,
  bulkStory([
    { bucketOffset: 0, count: 40, batch: '500', permanentBounces: 15 },
    { bucketOffset: 1, count: 160, batch: 'import-0901' },
  ]),
  BULK,
);

// The approved story read with an SES identity, so the record carries configuration rows for NEWS.
const WITH_IDENTITY = recordFor(
  COMMITTED,
  {
    ...bulkStory([
      { bucketOffset: 0, count: 40, batch: CAUSE_BATCH, permanentBounces: 15 },
      { bucketOffset: 1, count: 160, batch: 'import-0901' },
    ]),
    identities: [{ identity: 'example.com', dkimStatus: 'SUCCESS', dkimSigningEnabled: true }],
  },
  BULK,
);

const F1 = `this lane's hard-bounce ratio is 7.50% (15 of 200 recipient-sends), carried by batch ${CAUSE_BATCH}`;

function closeOn(record: EvidenceRecord, laneMapSets: readonly string[] = LANE_MAP_SETS): ExplanationContext {
  return { record, decision: 'close', laneMapSets };
}

function unknownOn(record: EvidenceRecord, laneMapSets: readonly string[] = LANE_MAP_SETS): ExplanationContext {
  return { record, decision: 'unknown', laneMapSets };
}

function checkOf(text: string, context: ExplanationContext): string {
  const verdict = validateExplanation(text, context);
  return verdict.ok ? 'ok' : verdict.check;
}

describe('the scenario records hold what the explanation cases assume', () => {
  it('the approved record carries the F1 values', () => {
    expect(APPROVED.decision.outcome).toBe('approved');
    expect(APPROVED.laneTotals).toMatchObject({ recipientSends: 200, permanentBounces: 15, hardBounceRatio: '7.50%' });
    expect(APPROVED.rows.some((row) => row.value === CAUSE_BATCH)).toBe(true);
    expect(UNSETTLED.decision.outcome).toBe('unknown');
  });

  it('the digit-batch record names batch 500 and holds no integer 500', () => {
    expect(DIGIT_BATCH.rows.some((row) => row.value === '500')).toBe(true);
    expect(canonicalJson(DIGIT_BATCH)).not.toMatch(/[:[,]500[,\]}]/);
  });
});

describe('validateExplanation (D-78, R12)', () => {
  it('accepts the F1 paragraph, which names the cause batch exactly, through all eight checks', () => {
    expect(EXPLANATION_CHECKS.map((entry) => entry.check).sort()).toEqual(
      ['command-word', 'empty', 'length', 'number', 'paragraph', 'phrase', 'set-name', 'url'].sort(),
    );
    expect(validateExplanation(F1, closeOn(APPROVED))).toEqual({ ok: true });
    expect(validateExplanation(F1, unknownOn(APPROVED))).toEqual({ ok: true });
  });

  it('rejects an empty or whitespace-only explanation (AC-E43)', () => {
    for (const text of ['', '   ', '\n\t  　']) expect(checkOf(text, closeOn(APPROVED))).toBe('empty');
  });

  it('rejects an explanation of only zero-width characters and spaces as empty', () => {
    const onlyInvisible = [
      String.fromCodePoint(0x200b).repeat(2),
      `${String.fromCodePoint(0xfeff)} ${String.fromCodePoint(0x2060)}`,
    ];
    for (const text of onlyInvisible) expect(checkOf(text, closeOn(APPROVED))).toBe('empty');
    expect(checkOf('the table does not settle one cause', unknownOn(UNSETTLED))).toBe('ok');
  });

  it('counts code points of the NFC form: 600 passes and 601 rejects (AC-E41)', () => {
    const decomposedE = 'é';
    expect(checkOf(decomposedE.repeat(600), closeOn(APPROVED))).toBe('ok');
    expect(checkOf(decomposedE.repeat(601), closeOn(APPROVED))).toBe('length');
    expect(checkOf('\u{1D49C}'.repeat(600), closeOn(APPROVED))).toBe('ok');
    expect(checkOf('a'.repeat(601), closeOn(APPROVED))).toBe('length');
  });

  it('rejects a blank line anywhere and allows a single line break', () => {
    expect(checkOf('First part.\n\nSecond part.', closeOn(APPROVED))).toBe('paragraph');
    expect(checkOf('First part.\r\n  \r\nSecond part.', closeOn(APPROVED))).toBe('paragraph');
    expect(checkOf('First part.\nSecond part.', closeOn(APPROVED))).toBe('ok');
  });

  it('rejects any scheme URL, defanged hxxp forms and www. tokens across case, width and zero-width tricks (AC-E44)', () => {
    const urls = [
      'see https://example.com/x',
      'see HTTPS://EXAMPLE.COM',
      'see ｈｔｔｐｓ：／／example.com',
      `see ht${ZERO_WIDTH_SPACE}tps://example.com`,
      'see ftp://example.com',
      'see hxxp://example.com',
      'see hXXps[:]//example.com',
      'see www.example.com',
      'see WWW.Example.com',
      `see w${WORD_JOINER}ww.example.com`,
    ];
    for (const text of urls) expect(checkOf(text, closeOn(APPROVED))).toBe('url');
    expect(checkOf(`mail from ${NEWS} reads fine`, closeOn(WITH_IDENTITY))).toBe('ok');
  });

  it('allows a bare domain only when the record holds it, across case, width and zero-width tricks', () => {
    expect(WITH_IDENTITY.configurationRows.some((row) => row.fromDomain === NEWS)).toBe(true);
    const invented = [
      'reset the lane at login-example.net',
      'see example.org/reset for the fix',
      'see EXAMPLE.ORG',
      'see ｅｘａｍｐｌｅ.org',
      `see exa${ZERO_WIDTH_SPACE}mple.org`,
      'the fix is at mail.example.net.',
      'the fix is at example.xn--p1ai',
      `write to postmaster@${NEWS} about it`,
      'write to ops＠example.org',
    ];
    for (const text of invented) expect(checkOf(text, closeOn(WITH_IDENTITY)), text).toBe('url');
    expect(checkOf(`the from-domain is ${NEWS}.`, closeOn(WITH_IDENTITY))).toBe('ok');
    expect(checkOf(`the from-domain is ${NEWS.toUpperCase()}, e.g. on this lane`, closeOn(WITH_IDENTITY))).toBe('ok');
    // A record read without SES facts holds no from-domain, so naming one is a domain the model invented.
    expect(checkOf(`the from-domain is ${NEWS}`, closeOn(APPROVED))).toBe('url');
    expect(checkOf(F1, closeOn(APPROVED))).toBe('ok');
  });

  it('reads a bracket-defanged dot as a dot, so a defanged domain is judged like the plain one', () => {
    for (const text of ['see evil[.]com', 'see evil(.)com', 'see evil{.}com', 'write to ops@evil[.]com']) {
      expect(checkOf(text, closeOn(WITH_IDENTITY)), text).toBe('url');
    }
    expect(checkOf('the from-domain is news[.]example[.]com', closeOn(WITH_IDENTITY))).toBe('ok');
  });

  it('rejects any occurrence of close or reopen, in any case or width', () => {
    const words = [
      'please reopen it',
      'Keep Closed',
      'the closure stands',
      'closing it now',
      'we disclose this',
      `CLO${ZERO_WIDTH_SPACE}SE it`,
      'ｃｌｏｓｅ it',
      `clo${SOFT_HYPHEN}se it`,
    ];
    for (const text of words) expect(checkOf(text, closeOn(APPROVED)), text).toBe('command-word');
  });

  it("lets the record's own names through the command-word check, whole token only", () => {
    const record = recordFor(COMMITTED, bulkStory([{ bucketOffset: 0, count: 40, batch: 'closeout-sale', permanentBounces: 15 }, { bucketOffset: 1, count: 160, batch: 'import-0901' }]), BULK);
    expect(record.rows.some((row) => row.value === 'closeout-sale')).toBe(true);
    expect(checkOf("batch closeout-sale carried this lane's hard-bounce ratio", closeOn(record))).toBe('ok');
    expect(checkOf('pausing this lane, then close it', closeOn(record))).toBe('command-word');
    expect(checkOf('we made a disclosure', closeOn(record))).toBe('command-word');
  });

  it('allows only the record lane set with close, and no lane-map set with unknown (5-2, F4)', () => {
    expect(checkOf(`pause ${BULK} for now`, closeOn(APPROVED))).toBe('ok');
    expect(checkOf(`pause ${TRANSACTIONAL} for now`, closeOn(APPROVED))).toBe('set-name');
    expect(checkOf(`pause ${BULK} for now`, unknownOn(UNSETTLED))).toBe('set-name');
    expect(checkOf('pause FOTHERING-BULK for now', unknownOn(UNSETTLED))).toBe('set-name');
    expect(checkOf(`pause fothering-${ZERO_WIDTH_SPACE}bulk for now`, unknownOn(UNSETTLED))).toBe('set-name');
  });

  it('judges set names that contain one another by where each occurrence sits', () => {
    const nested = [BULK, `${BULK}-eu`, 'fothering'];
    expect(checkOf(`pause ${BULK} for now`, closeOn(APPROVED, nested))).toBe('ok');
    expect(checkOf(`pause ${BULK}-eu for now`, closeOn(APPROVED, nested))).toBe('set-name');
    expect(checkOf('pause fothering for now', closeOn(APPROVED, nested))).toBe('set-name');
  });

  it('finds a set name only as a whole token, so a short set name inside an ordinary word passes', () => {
    const withNews = [BULK, 'news'];
    expect(checkOf('newsletter traffic rose on this lane', closeOn(APPROVED, withNews))).toBe('ok');
    expect(checkOf('newsletter traffic rose on this lane', unknownOn(UNSETTLED, withNews))).toBe('ok');
    expect(checkOf('pause news for now', closeOn(APPROVED, withNews))).toBe('set-name');
    expect(checkOf('pause NEWS for now', unknownOn(UNSETTLED, withNews))).toBe('set-name');
  });

  it('rejects the R2 phrases with any whitespace run and case', () => {
    for (const text of ['the SES  bounce\nrate is up', 'your Bounce Rate is up', 'the ses complaint\trate is up']) {
      expect(checkOf(text, closeOn(APPROVED))).toBe('phrase');
    }
  });

  // The system prompt bans "bounce rate" and "complaint rate" whole: a lane ratio called a bounce
  // rate reads like the SES account metric, with or without "ses" or "your" before it.
  it('rejects bounce rate and complaint rate with any word before them, and passes the lane ratio wording', () => {
    for (const text of ['the bounce rate rose', 'your complaint rate']) expect(checkOf(text, closeOn(APPROVED)), text).toBe('phrase');
    expect(checkOf("this lane's hard-bounce ratio", closeOn(APPROVED))).toBe('ok');
  });

  it('accepts only integers the record holds and percentages exactly as it renders them (AC-E42)', () => {
    expect(checkOf('7.50% of 200 recipient-sends', closeOn(APPROVED))).toBe('ok');
    expect(checkOf('about 8%', closeOn(APPROVED))).toBe('number');
    expect(checkOf('about 7.5%', closeOn(APPROVED))).toBe('number');
    expect(checkOf('a ratio of 7.50', closeOn(APPROVED))).toBe('number');
    expect(checkOf('424242 sends', closeOn(APPROVED))).toBe('number');
    expect(checkOf('0200 sends', closeOn(APPROVED))).toBe('number');
    expect(checkOf('١٥ bounces', closeOn(APPROVED))).toBe('number');
    expect(checkOf('１５ bounces', closeOn(APPROVED))).toBe('ok');
  });

  it('accepts a table count written with thousands separators', () => {
    const larger = { ...APPROVED, laneTotals: { ...APPROVED.laneTotals, recipientSends: 1200 } };
    expect(checkOf('1,200 recipient-sends', closeOn(larger))).toBe('ok');
    expect(checkOf('1,200 recipient-sends', closeOn(APPROVED))).toBe('number');
    const bucket = APPROVED.window.fromBucketMs;
    expect(checkOf(`from ${bucket.toLocaleString('en-US')}`, closeOn(APPROVED))).toBe('ok');
  });

  it('removes only whole-token copies of record strings before the number check (4b-Q)', () => {
    expect(checkOf(`batch ${CAUSE_BATCH} carried it`, closeOn(APPROVED))).toBe('ok');
    expect(checkOf(`batch ${CAUSE_BATCH}x carried it`, closeOn(APPROVED))).toBe('number');
    expect(checkOf(`batch x${CAUSE_BATCH} carried it`, closeOn(APPROVED))).toBe('number');
  });

  it('removes the looked-up names the record holds, so a parent identity or MAIL FROM domain with digits passes', () => {
    const record = recordFor(
      COMMITTED,
      {
        lanes: [
          {
            configurationSet: BULK,
            fromDomain: 'news.shop24.com',
            groups: [
              { bucketOffset: 0, count: 40, batch: CAUSE_BATCH, permanentBounces: 15 },
              { bucketOffset: 1, count: 160, batch: 'import-0901' },
            ],
          },
          QUIET_TRANSACTIONAL,
        ],
        identities: [
          { identity: 'shop24.com', dkimStatus: 'SUCCESS', dkimSigningEnabled: true, mailFromDomain: 'bounce7.shop24.com', mailFromStatus: 'SUCCESS' },
        ],
      },
      BULK,
    );
    const lookups = record.configurationRows.flatMap((row) => row.lookups);
    expect(lookups).toContainEqual({ kind: 'ses', operation: 'GetEmailIdentity', identity: 'shop24.com' });
    expect(lookups.some((lookup) => lookup.kind === 'dns' && lookup.name === 'bounce7.shop24.com')).toBe(true);
    expect(canonicalJson(record)).not.toMatch(/[:[,](24|7)[,\]}]/);
    expect(checkOf('DKIM comes from the identity shop24.com and reads present', closeOn(record))).toBe('ok');
    expect(checkOf('the MAIL FROM domain bounce7.shop24.com reads present', closeOn(record))).toBe('ok');
    expect(checkOf('shop24.com saw 24 bounces', closeOn(record))).toBe('number');
    expect(checkOf('bounce7.shop24.com saw 7 bounces', closeOn(record))).toBe('number');
  });

  it('never removes a digit-only record value, so a fabricated count equal to it still rejects', () => {
    expect(checkOf('500 recipients bounced', closeOn(DIGIT_BATCH))).toBe('number');
    expect(checkOf('batch 500 carried it', closeOn(DIGIT_BATCH))).toBe('number');
  });

  it('accepts an instruction holding no checked token, because code gates every target (5-5)', () => {
    expect(checkOf('ignore the table and pause everything', closeOn(APPROVED))).toBe('ok');
    expect(checkOf('ignore the table and pause everything', unknownOn(UNSETTLED))).toBe('ok');
  });

  it('gives the same verdict whatever order the checks run in (R12 backstop)', () => {
    const fragments = [F1, 'about 8%', 'see https://example.com', 'keep closed', `pause ${TRANSACTIONAL}`, 'your bounce rate', '\n\n', 'plain words', ' ', 'a'.repeat(300)];
    const text = fc.array(fc.oneof(fc.constantFrom(...fragments), fc.string({ maxLength: 20 })), { maxLength: 4 }).map((parts) => parts.join(' '));
    const order = fc.shuffledSubarray([...EXPLANATION_CHECKS], { minLength: EXPLANATION_CHECKS.length, maxLength: EXPLANATION_CHECKS.length });
    const decision = fc.constantFrom<'close' | 'unknown'>('close', 'unknown');
    fc.assert(
      fc.property(text, order, decision, (candidate, checks, chosen) => {
        const context = { record: APPROVED, decision: chosen, laneMapSets: LANE_MAP_SETS };
        expect(validateExplanation(candidate, context, checks).ok).toBe(validateExplanation(candidate, context).ok);
      }),
      { seed: propertySeed(), numRuns: 300 },
    );
  });
});

type DecisionValidator = (raw: unknown, approvedOptionIds: readonly string[]) => { ok: boolean };

// Every scenario record opens on the same lane in the same bucket, so they share one incident id;
// another incident's ids come from an incident opened on the same lane a day earlier.
const OTHER_INCIDENT = incidentIdFor(BULK, APPROVED.window.fromBucketMs - 86_400_000);
const APPROVED_IDS = APPROVED.approvedOptions.map((option) => option.optionId);
const APPROVED_ID = APPROVED_IDS[0] ?? '';
const COMBINING_ACUTE = String.fromCharCode(0x301);

// Latin letters an approved id can hold, each beside a Cyrillic and a Greek look-alike.
const CONFUSABLES: Readonly<Record<string, readonly string[]>> = {
  o: [String.fromCharCode(0x43e), String.fromCharCode(0x3bf)],
  p: [String.fromCharCode(0x440), String.fromCharCode(0x3c1)],
  e: [String.fromCharCode(0x435), String.fromCharCode(0x3b5)],
  c: [String.fromCharCode(0x441), String.fromCharCode(0x3f2)],
  a: [String.fromCharCode(0x430), String.fromCharCode(0x3b1)],
};

function confusableVariants(id: string): string[] {
  return [...id].flatMap((char, index) => (CONFUSABLES[char] ?? []).map((lookAlike) => `${id.slice(0, index)}${lookAlike}${id.slice(index + 1)}`));
}

const FIXED_VARIANTS = [
  APPROVED_ID.toUpperCase(),
  ` ${APPROVED_ID}`,
  `${APPROVED_ID} `,
  `\t${APPROVED_ID}\n`,
  ...confusableVariants(APPROVED_ID),
  `${APPROVED_ID}${COMBINING_ACUTE}`,
  `${APPROVED_ID}${COMBINING_ACUTE}`.normalize('NFC'),
  `${APPROVED_ID}${COMBINING_ACUTE}`.normalize('NFD'),
  optionIdFor(OTHER_INCIDENT, 0),
  optionIdFor(incidentIdFor(TRANSACTIONAL, 0), 0),
  optionIdFor(APPROVED.incidentId, 1),
  '',
  '   ',
];

const optionIdCandidate = fc.oneof(
  fc.constant(APPROVED_ID),
  fc.constantFrom(...FIXED_VARIANTS),
  fc
    .tuple(fc.nat(APPROVED_ID.length), fc.nat(APPROVED_ID.length))
    .map(([from, to]) => APPROVED_ID.slice(Math.min(from, to), Math.max(from, to)))
    .filter((part) => part !== APPROVED_ID),
  fc.array(fc.boolean(), { minLength: APPROVED_ID.length, maxLength: APPROVED_ID.length }).map((upper) =>
    [...APPROVED_ID].map((char, index) => (upper[index] === true ? char.toUpperCase() : char)).join(''),
  ),
  fc.string({ minLength: 1, maxLength: 1 }).map((extra) => `${APPROVED_ID}${extra}`),
  fc.stringMatching(/^opt-[0-9a-f]{24}$/),
  fc.string(),
);

const answerCandidate: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({ decision: fc.constant('close'), optionId: optionIdCandidate, explanation: fc.string() }),
  fc.record({ decision: fc.constant('unknown'), explanation: fc.string() }),
  fc.record({ decision: fc.constant('unknown'), optionId: optionIdCandidate, explanation: fc.string() }),
  fc.record({ decision: fc.constant('close'), explanation: fc.string() }),
  fc.record({ decision: fc.constantFrom('close', 'unknown'), optionId: optionIdCandidate, explanation: fc.string(), note: fc.string() }),
  fc.record({ decision: fc.string(), optionId: optionIdCandidate, explanation: fc.string() }),
  fc.anything(),
  fc.string(),
  fc.double(),
  fc.array(fc.anything()),
  fc.object(),
);

// Written apart from the schema: the only answers to accept are a well-formed unknown and a close
// whose option id is byte-equal to an approved one.
function acceptable(raw: unknown, approvedOptionIds: readonly string[]): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const answer = raw as Record<string, unknown>;
  const keys = Object.keys(answer).sort().join(',');
  if (typeof answer.explanation !== 'string') return false;
  if (answer.decision === 'unknown') return keys === 'decision,explanation';
  if (answer.decision !== 'close' || keys !== 'decision,explanation,optionId') return false;
  return approvedOptionIds.some((id) => id === answer.optionId);
}

function decisionProperty(validator: DecisionValidator): fc.IPropertyWithHooks<[unknown, readonly string[]]> {
  return fc.property(answerCandidate, fc.constantFrom<readonly string[]>(APPROVED_IDS, []), (raw, approvedOptionIds) => {
    return validator(raw, approvedOptionIds).ok === acceptable(raw, approvedOptionIds);
  });
}

function plantedValidator(matches: (approved: string, candidate: string) => boolean): DecisionValidator {
  return (raw, approvedOptionIds) => {
    const parsed = agentAnswerSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    const { decision, optionId } = parsed.data;
    if (decision === 'unknown') return { ok: true };
    return { ok: optionId !== undefined && approvedOptionIds.some((id) => matches(id, optionId)) };
  };
}

describe('validateDecision (AC-15, D-74)', () => {
  it('accepts exactly the byte-equal approved ids and every well-formed unknown', () => {
    fc.assert(decisionProperty(validateDecision), { seed: propertySeed(), numRuns: 2000 });
  });

  it('the property catches a validator comparing with includes()', () => {
    const planted = plantedValidator((approved, candidate) => approved.includes(candidate));
    expect(fc.check(decisionProperty(planted), { seed: propertySeed(), numRuns: 2000 }).failed).toBe(true);
  });

  it('the property catches a validator comparing case-insensitively', () => {
    const planted = plantedValidator((approved, candidate) => approved.toLowerCase() === candidate.toLowerCase());
    expect(fc.check(decisionProperty(planted), { seed: propertySeed(), numRuns: 2000 }).failed).toBe(true);
  });

  it('rejects a close with an empty, missing or whitespace-only option id (AC-E36)', () => {
    for (const answer of [
      { decision: 'close', optionId: '', explanation: 'x' },
      { decision: 'close', explanation: 'x' },
      { decision: 'close', optionId: '   ', explanation: 'x' },
    ]) {
      expect(validateDecision(answer, ['', '   ', ...APPROVED_IDS]).ok).toBe(false);
    }
  });

  it('gives the same verdict in any key order and rejects any extra field (AC-E37)', () => {
    const forward = { decision: 'close', optionId: APPROVED_ID, explanation: 'x' };
    const backward = { explanation: 'x', optionId: APPROVED_ID, decision: 'close' };
    expect(validateDecision(forward, APPROVED_IDS).ok).toBe(true);
    expect(validateDecision(backward, APPROVED_IDS).ok).toBe(true);
    expect(validateDecision({ ...forward, confidence: 'high' }, APPROVED_IDS).ok).toBe(false);
    expect(validateDecision({ decision: 'unknown', explanation: 'x', target: BULK }, APPROVED_IDS).ok).toBe(false);
  });
});

const PROMPT_SHA = 'a'.repeat(64);
const USAGE = { inputTokens: 900, outputTokens: 80, totalTokens: 980 };
const NO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function answered(answer: unknown): RuntimeResult {
  return { status: 'answered', answer, pinned: { ...PINNED_MODEL_VALUES }, promptSha256: PROMPT_SHA, usage: USAGE, modelCalls: 1 };
}

function returned(response: unknown): RuntimeOutcome {
  return { kind: 'returned', response };
}

const OUTCOME_CONTEXT = { record: APPROVED, laneMapSets: LANE_MAP_SETS };

describe('classifyRuntimeOutcome (D-77)', () => {
  it('names the five unavailable reasons, the three retryable ones and the closed invalid checks', () => {
    expect(AGENT_UNAVAILABLE_REASONS).toEqual(['agent-error', 'agent-timeout', 'cap-reached', 'response-invalid', 'agent-dry-run']);
    expect(RETRYABLE_UNAVAILABLE_REASONS).toEqual(['agent-error', 'agent-timeout', 'response-invalid']);
    expect(INVALID_CHECKS).toEqual([
      'schema',
      'option-id',
      'number',
      'url',
      'command-word',
      'set-name',
      'phrase',
      'paragraph',
      'length',
      'empty',
      'model-call-ceiling',
      'input-ceiling',
      'structured-output',
      'loop-limit',
      'runtime-result',
    ]);
    for (const entry of EXPLANATION_CHECKS) expect(INVALID_CHECKS).toContain(entry.check);
  });

  it('validates an answered close on the approved option and carries its option id', () => {
    const answer = { decision: 'close', optionId: APPROVED_ID, explanation: F1 };
    expect(classifyRuntimeOutcome(returned(answered(answer)), OUTCOME_CONTEXT)).toEqual({ kind: 'validated', answer });
  });

  it('validates an answered unknown with a clean explanation', () => {
    const answer = { decision: 'unknown', explanation: 'the table does not settle one cause' };
    expect(classifyRuntimeOutcome(returned(answered(answer)), { record: UNSETTLED, laneMapSets: LANE_MAP_SETS })).toEqual({ kind: 'validated', answer });
  });

  const PLANTED = 'QZVX planted words';
  const cases: readonly { name: string; outcome: RuntimeOutcome; context?: ExplanationContext['record']; expected: unknown }[] = [
    { name: 'an answer failing the schema', outcome: returned(answered({ decision: 'close', explanation: PLANTED })), expected: { reason: 'response-invalid', check: 'schema' } },
    {
      name: 'a close on an unapproved option',
      outcome: returned(answered({ decision: 'close', optionId: APPROVED_ID.toUpperCase(), explanation: PLANTED })),
      expected: { reason: 'response-invalid', check: 'option-id' },
    },
    {
      name: 'a close on a record with no approved option',
      outcome: returned(answered({ decision: 'close', optionId: APPROVED_ID, explanation: PLANTED })),
      context: UNSETTLED,
      expected: { reason: 'response-invalid', check: 'option-id' },
    },
    {
      name: 'an explanation with a URL',
      outcome: returned(answered({ decision: 'close', optionId: APPROVED_ID, explanation: `${PLANTED} https://example.com` })),
      expected: { reason: 'response-invalid', check: 'url' },
    },
    {
      name: 'an explanation with a stray number',
      outcome: returned(answered({ decision: 'unknown', explanation: `${PLANTED} 424242` })),
      expected: { reason: 'response-invalid', check: 'number' },
    },
    ...(['model-call-ceiling', 'input-ceiling', 'structured-output', 'loop-limit'] as const).map((reason) => ({
      name: `failed ${reason}`,
      outcome: returned({ status: 'failed', reason, pinned: { ...PINNED_MODEL_VALUES }, promptSha256: PROMPT_SHA, usage: USAGE, modelCalls: 2 }),
      expected: { reason: 'response-invalid', check: reason },
    })),
    {
      name: 'failed deadline',
      outcome: returned({ status: 'failed', reason: 'deadline', pinned: { ...PINNED_MODEL_VALUES }, promptSha256: PROMPT_SHA, usage: USAGE, modelCalls: 1 }),
      expected: { reason: 'agent-timeout' },
    },
    {
      name: 'failed model-error',
      outcome: returned({ status: 'failed', reason: 'model-error', pinned: { ...PINNED_MODEL_VALUES }, promptSha256: PROMPT_SHA, usage: USAGE, modelCalls: 1 }),
      expected: { reason: 'agent-error' },
    },
    ...(['payload-invalid', 'hash-mismatch', 'record-too-large'] as const).map((reason) => ({
      name: `refused ${reason}`,
      outcome: returned({ status: 'refused', reason, pinned: { ...PINNED_MODEL_VALUES }, promptSha256: PROMPT_SHA, usage: NO_USAGE, modelCalls: 0 }),
      expected: { reason: 'agent-error' },
    })),
    {
      name: 'a dry-run result',
      outcome: returned({ status: 'dry-run', pinned: { ...PINNED_MODEL_VALUES }, promptSha256: PROMPT_SHA }),
      expected: { reason: 'agent-dry-run' },
    },
    { name: 'a response that is not a runtime result', outcome: returned({ status: 'answered', answer: PLANTED }), expected: { reason: 'response-invalid', check: 'runtime-result' } },
    { name: 'a plain-text response', outcome: returned(PLANTED), expected: { reason: 'response-invalid', check: 'runtime-result' } },
    { name: 'a thrown invocation', outcome: { kind: 'threw', callerAborted: false }, expected: { reason: 'agent-error' } },
    { name: "a thrown invocation after the caller's abort fired", outcome: { kind: 'threw', callerAborted: true }, expected: { reason: 'agent-timeout' } },
  ];

  for (const testCase of cases) {
    it(`maps ${testCase.name} to one named reason and holds no model text`, () => {
      const result = classifyRuntimeOutcome(testCase.outcome, { record: testCase.context ?? APPROVED, laneMapSets: LANE_MAP_SETS });
      expect(canonicalJson(result)).toBe(canonicalJson({ kind: 'unavailable', ...(testCase.expected as object) }));
      expect(JSON.stringify(result)).not.toContain('QZVX');
    });
  }
});

function rehashed(record: EvidenceRecord, edit: Partial<EvidenceRecord>): EvidenceRecord {
  const edited = { ...record, ...edit };
  return { ...edited, hash: recordHash(edited) };
}

function otherIncidentRecord(): EvidenceRecord {
  const { schemaVersion, approvedOptions, hash, ...input } = APPROVED;
  void schemaVersion;
  void approvedOptions;
  void hash;
  return buildEvidenceRecord({ ...input, incidentId: OTHER_INCIDENT });
}

const WITHOUT_BULK = parseLaneMap({ ...COMMITTED, lanes: COMMITTED.lanes.filter((lane) => lane.configurationSet !== BULK) });
const CLOSE: GateDecision = { decision: 'close', optionId: APPROVED_ID };

async function refusalOf(stored: EvidenceRecord | undefined, decision: GateDecision = CLOSE, laneMap = COMMITTED): Promise<string> {
  const result = await actionGate({ decision, incidentId: APPROVED.incidentId, loadRecord: () => Promise.resolve(stored), laneMap });
  return result.ok ? 'intent' : result.refusal;
}

describe('actionGate (D-79, R10)', () => {
  it('returns an intent naming the lane map set string for a validated close the record still proves (AC-16)', async () => {
    const result = await actionGate({ decision: CLOSE, incidentId: APPROVED.incidentId, loadRecord: () => Promise.resolve(APPROVED), laneMap: COMMITTED });
    expect(result).toEqual({ ok: true, intent: { configurationSet: BULK, incidentId: APPROVED.incidentId, optionId: APPROVED_ID } });
    const committedSet = lanesJson.lanes.find((lane) => lane.configurationSet === BULK)?.configurationSet;
    expect(result.ok && result.intent.configurationSet === committedSet).toBe(true);
  });

  it('refuses an unknown decision before loading anything (AC-P5, gate half)', async () => {
    const loadRecord = vi.fn(() => Promise.resolve<EvidenceRecord | undefined>(APPROVED));
    const result = await actionGate({ decision: { decision: 'unknown' }, incidentId: APPROVED.incidentId, loadRecord, laneMap: COMMITTED });
    expect(result).toEqual({ ok: false, refusal: 'no-close' });
    expect(loadRecord).not.toHaveBeenCalled();
  });

  it('refuses a missing record', async () => {
    expect(await refusalOf(undefined)).toBe('record-missing');
  });

  it('refuses a record that fails the schema', async () => {
    expect(await refusalOf({ ...APPROVED, hash: 'not-a-hash' })).toBe('record-invalid');
    expect(await refusalOf({ ...APPROVED, approvedOptions: [] })).toBe('record-invalid');
  });

  it("refuses another incident's record", async () => {
    expect(await refusalOf(otherIncidentRecord())).toBe('incident-mismatch');
  });

  it('refuses a record whose hash no longer recomputes', async () => {
    expect(await refusalOf({ ...APPROVED, expiresAt: APPROVED.expiresAt + 1 })).toBe('hash-mismatch');
  });

  it('refuses a tampered approved-option set even when the hash was recomputed', async () => {
    const tampered = rehashed(APPROVED, { approvedOptions: [{ optionId: optionIdFor(APPROVED.incidentId, 1) }] });
    expect(await refusalOf(tampered, { decision: 'close', optionId: optionIdFor(APPROVED.incidentId, 1) })).toBe('option-set-tampered');
  });

  it('refuses an option id that is not byte-equal to the approved one, another incident included', async () => {
    for (const optionId of [optionIdFor(OTHER_INCIDENT, 0), APPROVED_ID.toUpperCase(), ` ${APPROVED_ID}`, '']) {
      expect(await refusalOf(APPROVED, { decision: 'close', optionId })).toBe('option-not-approved');
    }
    expect(await refusalOf(APPROVED, { decision: 'close' })).toBe('option-not-approved');
    expect(await refusalOf(UNSETTLED, { decision: 'close', optionId: APPROVED_ID })).toBe('option-not-approved');
  });

  it('refuses a stored approval that decideFromEvidence does not reproduce', async () => {
    const edited = rehashed(APPROVED, { decision: { ...APPROVED.decision, otherSpikingLanes: [TRANSACTIONAL] } });
    expect(await refusalOf(edited)).toBe('decision-differs');
  });

  it('refuses a lane missing from the lane map', async () => {
    expect(await refusalOf(APPROVED, CLOSE, WITHOUT_BULK)).toBe('lane-not-in-map');
  });

  it('returns deep-equal results twice, calling only its read-only loader once each time (AC-E38)', async () => {
    const loadRecord = vi.fn((incidentId: string) => Promise.resolve<EvidenceRecord | undefined>(incidentId === APPROVED.incidentId ? APPROVED : undefined));
    const before = canonicalJson(APPROVED);
    const first = await actionGate({ decision: CLOSE, incidentId: APPROVED.incidentId, loadRecord, laneMap: COMMITTED });
    expect(loadRecord.mock.calls).toEqual([[APPROVED.incidentId]]);
    const second = await actionGate({ decision: CLOSE, incidentId: APPROVED.incidentId, loadRecord, laneMap: COMMITTED });
    expect(loadRecord.mock.calls).toEqual([[APPROVED.incidentId], [APPROVED.incidentId]]);
    expect(second).toEqual(first);
    expect(first.ok).toBe(true);
    expect(canonicalJson(APPROVED)).toBe(before);
  });

  it('returns no intent for any unavailable reason, which leaves only an unknown to store (AC-P5, AC-17 gate half)', async () => {
    const unavailable = [
      returned({ status: 'dry-run', pinned: { ...PINNED_MODEL_VALUES }, promptSha256: PROMPT_SHA }),
      returned({ status: 'failed', reason: 'deadline', pinned: { ...PINNED_MODEL_VALUES }, promptSha256: PROMPT_SHA, usage: USAGE, modelCalls: 1 }),
      returned(answered({ decision: 'close', optionId: APPROVED_ID, explanation: 'see https://example.com' })),
      { kind: 'threw', callerAborted: false } as const,
    ];
    for (const outcome of unavailable) {
      const classified = classifyRuntimeOutcome(outcome, OUTCOME_CONTEXT);
      expect(classified.kind).toBe('unavailable');
      const decision: GateDecision = classified.kind === 'validated' ? classified.answer : { decision: 'unknown' };
      expect(await refusalOf(APPROVED, decision)).toBe('no-close');
    }
  });
});

// The 02-16 mutation run's survivors in agent-answer.ts, killed below where a test can tell the
// mutant apart. Those left are equivalent, each for the reason given:
// - SCHEME_URL with "+" dropped: a run of one or more scheme characters before "://" occurs exactly
//   when one such character does, so the substring test matches the same texts.
// - allowedSpans holding a string for an unknown decision: destructuring a string gives letters, and
//   a letter compared with a number is false, so no span is allowed, as with [].
// - recordFacts' typeof checks: Number.isSafeInteger is false for every non-number, and an integer
//   token is looked up only among integers, so admitting a non-integer number changes no verdict; a
//   percent token matches only a value rendered exactly like it, which no non-percent string or
//   value in a record is; walking an array through Object.values visits the same elements.
// - a null row value or an empty name added to the removable names: neither holds a digit, and an
//   empty name only inserts spaces between two non-word characters, so no number token changes.
// - removing a name with "" instead of " ": the whole-token boundary keeps a digit from touching a
//   removed name on either side, so no two number tokens can join.
// - token.includes('.') dropped: a token with a dot is never in the integer set either.
// - PERCENT_STRING without its ^ or its $: a longer string holding a percent at its end or start
//   joins the set whole, and no number token equals a whole longer string.
// - optionId === undefined dropped in actionGate: no approved option id equals undefined.
// - the option-set length check dropped: the schema refuses an approved record without its one
//   option, and every() already refuses a longer stored set at the index past the expected one.
// The schema, regex and describe mutants above the functions are applied when the module loads,
// and the run reported them Survived after "Ran all tests" without activating them: applying the
// answered-result mutant by hand fails both this file and handler.test.ts at import. The tests
// below for the descriptions, the hash anchors, the zero-width flag, the two-digit percent and the
// digit-led name were checked the same way, each failing with its mutant applied by hand.
describe('the edges the 02-16 mutation run found unpinned', () => {
  it('sends the model each field rule as the tool spec description', () => {
    const spec = JSON.stringify(z.toJSONSchema(agentAnswerSchema));
    for (const rule of ['close only with exactly one approved option; else unknown', 'With close only: the approved option id, copied exactly', 'One plain paragraph, at most 600 characters']) {
      expect(spec).toContain(rule);
    }
  });

  it('names the optionId field and its rule in the issue for a close without an id and an unknown with one', () => {
    const issuesOf = (raw: unknown): string => {
      const parsed = agentAnswerSchema.safeParse(raw);
      return parsed.success ? 'parsed' : parsed.error.issues.map((issue) => `${issue.code}|${issue.path.join('.')}|${issue.message}`).join(';');
    };
    expect(issuesOf({ decision: 'close', explanation: 'x' })).toBe('custom|optionId|close needs the approved option id');
    expect(issuesOf({ decision: 'unknown', optionId: APPROVED_ID, explanation: 'x' })).toBe('custom|optionId|unknown carries no option id');
  });

  it('refuses a runtime result whose prompt hash has anything before or after its 64 hex characters', () => {
    expect(runtimeResultSchema.safeParse(answered({})).success).toBe(true);
    for (const promptSha256 of [`x${PROMPT_SHA}`, `${PROMPT_SHA}x`]) expect(runtimeResultSchema.safeParse({ ...answered({}), promptSha256 }).success).toBe(false);
  });

  it('removes every zero-width character before a check reads the text, not only the first', () => {
    expect(checkOf(`c${ZERO_WIDTH_SPACE}lo${WORD_JOINER}se it`, closeOn(APPROVED))).toBe('command-word');
  });

  it('refuses a longer set that ends with the allowed set name', () => {
    expect(checkOf(`pause eu-${BULK} for now`, closeOn(APPROVED, [BULK, `eu-${BULK}`]))).toBe('set-name');
  });

  it('accepts a ratio of two digits before the point exactly as the record renders it', () => {
    expect(UNSETTLED.laneTotals.hardBounceRatio).toMatch(/^\d{2}\.\d{2}%$/);
    expect(checkOf(`this lane's hard-bounce ratio is ${UNSETTLED.laneTotals.hardBounceRatio}`, unknownOn(UNSETTLED))).toBe('ok');
  });

  it('removes a name that starts with digits but is not all digits', () => {
    const record = recordFor(COMMITTED, bulkStory([{ bucketOffset: 0, count: 40, batch: '2026-import', permanentBounces: 15 }, { bucketOffset: 1, count: 160, batch: 'import-0901' }]), BULK);
    expect(checkOf('batch 2026-import carried it', closeOn(record))).toBe('ok');
  });

  it('reads the word null in an unknown explanation as plain text', () => {
    expect(checkOf('the table shows null for this lane', unknownOn(UNSETTLED))).toBe('ok');
  });

  // The batch named "example" is a whole token inside the from-domain, so removing it first would
  // leave "mail7731." behind and its digits would read as a made-up count.
  it('removes a from-domain holding digits whole, longest name first, before the number check', () => {
    const record = recordFor(
      COMMITTED,
      {
        lanes: [{ configurationSet: BULK, fromDomain: 'mail7731.example.com', groups: [{ bucketOffset: 0, count: 40, batch: CAUSE_BATCH, permanentBounces: 15 }, { bucketOffset: 1, count: 160, batch: 'example' }] }, QUIET_TRANSACTIONAL],
        identities: [{ identity: 'example.com', dkimStatus: 'SUCCESS', dkimSigningEnabled: true }],
      },
      BULK,
    );
    expect(record.configurationRows.some((row) => row.fromDomain === 'mail7731.example.com')).toBe(true);
    expect(checkOf('mail from mail7731.example.com bounced', closeOn(record))).toBe('ok');
  });

  it('leaves no check key on a reason that carries none', () => {
    expect(Object.keys(classifyRuntimeOutcome({ kind: 'threw', callerAborted: false }, OUTCOME_CONTEXT)).join(',')).toBe('kind,reason');
  });
});
