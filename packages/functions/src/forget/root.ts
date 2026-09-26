import type { Logger, LogSink } from '@fothering/core/log';
import type {
  DryRunSink,
  FixtureOptions,
  KindTable,
  LiveClients,
  LiveConfig,
  RuntimeContext,
} from '@fothering/providers/port-types';
import type { ResolvedPorts } from '@fothering/providers/ports';
import { buildRootLogger, resolveRootPorts } from '../shared/root.js';

export interface ForgetDeps {
  ports: ResolvedPorts;
  kinds: KindTable;
  log: Logger;
  now: () => number;
}

export interface BuildForgetRootOptions {
  runtimeContext: RuntimeContext;
  switchValue: string | undefined;
  liveConfig?: LiveConfig;
  liveClients?: LiveClients;
  fixtures?: FixtureOptions;
  logSink?: LogSink;
  dryRunSink?: DryRunSink;
  now?: () => number;
}

// The forget function reads only the table name and the address-key secret id; it never touches
// the dead-letter queue, so readIngestLiveConfig's third variable has no analog here.
export function readForgetLiveConfig(): LiveConfig {
  const tableName = process.env.FOTHERING_TABLE_NAME;
  const addressKeySecretId = process.env.FOTHERING_ADDRESS_KEY_SECRET_ID;
  return {
    ...(tableName !== undefined ? { tableName } : {}),
    ...(addressKeySecretId !== undefined ? { addressKeySecretId } : {}),
  };
}

export function buildForgetRoot(options: BuildForgetRootOptions): ForgetDeps {
  const { ports, kinds } = resolveRootPorts(options);

  return {
    ports,
    kinds,
    log: buildRootLogger(options.runtimeContext, options.logSink),
    now: options.now ?? Date.now,
  };
}
