# Sprint 2026-10-02: mail that reaches Anthony

Opened after the Plan 7 launch: a paid booking produced no emails because the Gmail OAuth token the
Worker holds could no longer be decrypted ("google: not connected"), and nothing alerted anyone. The
last emails that went out were order emails on 2026-09-15. Ryan: "we need to build the mail sender
feature asap."

Issues: #1 transactional mail provider · #2 owner alert channel · #3 outbox watchdog.

## Stage 1: assessment

| lane | issues | size | kind | model(s) | overlaps / depends on | branch |
|---|---|---|---|---|---|---|
| spec | #1 #2 #3 | S | design (contract-level: interfaces, failure semantics, config) | main session (fable) writes one spec; Ryan reads it | none; precedes both lanes | — |
| A mailer | #1 | M | build against the spec | sonnet | `src/jobs/outbox.ts`, `Services` (`src/app.ts`, `src/index.ts`), `src/env.ts`, `wrangler.toml`, `vitest.config.ts`, `tests/helpers.ts`, every test asserting `google.sent` | `lane/mailer` |
| B alerts + watchdog | #2 #3 | M | build against the spec | sonnet | new `src/adapters/alerts.ts`, `src/jobs/watchdog.ts`, `src/store/outbox.ts` (one query), `src/scheduled.ts`, admin route + banner; shares the wiring files with A (`src/app.ts`, `src/index.ts`, `src/env.ts`, `wrangler.toml`, `vitest.config.ts`, `tests/helpers.ts`) | `lane/alerts` |

A and B share six wiring files in small, distinct hunks. They run as a sequence, not in parallel:
A lands first, B starts from the sprint branch with A in it. #2 and #3 are one lane because the
watchdog is the first and main consumer of the alert channel and the two together are still M.

Excluded: nothing. Follow-up filed separately once the Worker logs confirm the cause of the token failure
(dedicated encryption key for the Google token so an admin-secret rotation cannot break the calendar).

## Questions for Ryan (each needs a word before dispatch)

1. **Provider.** Recommend Resend: API key, free tier (3,000 emails a month, 100 a day) covers this
   store many times over, domain verification is three DNS records on a zone already in Cloudflare,
   bounces arrive as webhooks later if wanted. Alternative Postmark at $15 a month. The account and
   key are yours to create (billable resource); I wire the secret.
2. **From address.** Recommend `The Bull and Bloom <orders@thebullandbloom.com>` with reply-to
   `thebullandbloom@gmail.com`, so Anthony's replies keep working and customers see the domain, not a
   Gmail. Needs the DNS records from (1); I can add them through your Cloudflare session if you say so.
3. **Owner alert channel.** Recommend Cloudflare Email Routing's `send_email` binding: free, no
   provider, but it only delivers to destination addresses verified on the zone, so Anthony's Gmail and
   your fuchsassociates address get verified once (a click in each inbox). Alternative: SMS through
   Twilio, which is a second account and a few cents a message. Email Routing must be enabled on the
   zone; it may already be.
4. **Who gets watchdog alerts.** Recommend both of you.
5. **Thresholds.** Recommend: stuck = undelivered after 15 minutes; one alert an hour while stuck; a
   recovery notice when the queue drains. Confirm or change.
6. **Google stays for the calendar only** (closed days and the orders calendar). Recommend yes; a
   calendar failure costs a reminder, not an order, and it already shows in admin.

Waiting for your word before anything dispatches.

## Stage 2: dispatch

(filled in after the word)

## Landed

(one row per lane: commit, spec path)

## Outcome

(filled at close)
