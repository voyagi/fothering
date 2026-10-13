// Every pinned model value of the agent, declared once (D-68, D-75, D-76). The runtime, detection,
// the infra stack's IAM ARNs and the eval all read these, so a value changed here changes everywhere
// together. Plain values only: core imports nothing from the model SDK, and the live adapter turns
// them into provider options. Each value names its reason and whether the fact behind it is VERIFIED
// or UNVERIFIED; an UNVERIFIED one is measured at the owner checkpoint before any number is claimed.
export const MODEL_VALUES = {
  // EU geo inference profile, passed as the provider's modelId. A global profile routes worldwide and
  // contradicts the EU processing statement, and the bare id is not served on demand. VERIFIED, model card.
  inferenceProfileId: 'eu.anthropic.claude-sonnet-5',
  // Reported in every result and used in the foundation-model IAM ARNs. VERIFIED, model card.
  modelId: 'anthropic.claude-sonnet-5',
  // The profile's source Region and the Regions it may route to; the runtime role grants the profile
  // in the source and the foundation model in each destination (D-82). VERIFIED, model card; re-read
  // live at the owner checkpoint.
  sourceRegion: 'eu-central-1',
  destinationRegions: ['eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-3'],
  // No thinking field means adaptive thinking on this model, so "disabled" is sent on every call.
  // VERIFIED, thinking page per-model table; Bedrock pass-through confirmed at the checkpoint.
  thinking: 'disabled',
  // One paragraph of at most 600 code points plus the tool-call JSON fits far below it. VERIFIED
  // within the model's limit; the fit is measured at the checkpoint.
  maxTokens: 1_024,
  // A normal run takes one call; a plain-text answer or a failed parse costs one more, and one
  // throttling retry one more. VERIFIED from the SDK's compiled agent loop, given throttleAttempts 2.
  modelCallCeiling: 3,
  // Bounds one call's input: a 16,384-byte record, at most 3,072 bytes of system prompt and tool spec,
  // and 1,024 bytes of framing, under the assumption that a token covers at least one byte. That
  // tokenizer assumption is UNVERIFIED: the first measurement is the checkpoint's TokenUsage.
  inputTokenCeiling: 20_480,
  // The SDK's tool spec is input on every call too, so prompt and spec share one budget. Arithmetic
  // from verified sizes; the framing Bedrock adds for tool use is UNVERIFIED.
  promptAndToolSpecByteBudget: 3_072,
  systemPromptByteBudget: 2_048,
  // Short enough to read in an email, counted in code points of the NFC form by core's validator,
  // never by a UTF-16 length. A choice.
  explanationMaxCodePoints: 600,
  // Detection's wait for one invocation, leaving its 300-second function room for the SES and DNS
  // reads (D-40). A choice; model latency UNVERIFIED until the checkpoint.
  agentInvocationTimeoutMs: 90_000,
  // agentInvocationTimeoutMs less 10 seconds, so no model call starts after detection stopped waiting.
  runtimeDeadlineMs: 80_000,
  // One 1,024-token answer has no reason to take a minute, and a hung request must not outlive
  // detection's timeout. The option is VERIFIED in the provider's types; the value is a judgment.
  requestTimeoutMs: 60_000,
  // The SDK's default is six attempts with backoff up to 240 seconds, which breaks the ceiling and
  // the timeout; only a throttling error is retried. VERIFIED, retry strategy types.
  throttleAttempts: 2,
  throttleBackoffMs: 2_000,
  // A client-level retry never passes through the counting wrapper, so it would be an uncounted
  // request. VERIFIED, maxAttempts in the client's retry config.
  clientMaxAttempts: 1,
  // A free answer plus one forced or corrective cycle. The SDK's graceful stop; the call ceiling stays
  // the hard bound because throttling retries happen inside a cycle. VERIFIED, InvokeOptions.limits.
  loopTurns: 2,
  // First attempt and two retries per incident, and the day's checkpoint, three live runs and a few
  // retries (D-76). Choices.
  perIncidentInvocations: 3,
  perDayInvocations: 6,
  // Six full reservations fit and a seventh does not, so both day caps bind at the sixth invocation.
  // Arithmetic VERIFIED (D-68).
  perDayTokenReservations: 390_000,
} as const;

/** The worst one invocation can spend: every allowed call at its full input and output bound (D-68). */
export const TOKEN_RESERVATION_PER_INVOCATION = MODEL_VALUES.modelCallCeiling * (MODEL_VALUES.maxTokens + MODEL_VALUES.inputTokenCeiling);

/** The four values R9 says every runtime result carries. */
export const PINNED_MODEL_VALUES = {
  modelId: MODEL_VALUES.modelId,
  profileId: MODEL_VALUES.inferenceProfileId,
  maxTokens: MODEL_VALUES.maxTokens,
  thinking: MODEL_VALUES.thinking,
} as const;
