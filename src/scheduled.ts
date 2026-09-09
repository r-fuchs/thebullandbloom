import type { Env } from "./env";
import type { Services } from "./app";
import { expireHolds } from "./store/orders";
import { syncBlackouts, type BlackoutSyncResult } from "./jobs/blackouts";
import { drainOutbox, type DrainResult } from "./jobs/outbox";

type Failed = { status: "error"; error: string };
export interface ScheduledReport {
  expiredHolds: number | { error: string };
  blackouts: BlackoutSyncResult | Failed;
  outbox: DrainResult | Failed;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every 15 minutes (wrangler.toml). Each job is isolated so one failure never blocks the others. */
export async function runScheduled(env: Env, services: Services, now: Date): Promise<ScheduledReport> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const { google, config } = services;

  let expiredHolds: ScheduledReport["expiredHolds"];
  try { expiredHolds = await expireHolds(env.DB, nowSec); }
  catch (e) { console.error("scheduled: expireHolds failed", e); expiredHolds = { error: msg(e) }; }

  let blackouts: ScheduledReport["blackouts"];
  try { blackouts = await syncBlackouts(env.DB, google, config.timezone, now); }
  catch (e) { console.error("scheduled: syncBlackouts threw", e); blackouts = { status: "error", error: msg(e) }; }

  let outbox: ScheduledReport["outbox"];
  try { outbox = await drainOutbox({ db: env.DB, google, config, siteUrl: env.SITE_URL }, now); }
  catch (e) { console.error("scheduled: drainOutbox threw", e); outbox = { status: "error", error: msg(e) }; }

  return { expiredHolds, blackouts, outbox };
}
