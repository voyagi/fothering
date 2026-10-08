import type { Logger } from '@fothering/core/log';
import type { KindTable, LiveConfig } from '@fothering/providers/port-types';
import { resolvePortTable, type ResolvedPorts } from '@fothering/providers/ports';
import { buildRootLogger, type RootOptions } from '../shared/root.js';

export interface ForgetDeps {
  ports: ResolvedPorts;
  kinds: KindTable;
  log: Logger;
}

export type BuildForgetRootOptions = RootOptions;

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
  const { ports, kinds } = resolvePortTable(options);

  return {
    ports,
    kinds,
    log: buildRootLogger(options.runtimeContext, options.logSink),
  };
}
