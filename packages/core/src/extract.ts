import { isIP } from 'node:net';
import { UNCLASSIFIED } from './records.js';

// D-15, D-37, T-01-52: every extractor below returns a code it matched, a value it validated, or
// unclassified (undefined for a tag). None of them can return the text they were given, so a
// diagnostic line, a smtpResponse or a caller identity can never carry free text into a record.

const ENHANCED_STATUS_CODE_RE = /\b[245]\.\d{1,3}\.\d{1,3}\b/;
const ENHANCED_STATUS_CODE_ANCHORED_RE = /^[245]\.\d{1,3}\.\d{1,3}$/;
// An optional "smtp;" prefix, then a three-digit code not followed by a fourth digit, so a longer
// number at the start of the text is never mistaken for the code.
const BASIC_REPLY_CODE_RE = /^(?:smtp;\s*)?([245]\d{2})(?!\d)/i;
// reportingMTA on a bounce carries a DSN-style "dsn; " prefix; on a delay it is a bare IP. Any
// leading "word;" shape is stripped before the remainder is checked as an IP or a hostname.
const REPORTING_MTA_PREFIX_RE = /^[A-Za-z]+;\s*/;
const HOSTNAME_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const CALLER_IDENTITY_RE = /^[A-Za-z0-9+=,._-]{1,128}$/;
const TAG_VALUE_RE = /^[A-Za-z0-9_-]{1,256}$/;
const RECIPIENT_ACTIONS = ['failed', 'delayed', 'delivered', 'relayed', 'expanded'] as const;

export function extractEnhancedStatusCode(text: string): string {
  return ENHANCED_STATUS_CODE_RE.exec(text)?.[0] ?? UNCLASSIFIED;
}

export function extractBasicReplyCode(text: string): string {
  return BASIC_REPLY_CODE_RE.exec(text)?.[1] ?? UNCLASSIFIED;
}

export function validIp(value: string): string {
  return isIP(value) !== 0 ? value : UNCLASSIFIED;
}

export function validHostname(value: string): string {
  const lower = value.toLowerCase();
  if (lower.length > 253) return UNCLASSIFIED;
  const labels = lower.split('.');
  return labels.length >= 2 && labels.every((label) => HOSTNAME_LABEL_RE.test(label)) ? lower : UNCLASSIFIED;
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

export function tagValue(value: string): string | undefined {
  return TAG_VALUE_RE.test(value) ? value : undefined;
}
