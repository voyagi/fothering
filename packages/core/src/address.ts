import { createHmac } from 'node:crypto';
import { domainToASCII } from 'node:url';

export interface AddressKeyVersion {
  id: string;
  secret: string;
  activeFromMs: number;
}

export interface AddressKeySet {
  versions: readonly AddressKeyVersion[];
}

export interface PseudonymizedRecipient {
  receivingDomain: string;
  recipientHmac: string;
  keyVersion: string;
}

// A key set with no version active at a send time is a key configuration gap (a pruned or
// future-dated first version), not a fault in the event, so it carries its own name: ingest
// rethrows it for the retry instead of dropping the event as unminimizable.
export class NoActiveKeyVersionError extends Error {
  constructor(sendTimeMs: number) {
    super(`no address key version is active at or before ${sendTimeMs}`);
    this.name = 'NoActiveKeyVersionError';
  }
}

// D-34: the key version is chosen by send time, not processing time, so a retry after a
// rotation recomputes the same HMAC and the same record key.
export function selectKeyVersion(keySet: AddressKeySet, sendTimeMs: number): AddressKeyVersion {
  let selected: AddressKeyVersion | undefined;
  for (const version of keySet.versions) {
    if (version.activeFromMs > sendTimeMs) continue;
    if (selected === undefined || version.activeFromMs > selected.activeFromMs) selected = version;
  }
  if (selected === undefined) {
    throw new NoActiveKeyVersionError(sendTimeMs);
  }
  return selected;
}

export interface NormalizedAddress {
  local: string;
  domain: string;
}

// D-14: trim, take the address out of an angle-bracket display-name form if present, split at the
// last @ (a local part is free to hold its own @), domain through url.domainToASCII then
// lowercase (an empty result is unparseable), local part normalize('NFC') then toLowerCase(),
// plus-tags kept as-is. undefined means unparseable (AC-E24): no @, an empty local part, an empty
// domain, or a domain domainToASCII rejects.
export function normalizeAddress(raw: string): NormalizedAddress | undefined {
  const trimmed = raw.trim();
  const angleStart = trimmed.indexOf('<');
  const angleEnd = trimmed.lastIndexOf('>');
  const unwrapped = angleStart !== -1 && angleEnd > angleStart ? trimmed.slice(angleStart + 1, angleEnd) : trimmed;

  const atIndex = unwrapped.lastIndexOf('@');
  if (atIndex <= 0) return undefined;
  const localRaw = unwrapped.slice(0, atIndex);
  const domainRaw = unwrapped.slice(atIndex + 1);
  if (domainRaw === '') return undefined;

  const domain = domainToASCII(domainRaw).toLowerCase();
  if (domain === '') return undefined;
  const local = localRaw.normalize('NFC').toLowerCase();
  return { local, domain };
}

// The one hashing path (T-01-35's sibling for the address module): every caller, parseable or not,
// runs its input through this single createHmac call, so no second way to turn an address into a
// stored value can drift from this one.
function keyedHash(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

// AC-E24: an unparseable address is never split or reduced to a domain; it is hashed whole, trimmed
// and lowercased, exactly as it was handed in, so two spellings of an unparseable string that are
// equal after that transform still collide on the same hash (never on the raw text itself).
function hashInputFor(raw: string): string {
  const normalized = normalizeAddress(raw);
  return normalized === undefined ? raw.trim().toLowerCase() : `${normalized.local}@${normalized.domain}`;
}

export function pseudonymizeRecipient(
  raw: string,
  keySet: AddressKeySet,
  sendTimeMs: number,
): PseudonymizedRecipient {
  const version = selectKeyVersion(keySet, sendTimeMs);
  const normalized = normalizeAddress(raw);
  const receivingDomain = normalized === undefined ? 'unparseable' : normalized.domain;
  const recipientHmac = keyedHash(hashInputFor(raw), version.secret);
  return { receivingDomain, recipientHmac, keyVersion: version.id };
}

// The version with the greatest activeFromMs: the one a fresh event uses right now, as opposed to
// selectKeyVersion's send-time lookup for a specific past or present event.
export function currentKeyVersion(keySet: AddressKeySet): AddressKeyVersion {
  let current: AddressKeyVersion | undefined;
  for (const version of keySet.versions) {
    if (current === undefined || version.activeFromMs > current.activeFromMs) current = version;
  }
  if (current === undefined) {
    throw new Error('key set has no versions');
  }
  return current;
}

// The delete path (plan 01-07's forget command) does not know which key version wrote a given
// record, so it hashes the target address under every retained version and queries each in turn;
// newest first matches the report order the operator reads (D-18).
export function hmacUnderEveryVersion(
  raw: string,
  keySet: AddressKeySet,
): { keyVersion: string; recipientHmac: string }[] {
  const input = hashInputFor(raw);
  const newestFirst = [...keySet.versions].sort((a, b) => b.activeFromMs - a.activeFromMs);
  return newestFirst.map((version) => ({ keyVersion: version.id, recipientHmac: keyedHash(input, version.secret) }));
}
