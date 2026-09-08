import type { Connection } from "../adapters/google";

export interface ConnectionSource { load(): Promise<Connection | null> }
export interface GoogleState { account: string; closedCalendarId: string; ordersCalendarId: string; connectedAt: number }

const KEY_TOKEN = "google.token";
const KEY_STATE = "google.state";
const KEY_SYNC = "google.sync";
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function keyFor(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`google-token:${secret}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** AES-GCM; output is base64(iv) + "." + base64(ciphertext). */
export async function encrypt(secret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(secret), enc.encode(plain));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decrypt(secret: string, packed: string): Promise<string> {
  const i = packed.indexOf(".");
  if (i < 0) throw new Error("google token: malformed");
  const iv = unb64(packed.slice(0, i)), ct = unb64(packed.slice(i + 1));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await keyFor(secret), ct);
  return dec.decode(pt);
}

async function getJson<T>(db: D1Database, key: string): Promise<T | null> {
  const r = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(key).first<{ value_json: string }>();
  return r ? (JSON.parse(r.value_json) as T) : null;
}
async function putJson(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .bind(key, JSON.stringify(value)).run();
}

export async function saveConnection(db: D1Database, secret: string, conn: Connection): Promise<void> {
  await putJson(db, KEY_TOKEN, { account: conn.account, token: await encrypt(secret, conn.refreshToken) });
}

export async function loadConnection(db: D1Database, secret: string): Promise<Connection | null> {
  const row = await getJson<{ account: string; token: string }>(db, KEY_TOKEN);
  if (!row) return null;
  try {
    return { account: row.account, refreshToken: await decrypt(secret, row.token) };
  } catch (e) {
    console.error("google: stored token cannot be decrypted (ADMIN_SECRET rotated?); reconnect in admin", e);
    return null;
  }
}

export function connectionSource(db: D1Database, secret: string): ConnectionSource {
  return { load: () => loadConnection(db, secret) };
}

export async function saveState(db: D1Database, state: GoogleState): Promise<void> { await putJson(db, KEY_STATE, state); }
export async function loadState(db: D1Database): Promise<GoogleState | null> { return getJson<GoogleState>(db, KEY_STATE); }

export async function clearConnection(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key IN (?, ?, ?)").bind(KEY_TOKEN, KEY_STATE, KEY_SYNC).run();
}

export async function recordSync(db: D1Database, at: number, error: string | null): Promise<void> {
  await putJson(db, KEY_SYNC, { at, error });
}
export async function loadSync(db: D1Database): Promise<{ at: number | null; error: string | null }> {
  return (await getJson<{ at: number; error: string | null }>(db, KEY_SYNC)) ?? { at: null, error: null };
}
