import type { Alerts } from "../adapters/alerts";
import type { Mailer } from "../adapters/mailer";
import { stuckSummary } from "../store/outbox";

export interface WatchdogResult { stuck: number; givenUp: number; oldestAgeSec: number | null; alerted: boolean; recovered: boolean }
export interface WatchdogDeps { db: D1Database; alerts: Alerts; mailer: Mailer; googleConnected: boolean; /** for the admin link in the alert; the link line is omitted when absent */ siteUrl?: string }
export interface WatchdogState { stuckSince: number | null; lastAlertAt: number | null }

const KEY = "watchdog.state";
/** one alert an hour while the condition holds (D57) */
export const ALERT_EVERY_SECONDS = 3600;

export async function loadWatchdogState(db: D1Database): Promise<WatchdogState> {
  const row = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(KEY).first<{ value_json: string }>();
  try {
    const s = row ? JSON.parse(row.value_json) : null;
    return { stuckSince: typeof s?.stuckSince === "number" ? s.stuckSince : null, lastAlertAt: typeof s?.lastAlertAt === "number" ? s.lastAlertAt : null };
  } catch { return { stuckSince: null, lastAlertAt: null }; }
}

async function saveState(db: D1Database, s: WatchdogState): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .bind(KEY, JSON.stringify(s)).run();
}

/** D57: alert once an hour while rows are stuck or given up, and once when the queue clears. */
export async function runWatchdog(deps: WatchdogDeps, now: Date): Promise<WatchdogResult> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const [sum, state] = await Promise.all([stuckSummary(deps.db, nowSec), loadWatchdogState(deps.db)]);
  const result: WatchdogResult = { stuck: sum.stuck, givenUp: sum.givenUp, oldestAgeSec: sum.oldestAgeSec, alerted: false, recovered: false };

  if (sum.stuck > 0) {
    const next: WatchdogState = { stuckSince: state.stuckSince ?? nowSec, lastAlertAt: state.lastAlertAt };
    // With no alert channel nothing is recorded as sent, so the first tick after it is set up alerts.
    if (deps.alerts.configured() && (state.lastAlertAt === null || nowSec - state.lastAlertAt >= ALERT_EVERY_SECONDS)) {
      const minutes = Math.floor((sum.oldestAgeSec ?? 0) / 60);
      const cause = !deps.mailer.configured() ? "Email is not set up."
        : sum.kinds.includes("calendar_event") && !deps.googleConnected ? "Google is disconnected: reconnect in admin."
        : "Open admin and press Retry waiting messages.";
      const lines = [`Kinds: ${sum.kinds.join(", ")}`, `Oldest: ${minutes} minutes`, cause];
      if (deps.siteUrl) lines.push(`${deps.siteUrl.replace(/\/+$/, "")}/admin/`);
      await deps.alerts.notify(`Bull and Bloom: ${sum.stuck} ${sum.stuck === 1 ? "message" : "messages"} stuck in the outbox`, lines.join("\n"));
      next.lastAlertAt = nowSec;
      result.alerted = true;
    }
    if (next.stuckSince !== state.stuckSince || next.lastAlertAt !== state.lastAlertAt) await saveState(deps.db, next);
  } else if (state.stuckSince !== null) {
    if (deps.alerts.configured()) await deps.alerts.notify("Bull and Bloom: outbox recovered", "Every queued message has gone out.");
    await saveState(deps.db, { stuckSince: null, lastAlertAt: null });
    result.recovered = true;
  }
  return result;
}
