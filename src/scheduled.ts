import type { Env } from "./env";
import type { Services } from "./app";
import { expireHolds } from "./store/orders";
import { syncBlackouts, type BlackoutSyncResult } from "./jobs/blackouts";
import { drainOutbox, type DrainResult } from "./jobs/outbox";
import { materializeSubscriptions, type MaterializeResult } from "./jobs/materialize";

type Failed = { status: "error"; error: string };
export interface ScheduledReport {
  expiredHolds: number | { error: string };
  blackouts: BlackoutSyncResult | Failed;
  subscriptions: MaterializeResult | Failed;
  outbox: DrainResult | Failed;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every 15 minutes (wrangler.toml). Each job is isolated so one failure never blocks the others. */
export async function runScheduled(env: Env, services: Services, now: Date): Promise<ScheduledReport> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const { google, payments, config } = services;

  let expiredHolds: ScheduledReport["expiredHolds"];
  try { expiredHolds = await expireHolds(env.DB, nowSec); }
  catch (e) { console.error("scheduled: expireHolds failed", e); expiredHolds = { error: msg(e) }; }

  let blackouts: ScheduledReport["blackouts"];
  try { blackouts = await syncBlackouts(env.DB, google, config.timezone, now); }
  catch (e) { console.error("scheduled: syncBlackouts threw", e); blackouts = { status: "error", error: msg(e) }; }

  // Cheap and idempotent, so it rides the 15-minute tick rather than its own nightly cron (D29 as built):
  // a new closed day is reflected in the next three weeks of bouquets within 15 minutes.
  let subscriptions: ScheduledReport["subscriptions"];
  try { subscriptions = await materializeSubscriptions({ db: env.DB, config }, now); }
  catch (e) { console.error("scheduled: materializeSubscriptions threw", e); subscriptions = { status: "error", error: msg(e) }; }

  let outbox: ScheduledReport["outbox"];
  try { outbox = await drainOutbox({ db: env.DB, google, payments, config, siteUrl: env.SITE_URL }, now); }
  catch (e) { console.error("scheduled: drainOutbox threw", e); outbox = { status: "error", error: msg(e) }; }

  return { expiredHolds, blackouts, subscriptions, outbox };
}
