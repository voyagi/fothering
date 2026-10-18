# Reopen a lane

Fothering never turns sending back on by itself. This command does it for you: it re-enables
sending on one configuration set that Fothering paused, reads the setting back from SES, and
records the reopen on the pause it reverses. It refuses any set Fothering did not pause.

## How to run it

Read the function's name from the stack's own output:

```sh
aws cloudformation describe-stacks \
  --region eu-central-1 \
  --stack-name FotheringAction \
  --query "Stacks[0].Outputs[?OutputKey=='ReopenFunctionName'].OutputValue" \
  --output text
```

Then invoke the function under that name, with the configuration set to reopen in the payload:

```sh
aws lambda invoke \
  --region eu-central-1 \
  --function-name <ReopenFunctionName stack output> \
  --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 60 \
  --payload '{"configurationSet":"fothering-bulk"}' \
  result.json
```

The function runs for at most 30 seconds, and on a cold start up to 10 seconds of setup come before
that limit starts (Lambda's page on the execution environment lifecycle). The AWS CLI stops waiting
for an answer after 60 seconds by default and then retries on its own (Lambda's page on synchronous
invocation: the AWS CLI and SDKs "automatically retry on client timeouts"), which would run the
command a second time. `--cli-read-timeout 60` keeps that wait written down and above both, so one
command is one run and `result.json` holds its answer.

## What result.json holds

- `result`: what happened, one of the results below.
- `reason`: on a refusal, why.
- `configurationSet`: the set named in the payload.
- `requestedAtMs` and `readBackAtMs`: when the reopen went to SES and when it was read back, in
  epoch milliseconds, present once the command got that far.
- `capHourEndsAt`: on `lane-cap-reached`, the end of the UTC hour, as an ISO 8601 time.
- `note`: that reopening resets the set's SES reputation metrics.
- `limit`: the incident limit described under What this does not cover.

It never holds the payload, an address or a hash.

## Results

- `reopened`: SES accepted the change and the read-back shows sending enabled. Mail sent through
  the set goes out again.
- `reopen-failed`: SES refused the change, or the read-back still shows sending disabled. The set
  stays paused; run the command again.
- `reopen-unknown`: the read-back failed or came back without the sending setting, so the command
  cannot say whether the set is sending. Check the set in the SES console, or run the command again.
- `refused`: the command changed nothing and made no SES call; `reason` says why.
- `dry-run`: the live switch is off for this deployment, so the command wrote one log line naming
  the reopen it would have made and changed nothing.

## Refusals

- `not-in-lane-map`: the set is not in `lanes.json`.
- `operator-alert`: the set carries Fothering's own operator alerts, which it never pauses.
- `no-fothering-pause`: Fothering holds no pause on the set. That includes a set paused by hand or
  by another tool: reopen such a set in the SES console.
- `not-reopenable`: Fothering's last action on the set did not pause it. It refused, ran as a dry
  run, failed to pause, or had not finished pausing yet.
- `already-reopened`: this pause was already reopened.
- `reopen-in-progress`: another reopen of the same set is running. Wait 30 seconds, then run the
  command again if the set is still paused.
- `lane-cap-reached`: the set already had 4 pause and reopen attempts in this UTC hour.
  `capHourEndsAt` says when the hour ends; run the command after that.
- `payload-invalid`: the payload is not one `configurationSet` field naming one set, and nothing
  else. This is not a `result.json` answer: the command's own output shows a `FunctionError` field,
  and `result.json` holds the error, whose message reads:

```text
usage: pass a JSON payload holding one "configurationSet" field naming one configuration set from lanes.json, and nothing else
```

## The attempt cap

Pauses and reopens share one cap: at most 4 attempts per configuration set per UTC clock hour,
counted whether the call to SES then succeeds or not. That leaves room for a pause, a reopen and one
retry of each inside one hour, and it stops a pause and reopen loop at its third pause. A refusal
for the cap names the end of the hour in `capHourEndsAt`.

A `reopen-failed` or `reopen-unknown` run leaves the pause on record, so the command can always be
run again, and each run counts against the cap.

## Reputation metrics

Reopening a configuration set resets its SES reputation metrics, so the history SES keeps for that
set starts again. The `note` field in `result.json` says this for the set you reopened.

## What this does not cover

- A lane reopened before its hold check. A few minutes after a pause, Fothering checks that SES
  accepted no more mail for the set once the pause took hold, and only then reports it by email. A pause reopened before that
  check gets no hold check and no email about it.
- An incident whose lane moved on to a newer incident before any action run reached it. That older
  incident gets no pause and no email. With the action running every five minutes, this takes an
  outage of many hours.
- A lane that spikes again soon after a reopen. For `fothering-bulk`, the `limit` field reads:

Fothering pauses a lane at most once per incident, and an incident stays open while fothering-bulk keeps spiking and for at least 14 hours after it goes quiet, since SES can still report bounces from deliveries it retried for that long. If you reopen fothering-bulk inside that time and it spikes again, Fothering makes no new evidence record or decision, does not pause it again and sends no new email, so watch fothering-bulk yourself until then.
