// Per-event-type dedup identities (INGS-02): the EventBridge envelope id never appears here, so a
// retried delivery of the same underlying SES event always rebuilds the same identity and the
// conditional put absorbs it. A complaint recipient item's identity is always longer than its
// counting record's identity under the same feedbackId, so the two can never collide in the sort key.
export type IdentityInput =
  | { kind: 'Send'; messageId: string; recipientHmac: string }
  | { kind: 'Reject'; messageId: string }
  | { kind: 'Delivery'; messageId: string; recipientHmac: string }
  | { kind: 'Bounce'; feedbackId: string; recipientHmac: string }
  | { kind: 'Complaint'; feedbackId: string }
  | { kind: 'ComplaintRecipient'; feedbackId: string; recipientHmac: string }
  | { kind: 'DeliveryDelay'; messageId: string; recipientHmac: string; delayTimestampMs: number };

export function identityFor(input: IdentityInput): string {
  switch (input.kind) {
    case 'Send':
      return `Send#${input.messageId}#${input.recipientHmac}`;
    case 'Reject':
      return `Reject#${input.messageId}`;
    case 'Delivery':
      return `${input.messageId}#${input.recipientHmac}`;
    case 'Bounce':
      return `${input.feedbackId}#${input.recipientHmac}`;
    case 'Complaint':
      return input.feedbackId;
    case 'ComplaintRecipient':
      return `${input.feedbackId}#${input.recipientHmac}`;
    case 'DeliveryDelay':
      return `${input.messageId}#${input.recipientHmac}#${input.delayTimestampMs}`;
  }
}
