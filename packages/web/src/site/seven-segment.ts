// A number drawn as seven-segment digits at build time, for the readout window. Every segment is
// drawn, lit or unlit, the way a display shows its dark segments; the digits slant like the
// display's glass. The figure stays in the page text beside it, so the drawing is decoration.

// Segment outlines inside one 40 by 70 digit cell, named in the usual a to g order.
const SEGMENTS = {
  a: '6,0 34,0 29,6 11,6',
  b: '35,1 35,33 29,30 29,7',
  c: '35,37 35,69 29,63 29,40',
  d: '6,70 34,70 29,64 11,64',
  e: '5,37 11,40 11,63 5,69',
  f: '5,1 11,7 11,30 5,33',
  g: '7,35 12,31 28,31 33,35 28,39 12,39',
} as const;

type SegmentName = keyof typeof SEGMENTS;

const LIT: Readonly<Record<string, string>> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
};

const PITCH = 50;
const HEIGHT = 70;
// The slant moves the foot of a digit about 7 units left, so the drawing starts 8 units early.
const LEFT = -8;

export interface Segment {
  readonly name: SegmentName;
  readonly points: string;
  readonly lit: boolean;
}

export interface SegmentDigit {
  readonly transform: string;
  readonly segments: readonly Segment[];
}

export interface SegmentNumber {
  readonly viewBox: string;
  readonly digits: readonly SegmentDigit[];
}

export function segmentNumber(text: string): SegmentNumber {
  if (!/^\d+$/.test(text)) throw new Error(`seven segment: "${text}" is not a whole number of digits. Pass the figure as digits only.`);
  const digits = [...text].map((character, index): SegmentDigit => {
    const lit = LIT[character] ?? '';
    return {
      transform: `translate(${String(index * PITCH)},0) skewX(-6)`,
      segments: (Object.keys(SEGMENTS) as SegmentName[]).map((name) => ({ name, points: SEGMENTS[name], lit: lit.includes(name) })),
    };
  });
  return { viewBox: `${String(LEFT)} 0 ${String(text.length * PITCH - 7 - LEFT)} ${String(HEIGHT)}`, digits };
}
