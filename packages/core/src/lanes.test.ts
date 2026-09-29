import { describe, expect, it } from 'vitest';
import { laneMapSchema, parseLaneMap } from './lanes.js';
import lanesJson from '../../../lanes.json' with { type: 'json' };

function baseLane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configurationSet: 'fothering-transactional',
    lane: 'fothering-transactional',
    criticality: 'transactional',
    declaredStreams: ['receipts'],
    streamTagKey: 'stream',
    batchTagKey: 'batch',
    templateTagKey: 'template',
    campaignTagKey: 'campaign',
    operatorAlert: false,
    ...overrides,
  };
}

function baseMap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runIdTagKey: 'fothering_run',
    lanes: [baseLane()],
    ...overrides,
  };
}

function issuePaths(map: unknown): unknown[][] {
  const result = laneMapSchema.safeParse(map);
  if (result.success) throw new Error('expected parsing to fail');
  return result.error.issues.map((issue) => issue.path);
}

describe('laneMapSchema (AC-E32)', () => {
  it('parses the committed lanes.json unchanged', () => {
    expect(() => parseLaneMap(lanesJson)).not.toThrow();
  });

  it('rejects an empty lane map', () => {
    const paths = issuePaths(baseMap({ lanes: [] }));
    expect(paths).toContainEqual(['lanes']);
  });

  it('rejects a lane with zero declared streams', () => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ declaredStreams: [] })] }));
    expect(paths).toContainEqual(['lanes', 0, 'declaredStreams']);
  });

  it.each(['streamTagKey', 'batchTagKey', 'templateTagKey', 'campaignTagKey'])(
    'rejects a lane whose %s is empty',
    (field) => {
      const paths = issuePaths(baseMap({ lanes: [baseLane({ [field]: '' })] }));
      expect(paths).toContainEqual(['lanes', 0, field]);
    },
  );

  it.each(['lane', 'tenant'])('rejects a lane whose %s is empty', (field) => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ [field]: '' })] }));
    expect(paths).toContainEqual(['lanes', 0, field]);
  });

  it('rejects a declared stream that is empty', () => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ declaredStreams: [''] })] }));
    expect(paths).toContainEqual(['lanes', 0, 'declaredStreams', 0]);
  });

  it('rejects a declared stream that fails the tag-value pattern', () => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ declaredStreams: ['bad value!'] })] }));
    expect(paths).toContainEqual(['lanes', 0, 'declaredStreams', 0]);
  });

  // The closeability check reads a stream tag of unclassified as no stream at all, so a lane that
  // declared it could never close; the map refuses it where the operator can see why.
  it('rejects unclassified as a declared stream and names the reserved word', () => {
    const result = laneMapSchema.safeParse(baseMap({ lanes: [baseLane({ declaredStreams: ['receipts', 'unclassified'] })] }));
    if (result.success) throw new Error('expected parsing to fail');
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['lanes', 0, 'declaredStreams', 1]);
    expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain('unclassified');
  });

  it('rejects a repeated declared stream', () => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ declaredStreams: ['receipts', 'receipts'] })] }));
    expect(paths).toContainEqual(['lanes', 0, 'declaredStreams', 1]);
  });

  it('rejects a lane whose streamTagKey equals its campaignTagKey', () => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ campaignTagKey: 'stream' })] }));
    expect(paths).toContainEqual(['lanes', 0, 'campaignTagKey']);
  });

  it('rejects a lane whose streamTagKey equals the map runIdTagKey', () => {
    const paths = issuePaths(baseMap({ runIdTagKey: 'stream' }));
    expect(paths).toContainEqual(['runIdTagKey']);
  });

  // The runIdTagKey issue sits on the map, not on a lane, so its message is the only place that
  // can say which lane collides; without it a map of several lanes repeats one sentence per lane.
  it('names the lane and its field when a lane tag key equals the map runIdTagKey', () => {
    const result = laneMapSchema.safeParse(
      baseMap({ runIdTagKey: 'stream', lanes: [baseLane(), baseLane({ configurationSet: 'fothering-bulk', lane: 'fothering-bulk' })] }),
    );
    if (result.success) throw new Error('expected parsing to fail');
    const messages = result.error.issues.filter((issue) => issue.path[0] === 'runIdTagKey').map((issue) => issue.message);
    expect(messages).toEqual([
      'lanes[0].streamTagKey and runIdTagKey must be distinct',
      'lanes[1].streamTagKey and runIdTagKey must be distinct',
    ]);
  });

  it('reports a runIdTagKey collision once, for the one lane that collides', () => {
    const result = laneMapSchema.safeParse(
      baseMap({
        runIdTagKey: 'fothering_run',
        lanes: [
          baseLane(),
          baseLane({ configurationSet: 'fothering-bulk', lane: 'fothering-bulk', batchTagKey: 'fothering_run' }),
          baseLane({ configurationSet: 'fothering-other', lane: 'fothering-other' }),
        ],
      }),
    );
    if (result.success) throw new Error('expected parsing to fail');
    expect(result.error.issues.map((issue) => issue.message)).toEqual(['lanes[1].batchTagKey and runIdTagKey must be distinct']);
  });

  it('rejects a tag key starting with ses:', () => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ streamTagKey: 'ses:configuration-set' })] }));
    expect(paths).toContainEqual(['lanes', 0, 'streamTagKey']);
  });
});

// The SES MessageTag rule for a tag name: ASCII letters, digits, underscores or dashes only, at most
// 256 characters. A declared key outside it can never match a tag SES publishes, so the field it
// names would silently never be stored.
describe('laneMapSchema tag key naming (the SES message tag name rule)', () => {
  const LANE_TAG_KEYS = ['streamTagKey', 'batchTagKey', 'templateTagKey', 'campaignTagKey'];
  const UNSENDABLE_NAMES: readonly (readonly [string, string])[] = [
    ['a name holding a space', 'batch id'],
    ['a name holding a dot', 'batch.id'],
    ['a 257-character name', 'x'.repeat(257)],
  ];

  it.each(LANE_TAG_KEYS.flatMap((field) => UNSENDABLE_NAMES.map(([label, value]) => [field, label, value] as const)))(
    'rejects a lane whose %s is %s',
    (field, _label, value) => {
      const paths = issuePaths(baseMap({ lanes: [baseLane({ [field]: value })] }));
      expect(paths).toContainEqual(['lanes', 0, field]);
    },
  );

  const RUN_ID_CASES: readonly (readonly [string, string])[] = [['an empty name', ''], ...UNSENDABLE_NAMES];

  it.each(RUN_ID_CASES)('rejects a runIdTagKey that is %s', (_label, value) => {
    const paths = issuePaths(baseMap({ runIdTagKey: value }));
    expect(paths).toContainEqual(['runIdTagKey']);
  });

  it('accepts tag keys of exactly 256 characters', () => {
    const result = laneMapSchema.safeParse(
      baseMap({ runIdTagKey: 'r'.repeat(256), lanes: [baseLane({ streamTagKey: 's'.repeat(256) })] }),
    );
    expect(result.success).toBe(true);
  });
});

describe('laneMapSchema configuration set naming and duplicates (AC-E33, AC-E34)', () => {
  it('accepts a configuration set matching the AWS naming rule', () => {
    const result = laneMapSchema.safeParse(baseMap({ lanes: [baseLane({ configurationSet: 'ConfigSet', lane: 'doc-examples' })] }));
    expect(result.success).toBe(true);
  });

  it('rejects a configuration set containing a dot', () => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ configurationSet: 'fothering.transactional' })] }));
    expect(paths).toContainEqual(['lanes', 0, 'configurationSet']);
  });

  it('rejects a configuration set containing a space', () => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ configurationSet: 'fothering transactional' })] }));
    expect(paths).toContainEqual(['lanes', 0, 'configurationSet']);
  });

  it('rejects a configuration set of 65 characters', () => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ configurationSet: 'a'.repeat(65) })] }));
    expect(paths).toContainEqual(['lanes', 0, 'configurationSet']);
  });

  it('rejects two entries differing only by case, naming the index of the second entry', () => {
    const paths = issuePaths(
      baseMap({
        lanes: [
          baseLane({ configurationSet: 'bulk', lane: 'bulk' }),
          baseLane({ configurationSet: 'Bulk', lane: 'bulk-2' }),
        ],
      }),
    );
    expect(paths).toContainEqual(['lanes', 1, 'configurationSet']);
  });

  it('rejects the same configurationSet twice', () => {
    const paths = issuePaths(
      baseMap({
        lanes: [
          baseLane({ configurationSet: 'fothering-transactional', lane: 'a' }),
          baseLane({ configurationSet: 'fothering-transactional', lane: 'b' }),
        ],
      }),
    );
    expect(paths).toContainEqual(['lanes', 1, 'configurationSet']);
  });
});
