import { z } from 'zod';
import { hmacUnderEveryVersion, type AddressKeySet } from './address.js';
import type { RecordKey } from './records.js';

export interface ForgetStore {
  queryByRecipient(recipientHmac: string): Promise<RecordKey[]>;
  deleteRecord(key: RecordKey): Promise<void>;
}

export interface ForgetRecipientOptions {
  address: string;
  keySet: AddressKeySet;
  store: ForgetStore;
  /** Injected so a test never sleeps for real between re-query attempts. */
  sleep: (ms: number) => Promise<void>;
  maxRequeries?: number;
}

export interface ForgetKeyVersionReport {
  keyVersion: string;
  deleted: number;
}

export interface ForgetReport {
  perKeyVersion: ForgetKeyVersionReport[];
  deleted: number;
  remaining: number;
}

export const FORGET_USAGE = 'usage: pass a JSON payload holding one non-empty "address" field';

export const forgetPayloadSchema = z.object({ address: z.string().min(1) });

export class ForgetUsageError extends Error {
  constructor() {
    super(FORGET_USAGE);
    this.name = 'ForgetUsageError';
  }
}

const DEFAULT_MAX_REQUERIES = 3;
const REQUERY_DELAY_MS = 200;

// One pass over every retained hash: query the index, delete everything it names, and add the
// count to the running per-key-version tally. Called once for the main deletion and again, up to
// maxRequeries times, as the bounded re-query (Pitfall 10) - a later pass finding a record the
// first one missed deletes it too, it does not just report on it.
async function deleteMatches(
  store: ForgetStore,
  hashes: { keyVersion: string; recipientHmac: string }[],
  perKeyVersion: Map<string, number>,
): Promise<number> {
  let found = 0;
  for (const { keyVersion, recipientHmac } of hashes) {
    const keys = await store.queryByRecipient(recipientHmac);
    for (const key of keys) await store.deleteRecord(key);
    perKeyVersion.set(keyVersion, (perKeyVersion.get(keyVersion) ?? 0) + keys.length);
    found += keys.length;
  }
  return found;
}

// Deletion is exact-match only, by HMAC through the recipient index: a same-domain, near-miss or
// plus-tagged non-target address can never be reached here (T-01-33). The index updates in an
// eventually consistent fashion (Pitfall 10), so `remaining` is a read at the last re-query, never
// proof that nothing is left; a record written for an event still in flight needs a second run.
export async function forgetRecipient(options: ForgetRecipientOptions): Promise<ForgetReport> {
  const maxRequeries = options.maxRequeries ?? DEFAULT_MAX_REQUERIES;
  const hashes = hmacUnderEveryVersion(options.address, options.keySet);
  const perKeyVersion = new Map<string, number>(hashes.map((entry) => [entry.keyVersion, 0]));

  let deleted = await deleteMatches(options.store, hashes, perKeyVersion);

  let remaining = 0;
  for (let attempt = 1; attempt <= maxRequeries; attempt++) {
    const found = await deleteMatches(options.store, hashes, perKeyVersion);
    remaining = found;
    if (found === 0) break;
    deleted += found;
    if (attempt < maxRequeries) await options.sleep(REQUERY_DELAY_MS);
  }

  return {
    perKeyVersion: hashes.map((entry) => ({ keyVersion: entry.keyVersion, deleted: perKeyVersion.get(entry.keyVersion) ?? 0 })),
    deleted,
    remaining,
  };
}
