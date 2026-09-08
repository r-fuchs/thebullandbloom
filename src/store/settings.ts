import type { Defaults } from "../core/capacity";

const KEYS = ["cap", "cutoff", "openWeekdays"] as const;

export async function loadDefaults(db: D1Database, base: Defaults): Promise<Defaults> {
  const rows = await db.prepare("SELECT key, value_json FROM settings").all<{ key: string; value_json: string }>();
  const out: Defaults = { ...base, openWeekdays: [...base.openWeekdays] };
  for (const r of rows.results) {
    if ((KEYS as readonly string[]).includes(r.key)) (out as any)[r.key] = JSON.parse(r.value_json);
  }
  return out;
}

export async function saveDefaults(db: D1Database, patch: Partial<Defaults>): Promise<void> {
  const stmts = KEYS.filter((k) => patch[k] !== undefined).map((k) =>
    db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .bind(k, JSON.stringify(patch[k])),
  );
  if (stmts.length) await db.batch(stmts);
}
