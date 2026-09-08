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
