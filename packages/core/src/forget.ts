import { z } from 'zod';
import { hmacUnderEveryVersion, holdsOneMailbox, type AddressKeySet } from './address.js';
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
   * How many entries the index still listed at the last re-read: records that re-read found and
   * removed (already counted in `deleted`), plus entries for records an earlier pass removed that
   * the index had not caught up with. So this is not what is left in the table: a non-zero value
   * means the index had not settled when the re-reads ran out, and a second run shows what is left.
   */
  remaining: number;
}

export const FORGET_USAGE = 'usage: pass a JSON payload holding one non-empty "address" field naming one address, and nothing else';

// Trimmed before the length check: an address of spaces names no recipient, and it would still hash
// (hashing trims too) to whatever records carry the empty input. Strict, because a field this
// command does not read is a request it would silently not carry out: a second address field would
// be dropped while the report reads like a run that covered both. One mailbox, because a list in
// the one field would be read as its last bracketed address and delete someone else's records.
export const forgetPayloadSchema = z.strictObject({ address: z.string().trim().min(1).refine(holdsOneMailbox) });

export class ForgetUsageError extends Error {
  constructor() {
    super(FORGET_USAGE);
    this.name = 'ForgetUsageError';
  }
}

const DEFAULT_MAX_REQUERIES = 3;
const REQUERY_DELAY_MS = 200;

interface PassResult {
  /** Entries the index listed across every hash, whether or not a record was still behind each. */
  listed: number;
  /** Records actually removed. */
  removed: number;
}

// One pass over every retained hash: query the index, delete everything it names, and add the
// records actually removed to the running per-key-version tally. Called once for the main deletion
// and again, up to maxRequeries times, as the bounded re-query (Pitfall 10) - a later pass finding a
// record the first one missed deletes it too, it does not just report on it. The index lags both
// ways, so a key it still lists after an earlier pass removed its record deletes nothing and counts
// nothing as removed: counting keys instead of removals would report one record twice. It still
// counts as listed, because it shows the index has not caught up yet.
async function deleteMatches(
  store: ForgetStore,
  hashes: { keyVersion: string; recipientHmac: string }[],
  perKeyVersion: Map<string, number>,
): Promise<PassResult> {
  let listed = 0;
  let removed = 0;
  for (const { keyVersion, recipientHmac } of hashes) {
    const keys = await store.queryByRecipient(recipientHmac);
    listed += keys.length;
    let removedForHash = 0;
    for (const key of keys) {
      if (await store.deleteRecord(key)) removedForHash += 1;
    }
    perKeyVersion.set(keyVersion, (perKeyVersion.get(keyVersion) ?? 0) + removedForHash);
    removed += removedForHash;
  }
  return { listed, removed };
}

// Deletion is exact-match only, by HMAC through the recipient index: a same-domain, near-miss or
// plus-tagged non-target address can never be reached here (T-01-33). The index updates in an
// eventually consistent fashion (Pitfall 10), so `remaining` is a read at the last re-query, never
// proof that nothing is left; a record written for an event still in flight needs a second run.
export async function forgetRecipient(options: ForgetRecipientOptions): Promise<ForgetReport> {
  // No version means no hash and no search, so 0 deleted would be a report of nothing looked at.
  if (options.keySet.versions.length === 0) {
    throw new Error('the key set holds no key version, so no record could be searched');
  }
  const maxRequeries = options.maxRequeries ?? DEFAULT_MAX_REQUERIES;
  const hashes = hmacUnderEveryVersion(options.address, options.keySet);
  const perKeyVersion = new Map<string, number>(hashes.map((entry) => [entry.keyVersion, 0]));

  let deleted = (await deleteMatches(options.store, hashes, perKeyVersion)).removed;

  // Every re-query waits first, the first one included: one issued the instant the pass before it
  // ends gives the index no time to show a record it was still catching up on. The re-reads stop
  // early only when the index lists nothing at all: one that lists only records an earlier pass
  // removed has not seen the index settle, and a record it has yet to show may appear on the next.
  let remaining = 0;
  for (let attempt = 1; attempt <= maxRequeries; attempt++) {
    await options.sleep(REQUERY_DELAY_MS);
    const pass = await deleteMatches(options.store, hashes, perKeyVersion);
    deleted += pass.removed;
    remaining = pass.listed;
    if (pass.listed === 0) break;
  }

  return {
    perKeyVersion: hashes.map((entry) => ({ keyVersion: entry.keyVersion, deleted: perKeyVersion.get(entry.keyVersion) ?? 0 })),
    deleted,
    remaining,
  };
}
