import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readSavedItems } from './saved-items.js';

const IMAGE = JSON.parse(readFileSync(new URL('../../core/src/fixtures/run-folder-image.json', import.meta.url), 'utf8')) as Record<string, unknown>;

function savedText(path: string): string {
  return JSON.stringify(IMAGE[path], null, 2);
}

function refusalOf(text: string): string {
  try {
    readSavedItems(text);
    return 'no refusal';
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : 'a non-Error throw';
  }
}

describe('readSavedItems', () => {
  it('reads a saved lane query into plain items, numbers and nested maps included', () => {
    const items = readSavedItems(savedText('aws/items-lane-fothering-bulk.json'));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ pk: 'LANE#fothering-bulk', kind: 'send', runId: '<RUN_ID>' });
    expect(items[1]?.fields).toEqual({ bounceType: 'Permanent', remoteMtaIp: '192.0.2.25' });
  });

  it('reads a number attribute as a number', () => {
    const items = readSavedItems(savedText('aws/items-pointers.json'));
    expect(items.map((item) => item.version)).toEqual([1, 0]);
  });

  it('reads a query that found nothing as no items', () => {
    expect(readSavedItems('{"Items":[],"Count":0,"ScannedCount":0}')).toEqual([]);
  });

  it.each([
    ['a text that is not JSON', 'An error occurred (ResourceNotFoundException) when calling the Query operation', 'SavedItemsError: the saved text is not JSON'],
    ['a JSON object without Items', '{"Count":0}', 'SavedItemsError: the saved JSON holds no Items list'],
    ['Items that is not a list', '{"Items":{}}', 'SavedItemsError: the saved JSON holds no Items list'],
    ['a JSON list', '[]', 'SavedItemsError: the saved JSON holds no Items list'],
    ['an entry of plain values', '{"Items":[{"pk":"LANE#fothering-bulk"}]}', 'SavedItemsError: Items entry 1 is not DynamoDB JSON'],
    ['an entry with an unknown type', '{"Items":[{"pk":{"X":"LANE#fothering-bulk"}}]}', 'SavedItemsError: Items entry 1 is not DynamoDB JSON'],
    ['an entry with two types on one attribute', '{"Items":[{"pk":{"S":"a","N":"1"}}]}', 'SavedItemsError: Items entry 1 is not DynamoDB JSON'],
    ['an entry that is a list', '{"Items":[{"pk":{"S":"a"}},[1]]}', 'SavedItemsError: Items entry 2 is not DynamoDB JSON'],
    ['an entry whose nested map holds a plain value', '{"Items":[{"fields":{"M":{"bounceType":"Permanent"}}}]}', 'SavedItemsError: Items entry 1 is not DynamoDB JSON'],
  ])('refuses %s by its named error', (_label, text, expected) => {
    expect(refusalOf(text)).toBe(expected);
  });

  it('refuses a fraction past the safe integer range, which unmarshall cannot convert, by its named error and without the number', () => {
    const digits = `${'9'.repeat(20)}.5`;
    const refusal = refusalOf(`{"Items":[{"count":{"N":"${digits}"}}]}`);
    expect(refusal).toBe('SavedItemsError: Items entry 1 could not be unmarshalled');
  });

  it('never puts the saved text into the error message', () => {
    expect(refusalOf('{"Items":[{"pk":"secret-value@example.com"}]}')).not.toContain('secret-value');
  });
});
