# Forget one recipient

This command finds every stored record naming one recipient and removes it. It reaches send,
delivery, bounce and delivery-delay records, plus the recipient items a complaint writes for each
complained address, across every lane and every retained address-key version. It never touches a
different recipient, including a same-domain address or one carrying a different plus-tag.

The table holds no recipient address in plain text. Each record carries only a keyed hash of the
address (the address key), which is pseudonymised personal data, so a deletion request is served
by hashing the target address the same way and removing every record whose hash matches.

## How to run it

Invoke the deployed function directly, using the stack's own output for its name:

```
aws lambda invoke \
  --function-name <ForgetFunctionName stack output> \
  --cli-binary-format raw-in-base64-out \
  --payload '{"address":"jane@example.org"}' \
  result.json
```

`result.json` holds a deleted count per key version (newest first), a total deleted count and a
remaining count. It never holds the address or a hash.

A payload with no non-empty `address` field fails with:

```
usage: pass a JSON payload holding one non-empty "address" field
```

## The remaining count and running it twice

The recipient index this command reads is updated in an eventually consistent fashion, so it can
lag the table by a short moment right after a write or a delete. The command re-reads the index a
bounded number of times after its first pass to catch a record that pass missed, and reports the
count still showing at its last read.

A remaining count of zero means the index showed nothing at that last read, not a guarantee that
nothing exists. A record written for an event still in flight when the command runs needs a
second run to reach it, and if the index happened to be lagging, running the command again a
minute later confirms the count.

## What this does not cover

- Stored reply messages. There is no reply bucket yet: replies are added once the operator can
  approve a reply before it sends, and deleting a stored reply will be that later work's own job.
- AgentCore Memory, only if the agent ever comes to store something there. Nothing here reads or
  writes it.
- Minimized messages waiting in the dead-letter queue for redelivery. Those hold no recipient
  address and expire on their own after four days.
- Complaint counting records. A complaint writes one record with no recipient field to count the
  complaint itself, kept separate from the per-recipient items this command does remove.
