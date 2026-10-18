import { afterEach, describe, expect, it } from 'vitest';
import { readActionLiveConfig, readActionOperatorConfig } from './action/root.js';
import { readForgetLiveConfig } from './forget/root.js';
import { readIngestLiveConfig } from './ingest/root.js';
import { readReopenLiveConfig } from './reopen/root.js';

const TABLE_KEY = 'FOTHERING_TABLE_NAME';
const DLQ_KEY = 'FOTHERING_DLQ_URL';
const SECRET_KEY = 'FOTHERING_ADDRESS_KEY_SECRET_ID';
const FROM_KEY = 'FOTHERING_FROM_ADDRESS';
const OPERATOR_KEY = 'FOTHERING_OPERATOR_ADDRESS';

const TABLE_NAME = 'fothering-events';
const QUEUE_URL = 'https://sqs.eu-central-1.amazonaws.com/000000000000/fothering-dlq';
const SECRET_ID = 'fothering/address-keys';
const FROM_ADDRESS = 'alerts@example.com';
const OPERATOR_ADDRESS = 'ops@example.com';

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

function setAll(): void {
  process.env[TABLE_KEY] = TABLE_NAME;
  process.env[DLQ_KEY] = QUEUE_URL;
  process.env[SECRET_KEY] = SECRET_ID;
  process.env[FROM_KEY] = FROM_ADDRESS;
  process.env[OPERATOR_KEY] = OPERATOR_ADDRESS;
}

function unsetAll(): void {
  for (const key of [TABLE_KEY, DLQ_KEY, SECRET_KEY, FROM_KEY, OPERATOR_KEY]) delete process.env[key];
}

const saved = snapshot([TABLE_KEY, DLQ_KEY, SECRET_KEY, FROM_KEY, OPERATOR_KEY]);
afterEach(() => restore(saved));

describe('readIngestLiveConfig', () => {
  it('reads the table name, the dead-letter queue URL and the address-key secret id when set', () => {
    setAll();
    expect(readIngestLiveConfig()).toEqual({ tableName: TABLE_NAME, deadLetterQueueUrl: QUEUE_URL, addressKeySecretId: SECRET_ID });
  });

  it('leaves out each key whose variable is unset', () => {
    unsetAll();
    const config = readIngestLiveConfig();
    expect(config).toEqual({});
    expect(Object.keys(config)).toHaveLength(0);
  });
});

describe('readActionLiveConfig', () => {
  it('reads the table name and the address-key secret id, never the dead-letter queue URL', () => {
    setAll();
    const config = readActionLiveConfig();
    expect(config).toEqual({ tableName: TABLE_NAME, addressKeySecretId: SECRET_ID });
    expect(Object.hasOwn(config, 'deadLetterQueueUrl')).toBe(false);
  });

  it('leaves out each key whose variable is unset', () => {
    unsetAll();
    const config = readActionLiveConfig();
    expect(config).toEqual({});
    expect(Object.keys(config)).toHaveLength(0);
  });
});

describe('readActionOperatorConfig', () => {
  it('reads the From and operator addresses when set', () => {
    setAll();
    expect(readActionOperatorConfig()).toEqual({ from: FROM_ADDRESS, to: OPERATOR_ADDRESS });
  });

  it('leaves out each address whose variable is unset', () => {
    unsetAll();
    process.env[FROM_KEY] = FROM_ADDRESS;
    expect(readActionOperatorConfig()).toEqual({ from: FROM_ADDRESS });
    unsetAll();
    expect(Object.keys(readActionOperatorConfig())).toHaveLength(0);
  });
});

describe('readReopenLiveConfig', () => {
  it('reads the table name and nothing else', () => {
    setAll();
    expect(readReopenLiveConfig()).toEqual({ tableName: TABLE_NAME });
  });

  it('leaves out the table name when its variable is unset', () => {
    unsetAll();
    const config = readReopenLiveConfig();
    expect(config).toEqual({});
    expect(Object.keys(config)).toHaveLength(0);
  });
});

describe('readForgetLiveConfig', () => {
  it('reads the table name and the address-key secret id, never the dead-letter queue URL', () => {
    setAll();
    const config = readForgetLiveConfig();
    expect(config).toEqual({ tableName: TABLE_NAME, addressKeySecretId: SECRET_ID });
    expect(Object.hasOwn(config, 'deadLetterQueueUrl')).toBe(false);
  });

  it('leaves out each key whose variable is unset', () => {
    unsetAll();
    const config = readForgetLiveConfig();
    expect(config).toEqual({});
    expect(Object.keys(config)).toHaveLength(0);
  });
});
