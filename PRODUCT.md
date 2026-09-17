# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Operators at small software and online shop teams**, roughly 2 to 50 people, who send transactional and marketing email through Amazon SES without a deliverability specialist. The person who reads Fothering's email is usually a developer or founder who set up SES once and now owns it on top of their real job. Their situation: one stream (a newsletter, a partner list import) starts bouncing or drawing complaints, and the account reputation it damages is shared with receipts and password resets.
- **AWS partners who run SES for their clients** and need a closure they can explain to that client.
- **First readers: the judges** of the AWS CDS Agentic AI Partner Hackathon, people from AWS Communication Developer Services who know SES deeply. Every claim on every page has to survive an SES expert reading it.

## Product Purpose

Fothering reads every SES event per configuration set and message tag (send, delivery, bounce, complaint, reject, delivery delay), works out the cause of a bounce or complaint spike with the evidence in hand (one import batch, one template, one receiving mailbox provider, or a missing authentication record), and closes only that lane by switching sending off for that one configuration set. It reads the setting back through a second call to prove the pause took, then emails the operator what it saw, what it closed, what stays open, and the one action it wants approved. The operator replies "reopen" or "keep closed", SES receives the reply, and Fothering acts on it and confirms.

Success: when one stream starts damaging the shared account reputation, exactly that stream stops while receipts and password resets keep flowing. When the evidence does not settle the cause, nothing is closed and the operator is asked.

## Positioning

- The SES Virtual Deliverability Manager advisor recommends and never acts.
- AWS's documented CloudWatch alarm plus Lambda recipe pauses a configuration set at a threshold with no diagnosis.
- Fothering closes one lane, names the cause with cited evidence, proves the closure with a read-back, and takes its approval by email reply through SES itself. It refuses to close on a guess and never pauses the whole account.

## Operating Context

- The operator's working surface is their inbox: the closure email and the reply are the main interaction, not a dashboard.
- Pages: a landing page that is also the hackathon launch page; a zero-install incident replay played back from committed run artifacts (event timeline, evidence table, closure and read-back, the operator email, the reply that reopened the lane); an operator console (every lane open, closed or watching, each closure with its evidence, reopen or keep closed); a deploy-into-your-own-AWS-account page (template, exact IAM permissions and why, what it reads and writes, where data lives, removal); privacy and AI disclosure pages.
- A judge gives the entry minutes: the replay must make sense in under a minute with nothing installed.

## Capabilities and Constraints

- Amazon SES is the backbone: configuration sets, message tags, EventBridge event destinations, email receiving for replies, the mailbox simulator while in the sandbox. Amazon Bedrock AgentCore hosts the agent with a Bedrock model.
- Everything runs in eu-central-1 (Frankfurt) in the operator's own AWS account. No multi-tenant sign-up or billing.
- Dry run by default: recorded event fixtures, no live SES send, no model call, behind one go-live switch only the owner flips. The demo sends only to the SES mailbox simulator and the owner's verified address.
- Recipient addresses are personal data: stored as receiving domain plus a keyed hash, 30-day retention, documented deletion.
- Stack is already decided in `docs/adr/0001-stack.md`: Astro static site with a few interactive islands on Cloudflare Workers static assets; TypeScript agent, CDK, DynamoDB.
- Not a generic monitoring dashboard: the product acts and explains, it is not a chart wall.
- Terminology: a **lane** is one SES configuration set; **closing** a lane is setting its sending to disabled; **read-back** is the second call proving the setting took.
- Undecided: the measured number (minutes to closure and its comparison with the threshold alarm) does not exist until three live runs are recorded.

## Brand Commitments

- Name: Fothering. Its story: fothering is how a ship's crew stops one leak without stopping the ship, a sail drawn under the hull over the hole and held there by the water, as HMS Endeavour was refloated in 1770.
- Voice: calm, exact and operational, like a good incident note written by the person on call. Active voice, real verbs, errors that explain.

## Evidence on Hand

- No recorded incident yet: replay artifacts come from fixture runs until three live runs are captured, and every rendered artifact is labeled live or fixture.
- No customers, testimonials, press, benchmarks or pricing exist. Future work must not invent any.
- No logo or visual assets exist yet.

## Product Principles

1. Evidence or "unknown", never a guessed closure.
2. The smallest closure that stops the damage: one lane, never the account.
3. Prove every action: a closure is not done until the read-back confirms it.
4. The operator decides reopening, in the channel they already use.
5. Every claim holds up to an SES expert, and no number is shown before it is measured.

## Accessibility & Inclusion

WCAG 2.2 AA on every page; works with keyboard, touch and mouse on mobile, tablet and desktop; respects reduced motion and color scheme preferences.
