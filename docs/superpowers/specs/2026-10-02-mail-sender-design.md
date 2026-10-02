# Mail that reaches Anthony: provider sending, an independent alert channel, an outbox watchdog

**Date:** 2026-10-02
**Status:** decisions approved by Ryan in conversation; lanes build from this document
**Owner:** Ryan Fuchs (build); Anthony Demonia (operator)
**Issues:** #1 (provider), #2 (alert channel), #3 (watchdog). Sprint doc: `docs/superpowers/plans/2026-10-02-sprint-mail.md`.
**Builds on:** `2026-09-07-store-design.md` (D11 email via Gmail, D20 outbox), Plan 7 (booking emails).

## 1. Why

On 2026-10-02 a paid Wreath & Sip booking produced no emails. The webhook marked the seat paid and
queued both messages, and every send failed with "google: not connected": the Gmail refresh token the
Worker stores for Anthony's account could no longer be decrypted (the code's own diagnosis is an
ADMIN_SECRET rotation). The calendar sync had been failing the same way. The last emails that went out
were order emails on 2026-09-15. Nothing alerted anyone; the failure was found by reading the database.

Two faults, two fixes. Sending must not hang on an OAuth token the Worker holds, and a stuck queue must
tell someone within the quarter hour.

## 2. Decisions (2026-10-02, with Ryan)

- **D55 Email goes through Resend**, authenticated with an API key in a Worker secret, from
  `The Bull and Bloom <orders@thebullandbloom.com>` with reply-to `thebullandbloom@gmail.com`.
  Google keeps only the calendar (closed days, the orders calendar). Nothing about an email depends on
  Google any more.
- **D56 Owner alerts travel on a channel that shares nothing with Resend:** Cloudflare Email Routing's
  `send_email` binding, from `alerts@thebullandbloom.com` to `thebullandbloom@gmail.com` and
  `ryan@fuchsassociates.com` (both verified as destination addresses on the zone).
- **D57 The watchdog alerts on a stuck outbox**: any row not done after 15 minutes, or any row the
  drain has given up on. One alert an hour while the condition holds, one recovery notice when it
  clears, and a red banner across admin.
- **D58 An owner email that the provider rejects is also sent, shortened, on the alert channel.** The
  customer email retries as before; Anthony hears about the order either way.
- **D59 Missing configuration never throws at boot.** Without `RESEND_API_KEY` the mailer is "not set
  up": mail rows wait, admin says so, the watchdog alerts (if the alert channel is up). Without the
  `ALERT_MAIL` binding alerts are a no-op that admin reports as "not set up". The store keeps selling.
- **D60 Config carries the addresses**, not code: `mail.from`, `mail.replyTo`, `alerts.from`,
  `alerts.to[]` in `store.config.json`, validated at boot.
- **D61 The drain no longer skips everything when Google is disconnected.** Mail kinds deliver through
  the mailer regardless; only `calendar_event` rows wait for a Google connection.
- **D62 No new migration.** The outbox table and kinds are unchanged; the watchdog keeps its small
  state in the existing `settings` table.

## 3. What changes

### 3.1 Mailer (issue #1, lane A)

`src/adapters/mailer.ts`:

```ts
export interface Mailer {
  configured(): boolean;
  send(mail: Mail): Promise<void>;   // Mail = { to, subject, text } from adapters/google.ts, moved here
}
export class ResendMailer implements Mailer {
  constructor(apiKey: string | undefined, from: string, replyTo: string, fetchFn = fetch) {}
  // POST https://api.resend.com/emails
  //   headers: Authorization: Bearer <key>, Content-Type: application/json
  //   body: { from, to: [mail.to], reply_to: replyTo, subject, text }
  // 2xx → resolve. Anything else → throw Error(`resend ${status}: ${body.message ?? body}`) so the outbox retries.
  // Not configured → throw new MailerNotConfigured() (the drain treats it like Google-not-connected: leave the row waiting, no attempt counted).
}
```

`Mail` moves from `src/adapters/google.ts` to `src/adapters/mailer.ts`; `google.ts` re-exports it so
nothing else moves. `Google.sendMail` and `GoogleApi.sendMail` are deleted. `FakeGoogle.sent` is deleted;
`tests/fakes/mailer.ts` gets `FakeMailer { sent: Mail[]; failNext: string | null; isConfigured = true }`
with the same `maybeFail` shape as `FakeGoogle`.

Wiring: `Services` gains `mailer: Mailer`; `src/index.ts` builds
`new ResendMailer(env.RESEND_API_KEY, config.mail.from, config.mail.replyTo)`; `env.ts` gains
`RESEND_API_KEY?: string`; `vitest.config.ts` adds `RESEND_API_KEY: "re_test"`; `tests/helpers.ts`
constructs a `FakeMailer` and returns it from `testApp()` and `testServices()`.

Config (`src/config.ts`): `mail: { from: string; replyTo: string }`. Validation: `from` is either an
email or `Name <email>`; `replyTo` an email. Repo values per D55.

Outbox drain (`src/jobs/outbox.ts`, `OutboxDeps` gains `mailer: Mailer`):
- Every `sendMail` call becomes `deps.mailer.send(...)`.
- The top-of-drain `loadState` skip goes. `drainOutbox` loads the Google state once; `calendar_event`
  rows are attempted only when state exists, otherwise left untouched (not claimed, no attempt
  counted) and counted in a new `waiting` figure of `DrainResult`. Mail rows are attempted whenever the
  mailer is configured; when it is not, they are left untouched the same way.
- `DrainResult` becomes `{ status: "ok"; delivered: number; failed: number; waiting: number }`.
  `status: "skipped"` disappears; `tests/scheduled.test.ts` and `tests/jobs/outbox.test.ts` change
  accordingly.
- D58: for `email_owner`, `sub_confirmed_owner`, `sub_cancelled_owner`, `booking_confirmed_owner`, a
  send failure first calls `deps.alerts.notify(subject, firstLines)` best-effort (errors logged, never
  thrown), then rethrows so the row retries. Lane A codes this against the `Alerts` interface from
  §3.2 with a `NoAlerts` stub; lane B replaces the stub.

Admin: `GET /admin/api/google/status` gains `mail: { configured: boolean; from: string }`; the Google
panel's summary line says "Email goes out through Resend as <from>; Google is used for the calendars."
or "Email is not set up: RESEND_API_KEY is missing." README and the wrangler.toml secrets comment list
`RESEND_API_KEY`.

Tests: `tests/adapters/mailer.test.ts` (request shape, 2xx resolves, 4xx throws with the message,
unconfigured throws `MailerNotConfigured`); `tests/jobs/outbox.test.ts` rewritten from `google.sent` to
`mailer.sent`, plus: mail delivers with Google disconnected; calendar rows wait with Google
disconnected and deliver once connected; an unconfigured mailer leaves rows waiting with no attempt;
an owner-email failure calls alerts and still retries. `tests/routes/webhooks.test.ts` and
`tests/routes/subscriptions.test.ts` switch their `google.sent` assertions.

### 3.2 Alerts (issue #2, lane B)

`src/adapters/alerts.ts`:

```ts
export interface Alerts {
  configured(): boolean;
  notify(subject: string, text: string): Promise<void>;   // never throws; logs and returns
}
export class EmailRoutingAlerts implements Alerts {
  constructor(binding: SendEmail | undefined, from: string, to: string[]) {}
  // builds a minimal RFC 5322 text/plain message (From, To, Subject, Date, Message-ID, MIME-Version,
  // Content-Type: text/plain; charset=utf-8, blank line, body) and calls binding.send(new EmailMessage(from, to, raw))
  // once per recipient. `EmailMessage` comes from "cloudflare:email", imported lazily inside send() so test
  // files that import this module never load it.
}
export class NoAlerts implements Alerts { configured() { return false } async notify() {} }
```

Bindings: `wrangler.toml` gains `[[send_email]] name = "ALERT_MAIL"` (no destination restriction;
Email Routing must be enabled on the zone and the two destinations verified before deploy, a Ryan
step); `env.ts` gains `ALERT_MAIL?: SendEmail`; the vitest bindings get nothing (the adapter is unit
tested with a hand-written fake binding `{ send: async (m) => sent.push(m) }`).

Config: `alerts: { from: string; to: string[] }`, validated (from an address on the zone, `to`
non-empty, all emails). `Services` gains `alerts: Alerts`; `src/index.ts` builds
`env.ALERT_MAIL ? new EmailRoutingAlerts(env.ALERT_MAIL, config.alerts.from, config.alerts.to) : new NoAlerts()`.
`tests/fakes/alerts.ts`: `FakeAlerts { sent: Array<{ subject; text }>; isConfigured = true }`.

### 3.3 Watchdog (issue #3, lane B)

`src/jobs/watchdog.ts`:

```ts
export interface WatchdogResult { stuck: number; givenUp: number; oldestAgeSec: number | null; alerted: boolean; recovered: boolean }
export async function runWatchdog(deps: { db: D1Database; alerts: Alerts; mailer: Mailer; googleConnected: boolean }, now: Date): Promise<WatchdogResult>
```

- Stuck = rows with `done_at IS NULL` and (`next_attempt_at IS NULL` or `created_at <= now − 900`).
  `src/store/outbox.ts` gains `stuckSummary(db, now): { stuck, givenUp, oldestAgeSec, kinds: string[] }`.
- State lives in `settings` under `watchdog.state` as `{ stuckSince: number | null; lastAlertAt: number | null }`.
- When stuck > 0: if `lastAlertAt` is null or older than 3600 s, send one alert and record it.
  Subject: `Bull and Bloom: N messages stuck in the outbox`. Body: the kinds, the oldest age in
  minutes, and the likely cause line: "Email is not set up" when the mailer is unconfigured, "Google is
  disconnected: reconnect in admin" when calendar rows are stuck and Google is down, otherwise "Open
  admin and press Retry waiting messages." plus the admin link.
- When stuck = 0 and `stuckSince` is set: send `Bull and Bloom: outbox recovered` once and clear the state.
- `src/scheduled.ts` runs it after the drain, isolated like the other jobs; `ScheduledReport` gains
  `watchdog: WatchdogResult | Failed`.

Admin: `GET /admin/api/outbox` returns `{ pending, failed, stuck, oldestAgeSec, mail: { configured },
alerts: { configured }, lastAlertAt }`. `POST /admin/api/outbox/retry` does what `/google/retry`
does (that route stays). `site/admin/index.html`: on load and after every panel change, fetch
`/admin/api/outbox`; when `stuck > 0` or `failed > 0` show a red banner above the toolbar: "N messages
have not gone out (oldest M minutes). [Retry waiting messages]". The banner hides when the next fetch
reports zero.

Tests: `tests/jobs/watchdog.test.ts` (fresh stuck row below threshold: no alert; above: alert with the
kinds; second run inside the hour: no alert; after an hour: alert; drain clears: recovery once, then
quiet; given-up row alerts immediately), `tests/scheduled.test.ts` gains the `watchdog` entry,
`tests/routes/admin-google.test.ts` or a new `tests/routes/admin-outbox.test.ts` covers the route and
retry, `tests/smoke.test.ts` checks the banner markup is present and hidden by default.

## 4. Failure modes

| Situation | Behavior |
|---|---|
| Resend down or key revoked | mail rows retry with backoff; owner emails also go on the alert channel (D58); watchdog alerts within 15 minutes |
| `RESEND_API_KEY` missing | rows wait with no attempts; admin says "Email is not set up"; watchdog alerts |
| Email Routing binding missing or destinations unverified | alerts are a no-op; admin says "Alerts are not set up"; the banner still shows stuck rows |
| Google disconnected | mail unaffected; calendar rows wait; watchdog alert names the reconnect |
| Both channels down | the admin banner is the last line; nothing else is possible from inside the Worker |

## 5. Rollout (Ryan's steps, in order)

1. Resend: create the account, add `thebullandbloom.com`, add its three DNS records in Cloudflare,
   wait for "verified", create an API key. `! printf '%s' <key> | npx wrangler secret put RESEND_API_KEY`.
2. Cloudflare Email Routing on the zone: enable it, add `thebullandbloom@gmail.com` and
   `ryan@fuchsassociates.com` as destination addresses, click both verification emails.
3. Merge the sprint PR; the deploy carries the new binding. First check: `/admin/api/google/status`
   shows mail configured; place nothing, press "Retry waiting messages" if the banner shows anything.
4. Prove it with one real booking or order: both emails arrive from `orders@`, the owner copy in
   Anthony's inbox, and no banner.

## 6. Out of scope

Bounce webhooks from Resend; HTML email; SMS; moving the Google token to a dedicated key (filed as a
follow-up once the cause is confirmed from the logs).
