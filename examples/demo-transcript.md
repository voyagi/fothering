# Demo video transcript

What the demo video says, one paragraph per shot, in order.

1. Your shop sends everything through Amazon SES. Receipts, password resets, a newsletter. Then an old list gets
   imported, and the newsletter starts to bounce. SES counts bounces across the whole account. At five percent, the
   account goes under review. At ten, SES may pause all your sending. Receipts included.

2. This is Fothering. It reads the events your configuration sets publish. And when one stream goes wrong, it closes
   that one configuration set. Nothing else.

3. Here's a real run, in a real SES account. An old import goes out on the bulk lane, to the SES mailbox simulator.
   Code names the cause. Twenty of a hundred emails bounced for good, all from one batch: stale-import.

4. So code pauses the bulk lane. One configuration set. Then it reads the setting back from SES: sending enabled,
   false. About ten minutes later, it checks that nothing got through. And in the SES console? Disabled.

5. The transactional lane stays open, so receipts keep flowing. A send on the paused lane is refused, and the error
   names the set.

6. How did it decide? Code wrote one evidence record. An agent on Amazon Bedrock AgentCore got that record, and
   nothing else. It holds no tool that changes anything. It can confirm the lane code approved, or say unknown. And
   the email labels the one paragraph it wrote.

7. Then the operator gets one plain email, through a set Fothering never pauses. What happened, what it saw, what
   stays open, and the command to reopen. It never reopens on its own.

8. And when the evidence does not settle the cause? It closes nothing. Not on a guess. The email just says what code
   found. And it never pauses your whole account.

9. No AWS account? The replay on the site walks one incident in four steps, from the first bounce to the reopen.
   It's a fixture, and it says so.

10. To run it for real, deploy it into your own account. One CDK app that starts in dry run, and a page listing every
    permission it holds, generated from the template.

11. One bad import should not take your password resets down with it. Fothering.
