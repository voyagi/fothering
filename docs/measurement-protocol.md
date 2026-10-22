# Measurement protocol for the live runs

This protocol fixes how Fothering is measured against real SES: three scenarios sent through the
SES mailbox simulator into a fresh deploy in the operator's own AWS account, in eu-central-1. It is
committed before the first live send. A reviewed commit may change it until that send; from the
first send to the last logged run it does not change, so every run is judged by the rules written
here before any result was seen.

## Measured interval start

The interval starts at the earliest SES event timestamp at which the lane met its pre-registered
rule: the lane minimum of recipient-sends, the row minimum for every row of the cause's tag kind,
and the hard-bounce or complaint ratio with its minimum event count (Thresholds and minimum sample
names each). It is read from the run's stored events, never from a clock on the operator's machine.

## Measured interval end

The interval ends at the `GetConfigurationSet` read-back response time stored on the closure as
`readBackAtMs`: the moment Fothering read the lane's sending setting back after its pause request.
A run whose read-back did not show sending off has no end time, and the run log records the run's
outcome instead of an interval.

## Per-hop breakdown

Each hop of the interval is bounded by two stored times, read from the run's saved records. In
order from the SES event to the operator email:

1. The SES event time, when SES says the event happened, on the stored event record.
2. The EventBridge envelope time, `envelopeTimeMs` on the stored event record.
3. The ingest arrival, `arrivalTimeMs`, when the ingest function stored the event.
4. The evidence record and then the decision, as detection stored them for the incident.
5. The pause request, `pauseRequestedAtMs` on the closure.
6. The read-back, `readBackAtMs` on the closure, which ends the measured interval.
7. The hold end, `holdEndMs`, and the hold check, `holdCheckedAtMs`, both on the closure.
8. The operator email sent, `email.sentAtMs` on the closure.

## Damage count

The damage count is the number of sends SES accepted on the paused lane after the pause request:
the after-pause step's accepted attempts on that lane, plus the Send records the hold check counts
at or after the hold end. This is a definition only. No number is derived from it for any page.

## Thresholds and minimum sample

The thresholds are the values the code enforces in `packages/core/src/verdicts.ts`, unchanged from
the commit of this protocol to the last logged run. Ratios are integer fractions, compared by
cross-multiplication, never as decimals.

| Constant | Value |
| --- | --- |
| HARD_BOUNCE_THRESHOLD | 5/100 |
| COMPLAINT_THRESHOLD | 1/1000 |
| MIN_RATIO_EVENTS | 3 |
| LANE_MIN_RECIPIENT_SENDS | 100 |
| ROW_MIN_RECIPIENT_SENDS | 20 |
| COVERAGE_THRESHOLD | 9/10 |

A lane meets its rule when it holds at least `LANE_MIN_RECIPIENT_SENDS` recipient-sends, every row
of the cause's tag kind holds at least `ROW_MIN_RECIPIENT_SENDS`, and its permanent bounces reach
`HARD_BOUNCE_THRESHOLD` or its complaints reach `COMPLAINT_THRESHOLD`, either with at least
`MIN_RATIO_EVENTS` events. `COVERAGE_THRESHOLD` is the share of recipient-sends that must have
their events stored before the evidence counts as data. The scenarios are sized against these:
run 1 sends 120 bulk messages with 24 bounces, every batch at least 24, and run 3 sends 120 bulk
messages with 4 complaints, every campaign at least 24.

## Scenarios

The command reads these scenarios from `docs/measurement-scenarios.json`. The tables below repeat
that file field by field, and a repo test fails when the two differ.

Every recipient is a mailbox simulator address at the domain `simulator.amazonses.com`. The
Recipient column gives its local part (`success`, `bounce` or `complaint`); the command adds a
plus label built from the run id, the step and a three-digit counter, so no two messages share an
address. Every message carries its lane's stream tag, the batch, campaign or template tag its
group names, and the run id tag.

The Order line gives the send order. The cycle repeats, taking the stated number of messages from
each group in turn and skipping a group that has run out, until every group is empty. An interleave
sends one message of the named group after every stated number of cycle messages.

Runs go in the order below. Scenario 3 shares `fothering-bulk` with scenario 1. A scenario that
needs a pause runs only when its lane has no open incident, because Fothering pauses a lane at most
once per incident (Incident limit). Run 2 starts only after run 1's lane is reopened and read back
as sending, and run 1's raw files are saved and checked. An after-pause step starts only after the
closure reads `closed` and its operator email reads sent, so it can never make the hold check fail.

### Scenario 1: bulk-stale-import

| Field | Value |
| --- | --- |
| Run | 1 |
| Name | bulk-stale-import |
| Lane | fothering-bulk |
| Precondition | A fresh deploy with the live switch on from the first deploy, the three lane-map sets reading sending enabled with their EventBridge destinations, no open incident on fothering-bulk, and a From identity with no default configuration set. |
| Expected decision | close, cause tag batch stale-import |

#### Step spike

| Group | Lane | Tag kind | Tag value | Recipient | Count |
| --- | --- | --- | --- | --- | --- |
| clean-import | fothering-bulk | batch | clean-import | success | 96 |
| stale-import | fothering-bulk | batch | stale-import | bounce | 24 |
| receipts | fothering-transactional | template | order-receipt | success | 12 |

Order: cycle clean-import 4, stale-import 1; interleave receipts after every 10

The step sends 132 messages: 120 on `fothering-bulk`, of which 24 bounce, and 12 receipts on
`fothering-transactional`, the lane that keeps flowing.

#### Step after-pause

| Group | Lane | Tag kind | Tag value | Recipient | Count |
| --- | --- | --- | --- | --- | --- |
| bulk-retry | fothering-bulk | batch | clean-import | success | 3 |
| receipts-after | fothering-transactional | template | order-receipt | success | 3 |

Order: cycle bulk-retry 1, receipts-after 1

Each bulk attempt is expected to be refused by SES because the set is paused, and each
transactional attempt is expected to be accepted. The operator then reopens the lane with the
reopen command (`docs/reopen-a-lane.md`); the run command never reopens anything.

### Scenario 2: transactional-spike

| Field | Value |
| --- | --- |
| Run | 2 |
| Name | transactional-spike |
| Lane | fothering-transactional |
| Precondition | Run 1's lane reopened and read back as sending, with run 1's raw files saved and check-saved exiting 0. |
| Expected decision | unknown, reason not-closeable |

#### Step spike

| Group | Lane | Tag kind | Tag value | Recipient | Count |
| --- | --- | --- | --- | --- | --- |
| order-receipt | fothering-transactional | template | order-receipt | success | 96 |
| invoice-reminder | fothering-transactional | template | invoice-reminder | bounce | 24 |

Order: cycle order-receipt 4, invoice-reminder 1

The step sends 120 messages on `fothering-transactional`, of which 24 bounce. A transactional lane
is never closeable, so the expected result is no pause and the unknown-path operator email.

### Scenario 3: bulk-complaint-campaign

| Field | Value |
| --- | --- |
| Run | 3 |
| Name | bulk-complaint-campaign |
| Lane | fothering-bulk |
| Precondition | No open incident on fothering-bulk, so at least 14 hours after run 1's lane went quiet, which inside live session B means it is logged as not run with that reason. |
| Expected decision | close, cause tag campaign winback |

#### Step spike

| Group | Lane | Tag kind | Tag value | Recipient | Count |
| --- | --- | --- | --- | --- | --- |
| october-news | fothering-bulk | campaign | october-news | success | 96 |
| winback-success | fothering-bulk | campaign | winback | success | 20 |
| winback-complaint | fothering-bulk | campaign | winback | complaint | 4 |

Order: cycle october-news 4, winback-success 1, october-news 4, winback-success 1, october-news 4, winback-success 1, october-news 4, winback-success 1, october-news 4, winback-success 1, october-news 4, winback-complaint 1

The step sends 120 messages on `fothering-bulk`, of which 4 draw a complaint, all from the
`winback` campaign.

#### Step after-pause

| Group | Lane | Tag kind | Tag value | Recipient | Count |
| --- | --- | --- | --- | --- | --- |
| bulk-retry | fothering-bulk | batch | clean-import | success | 3 |
| receipts-after | fothering-transactional | template | order-receipt | success | 3 |

Order: cycle bulk-retry 1, receipts-after 1

## Contrast design

Within one lane, a clean group runs beside the bad one, so the evidence has to point at the group
and not at the lane: run 1 sends the `clean-import` batch beside `stale-import`, and run 3 sends the
`october-news` campaign beside `winback`. Across lanes, `fothering-bulk` spikes while
`fothering-transactional` keeps flowing, so a correct closure leaves the receipts lane sending; the
after-pause step checks that directly. Run 2 inverts the design: the spiking lane is
`fothering-transactional`, which Fothering must never close, so the correct result is no pause and
an email that says the cause is not settled.

## Pacing and throttles

The command starts each send at least 1250 milliseconds after the previous send started, across
every lane of the step, because the SES send rate is per account and not per configuration set.
That holds a step at 0.8 sends a second. The scenario source states the same gap as `minGapMs`,
and the command refuses to start when the account's maximum send rate reads below 0.8 a second.

The command never retries a send. Its SES client makes one attempt per message, so a throttle is
not absorbed by a hidden retry inside the gap. A throttled or refused attempt is recorded by its
error name, and the step continues at the same pace.

## Every run reported

A run starts when the command makes its first `SendEmail` call. Every started run goes into the run
log with its outcome, whether it closed and reopened, ended unknown, failed or was stopped partway;
a run is never left out because its result was poor. Every scenario that was not run goes into the
log too, with the reason.

## VDM state

Before the first send of each invocation the command reads the account once with `GetAccount` and
records whether Virtual Deliverability Manager is on (`VdmAttributes.VdmEnabled`), together with
production access, the maximum send rate and the request id, in the step's account file. The
protocol never changes the VDM setting: each run reports the state it found.

## Simulator domains

Live runs send only to the SES mailbox simulator at `simulator.amazonses.com`; the command refuses
any other recipient domain before the first send. The simulator answers with a delivery, a bounce
or a complaint according to the local part, and its mail does not count toward the account's SES
reputation metrics. It cannot stand in for a real mailbox provider or a missing authentication
record, so causes of those kinds appear on fixtures only, never in a live run.

## One caller identity per lane

Each lane the scenarios send on has its own sender role: `fothering-live-run-transactional` for
`fothering-transactional` and `fothering-live-run-bulk` for `fothering-bulk`, both under the IAM
path `/fothering-live-run/`, so whether either remains after removal is one role-list read. Each
role holds one permission policy, the statement in `docs/live-run-policy-transactional.json` or
`docs/live-run-policy-bulk.json`: `ses:SendEmail` on that lane's configuration set and on the From
domain's identity, and nothing else. The committed files carry the placeholders `<ACCOUNT_ID>` and
`<FROM_DOMAIN>`. IAM refuses a policy that still holds them, so a forgotten substitution fails
closed; the operator fills them in a scratch copy outside the repository.

Why one role per lane: SES records a role sender's caller identity by its role name, so two
sessions of one role are one caller. Fothering's closeability check refuses to close a lane whose
caller also sends through another configuration set, so one sender for both lanes would make the
bulk lane not closeable and the run would measure nothing. Before the first send the command checks
that every lane's profile resolves to an assumed role, that no two lanes share a role name, and
that all of them are in one account.

Each role trusts only the operator's own administrator identity in the same account, with a
maximum session of one hour. The operator creates both roles before the first send and deletes them
in the removal step; no code in this repository creates, changes or deletes an IAM principal or
policy. `fothering-alerts` carries only Fothering's own operator email, sent by the action
function's role, and the command never sends on it.

If the From address is itself a verified identity, not only its domain, SES may authorize a send
against the address identity instead. The operator reads that before creating the roles. If it is,
the address identity's ARN is added to both policies before the first send, and the policy test
widens to three resources in the same commit.

## Incident limit

Fothering pauses a lane at most once per incident. The product states that limit to the operator in
this sentence, quoted here for the bulk lane:

> Fothering pauses a lane at most once per incident, and an incident stays open while fothering-bulk keeps spiking and for at least 14 hours after it goes quiet, since SES can still report bounces from deliveries it retried for that long. If you reopen fothering-bulk inside that time and it spikes again, Fothering makes no new evidence record or decision, does not pause it again and sends no new email, so watch fothering-bulk yourself until then.

Scenario 3 sends on `fothering-bulk` like scenario 1, so it can start only after run 1's incident
has ended, at least 14 hours after the lane went quiet. That cannot happen inside the session that
ran run 1, so in that session scenario 3 is logged as not run, with this limit as the reason.

## Spend and what runs while deployed

Sends, from the scenario source, every one to the mailbox simulator:

- Run 1, step spike: 132 sends
- Run 1, step after-pause: 6 sends
- Run 2, step spike: 120 sends
- Run 3, step spike: 120 sends
- Run 3, step after-pause: 6 sends

The model runs only when detection opens an incident from stored events. Each incident allows at
most `MODEL_VALUES.perIncidentInvocations` (3) invocations and each UTC day at most
`MODEL_VALUES.perDayInvocations` (6). One invocation makes at most `MODEL_VALUES.modelCallCeiling`
(3) model calls and reserves `TOKEN_RESERVATION_PER_INVOCATION` (64512) tokens, and a UTC day
reserves at most `MODEL_VALUES.perDayTokenReservations` (390000). The worst UTC day is therefore 18
model calls with at most 368640 input tokens and 18432 output tokens. At Claude Sonnet 4.6 EU geo
inference prices of USD 3.30 per million input tokens and USD 16.50 per million output tokens (the
Bedrock offer as read on 2026-10-17, UNVERIFIED until re-read on the day of the runs), that is about
USD 1.22 of input and USD 0.30 of output, about USD 1.52 for the worst day. SES, Lambda, DynamoDB,
EventBridge and AgentCore charges are not priced here.

The account carries a USD 10 monthly budget alarm, which warns and does not stop spending. The
hackathon's USD 50 AWS credit ends on 2026-10-31.

While the stacks are deployed, detection runs every five minutes and the action function runs every
five minutes, whether or not anything is sent. With no new sending they open no incident and make
no model call. Removal ends both schedules. If the stacks are kept after the runs, the run log names
the removal date, no later than 2026-10-31, and both schedules run until then.

## Switch on from the start

Every stack is deployed with the context key `fothering:live` set to `live` from its very first
deploy (`-c fothering:live=live`; the live switch (README, Live switch) explains the key). An
incident decided under a dry-run deploy that is still open when the switch later goes on is mailed
by the first live action run, so a dry-run deploy ahead of the runs could send an operator email
about an incident no run made.

## No number on a page

No figure measured in these runs, whether a time, an interval or a count, appears on the site or in
the README. The site may say that a run was recorded, never how fast it was or how much it caught.
Publishing measured numbers is listed under What's next, after more runs than three.

## Removal order

The stacks are removed in this order, and nothing is destroyed before step 3:

1. Every lane Fothering closed is reopened with the reopen command (`docs/reopen-a-lane.md`) and read back as sending, and each lane-map set's configuration is saved under `aws/sets-before-removal/`.
2. The run's raw files are saved (Saved files) and the live-run command's `check-saved` check for the run exits 0; the first destroy waits for that exit code.
3. `FotheringAction` is destroyed first. The reopen function goes with it, which is why every reopen comes before this step.
4. `FotheringDetection` is destroyed next, then `FotheringRuntime` and `FotheringIngest`, since detection imports from both of them (README, Deploy and remove).
5. The two live-run roles under `/fothering-live-run/` are deleted.
6. The after-removal reads are saved under `aws/after-removal/` and checked: each stack reads deleted, every stack resource reads deleted, no log group remains under the stacks' prefixes, and no role remains under the roles' path.

If the operator keeps the stacks after the runs instead, steps 3 to 6 move to a removal date no
later than 2026-10-31, the run log names that date, and the spend in Spend and what runs while
deployed continues until then.

## Saved files

Every file of a run lives under `reports/live-runs/<runId>/`, a folder git ignores. The command
writes `run/`. The operator writes `aws/`, each file the output of one AWS CLI read, and appends one
line to `aws/saved.jsonl` for every saved file and for the deploy-finished and destroy-started
events, so the order of the saves can be checked.

Written by the command, per step:

- `run/<step>.account.json`: the account read (VDM state).
- `run/<step>.callers.json`: each lane's role name, account and ARN.
- `run/<step>.attempts.jsonl`: one record per send attempt, in send order.

Saved by the operator before removal:

- `aws/saved.jsonl`: the save log described above.
- `aws/stacks.json`: the four stacks after the last deploy, with the `FotheringAction` parameters and the outputs.
- `aws/templates/<StackName>.json`: each stack's original template.
- `aws/reopen-function.json`: the reopen function's configuration.
- `aws/items-pointers.json`: the bulk lane's incident marker and pause pointer.
- `aws/items-incident.json`: the incident's state, evidence, decision and closure, saved after the reopen result.
- `aws/items-lane-<set>.json`: each lane-map set's stored records.
- `aws/reopen-result.json`: the reopen command's own output file.
- `aws/sets-before-removal/<set>.json`: each set's configuration after the reopen and before the first destroy.

Saved after removal:

- `aws/after-removal/stack-<StackName>.json` and `aws/after-removal/resources-<StackName>.json`: each stack and its resources, read by stack id.
- `aws/after-removal/log-groups.json`: the log groups left under the stacks' prefixes.
- `aws/after-removal/roles.json`: the roles left under `/fothering-live-run/`.

The callers file holds the account id and role ARNs, and the operator's files hold addresses and
account details. None of them is ever committed.
