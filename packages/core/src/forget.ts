import { z } from 'zod';
import { hmacUnderEveryVersion, type AddressKeySet } from './address.js';
import type { RecordKey } from './records.js';

export interface ForgetStore {
  queryByRecipient(recipientHmac: string): Promise<RecordKey[]>;
  /** True when a record was removed, false when the key named no stored record. */
  deleteRecord(key: RecordKey): Promise<boolean>;
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
  /** Records removed under each retained key version, newest version first. */
  perKeyVersion: ForgetKeyVersionReport[];
  /** Every record removed, the last re-read's included. */
  deleted: number;
  /**
   * How many records the last re-read still turned up. Those are removed too and counted in
   * `deleted`, so this is not what is left in the table: a non-zero value means the index was still
   * showing new records when the re-reads ran out, and a second run confirms the count.
   */
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
// records actually removed to the running per-key-version tally. Called once for the main deletion
// and again, up to maxRequeries times, as the bounded re-query (Pitfall 10) - a later pass finding a
// record the first one missed deletes it too, it does not just report on it. The index lags both
// ways, so a key it still lists after an earlier pass removed its record deletes nothing and counts
// nothing: counting keys instead of removals would report one record twice.
async function deleteMatches(
  store: ForgetStore,
  hashes: { keyVersion: string; recipientHmac: string }[],
  perKeyVersion: Map<string, number>,
): Promise<number> {
  let removed = 0;
  for (const { keyVersion, recipientHmac } of hashes) {
    const keys = await store.queryByRecipient(recipientHmac);
    let removedForHash = 0;
    for (const key of keys) {
      if (await store.deleteRecord(key)) removedForHash += 1;
    }
    perKeyVersion.set(keyVersion, (perKeyVersion.get(keyVersion) ?? 0) + removedForHash);
    removed += removedForHash;
  }
  return removed;
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

  // Every re-query waits first, the first one included: one issued the instant the pass before it
  // ends gives the index no time to show a record it was still catching up on.
  let remaining = 0;
  for (let attempt = 1; attempt <= maxRequeries; attempt++) {
    await options.sleep(REQUERY_DELAY_MS);
    const found = await deleteMatches(options.store, hashes, perKeyVersion);
    remaining = found;
    if (found === 0) break;
    deleted += found;
  }

  return {
    perKeyVersion: hashes.map((entry) => ({ keyVersion: entry.keyVersion, deleted: perKeyVersion.get(entry.keyVersion) ?? 0 })),
    deleted,
    remaining,
  };
}
