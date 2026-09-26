import { createLogger, type LogSink, type Logger } from '@fothering/core/log';
import { parseLaneMap, type LaneMap } from '@fothering/core/lanes';
import { resolvePortTable } from '@fothering/providers/ports';
import type {
  DryRunSink,
  FixtureOptions,
  KindTable,
  LiveClients,
  LiveConfig,
  RuntimeContext,
} from '@fothering/providers/port-types';
import type { ResolvedPorts } from '@fothering/providers/ports';
import lanesJson from '../../../../lanes.json' with { type: 'json' };

// The committed demo lane map (D-24, D-38): esbuild bundles this file into the ingest function in
// plan 01-11, and CDK reads the same file at synth time for the rule's configuration-set filter.
const COMMITTED_LANE_MAP: LaneMap = parseLaneMap(lanesJson);

export interface IngestDeps {
  ports: ResolvedPorts;
  kinds: KindTable;
  laneMap: LaneMap;
  log: Logger;
  now: () => number;
}

export interface BuildIngestRootOptions {
  runtimeContext: RuntimeContext;
  switchValue: string | undefined;
  /** Accepted only in runtimeContext 'test' (D-24); a 'deployed' caller must use the committed lane map. */
  laneMap?: LaneMap;
  liveConfig?: LiveConfig;
  liveClients?: LiveClients;
  fixtures?: FixtureOptions;
  logSink?: LogSink;
  dryRunSink?: DryRunSink;
  now?: () => number;
}

// The three deployed table names, read as literals beside the switch (D-04's literal-read rule
// covers every env var the deployed handler needs, not only the switch). A key whose variable is
// unset is left out of the returned object entirely: exactOptionalPropertyTypes forbids assigning
// `undefined` to an optional field, so a conditional spread per key is the only legal shape here.
export function readIngestLiveConfig(): LiveConfig {
  return {};
}

// The one place per deployable that turns a runtime context and a switch value into a resolved
// port table, a lane map and a logger: every AWS client the ingest function ever touches comes
// from the `ports` this returns, never from a fresh import inside ingestEvent (SAFE-01).
export function buildIngestRoot(options: BuildIngestRootOptions): IngestDeps {
  if (options.laneMap !== undefined && options.runtimeContext !== 'test') {
    throw new Error('a lane map override is accepted only in runtimeContext test');
  }

  // exactOptionalPropertyTypes forbids assigning `undefined` to an optional field, so an unset
  // override is left out of the call entirely rather than passed through as `undefined`.
  const { ports, kinds } = resolvePortTable({
    runtimeContext: options.runtimeContext,
    switchValue: options.switchValue,
    ...(options.liveConfig !== undefined ? { liveConfig: options.liveConfig } : {}),
    ...(options.liveClients !== undefined ? { liveClients: options.liveClients } : {}),
    ...(options.fixtures !== undefined ? { fixtures: options.fixtures } : {}),
    ...(options.dryRunSink !== undefined ? { dryRunSink: options.dryRunSink } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const defaultSink: LogSink =
    options.runtimeContext === 'deployed'
      ? (line) => {
          process.stdout.write(`${line}\n`);
        }
      : () => {};

  return {
    ports,
    kinds,
    laneMap: options.laneMap ?? COMMITTED_LANE_MAP,
    log: createLogger(options.logSink ?? defaultSink),
    now: options.now ?? Date.now,
  };
}
