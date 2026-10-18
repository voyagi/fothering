// Where a replay text names an identifier (UI-SPEC lines 207 and 208), so the page renders it
// through the Identifier component: a backtick span, a tag value or a listed SES API name is set in
// mono; a configuration set name keeps the face of the text around it, as the comp sets lane names
// in running text, and only never breaks mid-name.

export interface IdentifierTerms {
  // Configuration set names, set in the surrounding face.
  readonly names: readonly string[];
  // Message tag values (key=value), set in mono.
  readonly values: readonly string[];
}

export type SegmentKind = 'text' | 'name' | 'code';

export interface Segment {
  readonly kind: SegmentKind;
  readonly text: string;
}

// The SES API operations and fields the replay's log names. The list is closed, so no other run
// of capitalised words (a product name, say) turns mono unasked.
export const LOG_API_NAMES = Object.freeze(['PutConfigurationSetSendingOptions', 'GetConfigurationSet', 'SendingOptions.SendingEnabled', 'SendingEnabled']);

// A term is a whole token: no word character, dot, equals sign or hyphen touches its start, and its
// end meets the text's end, a character outside those, or a full stop that ends the sentence.
const CONTINUES = /[\w.=-]/;
const startsToken = (text: string, at: number): boolean => at === 0 || !CONTINUES.test(text.charAt(at - 1));
function endsToken(text: string, end: number): boolean {
  if (end === text.length) return true;
  const next = text.charAt(end);
  if (next === '.') return end + 1 === text.length || /\s/.test(text.charAt(end + 1));
  return !CONTINUES.test(next);
}

interface Term {
  readonly text: string;
  readonly kind: SegmentKind;
}

function plainSegments(text: string, terms: readonly Term[]): Segment[] {
  const segments: Segment[] = [];
  let plain = '';
  let at = 0;
  while (at < text.length) {
    const found = terms.find((term) => text.startsWith(term.text, at) && startsToken(text, at) && endsToken(text, at + term.text.length));
    if (found === undefined) {
      plain += text.charAt(at);
      at += 1;
      continue;
    }
    if (plain !== '') segments.push({ kind: 'text', text: plain });
    plain = '';
    segments.push({ kind: found.kind, text: found.text });
    at += found.text.length;
  }
  if (plain !== '') segments.push({ kind: 'text', text: plain });
  return segments;
}

// Backtick spans the view wrote are code; in the text between them every listed term is found,
// the longest first, so SendingOptions.SendingEnabled is never read as SendingEnabled.
export function textSegments(text: string, terms: IdentifierTerms, apiNames: readonly string[] = []): Segment[] {
  const listed: Term[] = [
    ...terms.names.map((name) => ({ text: name, kind: 'name' as const })),
    ...[...terms.values, ...apiNames].map((value) => ({ text: value, kind: 'code' as const })),
  ].filter((term) => term.text !== '').sort((first, second) => second.text.length - first.text.length);
  return text.split('`').flatMap((part, index) => (index % 2 === 1 ? [{ kind: 'code' as const, text: part }] : plainSegments(part, listed)));
}
