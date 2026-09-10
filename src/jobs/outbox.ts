import type { Google } from "../adapters/google";
import type { StoreConfig } from "../config";
import { customerEmail, orderEvent, ownerEmail, ownerSubscriptionEmail, subscriptionCancelledEmail, subscriptionConfirmedEmail } from "../core/messages";
import type { Payments } from "../adapters/payments";
import { getSubscriber } from "../store/subscribers";
import { loadState, type GoogleState } from "../store/google";
import { getOrder, setCalendarEventId, type Order } from "../store/orders";
import { backoff, claimItem, CLAIM_LEASE_SECONDS, dueItems, isSubscriberKind, markDone, markFailed, type OutboxItem } from "../store/outbox";

export interface OutboxDeps { db: D1Database; google: Google; payments: Payments; config: StoreConfig; siteUrl: string }
export interface DrainResult { status: "skipped" | "ok"; delivered: number; failed: number }

/** Deliver every due outbox row once. Failures are rescheduled with backoff; nothing here throws. */
export async function drainOutbox(deps: OutboxDeps, now: Date): Promise<DrainResult> {
  const state = await loadState(deps.db);
  if (!state) return { status: "skipped", delivered: 0, failed: 0 };
  const nowSec = Math.floor(now.getTime() / 1000);
  let delivered = 0, failed = 0;
  for (const item of await dueItems(deps.db, nowSec)) {
    // Claim the row before delivering: an overlapping drain (webhook + cron, or two
    // near-simultaneous checkouts) racing on the same SELECT must not both send.
    // A lost claim means someone else has it — neither delivered nor failed here.
    if (item.nextAttemptAt === null) continue;
    if (!(await claimItem(deps.db, item.id, item.nextAttemptAt, nowSec + CLAIM_LEASE_SECONDS))) continue;

    let sent: boolean;
    try {
      sent = await deliver(deps, state, item);
    } catch (e) {
      const attempts = item.attempts + 1;
      const next = backoff(attempts, nowSec);
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`outbox: ${item.kind} for order ${item.orderId} failed (attempt ${attempts}${next === null ? ", giving up" : ""})`, msg);
      try {
        await markFailed(deps.db, item.id, attempts, next, msg);
      } catch (e2) {
        console.error("outbox: could not record failure", item.id, e2);
      }
      failed++;
      continue;
    }
    // The send already happened; a bookkeeping failure here must be logged, never
    // turned into a retry (that would resend a mail that already went out).
    try {
      await markDone(deps.db, item.id, nowSec);
    } catch (e) {
      console.error("outbox: delivered but could not mark done", item.id, e);
    }
    if (sent) delivered++;
  }
  return { status: "ok", delivered, failed };
}

/** Returns whether the item was actually delivered (false when dropped because the order no longer qualifies). */
async function deliver(deps: OutboxDeps, state: GoogleState, item: OutboxItem): Promise<boolean> {
  if (isSubscriberKind(item.kind)) return deliverSubscriber(deps, item);
  const order = await getOrder(deps.db, item.orderId);
  if (!order || (order.status !== "paid" && order.status !== "done")) {
    console.error(`outbox: order ${item.orderId} is ${order?.status ?? "missing"}; dropping ${item.kind}`);
    return false;
  }
  switch (item.kind) {
    case "calendar_event": await calendarEvent(deps, state, order); return true;
    case "email_customer": await deps.google.sendMail(customerEmail(order, deps.config)); return true;
    case "email_owner": await deps.google.sendMail(ownerEmail(order, deps.config, deps.siteUrl)); return true;
    default: console.error(`outbox: unknown order kind ${item.kind}`); return false;
  }
}

/** Subscription emails: the outbox subject is the subscriber id. */
async function deliverSubscriber(deps: OutboxDeps, item: OutboxItem): Promise<boolean> {
  const sub = await getSubscriber(deps.db, item.orderId);
  if (!sub) { console.error(`outbox: subscriber ${item.orderId} missing; dropping ${item.kind}`); return false; }
  switch (item.kind) {
    case "sub_confirmed_customer": {
      if (sub.status === "cancelled") return false;
      const portal = await deps.payments.portalLink(sub.stripeCustomerId, `${deps.siteUrl}/`);
      await deps.google.sendMail(subscriptionConfirmedEmail(sub, deps.config, portal));
      return true;
    }
    case "sub_confirmed_owner": await deps.google.sendMail(ownerSubscriptionEmail(sub, deps.config, deps.siteUrl, "started")); return true;
    case "sub_cancelled_customer": await deps.google.sendMail(subscriptionCancelledEmail(sub, deps.config)); return true;
    case "sub_cancelled_owner": await deps.google.sendMail(ownerSubscriptionEmail(sub, deps.config, deps.siteUrl, "cancelled")); return true;
    default: console.error(`outbox: unknown subscriber kind ${item.kind}`); return false;
  }
}

async function calendarEvent(deps: OutboxDeps, state: GoogleState, order: Order): Promise<void> {
  if (order.calendarEventId) return;
  const id = await deps.google.insertAllDayEvent(state.ordersCalendarId, orderEvent(order, deps.config, deps.siteUrl));
  await setCalendarEventId(deps.db, order.id, id);
}
