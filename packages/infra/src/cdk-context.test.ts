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

  // CDK reads the live switch key from every context source, files included, and a key left in a
  // file switches every later deploy on. The committed file must never carry it, so going live
  // stays one -c flag on one deploy command.
  it('never carries the live switch key', () => {
    expect(Object.keys(cdkJsonContext)).not.toContain('fothering:live');
  });
});
