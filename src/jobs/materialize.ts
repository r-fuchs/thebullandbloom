import type { StoreConfig } from "../config";
import { capFor } from "../core/capacity";
import { dueDates, nextAnchor, shiftForClosed, type IsOpen } from "../core/subscriptions";
import { addDays, ymdIn } from "../core/time";
import { loadDefaults } from "../store/settings";
import { getOverrides } from "../store/overrides";
import { enqueueForSubjectStatements } from "../store/outbox";
import { getSubscriber, insertMaterializedOrder, listSubscribers, type Subscriber } from "../store/subscribers";

export const HORIZON_DAYS = 21;   // D29
export const SIGNUP_LEAD_DAYS = 3; // pending decision 2, approved 2026-09-10
const FLAGS_KEY = "subscriptions.flags";

export interface MaterializeDeps { db: D1Database; config: StoreConfig }
export interface MaterializeResult { status: "ok"; created: number; skippedWeeks: number }
export interface SkippedWeek { subscriberId: string; customerName: string; week: string }

/** Studio-open predicate over [from, to] from defaults + overrides: open means a cap above zero. */
export async function openPredicate(deps: MaterializeDeps, from: string, to: string): Promise<IsOpen> {
  const [defaults, overrides] = await Promise.all([loadDefaults(deps.db, deps.config.defaults), getOverrides(deps.db, from, to)]);
  return (d) => capFor(d, defaults, overrides.get(d) ?? null) > 0;
}

/** Anchor for a new signup: first open occurrence of the weekday at least SIGNUP_LEAD_DAYS out; falls back to the bare weekday if the studio is closed for eight weeks. */
export async function anchorFor(deps: MaterializeDeps, weekday: number, now: Date): Promise<string> {
  const today = ymdIn(deps.config.timezone, now);
  const isOpen = await openPredicate(deps, today, addDays(today, 70));
  const a = nextAnchor(weekday, today, SIGNUP_LEAD_DAYS, isOpen);
  if (a) return a;
  console.error("materialize: no open day for weekday", weekday, "in eight weeks; anchoring on the calendar weekday");
  return nextAnchor(weekday, today, SIGNUP_LEAD_DAYS, () => true)!;
}

/**
 * Creates the paid, zero-priced orders for every active subscriber's due dates over the next
 * HORIZON_DAYS, applying D13, and queues a calendar event for each new one. Idempotent (D29).
 * With `onlyId` it runs for that subscriber alone (signup) and merges its skipped weeks into the flags.
 */
export async function materializeSubscriptions(deps: MaterializeDeps, now: Date, onlyId?: string): Promise<MaterializeResult> {
  const tz = deps.config.timezone;
  const today = ymdIn(tz, now), to = addDays(today, HORIZON_DAYS);
  const nowSec = Math.floor(now.getTime() / 1000);
  const isOpen = await openPredicate(deps, today, addDays(to, 7));
  const subs: Subscriber[] = onlyId
    ? [await getSubscriber(deps.db, onlyId)].filter((s): s is Subscriber => !!s && s.status === "active")
    : await listSubscribers(deps.db, "active");
  let created = 0;
  const skipped: SkippedWeek[] = [];
  for (const sub of subs) {
    const cadence = deps.config.subscriptions.cadences.find((c) => c.id === sub.cadenceId);
    if (!cadence) { console.error("materialize: subscriber", sub.id, "has unknown cadence", sub.cadenceId); continue; }
    for (const due of dueDates({ anchorDate: sub.anchorDate, perMonth: cadence.perMonth, pausedWeeks: sub.pausedWeeks }, today, to)) {
      const shift = shiftForClosed(due, isOpen);
      if ("skipped" in shift) { skipped.push({ subscriberId: sub.id, customerName: sub.customerName, week: shift.week }); continue; }
      const id = crypto.randomUUID();
      const inserted = await insertMaterializedOrder(deps.db, {
        id, subscriberId: sub.id, date: shift.date, sizeId: sub.sizeId, fulfillment: sub.fulfillment,
        customerName: sub.customerName, customerEmail: sub.customerEmail, customerPhone: sub.customerPhone,
        addressJson: sub.addressJson, note: sub.note,
      }, nowSec);
      if (!inserted) continue;
      created++;
      await deps.db.batch(enqueueForSubjectStatements(deps.db, id, ["calendar_event"], nowSec));
    }
  }
  await saveFlags(deps.db, skipped, onlyId, today);
  return { status: "ok", created, skippedWeeks: skipped.length };
}

export async function loadFlags(db: D1Database): Promise<SkippedWeek[]> {
  const r = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(FLAGS_KEY).first<{ value_json: string }>();
  if (!r) return [];
  try { const v = JSON.parse(r.value_json); return Array.isArray(v) ? v : []; } catch { return []; }
}

async function saveFlags(db: D1Database, fresh: SkippedWeek[], onlyId: string | undefined, today: string): Promise<void> {
  // A full run is authoritative; a single-subscriber run replaces only that subscriber's flags. Past weeks fall off.
  const prior = await loadFlags(db);
  const kept = onlyId ? prior.filter((f) => f.subscriberId !== onlyId) : [];
  const merged = [...kept, ...fresh].filter((f) => f.week >= addDays(today, -6));
  await db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .bind(FLAGS_KEY, JSON.stringify(merged)).run();
}
