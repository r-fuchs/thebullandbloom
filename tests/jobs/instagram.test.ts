import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { imageUrlFor, refreshFeed, REFRESH_EVERY_SECONDS } from "../../src/jobs/instagram";
import { clearIgConnection, listPosts, loadIgSync, loadIgToken, saveIgToken } from "../../src/store/instagram";
import { FakeInstagram, RECORDED_FEED } from "../fakes/instagram";

const NOW = new Date("2026-09-10T14:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const token = { accessToken: "ig_long_fake", expiresAt: NOW_SEC + 60 * 86400, userId: "1784", username: "thebullandbloom" };
const MEDIA = env.MEDIA!; // always bound in tests (vitest.config r2Buckets)
const deps = (ig: FakeInstagram) => ({ db: env.DB, media: MEDIA, instagram: ig, adminSecret: env.ADMIN_SECRET });

describe("refreshFeed", () => {
  beforeEach(async () => {
    await clearIgConnection(env.DB);
    await env.DB.prepare("DELETE FROM ig_posts").run();
    for (const k of (await MEDIA.list()).objects) await MEDIA.delete(k.key);
  });

  it("picks the still for videos and the image otherwise", () => {
    expect(imageUrlFor(RECORDED_FEED[0])).toBe("https://cdn.test/18001.jpg");
    expect(imageUrlFor(RECORDED_FEED[1])).toBe("https://cdn.test/18002-thumb.jpg");
    expect(imageUrlFor({ ...RECORDED_FEED[1], thumbnailUrl: undefined })).toBeNull();
  });

  it("skips when not connected", async () => {
    expect(await refreshFeed(deps(new FakeInstagram()), NOW)).toEqual({ status: "skipped" });
  });

  it("copies new posts into R2 and D1, newest first, and only runs every six hours", async () => {
    await saveIgToken(env.DB, env.ADMIN_SECRET, token);
    const ig = new FakeInstagram();
    expect(await refreshFeed(deps(ig), NOW)).toEqual({ status: "ok", added: 3 });
    const posts = await listPosts(env.DB, false);
    expect(posts.map((p) => p.igId)).toEqual(["18001", "18002", "18003"]);
    expect((await MEDIA.get("ig/18002"))!.httpMetadata?.contentType).toBe("image/jpeg");
    expect(await (await MEDIA.get("ig/18002"))!.text()).toBe("img:https://cdn.test/18002-thumb.jpg");
    expect(await loadIgSync(env.DB)).toEqual({ at: NOW_SEC, error: null });
    // 15 minutes later: not due; six hours later with a new post: one more
    expect(await refreshFeed(deps(ig), new Date(NOW.getTime() + 900_000))).toEqual({ status: "not_due" });
    ig.feed.unshift({ id: "18004", mediaType: "IMAGE", mediaUrl: "https://cdn.test/18004.jpg", permalink: "https://www.instagram.com/p/ddd/", timestamp: "2026-09-10T13:00:00+0000" });
    expect(await refreshFeed(deps(ig), new Date(NOW.getTime() + REFRESH_EVERY_SECONDS * 1000))).toEqual({ status: "ok", added: 1 });
    expect(ig.fetched).toHaveLength(4);
    expect((await listPosts(env.DB, false))[0].igId).toBe("18004");
  });

  it("keeps the cached set and records the error when Instagram fails", async () => {
    await saveIgToken(env.DB, env.ADMIN_SECRET, token);
    const ig = new FakeInstagram();
    await refreshFeed(deps(ig), NOW);
    ig.failNext = "token invalid";
    expect(await refreshFeed(deps(ig), NOW, true)).toEqual({ status: "error", error: "token invalid" });
    expect(await listPosts(env.DB, false)).toHaveLength(3);
    expect(await loadIgSync(env.DB)).toEqual({ at: NOW_SEC, error: "token invalid" });
  });

  it("renews the token inside its last two weeks and stores the new one", async () => {
    await saveIgToken(env.DB, env.ADMIN_SECRET, { ...token, expiresAt: NOW_SEC + 10 * 86400 });
    const ig = new FakeInstagram();
    expect((await refreshFeed(deps(ig), NOW)).status).toBe("ok");
    expect(ig.refreshed).toBe(1);
    const t = await loadIgToken(env.DB, env.ADMIN_SECRET);
    expect(t!.accessToken).toBe("ig_long_fake_r");
    expect(t!.expiresAt).toBeGreaterThan(NOW_SEC + 30 * 86400);
  });
});
