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

Each hop of the interval is bounded by two stored times, read from the run's saved records.

## Damage count

The damage count is the number of sends SES accepted on the paused lane after the pause request:
the after-pause step's accepted attempts on that lane, plus the Send records the hold check counts
at or after the hold end. This is a definition only. No number is derived from it for any page.

## Thresholds and minimum sample

The thresholds are the values the code enforces in `packages/core/src/verdicts.ts`, unchanged from
the commit of this protocol to the last logged run.

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

The command spaces its sends so the account's send rate is never reached, and it never retries a
send.

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

Each lane the scenarios send on has its own sender role, so SES records one caller per lane.

## Incident limit

Fothering pauses a lane at most once per incident, and scenario 3 waits for the bulk lane's
incident from run 1 to end.

## Spend and what runs while deployed

The runs send a few hundred simulator messages, and the deployed stacks keep running on their
schedules until they are removed.

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

The stacks are removed in a fixed order once every lane Fothering closed is open again.

## Saved files

Every raw file a run produces is saved under the run's own folder before anything is removed.
