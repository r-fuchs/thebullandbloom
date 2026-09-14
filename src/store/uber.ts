/**
 * The Uber access token lives in D1 `settings` under `uber.token` (D30). It is a 30-day
 * client-credentials bearer for the store's own Uber org, not a user credential, so unlike the
 * Google refresh token (D18) it is stored in the clear: encrypting it would buy nothing an
 * attacker with D1 access does not already have via UBER_CLIENT_SECRET's blast radius, and a
 * plaintext row can be read by a human debugging a courier problem. It is re-fetched on any 401.
 */
const KEY = "uber.token";

export interface CachedToken { token: string; expiresAt: number } // expiresAt: unix seconds
export interface TokenCache {
  load(): Promise<CachedToken | null>;
  save(t: CachedToken): Promise<void>;
  clear(): Promise<void>;
}

export function tokenCache(db: D1Database): TokenCache {
  return {
    async load() {
      const r = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(KEY).first<{ value_json: string }>();
      if (!r) return null;
      try {
        const v = JSON.parse(r.value_json) as CachedToken;
        return typeof v?.token === "string" && typeof v?.expiresAt === "number" ? v : null;
      } catch {
        console.error("uber: cached token row is not valid JSON; re-authenticating");
        return null;
      }
    },
    async save(t) {
      await db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
        .bind(KEY, JSON.stringify(t)).run();
    },
    async clear() {
      await db.prepare("DELETE FROM settings WHERE key = ?").bind(KEY).run();
    },
  };
}
