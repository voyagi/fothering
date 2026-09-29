import { describe, expect, it } from 'vitest';
import { cdkJsonContext } from './cdk-context.js';

// CDK's recommended value for the metadata flag is true, which widens the usage data CDK collects to
// construct property keys, bool and enum values and method calls. This repo keeps CLI telemetry off
// and that collection at its narrower default, so a later sweep to the recommended values fails here.
describe('cdk.json context', () => {
  it('keeps CLI telemetry off and the expanded construct usage collection off', () => {
    expect(cdkJsonContext['cli-telemetry']).toBe(false);
    expect(cdkJsonContext['@aws-cdk/core:enableAdditionalMetadataCollection']).toBe(false);
  });
});
