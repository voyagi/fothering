# Fothering

When one stream of the mail you send through Amazon SES starts bouncing, Fothering works out why,
closes that one lane, and asks you by email before it opens again.

Status: early build, not yet runnable end to end.

## Requirements

- Node.js 22.12 or later on the 22 line (Amazon Bedrock AgentCore Runtime runs Node.js 22)
- npm 10 or later

## Setup

```sh
npm ci
cp .env.example .env
```

Every AWS call runs against recorded fixtures unless `FOTHERING_LIVE` is set to `live`. Leave it unset
for development and tests.

## Checks

```sh
npm test            # unit and property tests
npm run lint        # whole-repo lint
npm run gate        # type check, complexity, duplication, boundaries, env file
npm run verify:ship # everything above, in order, with one verdict
```

## Layout

- `packages/core` - the decision core and the provider mode switch
- `docs/adr` - architecture decisions

## Licence

See [LICENSE](LICENSE).
