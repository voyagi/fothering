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

// text with its RFC 5322 comments taken out, or undefined when a comment never closes. A comment is
// a parenthesis outside a quoted string up to the one that closes it; comments nest, and a
// backslash inside one escapes the character after it. To the grammar a comment is folding
// whitespace, so each becomes one space and never joins the text on either side of it. With
// honourQuotes false a quote is an ordinary character.
function stripComments(text: string, honourQuotes: boolean): { stripped: string; openQuote: boolean } | undefined {
  let stripped = '';
  let depth = 0;
  let inQuotes = false;
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (depth > 0) {
      if (char === '\\') index += 1;
      else if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) stripped += ' ';
      }
    } else if (inQuotes) {
      stripped += char;
      if (char === '\\') {
        index += 1;
        stripped += text.charAt(index);
      } else if (char === '"') inQuotes = false;
    } else if (char === '(') depth = 1;
    else {
      stripped += char;
      if (honourQuotes && char === '"') inQuotes = true;
    }
  }
  return depth > 0 ? undefined : { stripped, openQuote: inQuotes };
}

// A send may name "jane@... (Jane)" where its bounce names the bare "jane@...", so every reading of
// an address starts here.
// A quote that never closes leaves no quoted part, as in unquotedPositions, so its parentheses are
// comments too. A comment that never closes strips nothing, as a '<' with no '>' leaves the field
// whole.
function withoutComments(text: string): string {
  const honouringQuotes = stripComments(text, true);
  if (honouringQuotes === undefined) return text;
  if (!honouringQuotes.openQuote) return honouringQuotes.stripped;
  return stripComments(text, false)?.stripped ?? text;
}

// The address in a display-name form sits in the last angle brackets outside a quoted string: a
// display name may quote a '<' of its own ("Sales <EU>" followed by the bracketed address), and a
// quoted local part may hold one inside the brackets. -1 when there is none.
function angleAddrStart(text: string): number {
  return unquotedPositions(text).findLast((index) => text[index] === '<') ?? -1;
}

// A bare field with the whitespace around its last '@' taken out, the same trim normalizeAddress
// gives each side of the split.
function bareWithoutSpaceAtTheAt(bare: string): string {
  const atIndex = bare.lastIndexOf('@');
  if (atIndex === -1) return bare;
  return `${bare.slice(0, atIndex).trimEnd()}@${bare.slice(atIndex + 1).trimStart()}`;
}

// A forget request names one person, and normalizeAddress reads the LAST bracketed address of a
// field, so "Jane <jane@...>, Bob <bob@...>" would reach Bob for a request about Jane. Outside
// quoted strings and comments, one mailbox holds no comma or semicolon (the list separators), at
// most one '<', nothing after the '>' that closes it, and, written bare, no whitespace except beside
// its last '@', which normalizeAddress trims from each side (so "jane(x)@..." reads as Jane).
export function holdsOneMailbox(raw: string): boolean {
  const trimmed = withoutComments(raw).trim();
  const outside = unquotedPositions(trimmed)
    .map((index) => trimmed[index])
    .join('');
  if (/[,;]/.test(outside)) return false;
  const opens = outside.split('<').length - 1;
  if (opens === 0) return !/\s/.test(bareWithoutSpaceAtTheAt(outside));
  if (opens > 1) return false;
  // An unquoted display name is a phrase, and no word of a phrase holds an '@': text before the '<'
  // that does is a second address ("jane@... <bob@...>"), and the bracketed one is a different person.
  // A quoted display name was taken out of outside above, so '"jane@..." <jane@...>' still passes.
  if (outside.slice(0, outside.indexOf('<')).includes('@')) return false;
  // With no '>' at all the slice is the whole field, which holds the '<', so it is refused too.
  return outside.slice(outside.lastIndexOf('>') + 1).trim() === '';
}

// D-14: take out comments, trim, take the address out of an angle-bracket display-name form if
// present, split at the last @ (a local part is free to hold its own @), then trim each side.
// Comments come out first so that a '<', '>' or '@' inside one is never read. RFC 5322's grammar
// lets whitespace sit inside the brackets, after the '<' and before the '>', and, though the RFC
// advises against it, on either side of the @. domainToASCII returns '' for a domain carrying a
// space, so untrimmed, such an address would read as unparseable. Domain through
// url.domainToASCII then lowercase (an empty result is unparseable), local part normalize('NFC')
// then toLowerCase(), plus-tags kept as-is. undefined means unparseable (AC-E24): no @, a local
// part or a domain that is empty once trimmed, or a domain domainToASCII rejects.
export function normalizeAddress(raw: string): NormalizedAddress | undefined {
  const trimmed = withoutComments(raw).trim();
  const angleStart = angleAddrStart(trimmed);
  const angleEnd = trimmed.lastIndexOf('>');
  const unwrapped = angleStart !== -1 && angleEnd > angleStart ? trimmed.slice(angleStart + 1, angleEnd) : trimmed;

  const atIndex = unwrapped.lastIndexOf('@');
  if (atIndex === -1) return undefined;
  const localRaw = unwrapped.slice(0, atIndex).trim();
  const domainRaw = unwrapped.slice(atIndex + 1).trim();
  if (localRaw === '' || domainRaw === '') return undefined;

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
// equal after that transform still collide on the same hash (never on the raw text itself). The
// caller passes raw's own normalizeAddress result, so an address is normalized once per call.
function hashInputFor(raw: string, normalized: NormalizedAddress | undefined): string {
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
  const recipientHmac = keyedHash(hashInputFor(raw, normalized), version.secret);
  return { receivingDomain, recipientHmac, keyVersion: version.id };
}

// The delete path (plan 01-07's forget command) does not know which key version wrote a given
// record, so it hashes the target address under every retained version and queries each in turn;
// newest first matches the report order the operator reads (D-18).
export function hmacUnderEveryVersion(
  raw: string,
  keySet: AddressKeySet,
): { keyVersion: string; recipientHmac: string }[] {
  const input = hashInputFor(raw, normalizeAddress(raw));
  const newestFirst = [...keySet.versions].sort((a, b) => b.activeFromMs - a.activeFromMs);
  return newestFirst.map((version) => ({ keyVersion: version.id, recipientHmac: keyedHash(input, version.secret) }));
}
