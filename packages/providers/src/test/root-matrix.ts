import { expect } from 'vitest';
import { resolveProviderMode } from '@fothering/core/mode';
import type { KindTable, ResolvedKind, RuntimeContext } from '../port-types.js';

export const SWITCH_VALUES: readonly (string | undefined)[] = [undefined, '', '   ', 'true', 'LIVE', ' live', 'live'];

const RUNTIME_CONTEXTS: readonly RuntimeContext[] = ['test', 'deployed'];

type KindColumns = readonly [test: ResolvedKind, deployed: ResolvedKind, deployedLive: ResolvedKind];

// Written out operation by operation, never computed from PORT_TABLE, so it stays an oracle that
// disagrees with a table whose declaration and behavior have drifted together.
// Columns: runtimeContext test; deployed with any switch value but exactly live; deployed with live.
export const EXPECTED_KINDS: Readonly<Record<string, Readonly<Record<string, KindColumns>>>> = {
  eventStore: {
    putIfAbsent: ['fixture', 'live', 'live'],
    queryLane: ['fixture', 'live', 'live'],
    queryByRecipient: ['fixture', 'live', 'live'],
    deleteRecord: ['fixture', 'live', 'live'],
    getRecord: ['fixture', 'live', 'live'],
  },
  addressKey: {
    getKeySet: ['fixture', 'live', 'live'],
  },
  deadLetter: {
    send: ['fixture', 'live', 'live'],
  },
  ses: {
    getEmailIdentity: ['fixture', 'live', 'live'],
    listEmailIdentities: ['fixture', 'live', 'live'],
    getConfigurationSetEventDestinations: ['fixture', 'live', 'live'],
    pauseConfigurationSet: ['fixture', 'dry-run', 'not-built-until-phase-3'],
    reopenConfigurationSet: ['fixture', 'dry-run', 'not-built-until-phase-3'],
    sendEmail: ['fixture', 'dry-run', 'not-built-until-phase-4'],
  },
  bedrockModel: {
    converse: ['fixture', 'dry-run', 'not-built-until-phase-2'],
  },
  agentCore: {
    invokeAgentRuntime: ['fixture', 'dry-run', 'not-built-until-phase-2'],
  },
  replyBucket: {
    getReplyObject: ['fixture', 'not-built-until-phase-4', 'not-built-until-phase-4'],
  },
};

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
