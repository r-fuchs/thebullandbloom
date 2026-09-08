import type { Override } from "../core/capacity";

export type OverrideSource = "admin" | "calendar";
export interface DayOverride extends Override { date: string; source: OverrideSource }
interface Row { date: string; source: OverrideSource; cap: number | null; closed: number }

export async function getOverrides(db: D1Database, from: string, to: string): Promise<Map<string, Override>> {
  const rows = await db.prepare("SELECT date, source, cap, closed FROM day_overrides WHERE date BETWEEN ? AND ? ORDER BY date")
    .bind(from, to).all<Row>();
  const out = new Map<string, Override>();
  for (const r of rows.results) {
    const cur = out.get(r.date) ?? { cap: null, closed: false };
    if (r.closed) cur.closed = true;
    if (r.source === "admin" && r.cap !== null) cur.cap = r.cap;
    out.set(r.date, cur);
  }
  return out;
}

export async function putAdminOverride(db: D1Database, date: string, o: Override): Promise<void> {
  await db.prepare(
    `INSERT INTO day_overrides (date, source, cap, closed) VALUES (?, 'admin', ?, ?)
     ON CONFLICT(date, source) DO UPDATE SET cap = excluded.cap, closed = excluded.closed`,
  ).bind(date, o.cap, o.closed ? 1 : 0).run();
}

export async function clearAdminOverride(db: D1Database, date: string): Promise<void> {
  await db.prepare("DELETE FROM day_overrides WHERE date = ? AND source = 'admin'").bind(date).run();
}

/** Make the calendar-sourced rows in [from, to] equal `closed` (date -> event id). Admin rows are never touched. */
export async function syncCalendarOverrides(
  db: D1Database, from: string, to: string, closed: Map<string, string>,
): Promise<{ added: number; removed: number }> {
  const existing = await db.prepare("SELECT date FROM day_overrides WHERE source = 'calendar' AND date BETWEEN ? AND ?")
    .bind(from, to).all<{ date: string }>();
  const have = new Set(existing.results.map((r) => r.date));
  const stmts: D1PreparedStatement[] = [];
  let added = 0, removed = 0;
  for (const [date, eventId] of closed) {
    if (!have.has(date)) added++;
    stmts.push(db.prepare(
      `INSERT INTO day_overrides (date, source, cap, closed, calendar_event_id) VALUES (?, 'calendar', NULL, 1, ?)
       ON CONFLICT(date, source) DO UPDATE SET closed = 1, calendar_event_id = excluded.calendar_event_id`,
    ).bind(date, eventId));
  }
  for (const date of have) {
    if (closed.has(date)) continue;
    removed++;
    stmts.push(db.prepare("DELETE FROM day_overrides WHERE date = ? AND source = 'calendar'").bind(date));
  }
  if (stmts.length) await db.batch(stmts);
  return { added, removed };
}
