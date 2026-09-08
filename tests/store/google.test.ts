import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  encrypt, decrypt, saveConnection, loadConnection, saveState, loadState, clearConnection,
  recordSync, loadSync, connectionSource,
} from "../../src/store/google";

const SECRET = "test-secret";

describe("store/google", () => {
  beforeEach(async () => { await clearConnection(env.DB); });

  it("encrypts and decrypts, with a fresh iv each time", async () => {
    const a = await encrypt(SECRET, "hello");
    const b = await encrypt(SECRET, "hello");
    expect(a).not.toBe(b);
    expect(a).not.toContain("hello");
    expect(await decrypt(SECRET, a)).toBe("hello");
    await expect(decrypt("other-secret", a)).rejects.toThrow();
  });

  it("stores the connection encrypted and reads it back", async () => {
    await saveConnection(env.DB, SECRET, { refreshToken: "rt_secret_value", account: "thebullandbloom@gmail.com" });
    const raw = await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'google.token'").first<{ value_json: string }>();
    expect(raw!.value_json).not.toContain("rt_secret_value");
    expect(await loadConnection(env.DB, SECRET)).toEqual({ refreshToken: "rt_secret_value", account: "thebullandbloom@gmail.com" });
    expect(await connectionSource(env.DB, SECRET).load()).toEqual({ refreshToken: "rt_secret_value", account: "thebullandbloom@gmail.com" });
  });

  it("returns null when absent or when the secret changed", async () => {
    expect(await loadConnection(env.DB, SECRET)).toBeNull();
    await saveConnection(env.DB, SECRET, { refreshToken: "rt", account: "a@b.c" });
    expect(await loadConnection(env.DB, "rotated")).toBeNull();
  });

  it("round-trips state and sync, and clear removes everything", async () => {
    await saveState(env.DB, { account: "a@b.c", closedCalendarId: "c1", ordersCalendarId: "c2", connectedAt: 5 });
    expect(await loadState(env.DB)).toEqual({ account: "a@b.c", closedCalendarId: "c1", ordersCalendarId: "c2", connectedAt: 5 });
    expect(await loadSync(env.DB)).toEqual({ at: null, error: null });
    await recordSync(env.DB, 100, null);
    expect(await loadSync(env.DB)).toEqual({ at: 100, error: null });
    await recordSync(env.DB, 200, "boom");
    expect(await loadSync(env.DB)).toEqual({ at: 200, error: "boom" });
    await clearConnection(env.DB);
    expect(await loadState(env.DB)).toBeNull();
    expect(await loadSync(env.DB)).toEqual({ at: null, error: null });
    expect(await loadConnection(env.DB, SECRET)).toBeNull();
  });
});
