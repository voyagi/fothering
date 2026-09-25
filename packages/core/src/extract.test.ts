import { describe, expect, it } from 'vitest';
import { loadSesEventFixture } from '@fothering/providers/fixtures/ses-events/index';
import { UNCLASSIFIED } from './records.js';
import {
  callerIdentity,
  extractBasicReplyCode,
  extractEnhancedStatusCode,
  recipientAction,
  recipientStatus,
  reportingMta,
  tagValue,
  validHostname,
  validIp,
} from './extract.js';

const SENTENCE_DIAGNOSTIC =
  'smtp; 550 5.1.1 The account Jane.Doe+x@Example.COM does not exist, see https://help.example.com/550?code=4.2.0';

describe('extractEnhancedStatusCode', () => {
  it('reads the enhanced status code out of a diagnostic line', () => {
    expect(extractEnhancedStatusCode('smtp; 550 5.1.1 user unknown')).toBe('5.1.1');
  });

  // AC-10: an address, a URL and a second dotted number sit in the same sentence; only the first
  // enhanced code comes back, never the address, the URL or the code embedded in it.
  it('returns only the first enhanced code from a sentence holding an address and a URL', () => {
    expect(extractEnhancedStatusCode(SENTENCE_DIAGNOSTIC)).toBe('5.1.1');
  });

  // A dotted IP holds runs that look like a code (10.5.1.7 holds 5.1.7), and a wrong class digit
  // turns a temporary failure into a permanent one in the evidence.
  it.each([
    ['inside an IPv4 address', 'smtp; 421 Service not available, closing channel [10.5.1.7]'],
    ['at the start of an IPv4 address', 'smtp; 421 connection to 5.9.10.11 timed out'],
    ['with more digits than a code holds', 'smtp; 550 see 5.1.1234'],
  ])('reads unclassified for a code-shaped run %s', (_label, text) => {
    expect(extractEnhancedStatusCode(text)).toBe(UNCLASSIFIED);
  });

  it('reads the real code that follows an IP address', () => {
    expect(extractEnhancedStatusCode('smtp; 421 host 10.5.1.7 said: 4.4.2 connection timed out')).toBe('4.4.2');
  });

  it('reads a code that ends a sentence', () => {
    expect(extractEnhancedStatusCode('smtp; 550 mailbox unavailable 5.1.1.')).toBe('5.1.1');
  });
});

describe('extractBasicReplyCode', () => {
  it('reads the three-digit reply code after an smtp; prefix', () => {
    expect(extractBasicReplyCode('smtp; 550 5.1.1 user unknown')).toBe('550');
  });

  it('reads the three-digit reply code from the same planted sentence, and nothing else from it', () => {
    expect(extractBasicReplyCode(SENTENCE_DIAGNOSTIC)).toBe('550');
  });

  it('reads a leading reply code with no smtp; prefix', () => {
    expect(extractBasicReplyCode('250 2.6.0 Message received')).toBe('250');
  });

  it('reads unclassified when the text has no leading code', () => {
    expect(extractBasicReplyCode('no code here')).toBe(UNCLASSIFIED);
  });
});

describe('validIp', () => {
  it('keeps a valid IPv4 address', () => {
    expect(validIp('203.0.113.9')).toBe('203.0.113.9');
  });

  it('keeps a valid IPv6 address', () => {
    expect(validIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('reads unclassified for an address with an out-of-range octet', () => {
    expect(validIp('123.456.789.012')).toBe(UNCLASSIFIED);
  });

  it("reads the Delivery fixture's remoteMtaIp as unclassified, since the AWS example is not a valid IPv4 address", () => {
    const fixture = loadSesEventFixture('delivery');
    const detail = fixture.event as { detail: { delivery: { remoteMtaIp: string } } };
    expect(validIp(detail.detail.delivery.remoteMtaIp)).toBe(UNCLASSIFIED);
  });
});

describe('validHostname', () => {
  it('lowercases a valid hostname', () => {
    expect(validHostname('MTA.Example.com')).toBe('mta.example.com');
  });

  it('reads unclassified for text with no dot and a space', () => {
    expect(validHostname('not a host')).toBe(UNCLASSIFIED);
  });

  it('reads unclassified for a dotted number, which is an invalid IP address, never a hostname', () => {
    expect(validHostname('123.456.789.012')).toBe(UNCLASSIFIED);
    expect(reportingMta('dsn; 999.1.1.1')).toBe(UNCLASSIFIED);
  });

  it('keeps a numeric label before a lettered top-level label', () => {
    expect(validHostname('10.mail.example.com')).toBe('10.mail.example.com');
  });

  it('reads unclassified for a label longer than 63 characters, and keeps one of exactly 63', () => {
    expect(validHostname(`${'a'.repeat(64)}.example.com`)).toBe(UNCLASSIFIED);
    expect(validHostname(`${'a'.repeat(63)}.example.com`)).toBe(`${'a'.repeat(63)}.example.com`);
  });
});

describe('reportingMta', () => {
  it('strips a dsn prefix and keeps a valid hostname', () => {
    expect(reportingMta('dsn; mta.example.com')).toBe('mta.example.com');
  });

  it('keeps a bare IP with no prefix', () => {
    expect(reportingMta('203.0.113.9')).toBe('203.0.113.9');
  });

  it('reads unclassified when neither an IP nor a hostname follows the prefix', () => {
    expect(reportingMta('dsn; <script>')).toBe(UNCLASSIFIED);
  });
});

describe('callerIdentity', () => {
  it('keeps an IAM-shaped identity', () => {
    expect(callerIdentity('ses_user')).toBe('ses_user');
  });

  it('reads unclassified for an address-shaped identity, since @ is never stored', () => {
    expect(callerIdentity('jane@example.com')).toBe(UNCLASSIFIED);
  });
});

describe('recipientStatus', () => {
  it('keeps an enhanced status code on its own', () => {
    expect(recipientStatus('5.1.1')).toBe('5.1.1');
  });

  it('reads unclassified for a full diagnostic line, since the pattern is anchored', () => {
    expect(recipientStatus('smtp; 550 5.1.1 user unknown')).toBe(UNCLASSIFIED);
  });
});

describe('recipientAction', () => {
  it('keeps a documented recipient action', () => {
    expect(recipientAction('failed')).toBe('failed');
  });

  it('reads unclassified for a value the AWS page does not document', () => {
    expect(recipientAction('bounced')).toBe(UNCLASSIFIED);
  });
});

describe('tagValue', () => {
  it('keeps a value built from letters, digits, hyphens and underscores', () => {
    expect(tagValue('newsletter-2026_09')).toBe('newsletter-2026_09');
  });

  it('reads absent for a value holding a space', () => {
    expect(tagValue('two words')).toBeUndefined();
  });

  it('reads absent for a value holding an @ sign', () => {
    expect(tagValue('a@b')).toBeUndefined();
  });

  it('reads absent for a value holding a non-ASCII letter', () => {
    // Built with String.fromCodePoint so this file's own source bytes stay ASCII.
    const value = `caf${String.fromCodePoint(0xe9)}`;
    expect(tagValue(value)).toBeUndefined();
  });

  it('reads absent for a 257-character value', () => {
    expect(tagValue('a'.repeat(257))).toBeUndefined();
  });
});
