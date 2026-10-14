# When the agent is unavailable

Every five minutes the detection function looks for a lane whose bounces or complaints are
spiking, writes the evidence record for the new incident, and then asks the agent on AgentCore
Runtime to explain it. The agent's answer is checked twice in code before anything is stored: the
option it names must be one the evidence record approved, copied exactly, and its explanation must
pass every text check. Only an answer that passes both becomes the incident's decision.

When the agent cannot give such an answer, the incident's decision reads `unknown` with one of the
five reasons below, and the lane is not paused. Nothing in this path can pause a lane: a closure
needs a validated agent decision, and an unknown one never is.

## The five reasons

| Reason | When it happens | Tried again by a later cycle |
|---|---|---|
| `agent-error` | The call to the runtime failed, the model call failed, the runtime refused the record, or the counter reservation hit a write conflict with another cycle | Yes, within the per-incident limit |
| `agent-timeout` | The runtime did not answer within 90 seconds, or its own model deadline passed first | Yes, within the per-incident limit |
| `response-invalid` | The runtime answered, but the answer failed a check: its shape, its option id, or a text check on the explanation (a link, a command word, another lane's name, a number the record does not hold, and others); or the runtime stopped at one of its own limits on model calls, input size, loop turns or structured output | Yes, within the per-incident limit |
| `cap-reached` | The incident has used its 3 invocations, or the account has used its 6 invocations or its token reservation for the UTC day | Never: the decision is final |
| `agent-dry-run` | The stack is deployed with the live switch unset, so the runtime is not called and nothing is spent | Not while the stack stays in dry run; the first cycle after the stack is deployed with the switch live invokes the incident as its first attempt, because nothing ran before |

For every reason, the lane keeps sending, and the incident stays open on its own schedule.

## Retries and limits

- Each later cycle tries an incident again only after `agent-error`, `agent-timeout` or
  `response-invalid`, and each try runs in a new runtime session named after the incident and the
  attempt number.
- An incident gets at most 3 invocations in all. The account gets at most 6 invocations per UTC day,
  counted in the shared table, so two detection functions running at once still spend from the
  same 6. A try that would pass either limit is refused before any call, and the incident then
  reads `cap-reached` for good.
- A stored decision, validated or `cap-reached`, ends every further try.
- An evidence record larger than the 16,384-byte limit is never sent to the runtime and reserves
  nothing; its own decision already reads `unknown` with the reason `record-too-large`.
- A cycle starts no new invocation after its first 180 seconds, so the function's 300-second limit
  can never cut off a call already counted. An incident left over waits for the next cycle.

## What the operator sees

The approved option stays in the evidence record whatever the agent did. A later email to the
operator can still offer to close the lane by reply, since that offer reads the option from the
evidence record and not from the agent.

The table and the logs hold only the reason, the check that failed and the attempt number. No text
from a rejected answer is stored or logged, so nothing the model wrote reaches the operator unless
it passed every check.
