// RED stub: identity.ts does not exist yet on this branch. Every call throws so minimize.test.ts
// fails on real assertions (a thrown error per test) instead of a module-resolution crash.
export type IdentityInput =
  | { kind: 'Send'; messageId: string; recipientHmac: string }
  | { kind: 'Reject'; messageId: string }
  | { kind: 'Delivery'; messageId: string; recipientHmac: string }
  | { kind: 'Bounce'; feedbackId: string; recipientHmac: string }
  | { kind: 'Complaint'; feedbackId: string }
  | { kind: 'ComplaintRecipient'; feedbackId: string; recipientHmac: string }
  | { kind: 'DeliveryDelay'; messageId: string; recipientHmac: string; delayTimestampMs: number };

export function identityFor(_input: IdentityInput): string {
  throw new Error('identityFor not implemented');
}
