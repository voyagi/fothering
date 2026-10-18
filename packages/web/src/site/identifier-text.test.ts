import { describe, expect, it } from 'vitest';
import { LOG_API_NAMES, textSegments, type Segment } from './identifier-text.js';

const TERMS = { names: ['fothering-bulk', 'fothering-transactional', 'fothering-alerts'], values: ['batch=2026-10-14-b', 'batch=2026-10-14-a'] };
// Each segment as kind:text, so a case reads as one string.
const shown = (segments: readonly Segment[]): string => segments.filter((segment) => segment.text !== '').map((segment) => `${segment.kind}:${segment.text}`).join('|');

describe('textSegments (UI-SPEC lines 207 and 208)', () => {
  it('sets a listed SES API name in a log detail as code, the longest listed name first', () => {
    expect(shown(textSegments('PutConfigurationSetSendingOptions, SendingEnabled false', TERMS, LOG_API_NAMES))).toBe('code:PutConfigurationSetSendingOptions|text:, |code:SendingEnabled|text: false');
    expect(shown(textSegments('GetConfigurationSet, SendingOptions.SendingEnabled true', TERMS, LOG_API_NAMES))).toBe('code:GetConfigurationSet|text:, |code:SendingOptions.SendingEnabled|text: true');
  });

  it('keeps a capitalised compound that is not on the list as plain text', () => {
    expect(shown(textSegments('The agent on AgentCore wrote the Why paragraph', TERMS, LOG_API_NAMES))).toBe('text:The agent on AgentCore wrote the Why paragraph');
  });

  it('sets a tag value as code and a configuration set name as a name, ending at punctuation', () => {
    expect(shown(textSegments('Cause batch=2026-10-14-b, 31 of 31 hard bounces', TERMS))).toBe('text:Cause |code:batch=2026-10-14-b|text:, 31 of 31 hard bounces');
    expect(shown(textSegments('Closed: fothering-bulk. Open: fothering-transactional, fothering-alerts.', TERMS)))
      .toBe('text:Closed: |name:fothering-bulk|text:. Open: |name:fothering-transactional|text:, |name:fothering-alerts|text:.');
  });

  it('keeps backtick spans as code and leaves a longer token that only starts with a name alone', () => {
    expect(shown(textSegments('`GetConfigurationSet` reads it for fothering-bulky', TERMS))).toBe('code:GetConfigurationSet|text: reads it for fothering-bulky');
  });
});
