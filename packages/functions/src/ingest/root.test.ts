import { describe, expect, it } from 'vitest';
import { TEST_ADDRESS_KEY_SET } from '@fothering/providers/fixtures/ingest-ports';
import { PORT_TABLE, resolvePortTable, type PortName, type PortRow } from '@fothering/providers/ports';
import { SWITCH_VALUES, assertRootMatrix } from '@fothering/providers/test/root-matrix';
import { buildIngestRoot } from './root.js';

const LIVE_CONFIG = {
  tableName: 'events',
  addressKeySecretId: 'address-key',
  deadLetterQueueUrl: 'https://sqs.eu-central-1.amazonaws.com/000000000000/fothering-dlq',
};
const ADDRESS_KEY_SECRET = 'ingest-root-test-secret-0123456789abcdef';

interface SentCommand {
  name: string;
  input: unknown;
}

// A structural stand-in for an SDK client: this package may not import an AWS client, and the
// adapters only ever call send with a command object. Each stub records what it was sent.
function stubClient(answer: (command: SentCommand) => unknown): {
  sent: SentCommand[];
  send(command: { constructor: { name: string }; input: unknown }): Promise<unknown>;
} {
  const sent: SentCommand[] = [];
  return {
    sent,
    async send(command) {
      const recorded = { name: command.constructor.name, input: command.input };
      sent.push(recorded);
      return answer(recorded);
    },
  };
}

function secretsManagerStub(): ReturnType<typeof stubClient> {
  return stubClient(() => ({ SecretString: JSON.stringify({ current: 'k1', activeFrom: { k1: 0 }, k1: ADDRESS_KEY_SECRET }) }));
}

function sesStub(): ReturnType<typeof stubClient> {
  return stubClient((command) => {
    if (command.name === 'GetEmailIdentityCommand') return { ConfigurationSetName: 'fothering-default' };
    throw new Error(`unexpected SES command ${command.name}`);
  });
}

describe('buildIngestRoot against the expected-kind table', () => {
  it('resolves every operation of every row to its expected kind over 2 contexts and 7 switch values', () => {
    expect(() => assertRootMatrix(buildIngestRoot)).not.toThrow();
  });

  it('reads the switch unset, empty and whitespace-only the same way (AC-E2)', () => {
    const unset = buildIngestRoot({ runtimeContext: 'deployed', switchValue: undefined }).kinds;
    expect(buildIngestRoot({ runtimeContext: 'deployed', switchValue: '' }).kinds).toEqual(unset);
    expect(buildIngestRoot({ runtimeContext: 'deployed', switchValue: '   ' }).kinds).toEqual(unset);
  });

  it('gives the same kind for every operation when built twice with the same inputs (AC-E3)', () => {
    for (const runtimeContext of ['test', 'deployed'] as const) {
      for (const switchValue of SWITCH_VALUES) {
        const first = buildIngestRoot({ runtimeContext, switchValue }).kinds;
        expect(buildIngestRoot({ runtimeContext, switchValue }).kinds).toEqual(first);
      }
    }
  });

  it('reports the same kinds when the table is declared in reverse order', () => {
    const reversed = Object.fromEntries(Object.entries(PORT_TABLE).reverse()) as unknown as Record<PortName, PortRow>;
    expect(Object.keys(reversed)).not.toEqual(Object.keys(PORT_TABLE));
    for (const runtimeContext of ['test', 'deployed'] as const) {
      for (const switchValue of SWITCH_VALUES) {
        const { kinds } = resolvePortTable({ runtimeContext, switchValue, table: reversed });
        expect(kinds).toEqual(buildIngestRoot({ runtimeContext, switchValue }).kinds);
      }
    }
  });

  it('builds no AWS client while resolving in deployed, whatever the switch', () => {
    let constructions = 0;
    const countingClient = (): { send: () => Promise<never> } => {
      constructions += 1;
      return { send: () => Promise.reject(new Error('not stubbed for this test')) };
    };
    for (const switchValue of SWITCH_VALUES) {
      buildIngestRoot({
        runtimeContext: 'deployed',
        switchValue,
        liveConfig: LIVE_CONFIG,
        liveClients: { dynamoDb: countingClient, secretsManager: countingClient, sqs: countingClient, sesv2: countingClient },
        dryRunSink: () => {},
      });
    }
    expect(constructions).toBe(0);
  });
});

describe('the ingest root in deployed with the switch unset', () => {
  it('serves an SES read through the live adapter and turns a pause into one dry-run line (AC-E1)', async () => {
    const ses = sesStub();
    const lines: string[] = [];
    const deps = buildIngestRoot({
      runtimeContext: 'deployed',
      switchValue: undefined,
      liveConfig: LIVE_CONFIG,
      liveClients: { sesv2: ses },
      dryRunSink: (line) => lines.push(line),
    });

    await expect(deps.ports.ses.getEmailIdentity('example.com')).resolves.toBe('fothering-default');
    await deps.ports.ses.pauseConfigurationSet('fothering-bulk');

    expect(lines).toEqual(['(dry-run) WOULD ses.pauseConfigurationSet fothering-bulk {"configurationSet":"fothering-bulk"}']);
    expect(ses.sent.map((command) => command.name)).toEqual(['GetEmailIdentityCommand']);
  });

  it.each(SWITCH_VALUES)('resolves the address key live and returns the stubbed secret, never the fixed test key, for switch %j (AC-P2)', async (switchValue) => {
    const secretsManager = secretsManagerStub();
    const deps = buildIngestRoot({
      runtimeContext: 'deployed',
      switchValue,
      liveConfig: LIVE_CONFIG,
      liveClients: { secretsManager },
      dryRunSink: () => {},
    });

    expect(deps.kinds.addressKey?.getKeySet).toBe('live');
    const keySet = await deps.ports.addressKey.getKeySet();
    expect(keySet).not.toEqual(TEST_ADDRESS_KEY_SET);
    expect(keySet.versions.map((version) => version.secret)).toEqual([ADDRESS_KEY_SECRET]);
    expect(secretsManager.sent).toHaveLength(1);
  });

  it('reads the address key only for a send line, not at resolution and not for a pause', async () => {
    const secretsManager = secretsManagerStub();
    const lines: string[] = [];
    const deps = buildIngestRoot({
      runtimeContext: 'deployed',
      switchValue: undefined,
      liveConfig: LIVE_CONFIG,
      liveClients: { secretsManager },
      dryRunSink: (line) => lines.push(line),
    });

    await deps.ports.ses.pauseConfigurationSet('fothering-bulk');
    expect(secretsManager.sent).toHaveLength(0);

    await deps.ports.ses.sendEmail({ from: 'ops@example.org', to: ['Jane.Doe+x@Example.COM'], subject: 'Hello Jane', text: 'A private sentence.' });
    expect(secretsManager.sent).toHaveLength(1);
    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain('@');
    expect(lines[1]).not.toContain('private sentence');
  });
});
