import type { Provenance } from '@fothering/core/records';
import type { IngestDeps } from './root.js';

export interface IngestResult {
  outcome: 'stored' | 'dropped' | 'dead-lettered';
  stored: number;
  duplicates: number;
}

export interface IngestOptions {
  provenance: Provenance;
}

// RED stub (#3770 TDD): every path drops so the tracer's stored-count assertion is what fails,
// not an import or a type error.
export async function ingestEvent(_rawEvent: unknown, _deps: IngestDeps, _options: IngestOptions): Promise<IngestResult> {
  return { outcome: 'dropped', stored: 0, duplicates: 0 };
}
