# Fothering

When one stream of the mail you send through Amazon SES starts bouncing, Fothering works out why,
closes that one lane, and asks you by email before it opens again.

Status: early build, not yet runnable end to end.

## Requirements

- Node.js 22.18 or later on the 22 line (Amazon Bedrock AgentCore Runtime runs Node.js 22)
- npm 10 or later

## Setup

```sh
npm ci
cp .env.example .env
```

Every AWS call in tests uses recorded fixtures; see Live switch below for what a deployed stack
does with `FOTHERING_LIVE`.

## Checks

```sh
npm test            # unit and property tests
npm run lint        # whole-repo lint
npm run gate        # type check, complexity, duplication, boundaries, env file
npm run verify:ship # everything above, in order, with one verdict
npm run permissions:snapshot # rewrite packages/infra/permissions.json after a role change
```

`packages/infra/permissions.json` lists every permission the two stacks grant. The test suite fails
until it matches the synthesized templates, so a change to a role shows up as a change to that file.

## Live switch

`FOTHERING_LIVE` has three cases:

- Tests: every provider resolves to a fixture whatever the switch holds, and the suite refuses to
  run at all when it reads `live`.
- A deployed stack with `FOTHERING_LIVE` unset: the product's own table, the address key secret
  and the queue are live. As the remaining operations join the port table, every SES read the
  closeability check needs is live too, while every SES pause, reopen and send, every model call
  and every InvokeAgentRuntime becomes one dry-run line instead of a real call.
- A deployed stack with `FOTHERING_LIVE` set to the exact word `live`: those mutations go live as
  later phases build them.

A deployed stack never takes the switch from a shell variable. It reaches a deployed function or
the runtime only through the CDK context key `fothering:live`, and only when that key is exactly
`live`: `LIVE`, `true` and a `FOTHERING_LIVE` set in your shell leave every function and the
runtime as the unset case above. A deploy without the key therefore gives the dry-run setup, and
`-c fothering:live=live` (see Deploy and remove) is the one way to change that.

## Deploy and remove

Run from the owner's account, in `eu-central-1`:

```sh
npm run build
npx cdk bootstrap             # once, before the first deploy
npx cdk deploy --all
npx cdk destroy --all
```

To deploy with the switch on, pass the context key. Do this only after a dry-run week you are
happy with:

```sh
npx cdk deploy --all -c fothering:live=live
```

Before sending any mail through a deployed stack, check that the ingest rule catches your
configuration sets. `npm run build` writes the rule into `cdk.out/FotheringIngest.template.json`:
save the `EventPattern` of its `AWS::Events::Rule` resource as `rule-pattern.json`. Save the `event`
object of `packages/providers/src/fixtures/ses-events/bounce.json` as `sample-event.json`, with its
`ses:configuration-set` tag set to one of the sets in `lanes.json`. This reports whether the rule
matches that event; a configuration set missing from `lanes.json` never matches:

```sh
aws events test-event-pattern --event-pattern file://rule-pattern.json --event file://sample-event.json
```

## Forget one recipient

See [docs/forget-one-recipient.md](docs/forget-one-recipient.md).

## Rotate the address key

Each container caches the key set for 5 minutes, so a rotation is one secret write, never two:

1. Add the new version's secret field and its `activeFrom` (epoch milliseconds; the key read
   refuses a value written in seconds or microseconds) at least 10 minutes after this write, and
   move `current` to the new version, in the same write. The key read refuses a secret whose
   `current` does not name the version with the newest `activeFrom`, so writing the new version
   first and moving `current` afterward stops ingest and forget in between the two writes.
2. Watch the ingest function's log for `key-set-unavailable` in the minutes after the write: a
   malformed secret keeps working in every warm container until its 5-minute cache expires, then
   stops ingest everywhere at once.
3. Remove a retired version's secret field and `activeFrom` entry only after 30 days plus the few
   days a TTL deletion can lag, so every record it could still be hashed under has expired first.

## Layout

- `packages/core` - the decision core and the provider mode switch
- `packages/providers` - the port table, fixtures and live AWS adapters
- `packages/functions` - the ingest and forget Lambda entries
- `packages/agent` - the no-model AgentCore runtime entry
- `packages/infra` - the CDK app and stacks
- `packages/web` - the judge-facing site (later phase)
- `docs/adr` - architecture decisions

## Licence

See [LICENSE](LICENSE).
