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

Ryan approved all six recommendations ("That works for me", 2026-10-02). Sprint branch
`sprint/2026-10-02` from origin/main @ 563c26d, worktree `.worktrees/sprint-2026-10-02`.
Spec: `docs/superpowers/specs/2026-10-02-mail-sender-design.md` (commit bef93f5), written in the main session.

- Lane A `lane/mailer` (#1): sonnet, worktree isolation, dispatched 2026-10-02 after the spec landed.
- Lane B `lane/alerts` (#2 #3): sonnet, dispatched after lane A lands (shared wiring files).

Ryan's rollout steps (spec §5) run in parallel with the lanes: Resend account + domain + key, Email
Routing destinations.

## Landed

| lane | landed | commit | notes |
|---|---|---|---|
| A mailer (#1) | 2026-10-02 | b0c7625 | gate: 393 tests + tsc clean in the lane worktree; squashed from lane/mailer. Open items handed to lane B: D58 alert only on a row's first failure. Left as-is: `gmail.send` still in the Google scopes (consent-screen change, takes effect only on reconnect); admin "Retry" button still tied to the Google panel until B's banner. |
| B alerts + watchdog (#2 #3) | 2026-10-02 | 5521e2b | gate: 411 tests + tsc clean in the lane worktree after one fix round (singular alert subject); squashed from lane/alerts. Wording chosen by the lane, open for Ryan: alert body "Kinds: … / Oldest: M minutes / <cause> / <admin link>", recovery body "Every queued message has gone out." |

## Outcome (2026-10-02 evening)

Merged as PR #5 → main 25a9767; Deploy run 37065583473 green (typecheck, 411 tests, deploy). Opened and closed
the same afternoon the failure was found. Rollout done the same evening: Resend domain thebullandbloom.com
verified (DKIM TXT + two DNS-only CNAMEs added by hand; Resend's inbound MX deliberately not added),
`RESEND_API_KEY` set from the clipboard without passing through chat, Email Routing enabled on the zone with its
MX/DKIM/SPF records and both destinations verified (ryan@fuchsassociates.com instantly, thebullandbloom@gmail.com
by Anthony's click). Production after deploy: health ok, outbox empty, no watchdog state yet.

Not yet proven live: an actual send through Resend and an alert through Email Routing. The first real order or
booking proves the former; the watchdog's hourly alert proves the latter only when something sticks. Follow-up
filed: #4 (dedicated key for the Google token). Lane worktrees and branches removed at close.
