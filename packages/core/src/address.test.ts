import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { propertySeed } from './test/property-seed.js';
import {
  currentKeyVersion,
  hmacUnderEveryVersion,
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

  it.each(['', '   ', 'no-at-sign', '@example.com', 'jane@', 'jane@exa mple.com'])(
    'treats %j as unparseable',
    (raw) => {
      expect(normalizeAddress(raw)).toBeUndefined();
    },
  );
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

  it('reports the newest retained version as current', () => {
    expect(currentKeyVersion(keySet).id).toBe('k2');
  });

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
