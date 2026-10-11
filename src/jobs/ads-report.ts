// The daily ads email (Ryan, 2026-10-11): what the Wreath & Sip campaigns spent and did yesterday,
// each campaign's spend to date, and where seats stand. Rides the 15-minute cron: the first tick at
// or after `sendAt` (store time) sends it, and a settings row keeps that to once a day per recipient,
// so a failed send is retried on the next tick and a delivered one is never repeated.

import type { Mailer } from "../adapters/mailer";
import type { CampaignInsights, MetaAds } from "../adapters/meta-ads";
import type { AdsReportConfig, StoreConfig } from "../config";
import { dollars } from "../core/messages";
import { humanTime } from "../core/offers";
import { addDays, hmIn, humanDate, longDate, ymdIn } from "../core/time";
import { listForOffer } from "../store/bookings";

export interface AdsReportDeps { db: D1Database; metaAds: MetaAds; mailer: Mailer; config: StoreConfig }
export type AdsReportResult =
  | { status: "skipped" }               // no marketing.adsReport in config
  | { status: "waiting" }               // before today's send time
  | { status: "done" }                  // every recipient already has today's report
  | { status: "sent"; sent: number; failed: number };

export interface SeatLine { offerName: string; date: string; start: string; taken: number; seats: number }
export interface NewBookingLine { customerName: string; seats: number; start: string; date: string }
export interface AdsReportInput {
  today: string;
  yesterday: string;
  lookbackDays: number;
  adAccountId: string;
  /** null when the token is not set; a string when Meta could not be read */
  meta: { yesterday: CampaignInsights[]; toDate: CampaignInsights[] } | null | { error: string };
  seats: SeatLine[];
  newBookings: NewBookingLine[];
}

const KEY = "ads_report.state";
interface State { date: string; sent: string[] }

async function loadState(db: D1Database): Promise<State | null> {
  const row = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(KEY).first<{ value_json: string }>();
  if (!row) return null;
  try {
    const s = JSON.parse(row.value_json) as Partial<State>;
    return typeof s.date === "string" && Array.isArray(s.sent) ? { date: s.date, sent: s.sent.filter((x): x is string => typeof x === "string") } : null;
  } catch { return null; }
}

async function saveState(db: D1Database, s: State): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .bind(KEY, JSON.stringify(s)).run();
}

const sum = (rows: CampaignInsights[], f: (r: CampaignInsights) => number) => rows.reduce((n, r) => n + f(r), 0);
const pct = (part: number, whole: number) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "0%");
const each = (cents: number, n: number) => (n > 0 ? ` (${dollars(Math.round(cents / n))} each)` : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function resultsLine(rows: CampaignInsights[]): string {
  const spend = sum(rows, (r) => r.spendCents);
  const imp = sum(rows, (r) => r.impressions);
  const clicks = sum(rows, (r) => r.linkClicks);
  const lpv = sum(rows, (r) => r.landingPageViews);
  const buys = sum(rows, (r) => r.purchases);
  return [
    `reach ${sum(rows, (r) => r.reach)}`,
    `${imp} impressions`,
    `${plural(clicks, "link click")} (${pct(clicks, imp)})`,
    `${plural(lpv, "landing page view")}${each(spend, lpv)}`,
    `${plural(buys, "purchase")}${each(spend, buys)}`,
  ].join(" · ");
}

/** Pure: the subject and body for one day's report. Exported for tests. */
export function composeAdsReport(input: AdsReportInput): { subject: string; text: string } {
  const lines: string[] = [`Ads report for ${longDate(input.today)}`, ""];
  let subjectSpend = "no ad data";

  if (input.meta === null) {
    lines.push("Meta ads: not connected yet (META_ACCESS_TOKEN is not set), so this report has bookings only.", "");
  } else if ("error" in input.meta) {
    lines.push(`Meta ads: could not be read this morning (${input.meta.error}). Bookings below are current.`, "");
    subjectSpend = "ads not read";
  } else {
    const y = input.meta.yesterday;
    const ySpend = sum(y, (r) => r.spendCents);
    lines.push(`Yesterday (${humanDate(input.yesterday)})`);
    if (y.length === 0) lines.push("  Spent $0.00 (no ads ran)");
    else lines.push(`  Spent ${dollars(ySpend)}`, `  ${resultsLine(y)}`);
    lines.push("");

    const toDate = [...input.meta.toDate].sort((a, b) => (a.dateStart < b.dateStart ? 1 : a.dateStart > b.dateStart ? -1 : 0));
    const total = sum(toDate, (r) => r.spendCents);
    lines.push(`Last ${input.lookbackDays} days, by campaign`);
    if (toDate.length === 0) lines.push("  No campaigns delivered.");
    for (const c of toDate) {
      const when = c.dateStart === c.dateStop ? humanDate(c.dateStart) : `${humanDate(c.dateStart)} to ${humanDate(c.dateStop)}`;
      lines.push(`  ${c.campaignName} (${when}): spent ${dollars(c.spendCents)} · ${plural(c.landingPageViews, "landing page view")}${each(c.spendCents, c.landingPageViews)} · ${plural(c.purchases, "purchase")}`);
    }
    lines.push(`  Total spent: ${dollars(total)}`, "");
    subjectSpend = `${dollars(ySpend)} yesterday, ${dollars(total)} in the last ${input.lookbackDays} days`;
  }

  lines.push("Seats");
  if (input.seats.length === 0) lines.push("  No upcoming classes.");
  for (const s of input.seats) lines.push(`  ${s.offerName} · ${humanDate(s.date)}, ${humanTime(s.start)} · ${s.taken} of ${s.seats} booked`);
  lines.push("", "New bookings in the last 24 hours");
  if (input.newBookings.length === 0) lines.push("  None.");
  for (const b of input.newBookings) lines.push(`  ${b.customerName}, ${plural(b.seats, "seat")} (${humanDate(b.date)}, ${humanTime(b.start)})`);
  lines.push("", `Ads Manager: https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${input.adAccountId}`);

  return { subject: `Wreath & Sip ads: ${subjectSpend}`, text: lines.join("\n") };
}

const matches = (c: CampaignInsights, needle: string | undefined) =>
  !needle || c.campaignName.toLowerCase().includes(needle.toLowerCase());

async function gather(deps: AdsReportDeps, cfg: AdsReportConfig, now: Date): Promise<AdsReportInput> {
  const tz = deps.config.timezone;
  const today = ymdIn(tz, now);
  const yesterday = addDays(today, -1);
  const lookbackDays = cfg.lookbackDays ?? 30;
  const nowSec = Math.floor(now.getTime() / 1000);

  let meta: AdsReportInput["meta"] = null;
  if (deps.metaAds.configured()) {
    try {
      const [y, toDate] = await Promise.all([
        deps.metaAds.campaignInsights(cfg.adAccountId, yesterday, yesterday),
        deps.metaAds.campaignInsights(cfg.adAccountId, addDays(today, -lookbackDays), yesterday),
      ]);
      meta = { yesterday: y.filter((c) => matches(c, cfg.campaignMatch)), toDate: toDate.filter((c) => matches(c, cfg.campaignMatch)) };
    } catch (e) {
      console.error("ads report: meta insights failed", e);
      meta = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const seats: SeatLine[] = [];
  const newBookings: NewBookingLine[] = [];
  for (const offer of deps.config.offers ?? []) {
    if (!offer.enabled) continue;
    const bookings = await listForOffer(deps.db, offer.id);
    for (const s of offer.sessions) {
      if (s.date < today) continue;
      const live = bookings.filter((b) => b.sessionId === s.id && (b.status === "paid" || b.status === "held"));
      seats.push({ offerName: offer.name, date: s.date, start: s.start, taken: live.reduce((n, b) => n + b.seats, 0), seats: s.seats });
      for (const b of live) {
        if (b.status === "paid" && b.createdAt >= nowSec - 86400) newBookings.push({ customerName: b.customerName, seats: b.seats, date: s.date, start: s.start });
      }
    }
  }
  return { today, yesterday, lookbackDays, adAccountId: cfg.adAccountId, meta, seats, newBookings };
}

export async function runAdsReport(deps: AdsReportDeps, now: Date): Promise<AdsReportResult> {
  const cfg = deps.config.marketing?.adsReport;
  if (!cfg) return { status: "skipped" };
  const tz = deps.config.timezone;
  const today = ymdIn(tz, now);
  if (hmIn(tz, now) < cfg.sendAt) return { status: "waiting" };

  const prior = await loadState(deps.db);
  const state: State = prior?.date === today ? prior : { date: today, sent: [] };
  const pending = cfg.recipients.filter((r) => !state.sent.includes(r));
  if (pending.length === 0) return { status: "done" };

  const mail = composeAdsReport(await gather(deps, cfg, now));
  let sent = 0, failed = 0;
  for (const to of pending) {
    try {
      await deps.mailer.send({ to, subject: mail.subject, text: mail.text });
      state.sent.push(to);
      await saveState(deps.db, state);
      sent++;
    } catch (e) {
      console.error(`ads report: send to ${to} failed`, e);
      failed++;
    }
  }
  return { status: "sent", sent, failed };
}
