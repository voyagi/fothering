import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMAIL_SEND_ATTEMPTS } from '@fothering/core/close-values';
import { parseClosure } from '@fothering/core/closure';
import { evidenceRecordSchema, recordHash, type EvidenceRecord } from '@fothering/core/evidence-record';
import { configurationVerdict, kindRowVerdict } from '@fothering/core/evidence-rows';
import { readSavedItems } from '@fothering/providers/saved-items';

const ARTIFACT = fileURLToPath(new URL('../../../../examples/live-run-1-email-failed/items-incident.json', import.meta.url));
const ITEMS = readSavedItems(readFileSync(ARTIFACT, 'utf8'));

function itemOf(sk: string): Record<string, unknown> {
  const item = ITEMS.find((candidate) => candidate.sk === sk);
  if (item === undefined) throw new Error(`the artifact holds no ${sk} item`);
  return item;
}

function recordOf(): EvidenceRecord {
  return evidenceRecordSchema.parse(itemOf('EVIDENCE').record);
}

function rowName(row: EvidenceRecord['rows'][number]): string {
  return `${row.dimension}:${row.value ?? '(no value)'}`;
}

function namesWith(record: EvidenceRecord, verdict: string): string[] {
  return [
    ...record.rows.filter((row) => row.verdict === verdict).map(rowName),
    ...record.configurationRows.filter((row) => row.verdict === verdict).map((row) => row.record),
  ];
}

describe('live run 1, the failed operator email (examples/live-run-1-email-failed)', () => {
  it('reads with the closure schema the action writes, and records the email as failed after every attempt', () => {
    const closure = parseClosure(itemOf('CLOSURE'));
    expect(closure).toEqual(expect.objectContaining({ configurationSet: 'fothering-bulk', outcome: 'closed', readBack: false, sendsAfterHold: 0 }));
    expect(closure?.email).toEqual(expect.objectContaining({ kind: 'closed', attempts: EMAIL_SEND_ATTEMPTS, failed: true, messageId: null, sentAtMs: null }));
  });

  it('is unedited: the evidence record parses and its stored hash is the hash of its own content', () => {
    const record = recordOf();
    expect(recordHash(record)).toBe(record.hash);
  });

  it('would show an edit: one verdict changed in a copy no longer matches the stored hash', () => {
    const record = recordOf();
    const edited = { ...record, rows: record.rows.map((row, index) => (index === 0 ? { ...row, verdict: 'cause' as const } : row)) };
    expect(recordHash(edited)).not.toBe(record.hash);
  });

  it('holds the verdicts the code derives from its own counts, the ruled-out set included', () => {
    const record = recordOf();
    for (const row of record.rows) expect(kindRowVerdict(row.kind, row, record.laneTotals, record.laneTotals.triggers), rowName(row)).toBe(row.verdict);
    for (const row of record.configurationRows) expect(configurationVerdict(row.state, row.corroboration), row.record).toBe(row.verdict);
    expect(namesWith(record, 'cause')).toEqual(['batch:stale-import']);
    expect(namesWith(record, 'ruled-out')).toEqual(['batch:clean-import', 'dkim', 'dmarc']);
    expect(namesWith(record, 'elevated')).toEqual(['template:(no value)', 'campaign:(no value)']);
    expect(namesWith(record, 'not-applicable')).toEqual(['mail-from', 'spf']);
  });
});
