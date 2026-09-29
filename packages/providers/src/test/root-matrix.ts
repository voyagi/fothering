import { expect } from 'vitest';
import { resolveProviderMode } from '@fothering/core/mode';
import type { KindTable, ResolvedKind, RuntimeContext } from '../port-types.js';

export const SWITCH_VALUES: readonly (string | undefined)[] = [undefined, '', '   ', 'true', 'LIVE', ' live', 'live'];

const RUNTIME_CONTEXTS: readonly RuntimeContext[] = ['test', 'deployed'];

type KindColumns = readonly [test: ResolvedKind, deployed: ResolvedKind, deployedLive: ResolvedKind];

export const EXPECTED_KINDS: Readonly<Record<string, Readonly<Record<string, KindColumns>>>> = {};

export interface RootMatrixOptions {
  runtimeContext: RuntimeContext;
  switchValue: string | undefined;
}

function expectedKinds(runtimeContext: RuntimeContext, switchValue: string | undefined): KindTable {
  const column = runtimeContext === 'test' ? 0 : resolveProviderMode(switchValue) === 'live' ? 2 : 1;
  return Object.fromEntries(
    Object.entries(EXPECTED_KINDS).map(([portName, row]) => [
      portName,
      Object.fromEntries(Object.entries(row).map(([operation, columns]) => [operation, columns[column]])),
    ]),
  );
}

export function assertRootMatrix(build: (options: RootMatrixOptions) => { kinds: KindTable }): void {
  for (const runtimeContext of RUNTIME_CONTEXTS) {
    for (const switchValue of SWITCH_VALUES) {
      const { kinds } = build({ runtimeContext, switchValue });
      expect(kinds, `${runtimeContext} with switch ${JSON.stringify(switchValue)}`).toEqual(expectedKinds(runtimeContext, switchValue));
    }
  }
}
