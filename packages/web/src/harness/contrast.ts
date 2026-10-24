// Contrast for page text axe-core leaves undecided because it sits on a CSS gradient: the first band
// of every page fades from the sky into the ground. axe names the reason (bgGradient) and the ratio
// the text needs, and the driver reads the text colour and the gradient as the browser computed them,
// with whether the gradient fills its element and whether anything else lies between the text and it;
// this module decides from those readings, and refuses any reading it cannot read whole.

export type Rgb = readonly [number, number, number];

// The facts the driver reads for a color-contrast node axe could not decide.
export interface ContrastReading {
  readonly messageKey?: string;
  readonly expected?: string;
  readonly color?: string;
  readonly background?: string;
  readonly opaque?: boolean;
  // The gradient's element keeps the default background size, repeat, position and clip, so the
  // gradient covers its whole box.
  readonly backgroundWhole?: boolean;
  // Hit testing at the text's centre meets only the text, its own ancestors and then the gradient's
  // element, so nothing from elsewhere on the page is painted between them.
  readonly stackClear?: boolean;
}

export type GradientVerdict =
  | { readonly kind: 'undecided' }
  | { readonly kind: 'pass'; readonly lowest: number }
  | { readonly kind: 'fail'; readonly lowest: number; readonly needed: number };

const UNDECIDED: GradientVerdict = Object.freeze({ kind: 'undecided' });
const COLOUR = /^rgba?\((\d+(?:\.\d+)?), (\d+(?:\.\d+)?), (\d+(?:\.\d+)?)(?:, (\d+(?:\.\d+)?))?\)$/;
const STOP = /^(rgba?\([^)]*\))(?: -?\d+(?:\.\d+)?(?:%|px)){0,2}$/;
const DIRECTION = /^(?:to [a-z]+(?: [a-z]+)?|-?\d+(?:\.\d+)?(?:deg|turn|rad|grad))$/;
// Steps per segment between two stops: fine enough that the lowest ratio is exact to two decimals.
const SAMPLES = 256;

// A colour in the rgb() or rgba() form the browser computes, fully opaque, or null.
export function opaqueRgb(text: string): Rgb | null {
  const match = COLOUR.exec(text.trim());
  if (match === null) return null;
  if (match[4] !== undefined && Number(match[4]) !== 1) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const linear = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = ([red, green, blue]: Rgb): number => 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);

export function contrastRatio(first: Rgb, second: Rgb): number {
  const [high, low] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

// Splits on the commas between a function's arguments, never on those inside a nested rgb().
function topLevelArguments(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(inner.slice(start).trim());
  return parts;
}

// The colour stops of one linear-gradient as Chromium computes it, such as
// `linear-gradient(rgb(217, 230, 255), rgb(255, 255, 255) 92%)`, in order. Null for anything else:
// another kind of image, several layers, an interpolation space, a colour hint, or a stop that is
// not an opaque rgb() colour, so no stop can go unread.
export function gradientStops(image: string): Rgb[] | null {
  const prefix = 'linear-gradient(';
  if (!image.startsWith(prefix) || !image.endsWith(')')) return null;
  const parts = topLevelArguments(image.slice(prefix.length, -1));
  if (parts.length > 0 && DIRECTION.test(parts[0] ?? '')) parts.shift();
  const stops: Rgb[] = [];
  for (const part of parts) {
    const colour = STOP.exec(part)?.[1];
    const rgb = colour === undefined ? null : opaqueRgb(colour);
    if (rgb === null) return null;
    stops.push(rgb);
  }
  return stops.length >= 2 ? stops : null;
}

const mix = (from: Rgb, to: Rgb, share: number): Rgb => [
  from[0] + (to[0] - from[0]) * share,
  from[1] + (to[1] - from[1]) * share,
  from[2] + (to[2] - from[2]) * share,
];

// The lowest contrast of a text colour against any point of the gradient, its opaque stops
// interpolated in sRGB as CSS does for colours written in the legacy rgb() form.
export function lowestContrast(text: Rgb, stops: readonly Rgb[]): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 1 < stops.length; index += 1) {
    const from = stops[index];
    const to = stops[index + 1];
    if (from === undefined || to === undefined) continue;
    for (let step = 0; step <= SAMPLES; step += 1) lowest = Math.min(lowest, contrastRatio(text, mix(from, to, step / SAMPLES)));
  }
  return lowest;
}

// The driver's record is parsed JSON, so a field may hold anything: only a string is read.
const stringField = (value: unknown): string => (typeof value === 'string' ? value : '');

const neededRatio = (expected: string): number | null => {
  const match = /^(\d+(?:\.\d+)?):1$/.exec(expected);
  return match === null ? null : Number(match[1]);
};

// Decides a color-contrast node only when axe gave up because of a gradient and every reading is
// whole: the ratio axe asks for, an opaque text colour with no transparency on the way up, a
// gradient whose every stop is read, that fills its element, with nothing else between it and the
// text. Anything short of that stays undecided and fails the audit.
export function gradientVerdict(reading: ContrastReading): GradientVerdict {
  if (reading.messageKey !== 'bgGradient' || reading.opaque !== true) return UNDECIDED;
  if (reading.backgroundWhole !== true || reading.stackClear !== true) return UNDECIDED;
  const needed = neededRatio(stringField(reading.expected));
  const colour = opaqueRgb(stringField(reading.color));
  const stops = gradientStops(stringField(reading.background));
  if (needed === null || colour === null || stops === null) return UNDECIDED;
  const lowest = lowestContrast(colour, stops);
  return lowest >= needed ? { kind: 'pass', lowest } : { kind: 'fail', lowest, needed };
}
