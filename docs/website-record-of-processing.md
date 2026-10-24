# Record of processing: the website

The record of processing (GDPR Article 30) for https://fothering.taranity.com, this project's own website, and the
route a personal data breach on it takes. Written 2026-10-24. A Fothering deployed into an operator's AWS account is
that operator's processing, not this record's: the site's privacy page and [forget-one-recipient.md](forget-one-recipient.md)
cover it.

## The one processing activity

| Field | Entry |
|---|---|
| Controller | The developer who built this hackathon entry; contact through an issue on the project's repository (the privacy page's wording) |
| Purpose | Serving the website's pages |
| Legal basis | Legitimate interest in serving the pages, GDPR Article 6(1)(f) |
| Data subjects | Visitors to the website |
| Personal data | The IP address and request details a browser sends when it loads a page. The site sets no cookie, runs no analytics and has no form and no server code: Cloudflare serves the built files as static assets (`packages/web/wrangler.jsonc` holds only the assets block). The one browser storage key, `fothering-theme`, stays in the visitor's browser and holds `light` or `dark`. |
| Processor | Cloudflare, which serves the pages. Its Customer DPA (version 6.4, effective 2026-04-03) forms part of the Self-Serve Subscription Agreement and names Cloudflare a processor. |
| Recipients and transfers | Cloudflare's network; any transfer outside the EU runs under the terms of that DPA |
| Retention | The site keeps nothing itself and configures no log storage (no Workers logs, no Logpush); Cloudflare keeps request data under its own terms |
| Security measures | HTTPS with HSTS, an enforced content security policy, `frame-ancestors 'none'`, no third-party script (`packages/web/public/_headers`) |

## When a personal data breach happens

1. Cloudflare tells the controller without undue delay once it becomes aware of a breach of security (its DPA,
   section 3.1(e)). A breach found any other way (a report, a look at the live site) starts at step 2 the same day.
2. The controller writes down every breach: what happened, its effects and what was done about it, whether or not it
   is notified (Article 33(5)).
3. Unless the breach is unlikely to result in a risk to visitors, the controller notifies the Dutch supervisory
   authority, the Autoriteit Persoonsgegevens (https://autoriteitpersoonsgegevens.nl), without undue delay and, where
   feasible, within 72 hours of becoming aware of it (Article 33(1)). A later notice gives the reasons for the delay.
4. Where the risk to visitors is high, the controller also tells them in plain language (Article 34). The site holds no
   contact details for its visitors, so that message is a public notice on the site itself (Article 34(3)(c)).
