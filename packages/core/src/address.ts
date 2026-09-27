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

// The positions of text's characters that sit outside quoted strings, a backslash inside quotes
// escaping the character after it. A quote that never closes leaves no quoted part to skip, so
// then every position counts as outside.
function unquotedPositions(text: string): number[] {
  const positions: number[] = [];
  let inQuotes = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inQuotes && char === '\\') index += 1;
    else if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes) positions.push(index);
  }
  return inQuotes ? Array.from({ length: text.length }, (_, index) => index) : positions;
}

// The address in a display-name form sits in the last angle brackets outside a quoted string: a
// display name may quote a '<' of its own ("Sales <EU>" followed by the bracketed address), and a
// quoted local part may hold one inside the brackets. -1 when there is none.
function angleAddrStart(text: string): number {
  return unquotedPositions(text).findLast((index) => text[index] === '<') ?? -1;
}

// A forget request names one person, and normalizeAddress reads the LAST bracketed address of a
// field, so "Jane <jane@...>, Bob <bob@...>" would reach Bob for a request about Jane. Outside
// quoted strings, one mailbox holds no comma or semicolon (the list separators), at most one '<',
// nothing after the '>' that closes it, and, written bare, no whitespace.
export function holdsOneMailbox(raw: string): boolean {
  const trimmed = raw.trim();
  const outside = unquotedPositions(trimmed)
    .map((index) => trimmed[index])
    .join('');
  if (/[,;]/.test(outside)) return false;
  const opens = outside.split('<').length - 1;
  if (opens === 0) return !/\s/.test(outside);
  if (opens > 1) return false;
  // With no '>' at all the slice is the whole field, which holds the '<', so it is refused too.
  return outside.slice(outside.lastIndexOf('>') + 1).trim() === '';
}

// D-14: trim, take the address out of an angle-bracket display-name form if present, split at the
// last @ (a local part is free to hold its own @), domain through url.domainToASCII then
// lowercase (an empty result is unparseable), local part normalize('NFC') then toLowerCase(),
// plus-tags kept as-is. undefined means unparseable (AC-E24): no @, an empty local part, an empty
// domain, or a domain domainToASCII rejects.
export function normalizeAddress(raw: string): NormalizedAddress | undefined {
  const trimmed = raw.trim();
  const angleStart = angleAddrStart(trimmed);
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

// The version with the greatest activeFromMs: the newest one the key set holds, whether or not it
// is active yet. During a rotation's margin (a new version is written at least 10 minutes before
// its activeFrom) it is future-dated, so it is not what an event sent now is hashed under; that is
// always selectKeyVersion's send-time lookup.
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
