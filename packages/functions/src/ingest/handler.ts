import { readLiveSwitch } from '@fothering/providers/live-switch';
import { memoPerContainer } from '../shared/container-memo.js';
import { buildIngestRoot, readIngestLiveConfig } from './root.js';
import { ingestEvent, type IngestResult } from './ingest.js';

const ingestDeps = memoPerContainer(() =>
  buildIngestRoot({
    runtimeContext: 'deployed',
    switchValue: readLiveSwitch(),
    liveConfig: readIngestLiveConfig(),
  }),
);

// `unknown`, not an aws-lambda EventBridge type: the zod parse inside ingestEvent is the real
// contract, so this package installs no @types/aws-lambda dependency for a shape it re-validates.
export const handler = async (event: unknown): Promise<IngestResult> =>
  ingestEvent(event, ingestDeps(), { provenance: 'live' });
