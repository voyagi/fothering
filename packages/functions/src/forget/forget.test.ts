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

function seededRecord(targetAddress: string, identity = 'id-1'): { record: EventRecord; recipientHmac: string } {
  const pseudonym = pseudonymizeRecipient(targetAddress, TEST_ADDRESS_KEY_SET, 0);
  const { pk, sk } = recordKey({ configurationSet: 'fothering-bulk', bucketStartMs: 0, eventType: 'Bounce', identity });
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
  // The record is stored under the address the documentation's own payload names, and that payload
  // is passed unchanged, so the example an operator copies is the one proven to delete.
  it('forgets the recipient from the documentation payload example, deleting its record and logging a count only', async () => {
    const example = readDocPayloadExample();
    const targetAddress = example.address;
    const deps = buildForgetRoot({ runtimeContext: 'test', switchValue: undefined });
    const { record, recipientHmac } = seededRecord(targetAddress);
    await deps.ports.eventStore.putIfAbsent(record);
    const lines: string[] = [];
    const loggedDeps: ForgetDeps = { ...deps, log: createLogger((line) => lines.push(line)) };

    const report = await forgetFromPayload(example, loggedDeps);

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

  // A field holding more than one address is refused before any hash is taken. Read as one address,
  // a bracketed list reaches its LAST bracketed address, so a request about Jane would delete the
  // records of the other person named beside her.
  it.each([
    'jane@example.com, nobody@example.org',
    'Jane <jane@example.com>, Nobody <nobody@example.org>',
    'Nobody <nobody@example.org> jane@example.com',
    'jane@example.com <nobody@example.org>',
    'jane@example.com<nobody@example.org>',
    '"jane@example.com" <nobody@example.org>',
  ])('refuses the address field %j with the usage error and deletes nobody, as the documentation warns', async (address) => {
    const deps = buildForgetRoot({ runtimeContext: 'test', switchValue: undefined });
    const jane = seededRecord('jane@example.com', 'id-1');
    const nobody = seededRecord('nobody@example.org', 'id-2');
    await deps.ports.eventStore.putIfAbsent(jane.record);
    await deps.ports.eventStore.putIfAbsent(nobody.record);

    await expect(forgetFromPayload({ address }, deps)).rejects.toThrow(ForgetUsageError);

    await expect(deps.ports.eventStore.queryByRecipient(jane.recipientHmac)).resolves.toHaveLength(1);
    await expect(deps.ports.eventStore.queryByRecipient(nobody.recipientHmac)).resolves.toHaveLength(1);
    expect(docText).toContain('one address per run');
  });

  // RFC 5322 lets whitespace sit inside the angle brackets, while a bounce stores the bare address, so
  // a request written that way names the same person and must reach that person's record.
  it('forgets the record of a bare address when the address field writes it with spaces inside the angle brackets', async () => {
    const deps = buildForgetRoot({ runtimeContext: 'test', switchValue: undefined });
    const { record, recipientHmac } = seededRecord('jane@example.com');
    await deps.ports.eventStore.putIfAbsent(record);

    const report = await forgetFromPayload({ address: 'Jane < jane@example.com >' }, deps);

    expect(report.deleted).toBe(1);
    expect(report.remaining).toBe(0);
    await expect(deps.ports.eventStore.queryByRecipient(recipientHmac)).resolves.toHaveLength(0);
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

  // The AWS CLI gives up after 60 s by default and then retries the invoke, starting a second run.
  // 300 s is the forget function's timeout, set in ingest-stack.ts and pinned by its synth test. A
  // cold start's Init phase runs before that timeout starts and may take up to 10 s (Lambda's
  // execution environment page), so the wait covers both, plus 20 s for the network.
  it('waits past the forget function Init phase and 300 s limit in its invoke command', () => {
    const readTimeout = /--cli-read-timeout (\d+)/.exec(docText)?.[1];
    expect(Number(readTimeout)).toBeGreaterThanOrEqual(10 + 300 + 20);
  });
});
