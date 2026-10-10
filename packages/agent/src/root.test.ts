import { describe, expect, it } from 'vitest';
import { PORT_TABLE } from '@fothering/providers/ports';
import { SWITCH_VALUES, assertRootMatrix } from '@fothering/providers/test/root-matrix';
import { buildAgentRoot } from './root.js';

describe('buildAgentRoot', () => {
  it("resolves every kind to fixture in 'test', for every switch value", () => {
    for (const switchValue of SWITCH_VALUES) {
      const { kinds } = buildAgentRoot({ runtimeContext: 'test', switchValue });
      for (const row of Object.values(kinds)) {
        for (const kind of Object.values(row)) {
          expect(kind).toBe('fixture');
        }
      }
    }
  });

  it('resolves every operation of every row to its expected kind over 2 contexts and 7 switch values', () => {
    expect(() => assertRootMatrix(buildAgentRoot)).not.toThrow();
  });

  it("in 'deployed', building the root with counting client factories constructs 0 clients", () => {
    let constructions = 0;
    const countingClient = (): { send: () => Promise<never> } => {
      constructions += 1;
      return {
        send: () => {
          throw new Error('not stubbed for this test');
        },
      };
    };
    for (const switchValue of SWITCH_VALUES) {
      buildAgentRoot({
        runtimeContext: 'deployed',
        switchValue,
        liveClients: { dynamoDb: countingClient, secretsManager: countingClient, sqs: countingClient, sesv2: countingClient },
      });
    }
    expect(constructions).toBe(0);
  });

  it('returns ports and a working log sink', () => {
    const lines: string[] = [];
    const { ports, kinds, log } = buildAgentRoot({
      runtimeContext: 'test',
      switchValue: undefined,
      logSink: (line) => lines.push(line),
    });
    expect(typeof ports.eventStore.putIfAbsent).toBe('function');
    expect(kinds.eventStore?.putIfAbsent).toBe('fixture');
    log.info({ event: 'probe', messageId: 'm-1' });
    expect(lines).toHaveLength(1);
  });

  // The type check is the assertion here (npm run gate:types): if the options type ever accepts a
  // planted port table again, the directive below goes unused and the check fails.
  it('takes no planted port table in its options', () => {
    const withTable = { runtimeContext: 'test' as const, switchValue: undefined, table: PORT_TABLE };
    // @ts-expect-error buildAgentRoot never passes a planted port table on to resolvePortTable
    expect(buildAgentRoot(withTable).kinds.eventStore?.putIfAbsent).toBe('fixture');
  });
});
