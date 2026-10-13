import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import { EXPLANATION_CHECKS, validateExplanation, type ExplanationContext } from './agent-answer.js';
import { canonicalJson, type EvidenceRecord } from './evidence-record.js';
import { parseLaneMap } from './lanes.js';
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
    expect(checkOf(`mail from ${NEWS} reads fine`, closeOn(APPROVED))).toBe('ok');
  });

  it('rejects any occurrence of close or reopen, in any case or width', () => {
    const words = [
      'please reopen it',
      'Keep Closed',
      'the closure stands',
      'we disclose this',
      `CLO${ZERO_WIDTH_SPACE}SE it`,
      'ｃｌｏｓｅ it',
      `clo${SOFT_HYPHEN}se it`,
    ];
    for (const text of words) expect(checkOf(text, closeOn(APPROVED))).toBe('command-word');
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

  it('rejects the R2 phrases with any whitespace run and case', () => {
    for (const text of ['the SES  bounce\nrate is up', 'your Bounce Rate is up', 'the ses complaint\trate is up']) {
      expect(checkOf(text, closeOn(APPROVED))).toBe('phrase');
    }
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
