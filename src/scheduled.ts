import type { Env } from "./env";
import type { Services } from "./app";
import { expireHolds } from "./store/orders";
import { expireHolds as expireBookingHolds } from "./store/bookings";
import { syncBlackouts, type BlackoutSyncResult } from "./jobs/blackouts";
import { drainOutbox, type DrainResult } from "./jobs/outbox";
import { runWatchdog, type WatchdogResult } from "./jobs/watchdog";
import { loadState } from "./store/google";
import { materializeSubscriptions, type MaterializeResult } from "./jobs/materialize";
import { refreshFeed, type FeedResult } from "./jobs/instagram";
import { runAdsReport, type AdsReportResult } from "./jobs/ads-report";
import { pricedConfig } from "./store/prices";

type Failed = { status: "error"; error: string };
export interface ScheduledReport {
  expiredHolds: number | { error: string };
  expiredBookingHolds: number | { error: string };
  blackouts: BlackoutSyncResult | Failed;
  subscriptions: MaterializeResult | Failed;
  instagram: FeedResult | Failed;
  outbox: DrainResult | Failed;
  watchdog: WatchdogResult | Failed;
  adsReport: AdsReportResult | Failed;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every 15 minutes (wrangler.toml). Each job is isolated so one failure never blocks the others. */
export async function runScheduled(env: Env, services: Services, now: Date): Promise<ScheduledReport> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const { google, mailer, alerts, payments, instagram, metaAds } = services;
  const config = await pricedConfig(env.DB, services.config); // emails retried here quote the admin's prices too

  let expiredHolds: ScheduledReport["expiredHolds"];
  try { expiredHolds = await expireHolds(env.DB, nowSec); }
  catch (e) { console.error("scheduled: expireHolds failed", e); expiredHolds = { error: msg(e) }; }

  let expiredBookingHolds: ScheduledReport["expiredBookingHolds"];
  try { expiredBookingHolds = await expireBookingHolds(env.DB, nowSec); }
  catch (e) { console.error("scheduled: expireBookingHolds failed", e); expiredBookingHolds = { error: msg(e) }; }

  let blackouts: ScheduledReport["blackouts"];
  try { blackouts = await syncBlackouts(env.DB, google, config.timezone, now); }
  catch (e) { console.error("scheduled: syncBlackouts threw", e); blackouts = { status: "error", error: msg(e) }; }

  // Cheap and idempotent, so it rides the 15-minute tick rather than its own nightly cron (D29 as built):
  // a new closed day is reflected in the next three weeks of bouquets within 15 minutes.
  let subscriptions: ScheduledReport["subscriptions"];
  try { subscriptions = await materializeSubscriptions({ db: env.DB, config }, now); }
  catch (e) { console.error("scheduled: materializeSubscriptions threw", e); subscriptions = { status: "error", error: msg(e) }; }

  let instagramRes: ScheduledReport["instagram"];
  try { instagramRes = await refreshFeed({ db: env.DB, media: env.MEDIA, instagram, adminSecret: env.ADMIN_SECRET }, now); }
  catch (e) { console.error("scheduled: refreshFeed threw", e); instagramRes = { status: "error", error: msg(e) }; }

  let outbox: ScheduledReport["outbox"];
  try { outbox = await drainOutbox({ db: env.DB, google, mailer, alerts, payments, config, siteUrl: env.SITE_URL }, now); }
  catch (e) { console.error("scheduled: drainOutbox threw", e); outbox = { status: "error", error: msg(e) }; }

  // After the drain, so a row it just delivered is not reported as stuck.
  let watchdog: ScheduledReport["watchdog"];
  try { watchdog = await runWatchdog({ db: env.DB, alerts, mailer, googleConnected: (await loadState(env.DB)) !== null, siteUrl: env.SITE_URL }, now); }
  catch (e) { console.error("scheduled: runWatchdog threw", e); watchdog = { status: "error", error: msg(e) }; }

  // The daily ads email: sends once per recipient on the first tick at or after its send time.
  let adsReport: ScheduledReport["adsReport"];
  try { adsReport = await runAdsReport({ db: env.DB, metaAds, mailer, config }, now); }
  catch (e) { console.error("scheduled: runAdsReport threw", e); adsReport = { status: "error", error: msg(e) }; }

  return { expiredHolds, expiredBookingHolds, blackouts, subscriptions, instagram: instagramRes, outbox, watchdog, adsReport };
}
