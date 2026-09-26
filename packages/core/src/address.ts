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

// Full normalization (angle brackets, NFC, unparseable input) is plan 01-07's job, behind
// this same signature. This plan implements only what the tracer needs: the domain after the
// last @, and the HMAC over the trimmed lowercased address.
export function pseudonymizeRecipient(
  raw: string,
  keySet: AddressKeySet,
  sendTimeMs: number,
): PseudonymizedRecipient {
  const version = selectKeyVersion(keySet, sendTimeMs);
  const trimmed = raw.trim();
  const domainPart = trimmed.slice(trimmed.lastIndexOf('@') + 1);
  const receivingDomain = domainToASCII(domainPart).toLowerCase();
  const recipientHmac = createHmac('sha256', version.secret).update(trimmed.toLowerCase()).digest('hex');
  return { receivingDomain, recipientHmac, keyVersion: version.id };
}
