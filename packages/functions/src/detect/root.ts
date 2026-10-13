import type { Logger } from '@fothering/core/log';
import { parseLaneMap, type LaneMap } from '@fothering/core/lanes';
import type { KindTable, LiveConfig } from '@fothering/providers/port-types';
import { resolvePortTable, type ResolvedPorts } from '@fothering/providers/ports';
import { sleep } from '@fothering/providers/ses-facts';
import { buildRootLogger, type RootOptions } from '../shared/root.js';
import lanesJson from '../../../../lanes.json' with { type: 'json' };

const COMMITTED_LANE_MAP: LaneMap = parseLaneMap(lanesJson);

export interface DetectDeps {
  ports: ResolvedPorts;
  kinds: KindTable;
  laneMap: LaneMap;
  log: Logger;
  now: () => number;
  /** Undefined when the deployment left FOTHERING_AGENT_RUNTIME_ARN unset; the cycle then reserves nothing. */
  agentRuntimeArn: string | undefined;
  wait: (ms: number) => Promise<void>;
  agentTimeoutSignal: (ms: number) => AbortSignal;
}

export interface BuildDetectRootOptions extends RootOptions {
  laneMap?: LaneMap;
  /** Replaces the one-second SES read spacing, so a test cycle does not sleep. */
  wait?: (ms: number) => Promise<void>;
  /** Replaces the invocation deadline, so a test can abort an invocation at once. */
  agentTimeoutSignal?: (ms: number) => AbortSignal;
}

// Each of these changes what a deployed cycle reads or how long it waits, so a deployed caller gets
// the committed lane map, the real spacing and the real deadline (D-24's rule for the lane map).
const TEST_ONLY_OVERRIDES = ['laneMap', 'wait', 'agentTimeoutSignal'] as const;

export function readDetectLiveConfig(): LiveConfig {
  const tableName = process.env.FOTHERING_TABLE_NAME;
  const agentRuntimeArn = process.env.FOTHERING_AGENT_RUNTIME_ARN;
  return {
    ...(tableName !== undefined ? { tableName } : {}),
    ...(agentRuntimeArn !== undefined ? { agentRuntimeArn } : {}),
  };
}

export function buildDetectRoot(options: BuildDetectRootOptions): DetectDeps {
  for (const name of TEST_ONLY_OVERRIDES) {
    if (options[name] !== undefined && options.runtimeContext !== 'test') {
      throw new Error(`a ${name} override is accepted only in runtimeContext test`);
    }
  }

  const { ports, kinds } = resolvePortTable(options);

  return {
    ports,
    kinds,
    laneMap: options.laneMap ?? COMMITTED_LANE_MAP,
    log: buildRootLogger(options.runtimeContext, options.logSink),
    now: options.now ?? Date.now,
    agentRuntimeArn: options.liveConfig?.agentRuntimeArn,
    wait: options.wait ?? sleep,
    agentTimeoutSignal: options.agentTimeoutSignal ?? ((ms) => AbortSignal.timeout(ms)),
  };
}
