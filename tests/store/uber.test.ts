import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { tokenCache } from "../../src/store/uber";

describe("store/uber token cache", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM settings WHERE key = 'uber.token'").run(); });

  it("returns null when nothing is cached", async () => {
    expect(await tokenCache(env.DB).load()).toBeNull();
  });

  it("round-trips a token, its expiry and the client id that minted it", async () => {
    const c = tokenCache(env.DB);
    await c.save({ token: "at_1", expiresAt: 1_800_000_000, clientId: "cid_a" });
    expect(await c.load()).toEqual({ token: "at_1", expiresAt: 1_800_000_000, clientId: "cid_a" });
    await c.save({ token: "at_2", expiresAt: 1_900_000_000, clientId: "cid_b" });
    expect(await c.load()).toEqual({ token: "at_2", expiresAt: 1_900_000_000, clientId: "cid_b" });
  });

  it("still loads a row saved before the client id existed", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('uber.token', ?)")
      .bind(JSON.stringify({ token: "at_old", expiresAt: 1_800_000_000 })).run();
    expect(await tokenCache(env.DB).load()).toEqual({ token: "at_old", expiresAt: 1_800_000_000 });
  });

  it("clears the cached token", async () => {
    const c = tokenCache(env.DB);
    await c.save({ token: "at_1", expiresAt: 1_800_000_000 });
    await c.clear();
    expect(await c.load()).toBeNull();
  });

  it("survives a corrupt row rather than throwing", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('uber.token', 'not json')").run();
    expect(await tokenCache(env.DB).load()).toBeNull();
  });
});
