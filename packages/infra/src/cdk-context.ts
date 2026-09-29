import cdkJson from '../../../cdk.json' with { type: 'json' };

// The context the CDK CLI hands the app on every deploy. An in-process synth (the permissions
// snapshot, the synth tests) has no CLI to pass it, so it reads the same file: a feature flag set
// there must shape the templates those checks look at, not only the ones a deploy uploads.
export const cdkJsonContext: Readonly<Record<string, unknown>> = cdkJson.context;
