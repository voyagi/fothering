import { isIP } from 'node:net';
import { UNCLASSIFIED } from './records.js';
import { SES_TAG_PATTERN } from './lanes.js';

// D-15, D-37, T-01-52: every extractor below returns a code it matched, a value it validated, or
// unclassified (undefined for a tag). None of them can return the text they were given, so a
// diagnostic line, a smtpResponse or a caller identity can never carry free text into a record.

// A code must stand alone: no word character or dot right before it, and no word character or
// dot-then-digit right after it. A plain \b boundary treats the dot as a boundary, so it read
// 5.1.7 out of the address 10.5.1.7; a sentence-ending dot after the code is still allowed.
// Global, because extractEnhancedStatusCode walks every code-shaped run in order.
const ENHANCED_STATUS_CODE_RE = /(?<![\w.])[245]\.\d{1,3}\.\d{1,3}(?!\w|\.\d)/g;
const ENHANCED_STATUS_CODE_ANCHORED_RE = /^[245]\.\d{1,3}\.\d{1,3}$/;
// An optional "smtp;" prefix, then a three-digit code not followed by a fourth digit, so a longer
// number at the start of the text is never mistaken for the code.
const BASIC_REPLY_CODE_RE = /^(?:smtp;\s*)?([245]\d{2})(?!\d)/i;
// The status code's own slot: right after the reply code and the space or hyphen that ends it
// (RFC 2034 section 3: the text of a reply is "prefaced with a status code").
const STATUS_SLOT_RE = /^(?:smtp;\s*)?[245]\d{2}[ -]([245]\.\d{1,3}\.\d{1,3})(?!\w|\.\d)/i;
// reportingMTA on a bounce carries a DSN-style "dsn; " prefix; on a delay it is a bare IP. Any
// leading "word;" shape is stripped before the remainder is checked as an IP or a hostname.
const REPORTING_MTA_PREFIX_RE = /^[A-Za-z]+;\s*/;
// RFC 1035 caps a label at 63 characters, and a top-level label is never all digits (RFC 3696
// section 2), which is also what keeps an invalid IP such as 123.456.789.012 from passing as a
// hostname once validIp has refused it.
const HOSTNAME_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TOP_LEVEL_LABEL_RE = /[a-z]/;
const CALLER_IDENTITY_RE = /^[A-Za-z0-9+=,._-]{1,128}$/;
const RECIPIENT_ACTIONS = ['failed', 'delayed', 'delivered', 'relayed', 'expanded'] as const;

// A code in the status slot right after the reply code is the status, whatever its class: SES
// itself writes "550 4.4.7 Message expired" when its retry window closes, a 5xx reply with a
// class 4 status. Anywhere else in the text, RFC 2034 section 4 decides: every status code "must
// agree with the primary response code", so a code-shaped run of another class (a server version
// such as Exim 4.94.2, a URL's ?code=4.2.0) is not the status and is skipped. With no reply code
// to agree with, the first run is the code.
export function extractEnhancedStatusCode(text: string): string {
  const slotted = STATUS_SLOT_RE.exec(text)?.[1];
  if (slotted !== undefined) return slotted;
  const replyClass = BASIC_REPLY_CODE_RE.exec(text)?.[1]?.charAt(0);
  for (const match of text.matchAll(ENHANCED_STATUS_CODE_RE)) {
    if (replyClass === undefined || match[0].startsWith(replyClass)) return match[0];
  }
  return UNCLASSIFIED;
}

export function extractBasicReplyCode(text: string): string {
  return BASIC_REPLY_CODE_RE.exec(text)?.[1] ?? UNCLASSIFIED;
}

// node:net isIP accepts an IPv6 zone id (fe80::1%eth0), and the text after the % can be any dotted
// name, so it would carry that name into a field that promises an address. No mail server is
// reached at a link-local scope, so a value with a zone id is refused rather than stored.
export function validIp(value: string): string {
  return !value.includes('%') && isIP(value) !== 0 ? value : UNCLASSIFIED;
}

export function validHostname(value: string): string {
  const lower = value.toLowerCase();
  if (lower.length > 253) return UNCLASSIFIED;
  const labels = lower.split('.');
  const topLevel = labels[labels.length - 1] ?? '';
  const valid = labels.length >= 2 && labels.every((label) => HOSTNAME_LABEL_RE.test(label)) && TOP_LEVEL_LABEL_RE.test(topLevel);
  return valid ? lower : UNCLASSIFIED;
}

export function reportingMta(value: string): string {
  const stripped = value.replace(REPORTING_MTA_PREFIX_RE, '');
  const ip = validIp(stripped);
  return ip !== UNCLASSIFIED ? ip : validHostname(stripped);
}

export function callerIdentity(value: string): string {
  return CALLER_IDENTITY_RE.test(value) ? value : UNCLASSIFIED;
}

export function recipientStatus(value: string): string {
  return ENHANCED_STATUS_CODE_ANCHORED_RE.test(value) ? value : UNCLASSIFIED;
}

export function recipientAction(value: string): string {
  return (RECIPIENT_ACTIONS as readonly string[]).includes(value) ? value : UNCLASSIFIED;
}

// The SES message tag rule is the same for a tag's name and its value, so a value is checked
// against the pattern the lane map checks its tag keys with.
export function tagValue(value: string): string | undefined {
  return SES_TAG_PATTERN.test(value) ? value : undefined;
}
