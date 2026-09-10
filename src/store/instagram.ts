import type { IgToken } from "../adapters/instagram";
import { decrypt, encrypt } from "./google";

const KEY_TOKEN = "instagram.token";
const KEY_SYNC = "instagram.sync";

export interface IgPost { igId: string; permalink: string; caption: string | null; mediaKey: string; contentType: string; takenAt: string; hidden: boolean; fetchedAt: number }
interface Row { ig_id: string; permalink: string; caption: string | null; media_key: string; content_type: string; taken_at: string; hidden: number; fetched_at: number }
const COLS = "ig_id, permalink, caption, media_key, content_type, taken_at, hidden, fetched_at";
const fromRow = (r: Row): IgPost => ({ igId: r.ig_id, permalink: r.permalink, caption: r.caption, mediaKey: r.media_key, contentType: r.content_type, takenAt: r.taken_at, hidden: r.hidden === 1, fetchedAt: r.fetched_at });

async function getJson<T>(db: D1Database, key: string): Promise<T | null> {
  const r = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(key).first<{ value_json: string }>();
  return r ? (JSON.parse(r.value_json) as T) : null;
}
async function putJson(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").bind(key, JSON.stringify(value)).run();
}

/** The long-lived token, AES-GCM encrypted with a key from ADMIN_SECRET (same scheme as Google, D18). */
export async function saveIgToken(db: D1Database, secret: string, t: IgToken): Promise<void> {
  await putJson(db, KEY_TOKEN, { username: t.username, userId: t.userId, expiresAt: t.expiresAt, token: await encrypt(secret, t.accessToken) });
}
export async function loadIgToken(db: D1Database, secret: string): Promise<IgToken | null> {
  const row = await getJson<{ username: string; userId: string; expiresAt: number; token: string }>(db, KEY_TOKEN);
  if (!row) return null;
  try { return { username: row.username, userId: row.userId, expiresAt: row.expiresAt, accessToken: await decrypt(secret, row.token) }; }
  catch (e) { console.error("instagram: stored token cannot be decrypted (ADMIN_SECRET rotated?); reconnect in admin", e); return null; }
}
export async function clearIgConnection(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key IN (?, ?)").bind(KEY_TOKEN, KEY_SYNC).run();
}
export async function recordIgSync(db: D1Database, at: number, error: string | null): Promise<void> { await putJson(db, KEY_SYNC, { at, error }); }
export async function loadIgSync(db: D1Database): Promise<{ at: number | null; error: string | null }> {
  return (await getJson<{ at: number; error: string | null }>(db, KEY_SYNC)) ?? { at: null, error: null };
}

export async function knownPostIds(db: D1Database): Promise<Set<string>> {
  const rows = await db.prepare("SELECT ig_id FROM ig_posts").all<{ ig_id: string }>();
  return new Set(rows.results.map((r) => r.ig_id));
}
export async function insertPost(db: D1Database, p: Omit<IgPost, "hidden">): Promise<void> {
  await db.prepare(
    "INSERT OR IGNORE INTO ig_posts (ig_id, permalink, caption, media_key, content_type, taken_at, hidden, fetched_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
  ).bind(p.igId, p.permalink, p.caption, p.mediaKey, p.contentType, p.takenAt, p.fetchedAt).run();
}
export async function listPosts(db: D1Database, includeHidden: boolean, limit = 24): Promise<IgPost[]> {
  const q = includeHidden
    ? db.prepare(`SELECT ${COLS} FROM ig_posts ORDER BY taken_at DESC LIMIT ?`).bind(limit)
    : db.prepare(`SELECT ${COLS} FROM ig_posts WHERE hidden = 0 ORDER BY taken_at DESC LIMIT ?`).bind(limit);
  return (await q.all<Row>()).results.map(fromRow);
}
export async function getPost(db: D1Database, igId: string): Promise<IgPost | null> {
  const r = await db.prepare(`SELECT ${COLS} FROM ig_posts WHERE ig_id = ?`).bind(igId).first<Row>();
  return r ? fromRow(r) : null;
}
export async function deletePost(db: D1Database, igId: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM ig_posts WHERE ig_id = ?").bind(igId).run();
  return r.meta.changes === 1;
}
export async function setPostHidden(db: D1Database, igId: string, hidden: boolean): Promise<boolean> {
  const r = await db.prepare("UPDATE ig_posts SET hidden = ? WHERE ig_id = ?").bind(hidden ? 1 : 0, igId).run();
  return r.meta.changes === 1;
}
