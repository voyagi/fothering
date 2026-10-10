import { readFileSync } from 'node:fs';
import type { EventRecord } from '@fothering/core/records';

// The mailbox simulator addresses one run sent to, one message per scenario per lane.
export const SIMULATOR_SCENARIOS = ['success', 'bounce', 'complaint', 'ooto', 'suppressionlist'] as const;

interface SimulatorMessage {
  messageId: string;
  configurationSet: string;
  scenario: (typeof SIMULATOR_SCENARIOS)[number];
}

interface StoredRecordFixture {
  provenance: string;
  source: string;
  replaced: string[];
  messages: SimulatorMessage[];
  records: EventRecord[];
}

// Records the deployed ingest stored for real simulator sends, kept as the table held them: no raw
// event was archived, so these sit beside the doc-derived events rather than replacing them as
// parser input. Read fresh on every call, so a test that changes one cannot change the next test's.
export function loadSimulatorRecordFixture(): StoredRecordFixture {
  const url = new URL('./simulator-sends.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as StoredRecordFixture;
}
