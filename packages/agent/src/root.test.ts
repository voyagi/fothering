import { describe, expect, it } from 'vitest';
import { buildAgentRoot } from './root.js';

const SWITCH_VALUES = [undefined, '', 'true', 'LIVE', ' live', 'live'];

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

  it("resolves the event store, address key and dead-letter rows live in 'deployed', for every switch value", () => {
    for (const switchValue of SWITCH_VALUES) {
      const { kinds } = buildAgentRoot({ runtimeContext: 'deployed', switchValue });
      for (const portName of ['eventStore', 'addressKey', 'deadLetter']) {
        for (const kind of Object.values(kinds[portName] ?? {})) {
          expect(kind).toBe('live');
        }
      }
    }
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
    buildAgentRoot({
      runtimeContext: 'deployed',
      switchValue: undefined,
      liveClients: { dynamoDb: countingClient, secretsManager: countingClient, sqs: countingClient },
    });
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
});
