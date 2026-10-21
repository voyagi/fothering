// What the operator email must disclose under Article 50 of the EU AI Act, declared once. Each
// constant is named by a verdict in docs/ai-act.md, which the AI Act gate checks against this file
// and its test; the email renderer imports them and its tests pin where each one appears.

/** Article 50(1): the From header reads `Fothering <address>`, so the sender is named before the email is opened. */
export const FROM_DISPLAY_NAME = 'Fothering';

/**
 * Article 50(1) and 50(2): the one model-written paragraph always sits under this label, whatever the
 * verdicts, so model text never reads as text code wrote.
 */
export const MODEL_PARAGRAPH_LABEL = "The model's explanation, checked by code against the evidence above:";

/** Article 50(1): every email ends by saying an automated agent sent it, and asks for no reply. */
export const AUTOMATED_SENDER_FOOTER =
  'Sent by Fothering, an automated agent. Replies to this address are not read by Fothering.';

/**
 * Article 50(2): the machine-readable mark on an email that shows the model paragraph. A plain-text
 * body has nowhere else to carry one, so it is a message header; an email without the paragraph
 * holds no generated text and carries none.
 */
export const MODEL_TEXT_MARKER_HEADER = {
  name: 'X-Fothering-AI-Generated',
  value: 'model-explanation-paragraph',
} as const;
