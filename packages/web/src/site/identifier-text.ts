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

// Stub until the segmenter is written: backtick spans only.
export function textSegments(text: string, terms: IdentifierTerms, apiNames: readonly string[] = []): Segment[] {
  void terms;
  void apiNames;
  return text.split('`').map((part, index) => ({ kind: index % 2 === 1 ? 'code' : 'text', text: part }));
}
