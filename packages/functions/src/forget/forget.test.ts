import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@fothering/core/log';
import { pseudonymizeRecipient } from '@fothering/core/address';
import { expiresAtFor, recordKey, type EventRecord } from '@fothering/core/records';
import { FORGET_USAGE, ForgetUsageError } from '@fothering/core/forget';
import { TEST_ADDRESS_KEY_SET } from '@fothering/providers/fixtures/ingest-ports';
import { buildForgetRoot, type ForgetDeps } from './root.js';
import { forgetFromPayload } from './handler.js';

const docUrl = new URL('../../../../docs/forget-one-recipient.md', import.meta.url);
const docText = readFileSync(docUrl, 'utf8');

function readDocPayloadExample(): { address: string } {
  const match = /\{"address":"[^"]+"\}/.exec(docText);
  if (match === null) throw new Error('docs/forget-one-recipient.md has no --payload JSON example');
  return JSON.parse(match[0]) as { address: string };
}

function seededRecord(targetAddress: string): { record: EventRecord; recipientHmac: string } {
  const pseudonym = pseudonymizeRecipient(targetAddress, TEST_ADDRESS_KEY_SET, 0);
  const { pk, sk } = recordKey({ configurationSet: 'fothering-bulk', bucketStartMs: 0, eventType: 'Bounce', identity: 'id-1' });
  return {
    recipientHmac: pseudonym.recipientHmac,
    record: {
      pk,
      sk,
      kind: 'outcome',
      eventType: 'Bounce',
      configurationSet: 'fothering-bulk',
      bucketStartMs: 0,
      mailTimestampMs: 0,
      envelopeTimeMs: 0,
      arrivalTimeMs: 0,
      messageId: 'msg-1',
      provenance: 'generated',
      expiresAt: expiresAtFor(0),
      fields: {},
      recipientHmac: pseudonym.recipientHmac,
      receivingDomain: pseudonym.receivingDomain,
      keyVersion: pseudonym.keyVersion,
    },
  };
}

describe('forgetFromPayload (AC-15)', () => {
  it('forgets the recipient from the documentation payload example, deleting its record and logging a count only', async () => {
    const targetAddress = 'jane@example.com';
    const deps = buildForgetRoot({ runtimeContext: 'test', switchValue: undefined });
    const { record, recipientHmac } = seededRecord(targetAddress);
    await deps.ports.eventStore.putIfAbsent(record);
    const lines: string[] = [];
    const loggedDeps: ForgetDeps = { ...deps, log: createLogger((line) => lines.push(line)) };

    const example = readDocPayloadExample();
    const report = await forgetFromPayload({ ...example, address: targetAddress }, loggedDeps);

    expect(report.deleted).toBe(1);
    expect(report.remaining).toBe(0);
    await expect(deps.ports.eventStore.queryByRecipient(recipientHmac)).resolves.toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({ event: 'forget-completed', level: 'info', count: 1 });
    for (const line of lines) {
      expect(line.toLowerCase()).not.toContain(targetAddress.toLowerCase());
      expect(line).not.toContain(recipientHmac);
    }
  });

  it('resolves 0 deleted and 0 remaining when the address has no records (AC-E28)', async () => {
    const deps = buildForgetRoot({ runtimeContext: 'test', switchValue: undefined });

    const report = await forgetFromPayload({ address: 'nobody@example.org' }, deps);

    expect(report.deleted).toBe(0);
    expect(report.remaining).toBe(0);
  });

  // A second field is refused, not ignored: a payload naming two addresses must not forget the first
  // and report it like a run that covered both.
  it.each([
    {},
    { address: '' },
    { address: '   ' },
    { address: 123 },
    null,
    'not an object',
    { address: 'jane@example.com', second: 'nobody@example.org' },
  ])(
    'rejects the payload %j with ForgetUsageError carrying the same usage line the documentation shows (AC-E28)',
    async (badPayload) => {
      const deps = buildForgetRoot({ runtimeContext: 'test', switchValue: undefined });

      await expect(forgetFromPayload(badPayload, deps)).rejects.toThrow(ForgetUsageError);
      await expect(forgetFromPayload(badPayload, deps)).rejects.toThrow(FORGET_USAGE);
    },
  );

  it('logs one failure line naming the error only when a delete fails partway, then rethrows', async () => {
    const targetAddress = 'jane@example.com';
    const deps = buildForgetRoot({ runtimeContext: 'test', switchValue: undefined });
    const { record, recipientHmac } = seededRecord(targetAddress);
    await deps.ports.eventStore.putIfAbsent(record);
    const lines: string[] = [];
    const failingDeps: ForgetDeps = {
      ...deps,
      ports: {
        ...deps.ports,
        eventStore: {
          ...deps.ports.eventStore,
          deleteRecord: async () => {
            throw new Error('throttled');
          },
        },
      },
      log: createLogger((line) => lines.push(line)),
    };

    await expect(forgetFromPayload({ address: targetAddress }, failingDeps)).rejects.toThrow('throttled');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([{ event: 'forget-failed', level: 'error', errorName: 'Error' }]);
    for (const line of lines) {
      expect(line.toLowerCase()).not.toContain(targetAddress.toLowerCase());
      expect(line).not.toContain(recipientHmac);
    }
  });

  it('matches the usage line the documentation shows verbatim', () => {
    expect(docText).toContain(FORGET_USAGE);
  });

  // A zero is only as good as the address it was asked about: a field naming two addresses is read
  // as one malformed address and reaches neither recipient, which the documentation must say.
  it('reads zero for a field naming two addresses, as the documentation warns', async () => {
    const targetAddress = 'jane@example.com';
    const deps = buildForgetRoot({ runtimeContext: 'test', switchValue: undefined });
    const { record, recipientHmac } = seededRecord(targetAddress);
    await deps.ports.eventStore.putIfAbsent(record);

    const report = await forgetFromPayload({ address: `${targetAddress}, nobody@example.org` }, deps);

    expect(report.deleted).toBe(0);
    await expect(deps.ports.eventStore.queryByRecipient(recipientHmac)).resolves.toHaveLength(1);
    expect(docText).toContain('one address per run');
  });
});

describe('docs/forget-one-recipient.md', () => {
  it('names the reply bucket and AgentCore Memory as not covered, and holds the second-run sentence (AC-15, AC-E30)', () => {
    expect(docText).toContain('reply bucket');
    expect(docText).toContain('AgentCore Memory');
    expect(docText.toLowerCase()).toContain('second run');
  });

  it('holds a parseable --payload JSON example naming one address', () => {
    const example = readDocPayloadExample();
    expect(typeof example.address).toBe('string');
    expect(example.address.length).toBeGreaterThan(0);
  });
});
