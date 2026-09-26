import { afterEach, describe, expect, it } from 'vitest';
import { readIngestLiveConfig } from '@fothering/functions/ingest/root';
import { readLiveSwitch } from './live-switch.js';

const SWITCH_KEY = 'FOTHERING_LIVE';
const TABLE_KEY = 'FOTHERING_TABLE_NAME';
const DLQ_KEY = 'FOTHERING_DLQ_URL';
const SECRET_KEY = 'FOTHERING_ADDRESS_KEY_SECRET_ID';

function snapshot(keys: readonly string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) saved[key] = process.env[key];
  return saved;
}

function restore(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('readLiveSwitch', () => {
  const saved = snapshot([SWITCH_KEY]);
  afterEach(() => restore(saved));

  it('returns undefined when the switch is unset', () => {
    delete process.env[SWITCH_KEY];
    expect(readLiveSwitch()).toBeUndefined();
  });

  it('returns the exact process value, whitespace untouched', () => {
    process.env[SWITCH_KEY] = ' live ';
    expect(readLiveSwitch()).toBe(' live ');
  });
});

describe('readIngestLiveConfig', () => {
  const saved = snapshot([TABLE_KEY, DLQ_KEY, SECRET_KEY]);
  afterEach(() => restore(saved));

  it('reads all three table names from the environment when set', () => {
    process.env[TABLE_KEY] = 'fothering-events';
    process.env[DLQ_KEY] = 'https://sqs.eu-central-1.amazonaws.com/000000000000/fothering-dlq';
    process.env[SECRET_KEY] = 'fothering/address-keys';

    expect(readIngestLiveConfig()).toEqual({
      tableName: 'fothering-events',
      deadLetterQueueUrl: 'https://sqs.eu-central-1.amazonaws.com/000000000000/fothering-dlq',
      addressKeySecretId: 'fothering/address-keys',
    });
  });

  it('leaves out each key whose variable is unset', () => {
    delete process.env[TABLE_KEY];
    delete process.env[DLQ_KEY];
    delete process.env[SECRET_KEY];

    const config = readIngestLiveConfig();
    expect(config).toEqual({});
    expect(Object.keys(config)).toHaveLength(0);
  });
});
