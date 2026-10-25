# Live run 1: the operator email that failed

On 2026-10-22, Fothering's first live run in a real SES account paused the bulk configuration set, read the setting
back as disabled and held it, but the operator email failed on all three attempts: `items-incident.json` is the
incident's DynamoDB items exactly as `aws dynamodb query` saved them, with `email.failed` true and no message id. The
cause was ours: in the SES sandbox, SES also authorizes `SendEmail` against the recipient's identity, and the action
role could send only through the sender's identity, so the fix added the operator address's identity to that role and
run 2 the same day delivered the email. The evidence record in the same file shows the ruled-out set beside the cause
(the clean import batch, DKIM and DMARC ruled out, the stale import batch the cause), and
`packages/functions/src/live-run/failed-email-artifact.test.ts` re-derives every verdict and the record's hash from
this file.
