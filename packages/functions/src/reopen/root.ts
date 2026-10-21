import type { Logger } from '@fothering/core/log';
import { parseLaneMap, type LaneMap } from '@fothering/core/lanes';
import type { DecisionStorePort, KindTable, LiveConfig, SesPort } from '@fothering/providers/port-types';
import { resolvePortTable } from '@fothering/providers/ports';
import { sleep } from '@fothering/providers/ses-facts';
import { buildRootLogger, type RootOptions } from '../shared/root.js';
import lanesJson from '../../../../lanes.json' with { type: 'json' };

const COMMITTED_LANE_MAP: LaneMap = parseLaneMap(lanesJson);

/** The reopen reaches SES through these two operations and no other: no fact read, no pause, no send. */
export type ReopenSesPort = Pick<SesPort, 'reopenConfigurationSet' | 'getConfigurationSetSending'>;

export interface ReopenDeps {
  ports: { decisionStore: DecisionStorePort; ses: ReopenSesPort };
  kinds: KindTable;
  laneMap: LaneMap;
  log: Logger;
  now: () => number;
  wait: (ms: number) => Promise<void>;
}

export interface BuildReopenRootOptions extends RootOptions {
  laneMap?: LaneMap;
  /** Replaces the one-second SES spacing, so a test run does not sleep. */
  wait?: (ms: number) => Promise<void>;
}

const TEST_ONLY_OVERRIDES = ['laneMap', 'wait'] as const;

// The reopen role holds no secret and no queue (D-104), so the table name is all it reads.
export function readReopenLiveConfig(): LiveConfig {
  const tableName = process.env.FOTHERING_TABLE_NAME;
  return tableName !== undefined ? { tableName } : {};
}

// Named, never spread, so the pause and the send cannot ride along on a copy of the resolved port.
function reopenSes(ses: SesPort): ReopenSesPort {
  return {
    reopenConfigurationSet: (configurationSet) => ses.reopenConfigurationSet(configurationSet),
    getConfigurationSetSending: (configurationSet) => ses.getConfigurationSetSending(configurationSet),
  };
}

export function buildReopenRoot(options: BuildReopenRootOptions): ReopenDeps {
  for (const name of TEST_ONLY_OVERRIDES) {
    if (options[name] !== undefined && options.runtimeContext !== 'test') {
      throw new Error(`a ${name} override is accepted only in runtimeContext test`);
    }
  }

  const { ports, kinds } = resolvePortTable(options);

  return {
    ports: { decisionStore: ports.decisionStore, ses: reopenSes(ports.ses) },
    kinds,
    laneMap: options.laneMap ?? COMMITTED_LANE_MAP,
    log: buildRootLogger(options.runtimeContext, options.logSink),
    now: options.now ?? Date.now,
    wait: options.wait ?? sleep,
  };
}
