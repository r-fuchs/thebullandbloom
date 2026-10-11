import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { composeAdsReport, runAdsReport } from "../../src/jobs/ads-report";
import type { CampaignInsights } from "../../src/adapters/meta-ads";
import type { StoreConfig } from "../../src/config";
import { FakeMailer } from "../fakes/mailer";
import { FakeMetaAds } from "../fakes/meta-ads";
import { WREATH, offersConfig } from "../helpers";

// Sun Oct 11 2026. 07:30 EDT = 11:30Z. WREATH's bookable session ("sat") is Sat Sep 12 in the fixtures, so
// this file dates its own offer instead.
const OFFER = { ...WREATH, id: "wreath-oct", name: "Wreath & Sip", sessions: [
  { id: "2026-10-17-1100", date: "2026-10-17", start: "11:00", seats: 8 },
  { id: "2026-10-17-1400", date: "2026-10-17", start: "14:00", seats: 8 },
  { id: "2026-10-03-1100", date: "2026-10-03", start: "11:00", seats: 8 },
] };
const RECIPIENTS = ["ryan@example.com", "anthony@example.com"];
function config(): StoreConfig {
  const base = offersConfig([OFFER]);
  return { ...base, marketing: { metaPixelId: "", adsReport: { recipients: RECIPIENTS, sendAt: "07:30", adAccountId: "1120923584233745", campaignMatch: "wreath" } } };
}
const at = (iso: string) => new Date(iso);
const TEST: CampaignInsights = { campaignId: "1", campaignName: "Wreath & Sip Oct 17 test", dateStart: "2026-10-07", dateStop: "2026-10-09", spendCents: 2266, reach: 522, impressions: 723, linkClicks: 21, landingPageViews: 17, purchases: 0 };
const FINAL: CampaignInsights = { campaignId: "2", campaignName: "Wreath & Sip Oct 17 final week", dateStart: "2026-10-10", dateStop: "2026-10-10", spendCents: 2014, reach: 410, impressions: 560, linkClicks: 18, landingPageViews: 14, purchases: 1 };
const OTHER: CampaignInsights = { ...TEST, campaignId: "3", campaignName: "Bouquet subscriptions", spendCents: 99900 };

let mailer: FakeMailer;
let meta: FakeMetaAds;
const run = (iso: string, cfg = config()) => runAdsReport({ db: env.DB, metaAds: meta, mailer, config: cfg }, at(iso));

async function booking(id: string, sessionId: string, name: string, seats: number, createdAt: number, status = "paid") {
  await env.DB.prepare(`INSERT INTO bookings (id, created_at, status, offer_id, session_id, customer_name, customer_email, price_cents, seats)
    VALUES (?, ?, ?, 'wreath-oct', ?, ?, 'x@example.com', 10000, ?)`).bind(id, createdAt, status, sessionId, name, seats).run();
}

describe("composeAdsReport", () => {
  const base = { today: "2026-10-11", yesterday: "2026-10-10", lookbackDays: 30, adAccountId: "1120923584233745",
    seats: [{ offerName: "Wreath & Sip", date: "2026-10-17", start: "11:00", taken: 6, seats: 8 }, { offerName: "Wreath & Sip", date: "2026-10-17", start: "14:00", taken: 2, seats: 8 }],
    newBookings: [{ customerName: "Haley Gallo", seats: 1, date: "2026-10-17", start: "14:00" }] };

  it("leads with yesterday's spend, lists each campaign's spend to date, then seats", () => {
    const m = composeAdsReport({ ...base, meta: { yesterday: [FINAL], toDate: [TEST, FINAL] } });
    expect(m.subject).toBe("Wreath & Sip ads: $20.14 yesterday, $42.80 in the last 30 days");
    expect(m.text).toBe([
      "Ads report for Sunday, October 11",
      "",
      "Yesterday (Sat Oct 10)",
      "  Spent $20.14",
      "  reach 410 · 560 impressions · 18 link clicks (3.2%) · 14 landing page views ($1.44 each) · 1 purchase ($20.14 each)",
      "",
      "Last 30 days, by campaign",
      "  Wreath & Sip Oct 17 final week (Sat Oct 10): spent $20.14 · 14 landing page views ($1.44 each) · 1 purchase",
      "  Wreath & Sip Oct 17 test (Wed Oct 7 to Fri Oct 9): spent $22.66 · 17 landing page views ($1.33 each) · 0 purchases",
      "  Total spent: $42.80",
      "",
      "Seats",
      "  Wreath & Sip · Sat Oct 17, 11 am · 6 of 8 booked",
      "  Wreath & Sip · Sat Oct 17, 2 pm · 2 of 8 booked",
      "",
      "New bookings in the last 24 hours",
      "  Haley Gallo, 1 seat (Sat Oct 17, 2 pm)",
      "",
      "Ads Manager: https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1120923584233745",
    ].join("\n"));
  });

  it("says so when no ads ran yesterday and nothing is booked yet", () => {
    const m = composeAdsReport({ ...base, meta: { yesterday: [], toDate: [TEST] }, seats: [], newBookings: [] });
    expect(m.subject).toBe("Wreath & Sip ads: $0.00 yesterday, $22.66 in the last 30 days");
    expect(m.text).toContain("  Spent $0.00 (no ads ran)");
    expect(m.text).toContain("  No upcoming classes.");
    expect(m.text).toContain("  None.");
  });

  it("explains a missing token, and a Meta failure, without dropping the bookings", () => {
    const none = composeAdsReport({ ...base, meta: null });
    expect(none.subject).toBe("Wreath & Sip ads: no ad data");
    expect(none.text).toContain("META_ACCESS_TOKEN is not set");
    expect(none.text).toContain("6 of 8 booked");
    const err = composeAdsReport({ ...base, meta: { error: "meta ads insights: 400 Invalid OAuth access token" } });
    expect(err.subject).toBe("Wreath & Sip ads: ads not read");
    expect(err.text).toContain("could not be read this morning (meta ads insights: 400 Invalid OAuth access token)");
    expect(err.text).toContain("Haley Gallo");
  });
});

describe("runAdsReport", () => {
  beforeEach(async () => {
    mailer = new FakeMailer();
    meta = new FakeMetaAds();
    meta.rows = [TEST, FINAL, OTHER];
    await env.DB.prepare("DELETE FROM bookings").run();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'ads_report.state'").run();
  });

  it("is skipped without config and waits until the send time", async () => {
    const cfg = config();
    expect(await run("2026-10-11T12:00:00Z", { ...cfg, marketing: { metaPixelId: "" } })).toEqual({ status: "skipped" });
    expect(await run("2026-10-11T11:29:00Z")).toEqual({ status: "waiting" });
    expect(mailer.sent).toEqual([]);
  });

  it("sends one report to every recipient at the first tick after the send time, then stops for the day", async () => {
    const nowSec = Math.floor(Date.parse("2026-10-11T11:30:00Z") / 1000);
    await booking("b1", "2026-10-17-1100", "Chloe", 1, nowSec - 5 * 86400);
    await booking("b2", "2026-10-17-1100", "Sean", 2, nowSec - 3 * 86400);
    await booking("b3", "2026-10-17-1400", "Haley", 1, nowSec - 3600);
    await booking("b4", "2026-10-17-1400", "Gone", 2, nowSec - 60, "cancelled");
    await booking("b5", "2026-10-03-1100", "Past", 1, nowSec - 60);

    expect(await run("2026-10-11T11:30:00Z")).toEqual({ status: "sent", sent: 2, failed: 0 });
    expect(mailer.sent.map((m) => m.to)).toEqual(RECIPIENTS);
    const { subject, text } = mailer.sent[0];
    expect(subject).toBe("Wreath & Sip ads: $20.14 yesterday, $42.80 in the last 30 days");
    expect(text).not.toContain("Bouquet subscriptions");           // campaignMatch filters it out
    expect(text).toContain("Wreath & Sip · Sat Oct 17, 11 am · 3 of 8 booked");
    expect(text).toContain("Wreath & Sip · Sat Oct 17, 2 pm · 1 of 8 booked");
    expect(text).toContain("  Haley, 1 seat (Sat Oct 17, 2 pm)");
    expect(text).not.toContain("Past");                            // sessions already gone are left out
    expect(text).not.toContain("Gone");
    expect(meta.calls).toEqual([
      { adAccountId: "1120923584233745", since: "2026-10-10", until: "2026-10-10" },
      { adAccountId: "1120923584233745", since: "2026-09-11", until: "2026-10-10" },
    ]);

    expect(await run("2026-10-11T11:45:00Z")).toEqual({ status: "done" });
    expect(await run("2026-10-11T23:59:00Z")).toEqual({ status: "done" });
    expect(mailer.sent).toHaveLength(2);
    // next day, a fresh report
    expect(await run("2026-10-12T11:30:00Z")).toEqual({ status: "sent", sent: 2, failed: 0 });
    expect(mailer.sent).toHaveLength(4);
  });

  it("retries only the recipient whose send failed", async () => {
    mailer.failNext = "resend: 500";
    expect(await run("2026-10-11T11:30:00Z")).toEqual({ status: "sent", sent: 1, failed: 1 });
    expect(mailer.sent.map((m) => m.to)).toEqual(["anthony@example.com"]);
    expect(await run("2026-10-11T11:45:00Z")).toEqual({ status: "sent", sent: 1, failed: 0 });
    expect(mailer.sent.map((m) => m.to)).toEqual(["anthony@example.com", "ryan@example.com"]);
    expect(await run("2026-10-11T12:00:00Z")).toEqual({ status: "done" });
  });

  it("still sends when the token is missing or Meta fails, saying which", async () => {
    meta.isConfigured = false;
    expect(await run("2026-10-11T11:30:00Z")).toEqual({ status: "sent", sent: 2, failed: 0 });
    expect(mailer.sent[0].text).toContain("META_ACCESS_TOKEN is not set");
    expect(meta.calls).toEqual([]);

    await env.DB.prepare("DELETE FROM settings WHERE key = 'ads_report.state'").run();
    meta.isConfigured = true;
    meta.failNext = "meta ads insights: 401 expired";
    expect(await run("2026-10-11T11:30:00Z")).toEqual({ status: "sent", sent: 2, failed: 0 });
    expect(mailer.sent[2].subject).toBe("Wreath & Sip ads: ads not read");
    expect(mailer.sent[2].text).toContain("401 expired");
  });
});
