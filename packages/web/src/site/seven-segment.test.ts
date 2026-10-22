import { describe, expect, it } from 'vitest';
import { segmentNumber } from './seven-segment.js';

const litOf = (text: string): string[] => segmentNumber(text).digits.map((digit) => digit.segments.filter((segment) => segment.lit).map((segment) => segment.name).join(''));

describe('segmentNumber', () => {
  it('lights the segments of each digit and draws the rest unlit', () => {
    expect(litOf('412')).toEqual(['bcfg', 'bc', 'abdeg']);
    expect(litOf('0123456789')).toEqual(['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg']);
    for (const digit of segmentNumber('412').digits) expect(digit.segments).toHaveLength(7);
  });

  it('sets each digit one pitch to the right and sizes the view box to the digit count', () => {
    const drawn = segmentNumber('412');
    expect(drawn.digits.map((digit) => digit.transform)).toEqual(['translate(0,0) skewX(-6)', 'translate(50,0) skewX(-6)', 'translate(100,0) skewX(-6)']);
    expect(drawn.viewBox).toBe('-8 0 151 70');
  });

  it('refuses anything but digits', () => {
    for (const text of ['', '4.1', '-3', '41 2']) expect(() => segmentNumber(text), text).toThrow('seven segment:');
  });
});
