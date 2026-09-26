import { readLiveSwitch } from '@fothering/providers/live-switch';
import { buildIngestRoot, readIngestLiveConfig, type IngestDeps } from './root.js';
import { ingestEvent, type IngestResult } from './ingest.js';

// Built once per container, not per invocation: every AWS client this function ever touches comes
// from this one root (SAFE-01), and rebuilding it per event would re-read the switch on every
// call for no benefit, since none of these values change within a container's lifetime.
let deps: IngestDeps | undefined;

function ingestDeps(): IngestDeps {
  if (deps === undefined) {
    deps = buildIngestRoot({
      runtimeContext: 'deployed',
      switchValue: readLiveSwitch(),
      liveConfig: readIngestLiveConfig(),
    });
  }
  return deps;
}

// `unknown`, not an aws-lambda EventBridge type: the zod parse inside ingestEvent is the real
// contract, so this package installs no @types/aws-lambda dependency for a shape it re-validates.
export const handler = async (event: unknown): Promise<IngestResult> =>
  ingestEvent(event, ingestDeps(), { provenance: 'live' });
