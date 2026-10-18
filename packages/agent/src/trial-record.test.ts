import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { evidenceRecordSchema, recordHash } from '@fothering/core/evidence-record';
import { fixtureEvidenceRecord } from '@fothering/core/test/decision-cycle';

const TRIAL_RECORD = new URL('../fixtures/trial-record.json', import.meta.url);

// The README's runtime trial sends this file. CI never writes a snapshot, so a record format change
// that is not committed here fails there instead of leaving the trial on a stale record (D-119).
describe('the committed trial record the README names (D-119)', () => {
  it('equals the shared builder output byte for byte', async () => {
    await expect(`${JSON.stringify(fixtureEvidenceRecord(), null, 2)}\n`).toMatchFileSnapshot('../fixtures/trial-record.json');
  });

  it('is an honest record with one approved option for fothering-bulk and no address', async () => {
    const text = await readFile(TRIAL_RECORD, 'utf8');
    const record = evidenceRecordSchema.parse(JSON.parse(text) as unknown);
    expect(recordHash(record)).toBe(record.hash);
    expect(record.lane.configurationSet).toBe('fothering-bulk');
    expect(record.approvedOptions).toHaveLength(1);
    expect(text).not.toContain('@');
  });
});
