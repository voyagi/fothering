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

  it('rejects a declared stream that is empty', () => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ declaredStreams: [''] })] }));
    expect(paths).toContainEqual(['lanes', 0, 'declaredStreams', 0]);
  });

  it('rejects a declared stream that fails the tag-value pattern', () => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ declaredStreams: ['bad value!'] })] }));
    expect(paths).toContainEqual(['lanes', 0, 'declaredStreams', 0]);
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

  it('rejects a tag key starting with ses:', () => {
    const paths = issuePaths(baseMap({ lanes: [baseLane({ streamTagKey: 'ses:configuration-set' })] }));
    expect(paths).toContainEqual(['lanes', 0, 'streamTagKey']);
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
