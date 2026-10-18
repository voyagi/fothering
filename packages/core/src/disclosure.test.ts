import { describe, expect, it } from 'vitest';
import * as disclosure from './disclosure.js';

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const EXAMPLE_ADDRESS = /@|example\.(com|org|net)/i;

function textValues(): string[] {
  return Object.values(disclosure).flatMap((value: unknown) => {
    if (typeof value === 'string') return [value];
    if (typeof value === 'object' && value !== null) {
      return Object.values(value).filter((part): part is string => typeof part === 'string');
    }
    return [];
  });
}

describe('disclosure constants', () => {
  it('names the sender Fothering in the From header', () => {
    expect(disclosure.FROM_DISPLAY_NAME).toBe('Fothering');
  });

  it('labels the model paragraph so it never reads as code-made text', () => {
    expect(disclosure.MODEL_PARAGRAPH_LABEL).toBe("The model's explanation, checked by code against the evidence above:");
  });

  it('closes every email with the automated-sender footer, which asks for no reply', () => {
    expect(disclosure.AUTOMATED_SENDER_FOOTER).toBe(
      'Sent by Fothering, an automated agent. Replies to this address are not read by Fothering.',
    );
  });

  it('holds only printable 7-bit ASCII and no address', () => {
    const values = textValues();
    expect(values.length).toBeGreaterThanOrEqual(3);
    for (const value of values) {
      expect(value).toMatch(PRINTABLE_ASCII);
      expect(value).not.toMatch(EXAMPLE_ADDRESS);
    }
  });

  // docs/ai-act.md names this test as the one pinning the Article 50(2) header, so a missing export
  // fails it rather than letting it pass with no assertion.
  it('gives the machine-readable marker a header name SES accepts', () => {
    const marker: unknown = (disclosure as Record<string, unknown>)['MODEL_TEXT_MARKER_HEADER'];
    expect(marker).toEqual({ name: expect.any(String), value: expect.any(String) });
    const { name, value } = marker as { name: string; value: string };
    // SES MessageHeader: the name is printable ASCII 33 to 126 without a colon, at most 126 characters.
    expect(name).toMatch(/^[\x21-\x39\x3b-\x7e]{1,126}$/);
    expect(value).toMatch(PRINTABLE_ASCII);
  });
});
