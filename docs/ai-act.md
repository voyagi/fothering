# EU AI Act, Article 50: what Fothering discloses

This document records, paragraph by paragraph, whether the transparency obligations in Article 50
of the EU AI Act bind Fothering, and where a paragraph applies, the code that meets it and the test
that pins that code.

Source: Regulation (EU) 2024/1689, consolidated text as amended by Regulation (EU) 2026/1744, read
on EUR-Lex on 2026-10-18:
[consolidated text](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02024R1689-20260727).
The text as first published is in the
[Official Journal](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202401689).
Regulation (EU) 2026/1744 changes Article 50(7), Article 111 and Article 113; EUR-Lex does not
list Article 50(1) to 50(4) among the passages it changes. Quotations below are from the
consolidated text.

## What Fothering is, for this purpose

Fothering watches the events an Amazon SES account publishes, pauses one configuration set when
code finds that lane damaging the account's sending reputation, and emails the operator what it saw
and what it did. Code makes every decision: which lane, whether to pause, and every sentence of the
email but one.

That one is the explanation paragraph. When the agent runs, Claude Sonnet 4.6 on Amazon Bedrock
writes a single paragraph explaining the evidence. Code checks the paragraph against the evidence
record before the email shows it and leaves it out when the check fails. Fothering produces no
other model-written text, no image, audio or video, and publishes nothing.

In this document the provider is the project, which writes and publishes Fothering's code, and the
deployer is the operator, who runs Fothering in their own AWS account and receives its email at
one address they set when they deploy it.

Summary of the verdicts below: 50(1) and 50(2) bind Fothering and are met by the constants in
`packages/core/src/disclosure.ts`; 50(3) and 50(4) do not bind it.

## Article 50(1) interaction with natural persons

> Providers shall ensure that AI systems intended to interact directly with natural persons are
> designed and developed in such a way that the natural persons concerned are informed that they
> are interacting with an AI system, unless this is obvious from the point of view of a natural
> person who is reasonably well-informed, observant and circumspect, taking into account the
> circumstances and the context of use.

The paragraph then exempts systems authorised by law to detect, prevent, investigate or prosecute
criminal offences. Fothering is not such a system.

Verdict: APPLIES, and the duty is the provider's.

The operator email is addressed to a person, who reads it and decides whether to reopen a paused
configuration set. That is the system dealing with a natural person directly, even though the email
goes one way and asks for no reply. The paragraph's exception for an AI system that is obvious to a
well-informed reader could be argued, since the operator chose to deploy Fothering, but it is not
relied on: the operator address can be a shared inbox read by someone who never saw the deployment.
So every email says what sent it:

- The From header carries the display name `Fothering`, the constant `FROM_DISPLAY_NAME`, so the
  sender is named before the email is opened.
- Every email ends with the footer in `AUTOMATED_SENDER_FOOTER`: "Sent by Fothering, an automated
  agent. Replies to this address are not read by Fothering."
- When the email shows the model's paragraph, it sits under the label in `MODEL_PARAGRAPH_LABEL`,
  "The model's explanation, checked by code against the evidence above:", so model text never
  reads as text code wrote.

The constants live in `packages/core/src/disclosure.ts` and `packages/core/src/disclosure.test.ts`
pins their wording. The email renderer imports them, and its tests pin where each one appears.

## Article 50(2) machine-readable marking of generated content

> Providers of AI systems, including general-purpose AI systems, generating synthetic audio,
> image, video or text content, shall ensure that the outputs of the AI system are marked in a
> machine-readable format and detectable as artificially generated or manipulated. Providers shall
> ensure their technical solutions are effective, interoperable, robust and reliable as far as this
> is technically feasible, taking into account the specificities and limitations of various types
> of content, the costs of implementation and the generally acknowledged state of the art, as may be
> reflected in relevant technical standards. This obligation shall not apply to the extent the AI
> systems perform an assistive function for standard editing or do not substantially alter the
> input data provided by the deployer or the semantics thereof, or where authorised by law to
> detect, prevent, investigate or prosecute criminal offences.

Verdict: APPLIES, and the duty is the provider's.

Fothering generates text: the explanation paragraph is new prose a model writes about an incident.
The exceptions do not fit cleanly. The paragraph is not standard editing of text the operator
supplied, and its input is an evidence record computed from SES events, not text the paragraph
restates. Fothering does not rely on them.

The paragraph is plain text inside a plain-text email, which has no metadata field of its own, so
the machine-readable mark is a message header on the email that shows it. The header is the
constant `MODEL_TEXT_MARKER_HEADER` in `packages/core/src/disclosure.ts`: name
`X-Fothering-AI-Generated`, value `model-explanation-paragraph`. A mail filter or archive can detect
the generated content from the header without reading the body, and the label above the paragraph
shows a reader exactly which part a model wrote. An email without the paragraph holds no generated
text and carries no header. `packages/core/src/disclosure.test.ts` checks that the header name and
value are printable ASCII and that the name is one SES accepts.

Article 50(7) lets the Commission adopt an implementing act with common rules for the obligations
in this paragraph. If such rules name a marking method, the header follows them.

## Article 50(3) emotion recognition and biometric categorisation

> Deployers of an emotion recognition system or a biometric categorisation system shall inform the
> natural persons exposed thereto of the operation of the system, and shall process the personal
> data in accordance with Regulations (EU) 2016/679 and (EU) 2018/1725 and Directive (EU) 2016/680,
> as applicable.

Verdict: DOES NOT APPLY.

Fothering is neither kind of system. It reads delivery events: counts, bounce and complaint types,
receiving domains and a keyed hash of each recipient address. It processes no biometric data and
infers nothing about anyone's emotions.

## Article 50(4) deep fakes and text published on matters of public interest

> Deployers of an AI system that generates or manipulates image, audio or video content
> constituting a deep fake, shall disclose that the content has been artificially generated or
> manipulated.

Its second subparagraph covers text:

> Deployers of an AI system that generates or manipulates text which is published with the purpose
> of informing the public on matters of public interest shall disclose that the text has been
> artificially generated or manipulated.

Verdict: DOES NOT APPLY.

Fothering generates no image, audio or video. Its one generated paragraph goes privately to one
operator address to explain one incident in that operator's own sending; it is not published and
does not inform the public on a matter of public interest. Both duties in this paragraph are
deployers' duties: an operator who published such a paragraph for that purpose would hold the
second one.

## When these obligations apply

Article 113 says the Regulation "shall apply from 2 August 2026" and then lists exceptions for
named chapters and articles. None of them names Article 50, so this document reads Article 50 as
applying from 2 August 2026.

Article 111(4), added by Regulation (EU) 2026/1744, gives some systems more time for Article
50(2):

> Providers of AI systems, including general-purpose AI systems, generating synthetic audio,
> image, video or text content, that have been placed on the market before 2 August 2026 shall take
> the necessary steps in order to comply with Article 50(2) by 2 December 2026.

That later date covers only systems placed on the market before 2 August 2026. Work on Fothering
began on 2026-09-15, its first commit, so the extension does not reach it: the header ships with
the first version that sends an operator email.

## Article 50(5) to 50(7)

Paragraph 5 says the information in paragraphs 1 to 4 "shall be provided to the natural persons
concerned in a clear and distinguishable manner at the latest at the time of the first interaction
or exposure" and "shall conform to the applicable accessibility requirements". The From name shows
in the inbox before an email is opened, and the footer and the label are part of every email that
needs them, all as plain text, with no image or styling needed to read them.

Paragraph 6 says paragraphs 1 to 4 do not affect Chapter III and are without prejudice to other
transparency obligations in Union or national law. This document covers Article 50 only.

Paragraph 7 asks the Commission to encourage codes of practice on detecting, marking and labelling
generated content, and lets it adopt an implementing act with common rules where it finds a code
inadequate. The marking choice under Article 50(2) above is revisited if such a code or act names a
method for text.
