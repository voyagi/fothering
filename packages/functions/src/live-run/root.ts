import { execFileSync } from 'node:child_process';
import { parseLaneMap, type LaneMap } from '@fothering/core/lanes';
import { LIVE_SWITCH, resolveProviderMode } from '@fothering/core/mode';
import { parseScenarioSource, type ScenarioSource } from '@fothering/core/scenarios';
import type { LiveRunPortFactory } from '@fothering/providers/live-run-port-types';
import {
  createFixtureLiveRunPorts,
  createFixtureLiveRunState,
  type FixtureLiveRunState,
} from '@fothering/providers/fixtures/live-run-ports';
import { sleep } from '@fothering/providers/ses-facts';
import type { RootOptions } from '../shared/root.js';
import lanesJson from '../../../../lanes.json' with { type: 'json' };
import scenariosJson from '../../../../docs/measurement-scenarios.json' with { type: 'json' };

const COMMITTED_LANE_MAP: LaneMap = parseLaneMap(lanesJson);
const COMMITTED_SCENARIOS: ScenarioSource = parseScenarioSource(scenariosJson);

export interface LiveRunIo {
  out(line: string): void;
  err(line: string): void;
}

export interface LiveRunDeps {
  switchValue: string | undefined;
  /** Called only once every local check has passed, so a refusal builds no port. */
  portFactory: () => LiveRunPortFactory;
  scenarios: ScenarioSource;
  laneMap: LaneMap;
  monotonicMs: () => number;
  nowUtc: () => number;
  sleep: (ms: number) => Promise<void>;
  repoRoot: string;
  /** Throws unless git reads the path as ignored. */
  gitCheckIgnore: (path: string) => void;
  io: LiveRunIo;
}

export interface BuildLiveRunRootOptions extends Pick<RootOptions, 'runtimeContext' | 'switchValue'> {
  repoRoot: string;
  io?: LiveRunIo;
  liveRunFixtures?: FixtureLiveRunState;
  liveFactory?: () => LiveRunPortFactory;
  scenarios?: ScenarioSource;
  laneMap?: LaneMap;
  monotonicMs?: () => number;
  nowUtc?: () => number;
  sleep?: (ms: number) => Promise<void>;
  gitCheckIgnore?: (path: string) => void;
}

const TEST_ONLY_OVERRIDES = ['scenarios', 'laneMap', 'monotonicMs', 'nowUtc', 'sleep', 'gitCheckIgnore'] as const;

const PROCESS_IO: LiveRunIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

// The fixture factory is a test seam, and the live one is built only while the switch reads live,
// so a deployed root with the switch off has nothing that could sign a request.
function portFactoryFor(options: BuildLiveRunRootOptions): () => LiveRunPortFactory {
  if (options.runtimeContext === 'test') {
    const state = options.liveRunFixtures ?? createFixtureLiveRunState();
    return () => createFixtureLiveRunPorts(state);
  }
  const { liveFactory, switchValue } = options;
  return () => {
    if (resolveProviderMode(switchValue) !== 'live') throw new Error(`the live port factory is built only while ${LIVE_SWITCH} reads live`);
    if (liveFactory === undefined) throw new Error('no live port factory was given to a deployed live-run root');
    return liveFactory();
  };
}

// An argument array and no shell, so a path can never be read as a command.
function gitCheckIgnoreIn(repoRoot: string): (path: string) => void {
  return (path) => {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: repoRoot, stdio: 'ignore', windowsHide: true });
  };
}

export function buildLiveRunRoot(options: BuildLiveRunRootOptions): LiveRunDeps {
  for (const name of TEST_ONLY_OVERRIDES) {
    if (options[name] !== undefined && options.runtimeContext !== 'test') {
      throw new Error(`a ${name} override is accepted only in runtimeContext test`);
    }
  }

  return {
    switchValue: options.switchValue,
    portFactory: portFactoryFor(options),
    scenarios: options.scenarios ?? COMMITTED_SCENARIOS,
    laneMap: options.laneMap ?? COMMITTED_LANE_MAP,
    monotonicMs: options.monotonicMs ?? (() => performance.now()),
    nowUtc: options.nowUtc ?? Date.now,
    sleep: options.sleep ?? sleep,
    repoRoot: options.repoRoot,
    gitCheckIgnore: options.gitCheckIgnore ?? gitCheckIgnoreIn(options.repoRoot),
    io: options.io ?? PROCESS_IO,
  };
}
