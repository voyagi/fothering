import { resolvePortTable, type ResolvedPorts } from '@fothering/providers/ports';
import { createLogger, type Logger, type LogSink } from '@fothering/core/log';
import type {
  DryRunSink,
  FixtureOptions,
  KindTable,
  LiveClients,
  LiveConfig,
  RuntimeContext,
} from '@fothering/providers/port-types';

export interface ResolveRootPortsOptions {
  runtimeContext: RuntimeContext;
  switchValue: string | undefined;
  liveConfig?: LiveConfig;
  liveClients?: LiveClients;
  fixtures?: FixtureOptions;
  dryRunSink?: DryRunSink;
  now?: () => number;
}

// Every composition root in this package resolves its ports the same seven-field way; written
// once here so a second root never copies the conditional-spread block, which would trip
// gate:dup (threshold 0) against the first root that already needs it.
export function resolveRootPorts(options: ResolveRootPortsOptions): { ports: ResolvedPorts; kinds: KindTable } {
  return resolvePortTable({
    runtimeContext: options.runtimeContext,
    switchValue: options.switchValue,
    ...(options.liveConfig !== undefined ? { liveConfig: options.liveConfig } : {}),
    ...(options.liveClients !== undefined ? { liveClients: options.liveClients } : {}),
    ...(options.fixtures !== undefined ? { fixtures: options.fixtures } : {}),
    ...(options.dryRunSink !== undefined ? { dryRunSink: options.dryRunSink } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

// A deployed root writes JSON lines to stdout; a test root writes nowhere, since a test wanting to
// inspect log lines already overrides `log` on its own copy of the deps object it gets back.
function defaultRootLogSink(runtimeContext: RuntimeContext): LogSink {
  return runtimeContext === 'deployed'
    ? (line) => {
        process.stdout.write(`${line}\n`);
      }
    : () => {};
}

export function buildRootLogger(runtimeContext: RuntimeContext, override: LogSink | undefined): Logger {
  return createLogger(override ?? defaultRootLogSink(runtimeContext));
}
