import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { propertySeed } from './test/property-seed.js';
import {
  hmacUnderEveryVersion,
  holdsOneMailbox,
  NoActiveKeyVersionError,
  normalizeAddress,
  pseudonymizeRecipient,
  selectKeyVersion,
  type AddressKeySet,
} from './address.js';

function oneVersionKeySet(secret: string): AddressKeySet {
  return { versions: [{ id: 'k1', secret, activeFromMs: 0 }] };
}

describe('normalizeAddress (D-14)', () => {
  it('strips display-name wrapping, splits at the last @, and lowercases the domain', () => {
    expect(normalizeAddress('  Jane Doe <Jane.Doe+News@Example.COM>  ')).toEqual({
      local: 'jane.doe+news',
      domain: 'example.com',
    });
  });

  it('splits an address holding two @ signs at the last one', () => {
    expect(normalizeAddress('a@b@example.com')).toEqual({ local: 'a@b', domain: 'example.com' });
  });

  it('normalizes a Unicode domain and its punycode form to the same domain', () => {
    // b, U+00FC, c, h, e, r - kept ASCII in this file per the plan's source constraint
    const idnLabel = String.fromCodePoint(0x62, 0xfc, 0x63, 0x68, 0x65, 0x72);
    const unicode = normalizeAddress(`jane@${idnLabel}.example`);
    const punycode = normalizeAddress('jane@xn--bcher-kva.example');
    expect(unicode).toEqual(punycode);
    expect(punycode?.domain).toBe('xn--bcher-kva.example');
  });

  it('normalizes an NFD local part and its NFC form to the same local part', () => {
    const nfdLocal = String.fromCodePoint(0x4a, 0x6f, 0x73, 0x65, 0x301); // J o s e + combining acute
    const nfcLocal = String.fromCodePoint(0x4a, 0x6f, 0x73, 0xe9); // J o s + e-acute (precomposed)
    expect(normalizeAddress(`${nfdLocal}@example.com`)).toEqual(normalizeAddress(`${nfcLocal}@example.com`));
  });

  it.each(['', '   ', 'no-at-sign', '@example.com', 'jane@', 'jane@exa mple.com', '< @example.com>', '<jane@ >'])(
    'treats %j as unparseable',
    (raw) => {
      expect(normalizeAddress(raw)).toBeUndefined();
    },
  );
});

// SES reports a Send's destination as the sender wrote it, display name included, while a bounce
// names the bare address. Both must reduce to one HMAC or a forget request reaches only one of them.
describe('normalizeAddress on name-addr edge forms', () => {
  it.each([
    ['a display name quoting its own angle brackets', '"Sales <EU>" <Jane@Example.com>', { local: 'jane', domain: 'example.com' }],
    ['a quoted local part holding an angle bracket', '<"a<b"@Example.com>', { local: '"a<b"', domain: 'example.com' }],
    ['a display name quoting an @', '"jane@evil.example" <jane@example.com>', { local: 'jane', domain: 'example.com' }],
    ['a display name whose quote never closes', '"Jane <Jane@Example.com>', { local: 'jane', domain: 'example.com' }],
    ['a quoted local part holding an escaped quote and a bracket', '<"a\\"<b"@Example.com>', { local: '"a\\"<b"', domain: 'example.com' }],
    ['spaces inside the angle brackets', 'Jane < Jane@Example.com >', { local: 'jane', domain: 'example.com' }],
    ['spaces around the @ inside the angle brackets', 'Jane <jane @ Example.com>', { local: 'jane', domain: 'example.com' }],
    ['a bare address with spaces around the @', 'Jane @ Example.com', { local: 'jane', domain: 'example.com' }],
  ])('reduces %s to the bare address', (_label, raw, expected) => {
    expect(normalizeAddress(raw)).toEqual(expected);
  });

  it('hashes a display-name destination and the bare bounce address to one HMAC', () => {
    const keySet = oneVersionKeySet('secret-one');
    const send = pseudonymizeRecipient('"Sales <EU>" <jane@example.com>', keySet, 0);
    const bounce = pseudonymizeRecipient('jane@example.com', keySet, 0);
    expect(send.recipientHmac).toBe(bounce.recipientHmac);
  });

  // RFC 5322 lets whitespace sit inside the angle brackets, and domainToASCII returns '' for a domain
  // carrying a space: untrimmed, this destination reads as unparseable and is hashed whole, apart
  // from the bare address a bounce names.
  it('hashes a destination with spaces inside its angle brackets and the bare bounce address to one HMAC, under the real receiving domain', () => {
    const keySet = oneVersionKeySet('secret-one');
    const send = pseudonymizeRecipient('Jane < jane@example.com >', keySet, 0);
    const bounce = pseudonymizeRecipient('jane@example.com', keySet, 0);
    expect(send.recipientHmac).toBe(bounce.recipientHmac);
    expect(send.receivingDomain).toBe('example.com');
  });
});

// Only a '<' followed later by a '>' is a bracketed address. A lone '<', a lone '>', or a '>' that
// comes before the '<' leaves the field as written, so it is split and checked whole rather than
// cut down to a slice that happens to parse.
describe('normalizeAddress when the angle brackets do not form a pair', () => {
  it('reads a field with a "<" and no closing ">" whole', () => {
    expect(normalizeAddress('Jane <jane@example.com')).toEqual({ local: 'jane <jane', domain: 'example.com' });
  });

  it('treats a field with a ">" and no "<" as unparseable, since the domain keeps the ">"', () => {
    expect(normalizeAddress('jane@example.com>')).toBeUndefined();
  });

  it('reads a field whose ">" comes before its "<" whole', () => {
    expect(normalizeAddress('x> Jane <jane@example.com')).toEqual({ local: 'x> jane <jane', domain: 'example.com' });
  });
});

// RFC 5322 lets a comment in parentheses sit beside an address, and the old "addr (Name)" form puts
// the name there. domainToASCII returns '' for "example.com (Jane)" and keeps the parentheses of
// "example.com(Jane)", so unstripped, a commented destination is hashed apart from the bare address
// a bounce names, and a forget request for that bare address never reaches its record.
describe('normalizeAddress with RFC 5322 comments', () => {
  it.each([
    ['a trailing comment after a space', 'jane@example.com (Jane)'],
    ['a trailing comment with no space', 'jane@Example.com(Jane)'],
    ['a comment after the closing angle bracket', 'Jane <jane@example.com> (work)'],
    ['a comment before the address', '(Jane) jane@example.com'],
    ['a comment beside the @', 'jane(x)@example.com'],
    ['a nested comment', 'jane@example.com (Jane (Sales))'],
    ['a comment holding an escaped parenthesis', 'jane@example.com (Jane \\) Doe)'],
    ['a comment holding a quote', 'jane@example.com (Jane "x)'],
    ['a comment holding angle brackets', 'jane@example.com (Jane <bob@example.org>)'],
  ])('reduces %s to the bare address', (_label, raw) => {
    expect(normalizeAddress(raw)).toEqual({ local: 'jane', domain: 'example.com' });
  });

  it('keeps the parentheses of a quoted local part, which are text and not a comment', () => {
    expect(normalizeAddress('"a(b)"@Example.com')).toEqual({ local: '"a(b)"', domain: 'example.com' });
  });

  it('keeps the parentheses of a quoted local part holding an escaped quote', () => {
    expect(normalizeAddress('"a\\"(b)"@Example.com')).toEqual({ local: '"a\\"(b)"', domain: 'example.com' });
  });

  it('reads a comment as a space, so it never joins the two halves of a domain', () => {
    expect(normalizeAddress('jane@exam(x)ple.com')).toBeUndefined();
  });

  it('reads a nested comment as one space, not one per level', () => {
    expect(normalizeAddress('a(b(c))d@Example.com')).toEqual({ local: 'a d', domain: 'example.com' });
  });

  it('strips nothing from a comment that never closes, so the field stays unparseable', () => {
    expect(normalizeAddress('jane@example.com (Jane')).toBeUndefined();
  });

  it('hashes a commented destination, with and without a space, and the bare bounce address to one HMAC, under the real receiving domain', () => {
    const keySet = oneVersionKeySet('secret-one');
    const bounce = pseudonymizeRecipient('jane@example.com', keySet, 0);
    for (const destination of ['jane@example.com (Jane)', 'jane@example.com(Jane)']) {
      const send = pseudonymizeRecipient(destination, keySet, 0);
      expect(send.recipientHmac).toBe(bounce.recipientHmac);
      expect(send.receivingDomain).toBe('example.com');
    }
  });

  it('lets a forget request for the bare address reach a record stored from a commented destination, and no other', () => {
    const keySet = oneVersionKeySet('secret-one');
    const stored = pseudonymizeRecipient('jane@example.com(Jane)', keySet, 0).recipientHmac;
    expect(hmacUnderEveryVersion('jane@example.com', keySet).map((entry) => entry.recipientHmac)).toEqual([stored]);
    expect(hmacUnderEveryVersion('bob@example.com', keySet).map((entry) => entry.recipientHmac)).not.toContain(stored);
  });

  // The forget payload must pass holdsOneMailbox before any hash is taken, so a destination stored
  // under the bare hash is reachable by its own spelling too, not only by the bare address.
  it.each([['a comment before the @', 'jane(x)@example.com'], ['a comment after the @', 'jane@(x)example.com']])(
    'accepts a forget request spelled with %s and reaches the bare address record',
    (_label, spelling) => {
      const keySet = oneVersionKeySet('secret-one');
      const stored = pseudonymizeRecipient('jane@example.com', keySet, 0).recipientHmac;
      expect(holdsOneMailbox(spelling)).toBe(true);
      expect(hmacUnderEveryVersion(spelling, keySet).map((entry) => entry.recipientHmac)).toEqual([stored]);
    },
  );

  // A field that is only a comment holds no list, so a forget request may name it; with no @ left it
  // is unparseable, and like any unparseable text it is hashed whole, comment included (AC-E24).
  it('hashes a field holding only a comment whole, so a forget for that text reaches its record and the bare name does not', () => {
    const keySet = oneVersionKeySet('secret-one');
    expect(holdsOneMailbox('(Jane)')).toBe(true);
    expect(normalizeAddress('(Jane)')).toBeUndefined();
    const stored = pseudonymizeRecipient('(Jane)', keySet, 0);
    expect(stored.receivingDomain).toBe('unparseable');
    expect(hmacUnderEveryVersion('(jane)', keySet).map((entry) => entry.recipientHmac)).toEqual([stored.recipientHmac]);
    expect(hmacUnderEveryVersion('Jane', keySet).map((entry) => entry.recipientHmac)).not.toContain(stored.recipientHmac);
  });
});

// A forget request names one person, and normalizeAddress reads the LAST bracketed address of a
// field, so a list must be refused before any hash is taken: "Jane <jane@...>, Bob <bob@...>" would
// otherwise reach Bob for a request about Jane.
describe('holdsOneMailbox', () => {
  const accepted = [
    ['a bare address', 'jane@example.com'],
    ['a display-name form', 'Jane Doe <jane@example.com>'],
    ['a display name quoting a comma', '"Doe, Jane" <jane@example.com>'],
    ['a display name quoting its own angle brackets', '"Sales <EU>" <jane@example.com>'],
    ['a quoted local part holding an angle bracket', '<"a<b"@example.com>'],
    ['a display name whose quote never closes', '"Jane <jane@example.com>'],
    ['a quoted local part holding an escaped quote and a bracket', '<"a\\"<b"@example.com>'],
    ['a bare address with a trailing comment', 'jane@example.com (Jane)'],
    ['a bare address with a trailing comment and no space', 'jane@example.com(Jane)'],
    ['a display-name form with a comment after the closing bracket', 'Jane <jane@example.com> (work)'],
    ['a comment holding a comma', 'jane@example.com (Doe, Jane)'],
    ['a comment holding a bracketed address', 'jane@example.com (Jane <bob@example.org>)'],
    ['a comment after a display name whose quote never closes', '"Jane <jane@example.com> (work)'],
    ['a bare address with a comment before the @', 'jane(x)@example.com'],
    ['a bare address with a comment after the @', 'jane@(x)example.com'],
    ['a bare address with whitespace on either side of the @', 'jane @ example.com'],
    ['a quoted display name holding an @', '"jane@example.com" <jane@example.com>'],
    ['a quoted display name holding the same address in other letter case', '"JANE@Example.com" <jane@example.com>'],
  ] as const;

  it.each(accepted)('accepts %s', (_label, raw) => {
    expect(holdsOneMailbox(raw)).toBe(true);
  });

  // What the gate lets through is what forget hashes, so normalizeAddress must read each accepted
  // field as the address the gate judged, not an end moved by text after it.
  it.each(accepted)('reads %s as an address at example.com', (_label, raw) => {
    expect(normalizeAddress(raw)?.domain).toBe('example.com');
  });

  it.each([
    ['two display-name forms', 'Jane <jane@example.com>, Bob <bob@example.org>'],
    ['a display-name form then a bare address', 'Jane <jane@example.com>, bob@example.org'],
    ['two bare addresses and a comma', 'jane@example.com, bob@example.org'],
    ['two bare addresses and a semicolon', 'jane@example.com; bob@example.org'],
    ['two bare addresses and a comma with no space', 'jane@example.com,bob@example.org'],
    ['two bare addresses and a semicolon with no space', 'jane@example.com;bob@example.org'],
    ['two bare addresses and a space', 'jane@example.com bob@example.org'],
    ['two bracketed addresses and no separator', '<jane@example.com> <bob@example.org>'],
    ['text after the closing bracket', 'Jane <jane@example.com> bob@example.org'],
    ['an address as the display name before a bracketed one', 'jane@example.com <bob@example.org>'],
    ['an address as the display name with no space before the bracket', 'jane@example.com<bob@example.org>'],
    // A mail client shows the quoted name, so this reads as Jane and would delete Bob's records.
    ['a quoted display name holding a different address', '"jane@example.com" <bob@example.org>'],
    ['a quoted display name holding the same local part at another domain', '"jane@example.org" <jane@example.com>'],
    ['a quoted display name holding an address and more text', '"jane@example.com, Bob" <bob@example.org>'],
    ['a list behind a quote that never closes', '"Jane, <jane@example.com>, <bob@example.org>'],
    ['a second address after a comment', 'jane@example.com (Jane) bob@example.org'],
    ['a list whose first address carries a comment', 'jane@example.com (Jane), bob@example.org'],
    ['a comment that never closes', 'jane@example.com (Jane'],
    ['a comment that never closes behind a quote that never closes', '"Jane <jane@example.com> (work'],
    ['a space beside the @ and another between two addresses', 'jane @example.com bob@example.org'],
    ['a space inside the local part, away from the @', 'jane doe@example.com'],
    ['a space inside the domain, away from the @', 'jane@example .com'],
    ['two words and no @', 'Jane Doe'],
    ['a quoted string holding a > after the closing bracket', '<jane@example.com> "x>"'],
    ['a quoted string after the closing bracket', '<jane@example.com> "x"'],
    ['a second > after the closing bracket', '<jane@example.com>>'],
    ['a quote that never closes after the closing bracket', '<jane@example.com> "x>'],
  ])('refuses %s', (_label, raw) => {
    expect(holdsOneMailbox(raw)).toBe(false);
  });

  it('accepts every generated address, bare and inside a display-name form (fixed seed)', () => {
    fc.assert(
      fc.property(fc.emailAddress(), (address) => {
        expect(holdsOneMailbox(address)).toBe(true);
        expect(holdsOneMailbox(`Some Name <${address}>`)).toBe(true);
      }),
      { seed: propertySeed() },
    );
  });
});

// Comment text with every character the readers treat specially except the three that end or
// escape a comment, so a comment can never leak a separator, bracket, quote or @ into a reading.
const commentText = fc.string({ unit: fc.constantFrom('a', 'Z', ' ', ',', ';', '@', '<', '>', '"', '.'), maxLength: 12 });

describe('RFC 5322 comments on generated addresses (fixed seed)', () => {
  it('reads a comment after the address or on either side of its @ as the bare address, and as one mailbox', () => {
    fc.assert(
      fc.property(fc.emailAddress(), commentText, (address, comment) => {
        const atIndex = address.lastIndexOf('@');
        const local = address.slice(0, atIndex);
        const domain = address.slice(atIndex + 1);
        for (const spelling of [`${address} (${comment})`, `${local}(${comment})@${domain}`, `${local}@(${comment})${domain}`]) {
          expect(normalizeAddress(spelling)).toEqual(normalizeAddress(address));
          expect(holdsOneMailbox(spelling)).toBe(true);
        }
      }),
      { seed: propertySeed() },
    );
  });

  it('refuses two addresses joined only by a comment, whatever the comment holds', () => {
    fc.assert(
      fc.property(fc.emailAddress(), fc.emailAddress(), commentText, (first, second, comment) => {
        expect(holdsOneMailbox(`${first}(${comment})${second}`)).toBe(false);
        expect(holdsOneMailbox(`${first} (${comment}) ${second}`)).toBe(false);
      }),
      { seed: propertySeed() },
    );
  });
});

describe('pseudonymizeRecipient (unchanged signature, completed normalization)', () => {
  it('gives the same HMAC for case variants and a different one for a plus-tagged address', () => {
    const keySet = oneVersionKeySet('secret-one');
    const base = pseudonymizeRecipient('jane@example.com', keySet, 0);
    const upper = pseudonymizeRecipient('Jane@Example.COM', keySet, 0);
    const plusTagged = pseudonymizeRecipient('jane+a@example.com', keySet, 0);

    expect(upper.recipientHmac).toBe(base.recipientHmac);
    expect(upper.receivingDomain).toBe(base.receivingDomain);
    expect(plusTagged.recipientHmac).not.toBe(base.recipientHmac);
  });

  it('gives a different HMAC for the same address under a different key, and a plain SHA-256 helper fails that assertion', () => {
    const keySetA = oneVersionKeySet('secret-one');
    const keySetB = oneVersionKeySet('secret-two');

    expect(pseudonymizeRecipient('jane@example.com', keySetA, 0).recipientHmac).not.toBe(
      pseudonymizeRecipient('jane@example.com', keySetB, 0).recipientHmac,
    );

    // The differs-by-key assertion itself must be able to fail: run it against a helper that
    // ignores the key entirely, proving the assertion is discriminating, not vacuous.
    const plainHash = (raw: string) => createHash('sha256').update(raw.trim().toLowerCase()).digest('hex');
    expect(() => {
      expect(plainHash('jane@example.com')).not.toBe(plainHash('jane@example.com'));
    }).toThrow();
  });

  it.each(['', '   ', 'no-at-sign', '@example.com', 'jane@'])(
    'stores no plaintext for the unparseable recipient %j: receiving domain unparseable, HMAC of the trimmed lowercased string',
    (raw) => {
      const keySet = oneVersionKeySet('secret-one');
      const result = pseudonymizeRecipient(raw, keySet, 0);
      expect(result.receivingDomain).toBe('unparseable');
      expect(result.recipientHmac).toBe(createHmac('sha256', 'secret-one').update(raw.trim().toLowerCase()).digest('hex'));
      expect(result.keyVersion).toBe('k1');
    },
  );
});

describe('key version selection by send time (D-34)', () => {
  const ROTATION_MS = 1_700_000_000_000;
  const keySet: AddressKeySet = {
    versions: [
      { id: 'k1', secret: 'secret-one', activeFromMs: 0 },
      { id: 'k2', secret: 'secret-two', activeFromMs: ROTATION_MS },
    ],
  };

  it('selects k1 before the rotation and k2 at or after it', () => {
    expect(selectKeyVersion(keySet, ROTATION_MS - 1).id).toBe('k1');
    expect(selectKeyVersion(keySet, ROTATION_MS).id).toBe('k2');
  });

  it('selects the active version for a send inside the rotation margin, not the future-dated newest one', () => {
    const sendInsideMarginMs = ROTATION_MS - 5 * 60 * 1000;
    expect(selectKeyVersion(keySet, sendInsideMarginMs).id).toBe('k1');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses the send time %s instead of picking the newest version',
    (sendTimeMs) => {
      expect(() => selectKeyVersion(keySet, sendTimeMs)).toThrow(NoActiveKeyVersionError);
    },
  );

  it('hashes under every retained version, newest first, matching what pseudonymizeRecipient gives at the send time of each version', () => {
    const every = hmacUnderEveryVersion('jane@example.com', keySet);
    expect(every.map((entry) => entry.keyVersion)).toEqual(['k2', 'k1']);
    expect(every[0]?.recipientHmac).toBe(pseudonymizeRecipient('jane@example.com', keySet, ROTATION_MS).recipientHmac);
    expect(every[1]?.recipientHmac).toBe(pseudonymizeRecipient('jane@example.com', keySet, 0).recipientHmac);
  });
});

describe('normalization property (fixed seed)', () => {
  it('is idempotent, and the HMAC is unchanged by upper-casing the whole address', () => {
    const keySet = oneVersionKeySet('secret-one');
    fc.assert(
      fc.property(fc.emailAddress(), (address) => {
        const normalized = normalizeAddress(address);
        if (normalized === undefined) return;
        const reNormalized = normalizeAddress(`${normalized.local}@${normalized.domain}`);
        expect(reNormalized).toEqual(normalized);

        const upperHmac = pseudonymizeRecipient(address.toUpperCase(), keySet, 0).recipientHmac;
        const lowerHmac = pseudonymizeRecipient(address, keySet, 0).recipientHmac;
        expect(upperHmac).toBe(lowerHmac);
      }),
      { seed: propertySeed() },
    );
  });
});
