import type { LaneMap } from '@fothering/core/lanes';
import type { ScenarioSource } from '@fothering/core/scenarios';
import type { LiveRunPortFactory } from '@fothering/providers/live-run-port-types';
import type { FixtureLiveRunState } from '@fothering/providers/fixtures/live-run-ports';
import type { RootOptions } from '../shared/root.js';

export interface LiveRunIo {
  out(line: string): void;
  err(line: string): void;
}

export interface LiveRunDeps {
  switchValue: string | undefined;
  portFactory: () => LiveRunPortFactory;
  scenarios: ScenarioSource;
  laneMap: LaneMap;
  monotonicMs: () => number;
  nowUtc: () => number;
  sleep: (ms: number) => Promise<void>;
  repoRoot: string;
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

export function buildLiveRunRoot(options: BuildLiveRunRootOptions): LiveRunDeps {
  return { switchValue: options.switchValue, repoRoot: options.repoRoot } as LiveRunDeps;
}
