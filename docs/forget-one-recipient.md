# Forget one recipient

This command finds every stored record naming one recipient and removes it. It reaches send,
delivery, bounce and delivery-delay records, plus the recipient items a complaint writes for each
complained address, across every lane and every retained address-key version. It never touches a
different recipient, including a same-domain address or one carrying a different plus-tag.

The table holds no recipient address in plain text. Each record carries only a keyed hash of the
address (the address key), which is pseudonymised personal data, so a deletion request is served
by hashing the target address the same way and removing every record whose hash matches.

## How to run it

Read the function's name from the stack's own output:

```sh
aws cloudformation describe-stacks \
  --region eu-central-1 \
  --stack-name FotheringIngest \
  --query "Stacks[0].Outputs[?OutputKey=='ForgetFunctionName'].OutputValue" \
  --output text
```

Then invoke the function directly under that name:

```sh
aws lambda invoke \
  --region eu-central-1 \
  --function-name <ForgetFunctionName stack output> \
  --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 330 \
  --payload '{"address":"jane@example.org"}' \
  result.json
```

The function may run for up to its 5-minute limit, and the AWS CLI stops waiting for an answer
after 60 seconds unless told otherwise, then retries on its own (Lambda's page on synchronous
invocation: the AWS CLI and SDKs "automatically retry on client timeouts"), which starts the run
again. On a cold start, up to 10 seconds of setup come before that limit starts (Lambda's page on
the execution environment lifecycle). `--cli-read-timeout 330` keeps the command waiting past both,
so one command is one run and `result.json` holds its counts.

`result.json` holds a deleted count per key version (newest first), a total deleted count and a
remaining count. It never holds the address or a hash.

A deleted count of zero means no stored record matched the address as the command normalizes it:
letter case, a display name and two Unicode spellings of one name are handled, and a plus-tag stays
part of the address. A typo also reads zero, so check the spelling before taking a zero as the
answer.

A payload with no non-empty `address` field fails, and so does one carrying any other field beside
it, or an `address` holding more than one address: a list separated by commas, semicolons or
spaces, or a second address beside a bracketed one. Read as one address, such a list would reach
the last bracketed address in it, a different person. Pass one address per run. The command's own
output then shows a `FunctionError` field, and `result.json` holds the error, whose message reads:

```text
usage: pass a JSON payload holding one non-empty "address" field naming one address, and nothing else
```

## The remaining count and running it twice

The recipient index this command reads is updated in an eventually consistent fashion, so it can
lag the table by a short moment right after a write or a delete. The command re-reads the index a
bounded number of times after its first pass, waiting briefly before each re-read, to catch a
record that pass missed, and stops early only when a re-read lists nothing. A record the index
still lists after it was deleted is not counted twice.

The remaining count is how many entries the index still listed at the last re-read: records that
re-read found and removed, which the deleted count already includes, plus entries for records an
earlier pass removed that the index had not caught up with yet. So it is not what is left in the
table. A non-zero remaining count means the index had not settled when the re-reads ran out: run
the command again a minute later to confirm.

A remaining count of zero means the index showed nothing at that last read, not a guarantee that
nothing exists. A record written for an event still in flight when the command runs needs a
second run to reach it.

A run that fails partway, for example on an AWS error during a delete, returns that error and
writes one `forget-failed` log line naming the error type. A run stopped by the function's time
limit writes no such line: the invoke result reports the timeout instead. Either way, what it
already removed stays removed, and running it again removes the rest.

## What this does not cover

- Stored reply messages. There is no reply bucket yet: replies are added once the operator can
  approve a reply before it sends, and deleting a stored reply will be that later work's own job.
- AgentCore Memory, only if the agent ever comes to store something there. Nothing here reads or
  writes it.
- Minimized messages waiting in the dead-letter queue. Those hold the same keyed hash, never the
  address, and the queue drops them on its own after four days. A message redriven from the queue
  writes its records back, so after a redrive, run this command again for any address it was run
  for in the four days before.
- Complaint counting records. A complaint writes one record with no recipient field to count the
  complaint itself, kept separate from the per-recipient items this command does remove.
- Records hashed under an address-key version already removed from the key secret. This command
  hashes only under the versions the secret still holds, so keep a retired version there for 30
  days after its successor became active, plus the few days expired records can take to disappear.
