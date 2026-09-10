import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { testApp } from "../helpers";
import { clearIgConnection, listPosts, loadIgToken, saveIgToken } from "../../src/store/instagram";
import { refreshFeed } from "../../src/jobs/instagram";

const NOW = new Date("2026-09-10T14:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const token = { accessToken: "ig_long_fake", expiresAt: NOW_SEC + 60 * 86400, userId: "1784", username: "thebullandbloom" };
async function login(fetch: any) {
  const r = await fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: "open-sesame-1234" }) });
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return (path: string, init: RequestInit = {}) => fetch(path, { ...init, headers: { ...(init.headers as any), cookie, "content-type": "application/json" }, redirect: "manual" });
}

describe("instagram routes", () => {
  beforeEach(async () => {
    await clearIgConnection(env.DB);
    await env.DB.prepare("DELETE FROM ig_posts").run();
  });

  it("serves an empty feed before anything is connected", async () => {
    const { fetch } = testApp(NOW);
    const r = await fetch("/api/feed");
    expect(await r.json()).toEqual({ posts: [] });
    expect(r.headers.get("cache-control")).toContain("max-age=300");
    expect((await fetch("/media/ig/nope")).status).toBe(404);
  });

  it("connects through start → callback, pulls the feed at once, and serves images from our storage", async () => {
    const { fetch, instagram } = testApp(NOW);
    const api = await login(fetch);
    expect((await fetch("/admin/api/instagram/status")).status).toBe(401);
    expect(await (await api("/admin/api/instagram/status")).json()).toMatchObject({ configured: true, connected: false, username: null, posts: [] });
    const start = await api("/admin/api/instagram/start");
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get("location")!);
    expect(loc.searchParams.get("redirect_uri")).toBe(`${env.SITE_URL}/admin/instagram/callback`);
    const state = loc.searchParams.get("state")!;
    expect((await fetch("/admin/instagram/callback?code=good-code&state=999.forged", { redirect: "manual" })).status).toBe(400);
    const cb = await fetch(`/admin/instagram/callback?code=good-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(cb.headers.get("location")).toBe("/admin/?instagram=connected");
    expect((await loadIgToken(env.DB, env.ADMIN_SECRET))!.username).toBe("thebullandbloom");
    expect(instagram.fetched).toHaveLength(3);
    const feed = await (await fetch("/api/feed")).json();
    expect(feed.posts.map((p: any) => p.id)).toEqual(["18001", "18002", "18003"]);
    expect(feed.posts[0]).toEqual({ id: "18001", url: "/media/ig/18001", permalink: "https://www.instagram.com/p/aaa/", caption: "Tuesday's bouquets, out the door.", takenAt: "2026-09-08T14:05:00+0000" });
    const img = await fetch("/media/ig/18001");
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(await img.text()).toBe("img:https://cdn.test/18001.jpg");
    const status = await (await api("/admin/api/instagram/status")).json();
    expect(status).toMatchObject({ connected: true, username: "thebullandbloom", lastSyncAt: NOW_SEC, lastSyncError: null });
    expect(status.posts).toHaveLength(3);
  });

  it("hides a post from the feed but keeps it in admin, and disconnects", async () => {
    await saveIgToken(env.DB, env.ADMIN_SECRET, token);
    const { fetch, instagram } = testApp(NOW);
    await refreshFeed({ db: env.DB, media: env.MEDIA, instagram, adminSecret: env.ADMIN_SECRET }, NOW, true);
    const api = await login(fetch);
    expect((await api("/admin/api/instagram/posts/18002", { method: "PUT", body: JSON.stringify({ hidden: true }) })).status).toBe(200);
    expect((await api("/admin/api/instagram/posts/nope", { method: "PUT", body: JSON.stringify({ hidden: true }) })).status).toBe(404);
    expect((await (await fetch("/api/feed")).json()).posts.map((p: any) => p.id)).toEqual(["18001", "18003"]);
    const adminPosts = (await (await api("/admin/api/instagram/status")).json()).posts;
    expect(adminPosts.find((p: any) => p.id === "18002").hidden).toBe(true);
    expect((await api("/admin/api/instagram/refresh", { method: "POST" })).status).toBe(200);
    expect((await api("/admin/api/instagram/disconnect", { method: "POST" })).status).toBe(204);
    expect((await (await api("/admin/api/instagram/status")).json()).connected).toBe(false);
    expect(await listPosts(env.DB, false)).toHaveLength(2); // cached posts survive a disconnect
  });

  it("returns 503 from start when the app is not configured", async () => {
    const { fetch, instagram } = testApp(NOW);
    instagram.isConfigured = false;
    const api = await login(fetch);
    expect((await api("/admin/api/instagram/start")).status).toBe(503);
  });
});
