export type OutboxKind = "calendar_event" | "email_customer" | "email_owner";
export const ORDER_PAID_KINDS: readonly OutboxKind[] = ["calendar_event", "email_customer", "email_owner"];
export const MAX_ATTEMPTS = 24;

export interface OutboxItem {
  id: string; kind: OutboxKind; orderId: string; createdAt: number; attempts: number;
  nextAttemptAt: number | null; lastError: string | null; doneAt: number | null;
}
interface Row {
  id: string; kind: OutboxKind; order_id: string; created_at: number; attempts: number;
  next_attempt_at: number | null; last_error: string | null; done_at: number | null;
}
const COLS = "id, kind, order_id, created_at, attempts, next_attempt_at, last_error, done_at";
function fromRow(r: Row): OutboxItem {
  return { id: r.id, kind: r.kind, orderId: r.order_id, createdAt: r.created_at, attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at, lastError: r.last_error, doneAt: r.done_at };
}

/**
 * One INSERT per kind, each guarded by "the order for this session is paid", so the statements
 * can ride in the same batch as the paid UPDATE and are no-ops on a duplicate webhook.
 */
export function enqueueForSessionStatements(
  db: D1Database, sessionId: string, kinds: readonly OutboxKind[], now: number,
): D1PreparedStatement[] {
  return kinds.map((kind) => db.prepare(
    `INSERT OR IGNORE INTO outbox (id, kind, order_id, created_at, attempts, next_attempt_at)
     SELECT ?1, ?2, id, ?3, 0, ?3 FROM orders WHERE stripe_session_id = ?4 AND status = 'paid'`,
  ).bind(crypto.randomUUID(), kind, now, sessionId));
}

export async function dueItems(db: D1Database, now: number, limit = 20): Promise<OutboxItem[]> {
  const rows = await db.prepare(
    `SELECT ${COLS} FROM outbox WHERE done_at IS NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
     ORDER BY created_at, kind LIMIT ?`,
  ).bind(now, limit).all<Row>();
  return rows.results.map(fromRow);
}

export async function markDone(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE outbox SET done_at = ?, last_error = NULL WHERE id = ?").bind(now, id).run();
}

export async function markFailed(db: D1Database, id: string, attempts: number, nextAttemptAt: number | null, error: string): Promise<void> {
  await db.prepare("UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?")
    .bind(attempts, nextAttemptAt, error.slice(0, 500), id).run();
}

export async function counts(db: D1Database): Promise<{ pending: number; failed: number }> {
  const r = await db.prepare(
    `SELECT SUM(CASE WHEN next_attempt_at IS NOT NULL THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN next_attempt_at IS NULL THEN 1 ELSE 0 END) AS failed
     FROM outbox WHERE done_at IS NULL`,
  ).first<{ pending: number | null; failed: number | null }>();
  return { pending: r?.pending ?? 0, failed: r?.failed ?? 0 };
}

export async function retryFailed(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare("UPDATE outbox SET attempts = 0, next_attempt_at = ? WHERE done_at IS NULL AND next_attempt_at IS NULL").bind(now).run();
  return r.meta.changes;
}

/** Next attempt time after `attempts` failures (2, 4, 8 … 64 minutes, capped), or null once we give up. */
export function backoff(attempts: number, now: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return now + 60 * 2 ** Math.min(attempts, 6);
}
