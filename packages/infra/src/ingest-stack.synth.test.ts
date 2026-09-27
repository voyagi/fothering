import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { parseLaneMap } from '@fothering/core/lanes';
import { PARTITION_KEY, SORT_KEY, TTL_ATTRIBUTE } from '@fothering/core/records';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import { IngestStack } from './ingest-stack.js';

const SES_DETAIL_TYPES = [
  'Email Sent',
  'Email Delivered',
  'Email Bounced',
  'Email Complaint Received',
  'Email Rejected',
  'Email Delivery Delayed',
];

// A synthesized asset needs a real directory to hash; esbuild never runs here (D-19), so this is a
// one-file stand-in for the real bundle scripts/build.mjs produces.
function stubAssetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fothering-ingest-asset-'));
  writeFileSync(join(dir, 'index.js'), 'exports.handler = async () => ({});\n');
  return dir;
}

describe('IngestStack synth', () => {
  let assetDir: string;
  afterEach(() => {
    if (assetDir) rmSync(assetDir, { recursive: true, force: true });
  });

  // A synth loads aws-cdk-lib whole and hashes an asset: 3.3 s alone, and 6.3 s once under a full
  // parallel suite, past vitest's 5 s default. The limit is explicit so load cannot fail it.
  it('synthesizes one rule, one function and one table matching the committed lane map', { timeout: 30_000 }, () => {
    assetDir = stubAssetDir();
    const laneMap = parseLaneMap(lanesJson);
    const app = new App();
    const stack = new IngestStack(app, 'FotheringIngestTest', {
      env: { region: 'eu-central-1' },
      laneMap,
      ingestAssetDir: assetDir,
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Events::Rule', 1);
    const rules = template.findResources('AWS::Events::Rule');
    const [rule] = Object.values(rules) as Array<{ Properties: Record<string, unknown> }>;
    if (rule === undefined) throw new Error('template synthesized no AWS::Events::Rule');
    const pattern = rule.Properties.EventPattern as Record<string, unknown>;
    expect(pattern.source).toEqual(['aws.ses']);
    expect(pattern['detail-type']).toEqual(SES_DETAIL_TYPES);
    const detail = pattern.detail as { mail: { tags: Record<string, string[]> } };
    expect(detail.mail.tags['ses:configuration-set']).toEqual(
      laneMap.lanes.map((lane) => lane.configurationSet),
    );
    const targets = rule.Properties.Targets as Array<Record<string, unknown>>;
    expect(targets).toHaveLength(1);
    expect(targets[0]?.DeadLetterConfig).toBeUndefined();

    // Explicit, never CDK's 3 s and 128 MB defaults: a timeout stops the handler before its own
    // dead-letter path runs, so a Send with many destinations must not run out of time.
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Timeout: 30,
      MemorySize: 512,
    });

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: PARTITION_KEY, KeyType: 'HASH' },
        { AttributeName: SORT_KEY, KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
    });
  });
});
