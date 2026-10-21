import type { Logger } from '@fothering/core/log';
import { parseLaneMap, type LaneMap } from '@fothering/core/lanes';
import type { DecisionStorePort, EventStorePort, KindTable, LiveConfig, SesPort } from '@fothering/providers/port-types';
import { resolvePortTable } from '@fothering/providers/ports';
import { sleep } from '@fothering/providers/ses-facts';
import { buildRootLogger, type RootOptions } from '../shared/root.js';
import lanesJson from '../../../../lanes.json' with { type: 'json' };

const COMMITTED_LANE_MAP: LaneMap = parseLaneMap(lanesJson);

/** The action never reopens a set: only the operator's reopen command does (AC-P4). */
export type ActionSesPort = Omit<SesPort, 'reopenConfigurationSet'>;

/** The deploy-time addresses the operator email goes from and to; either may be unset (D-107). */
export interface OperatorConfig {
  from?: string;
  to?: string;
}

export interface ActionDeps {
  ports: { decisionStore: DecisionStorePort; eventStore: EventStorePort; ses: ActionSesPort };
  kinds: KindTable;
  laneMap: LaneMap;
  log: Logger;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  operator: { from: string | undefined; to: string | undefined };
}

export interface BuildActionRootOptions extends RootOptions {
  laneMap?: LaneMap;
  /** Replaces the one-second SES spacing, so a test run does not sleep. */
  wait?: (ms: number) => Promise<void>;
  operator?: OperatorConfig;
}

// Each changes what a deployed run reads or how long it waits, so a deployed caller gets the committed
// lane map and the real spacing (D-24's rule for the lane map).
const TEST_ONLY_OVERRIDES = ['laneMap', 'wait'] as const;

// The address key is read for the dry-run send line alone, which pseudonymizes From and To (D-104).
export function readActionLiveConfig(): LiveConfig {
  const tableName = process.env.FOTHERING_TABLE_NAME;
  const addressKeySecretId = process.env.FOTHERING_ADDRESS_KEY_SECRET_ID;
  return {
    ...(tableName !== undefined ? { tableName } : {}),
    ...(addressKeySecretId !== undefined ? { addressKeySecretId } : {}),
  };
}

export function readActionOperatorConfig(): OperatorConfig {
  const from = process.env.FOTHERING_FROM_ADDRESS;
  const to = process.env.FOTHERING_OPERATOR_ADDRESS;
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

// Each operation is named, never spread from the resolved port, so the reopen operation cannot ride
// along on a copy and a new SES operation reaches the action only by being listed here.
function actionSes(ses: SesPort): ActionSesPort {
  return {
    getEmailIdentity: (identity) => ses.getEmailIdentity(identity),
    listEmailIdentities: () => ses.listEmailIdentities(),
    listConfigurationSets: () => ses.listConfigurationSets(),
    getConfigurationSetEventDestinations: (configurationSet) => ses.getConfigurationSetEventDestinations(configurationSet),
    getConfigurationSetSending: (configurationSet) => ses.getConfigurationSetSending(configurationSet),
    pauseConfigurationSet: (configurationSet) => ses.pauseConfigurationSet(configurationSet),
    sendEmail: (request) => ses.sendEmail(request),
  };
}

export function buildActionRoot(options: BuildActionRootOptions): ActionDeps {
  for (const name of TEST_ONLY_OVERRIDES) {
    if (options[name] !== undefined && options.runtimeContext !== 'test') {
      throw new Error(`a ${name} override is accepted only in runtimeContext test`);
    }
  }

  const { ports, kinds } = resolvePortTable(options);

  return {
    ports: { decisionStore: ports.decisionStore, eventStore: ports.eventStore, ses: actionSes(ports.ses) },
    kinds,
    laneMap: options.laneMap ?? COMMITTED_LANE_MAP,
    log: buildRootLogger(options.runtimeContext, options.logSink),
    now: options.now ?? Date.now,
    wait: options.wait ?? sleep,
    operator: { from: options.operator?.from, to: options.operator?.to },
  };
}
