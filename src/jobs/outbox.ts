import type { Google } from "../adapters/google";
import type { StoreConfig } from "../config";
import { customerEmail, orderEvent, ownerEmail } from "../core/messages";
import { loadState, type GoogleState } from "../store/google";
import { getOrder, setCalendarEventId, type Order } from "../store/orders";
import { backoff, dueItems, markDone, markFailed, type OutboxItem } from "../store/outbox";

export interface OutboxDeps { db: D1Database; google: Google; config: StoreConfig; siteUrl: string }
export interface DrainResult { status: "skipped" | "ok"; delivered: number; failed: number }

/** Deliver every due outbox row once. Failures are rescheduled with backoff; nothing here throws. */
export async function drainOutbox(deps: OutboxDeps, now: Date): Promise<DrainResult> {
  const state = await loadState(deps.db);
  if (!state) return { status: "skipped", delivered: 0, failed: 0 };
  const nowSec = Math.floor(now.getTime() / 1000);
  let delivered = 0, failed = 0;
  for (const item of await dueItems(deps.db, nowSec)) {
    try {
      const sent = await deliver(deps, state, item);
      await markDone(deps.db, item.id, nowSec);
      if (sent) delivered++;
    } catch (e) {
      const attempts = item.attempts + 1;
      const next = backoff(attempts, nowSec);
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`outbox: ${item.kind} for order ${item.orderId} failed (attempt ${attempts}${next === null ? ", giving up" : ""})`, msg);
      await markFailed(deps.db, item.id, attempts, next, msg);
      failed++;
    }
  }
  return { status: "ok", delivered, failed };
}

/** Returns whether the item was actually delivered (false when dropped because the order no longer qualifies). */
async function deliver(deps: OutboxDeps, state: GoogleState, item: OutboxItem): Promise<boolean> {
  const order = await getOrder(deps.db, item.orderId);
  if (!order || (order.status !== "paid" && order.status !== "done")) {
    console.error(`outbox: order ${item.orderId} is ${order?.status ?? "missing"}; dropping ${item.kind}`);
    return false;
  }
  switch (item.kind) {
    case "calendar_event": await calendarEvent(deps, state, order); return true;
    case "email_customer": await deps.google.sendMail(customerEmail(order, deps.config)); return true;
    case "email_owner": await deps.google.sendMail(ownerEmail(order, deps.config, deps.siteUrl)); return true;
  }
}

async function calendarEvent(deps: OutboxDeps, state: GoogleState, order: Order): Promise<void> {
  if (order.calendarEventId) return;
  const id = await deps.google.insertAllDayEvent(state.ordersCalendarId, orderEvent(order, deps.config, deps.siteUrl));
  await setCalendarEventId(deps.db, order.id, id);
}
