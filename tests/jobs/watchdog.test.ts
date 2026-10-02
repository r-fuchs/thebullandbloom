import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { runWatchdog, loadWatchdogState } from "../../src/jobs/watchdog";
import { FakeAlerts } from "../fakes/alerts";
import { FakeMailer } from "../fakes/mailer";

const T0 = 1_800_000_000;
const at = (sec: number) => new Date(sec * 1000);
let al: FakeAlerts;
let m: FakeMailer;
const run = (sec: number, googleConnected = true) =>
  runWatchdog({ db: env.DB, alerts: al, mailer: m, googleConnected, siteUrl: "https://x.test" }, at(sec));

async function row(id: string, kind: string, createdAt: number, nextAttemptAt: number | null, doneAt: number | null = null) {
  await env.DB.prepare("INSERT INTO outbox (id, kind, order_id, created_at, attempts, next_attempt_at, done_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
    .bind(id, kind, id, createdAt, nextAttemptAt, doneAt).run();
}

describe("runWatchdog", () => {
  beforeEach(async () => {
    al = new FakeAlerts();
    m = new FakeMailer();
    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'watchdog.state'").run();
  });

  it("stays quiet for a fresh row and for rows that are done", async () => {
    await row("a", "email_owner", T0 - 899, T0);
    await row("b", "email_owner", T0 - 5000, T0, T0 - 10);
    expect(await run(T0)).toEqual({ stuck: 0, givenUp: 0, oldestAgeSec: null, alerted: false, recovered: false });
    expect(al.sent).toEqual([]);
  });

  it("alerts once the oldest row passes 15 minutes, naming the kinds and age, then at most hourly", async () => {
    await row("a", "email_owner", T0 - 900, T0 + 60);
    await row("b", "email_customer", T0 - 600, T0 + 60);
    expect(await run(T0)).toEqual({ stuck: 1, givenUp: 0, oldestAgeSec: 900, alerted: true, recovered: false });
    expect(al.sent).toHaveLength(1);
    expect(al.sent[0].subject).toBe("Bull and Bloom: 1 message stuck in the outbox");
    expect(al.sent[0].text).toContain("email_owner");
    expect(al.sent[0].text).toContain("15 minutes");
    expect(al.sent[0].text).toContain("Retry waiting messages");
    expect(al.sent[0].text).toContain("https://x.test/admin/");
    expect(await loadWatchdogState(env.DB)).toEqual({ stuckSince: T0, lastAlertAt: T0 });

    expect((await run(T0 + 900)).alerted).toBe(false);
    expect((await run(T0 + 3599)).alerted).toBe(false);
    expect(al.sent).toHaveLength(1);
    expect((await run(T0 + 3600)).alerted).toBe(true);
    expect(al.sent).toHaveLength(2);
    expect((await loadWatchdogState(env.DB)).stuckSince).toBe(T0);
  });

  it("alerts at once for a row the drain gave up on, even a fresh one", async () => {
    await row("g", "booking_confirmed_owner", T0 - 30, null);
    expect(await run(T0)).toEqual({ stuck: 1, givenUp: 1, oldestAgeSec: 30, alerted: true, recovered: false });
    expect(al.sent[0].text).toContain("booking_confirmed_owner");
  });

  it("sends one recovery notice when the queue drains, then stays quiet", async () => {
    await row("a", "email_owner", T0 - 1000, T0 + 60);
    await run(T0);
    await env.DB.prepare("UPDATE outbox SET done_at = ? WHERE id = 'a'").bind(T0 + 100).run();
    expect(await run(T0 + 120)).toEqual({ stuck: 0, givenUp: 0, oldestAgeSec: null, alerted: false, recovered: true });
    expect(al.sent.map((s) => s.subject)).toEqual(["Bull and Bloom: 1 message stuck in the outbox", "Bull and Bloom: outbox recovered"]);
    expect(await loadWatchdogState(env.DB)).toEqual({ stuckSince: null, lastAlertAt: null });
    expect((await run(T0 + 240)).recovered).toBe(false);
    expect(al.sent).toHaveLength(2);
  });

  it("names the likely cause: mailer not set up, Google down for calendar rows, else retry", async () => {
    await row("a", "email_customer", T0 - 1000, T0 + 60);
    m.isConfigured = false;
    await run(T0);
    expect(al.sent[0].text).toContain("Email is not set up");

    await env.DB.prepare("DELETE FROM settings WHERE key = 'watchdog.state'").run();
    m.isConfigured = true;
    await row("c", "calendar_event", T0 - 1000, T0 + 60);
    await run(T0, false);
    expect(al.sent[1].text).toContain("Google is disconnected: reconnect in admin");

    await env.DB.prepare("DELETE FROM settings WHERE key = 'watchdog.state'").run();
    await run(T0, true);
    expect(al.sent[2].text).toContain("press Retry waiting messages");
  });

  it("uses the plural subject for several stuck rows", async () => {
    await row("p1", "email_owner", T0 - 1000, T0 + 60);
    await row("p2", "email_customer", T0 - 1000, T0 + 60);
    await row("p3", "courier_email", T0 - 1000, T0 + 60);
    await run(T0);
    expect(al.sent[0].subject).toBe("Bull and Bloom: 3 messages stuck in the outbox");
  });

  it("with no alert channel it reports the counts and records no alert, so the first tick after setup alerts", async () => {
    await row("a", "email_owner", T0 - 1000, T0 + 60);
    al.isConfigured = false;
    expect(await run(T0)).toMatchObject({ stuck: 1, alerted: false });
    expect(al.sent).toEqual([]);
    al.isConfigured = true;
    expect((await run(T0 + 60)).alerted).toBe(true);
  });
});
