import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { identifierWordParts, LOG_API_NAMES, longValueParts, textSegments, type Segment } from './identifier-text.js';

// A capitalised word, and a CDK logical id's hash: eight uppercase hex characters.
const capitalised = fc.tuple(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), fc.stringMatching(/^[a-z]{1,8}$/)).map(([head, tail]) => `${head}${tail}`);
const hexHash = fc.stringMatching(/^[0-9A-F]{8}$/);
// Where each part but the last ends, as offsets into the joined text.
const lineEnds = (parts: readonly string[]): number[] => parts.slice(0, -1).reduce<number[]>((ends, part) => [...ends, (ends.at(-1) ?? 0) + part.length], []);

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

describe('longValueParts (the deploy schedules, Schedule.astro)', () => {
  it('ends a part after a slash, a colon or a comma', () => {
    expect(longValueParts('arn:aws:iam::<account>:role/FotheringRole,x')).toEqual(['arn:', 'aws:', 'iam:', ':', '<account>:', 'role/', 'Fothering', 'Role,', 'x']);
  });

  it('never splits inside a CDK hex hash, and starts the word after it on its own', () => {
    expect(longValueParts('FotheringIngestEventsTable165FCE28Arn')).toEqual(['Fothering', 'Ingest', 'Events', 'Table165FCE28', 'Arn']);
    expect(longValueParts('FotheringActionABCDEF12Arn')).toEqual(['Fothering', 'Action', 'ABCDEF12', 'Arn']);
  });

  it('keeps an acronym whole and starts the capitalised word after it', () => {
    expect(longValueParts('SESConfigSet')).toEqual(['SES', 'Config', 'Set']);
  });

  it('gives back exactly the text it was given', () => {
    for (const text of ['', 'a', 'arn:aws:s3:::bucket/key', 'FotheringIngestEventsTable165FCE28Arn', 'SESConfigSet', '1A2B3C4D']) expect(longValueParts(text).join('')).toBe(text);
  });

  it('gives back any text whole, with no empty part', () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }), (text) => {
      const parts = longValueParts(text);
      return parts.join('') === text && (text === '' || parts.every((part) => part !== ''));
    }));
  });

  // CDK names a resource Word...Word<hash>Word...: no line end may fall inside the hash.
  it('never ends a line inside a CDK hash, whatever words stand around it', () => {
    fc.assert(fc.property(fc.array(capitalised, { minLength: 1, maxLength: 3 }), hexHash, fc.array(capitalised, { maxLength: 2 }), (before, hash, after) => {
      const start = before.join('').length;
      const ends = lineEnds(longValueParts(`${before.join('')}${hash}${after.join('')}`));
      return ends.every((end) => end <= start || end >= start + hash.length);
    }));
  });
});

describe('identifierWordParts (the Identifier word mode, UI-SPEC line 208)', () => {
  it('starts a word at each capital after a small letter, and after the colon of an IAM action', () => {
    expect(identifierWordParts('PutConfigurationSetSendingOptions')).toEqual(['Put', 'Configuration', 'Set', 'Sending', 'Options']);
    expect(identifierWordParts('ses:GetConfigurationSetEventDestinations')).toEqual(['ses:', 'Get', 'Configuration', 'Set', 'Event', 'Destinations']);
  });

  it('keeps a run of capitals whole and starts a word after a digit', () => {
    expect(identifierWordParts('GetSES')).toEqual(['Get', 'SES']);
    expect(identifierWordParts('S3Bucket')).toEqual(['S3', 'Bucket']);
  });

  // The same acronym rule longValueParts follows, so an acronym never glues to the word after it.
  it('starts the capitalised word after an acronym', () => {
    expect(identifierWordParts('SESConfigSet')).toEqual(['SES', 'Config', 'Set']);
    expect(identifierWordParts('ses:GetVDMAttributes')).toEqual(['ses:', 'Get', 'VDM', 'Attributes']);
  });

  it('gives back any name whole, with no empty part', () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z0-9]{0,4}:?[A-Za-z0-9]{0,20}$/), (value) => {
      const parts = identifierWordParts(value);
      return parts.join('') === value && (value === '' || parts.every((part) => part !== ''));
    }));
  });
});
