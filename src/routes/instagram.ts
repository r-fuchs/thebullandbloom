import type { App } from "../app";
import { makeSession, verifySession } from "../admin/session";
import { clearIgConnection, getPost, listPosts, loadIgSync, loadIgToken, saveIgToken, setPostHidden } from "../store/instagram";
import { refreshFeed } from "../jobs/instagram";

const STATE_TTL = 600;
const stateSecret = (adminSecret: string) => `${adminSecret}:instagram-state`;
const redirectUri = (siteUrl: string) => `${siteUrl}/admin/instagram/callback`;
const publicPost = (p: { igId: string; permalink: string; caption: string | null; takenAt: string; hidden: boolean }) =>
  ({ id: p.igId, url: `/media/ig/${p.igId}`, permalink: p.permalink, caption: p.caption, takenAt: p.takenAt, hidden: p.hidden });

/** Public feed and cached images. */
export function instagramPublic(r: App): void {
  r.get("/api/feed", async (c) => {
    const posts = await listPosts(c.env.DB, false, 12);
    return c.json({ posts: posts.map(({ hidden: _h, ...p }) => { const { hidden, ...rest } = publicPost({ ...p, hidden: false }); return rest; }) },
      200, { "cache-control": "public, max-age=300" });
  });
  r.get("/media/ig/:id", async (c) => {
    const post = await getPost(c.env.DB, c.req.param("id"));
    if (!post) return c.text("not found", 404);
    const obj = c.env.MEDIA ? await c.env.MEDIA.get(post.mediaKey) : null;
    if (!obj) return c.text("not found", 404);
    return new Response(obj.body, { headers: { "content-type": post.contentType, "cache-control": "public, max-age=31536000, immutable", etag: obj.httpEtag } });
  });
}

/** Mounted from adminRoutes() AFTER its cookie middleware, like Google (D25 for the callback). */
export function registerInstagramAdmin(r: App): void {
  const deps = (c: any) => ({ db: c.env.DB, media: c.env.MEDIA, instagram: c.get("services").instagram, adminSecret: c.env.ADMIN_SECRET });

  r.get("/admin/api/instagram/status", async (c) => {
    const { instagram } = c.get("services");
    const [token, sync, posts] = await Promise.all([loadIgToken(c.env.DB, c.env.ADMIN_SECRET), loadIgSync(c.env.DB), listPosts(c.env.DB, true, 60)]);
    return c.json({
      configured: instagram.configured() && Boolean(c.env.MEDIA), storage: Boolean(c.env.MEDIA), connected: token !== null, username: token?.username ?? null, tokenExpiresAt: token?.expiresAt ?? null,
      lastSyncAt: sync.at, lastSyncError: sync.error, posts: posts.map(publicPost),
    });
  });
  r.get("/admin/api/instagram/start", async (c) => {
    const { instagram, clock } = c.get("services");
    if (!instagram.configured() || !c.env.MEDIA) return c.json({ error: "instagram_not_configured" }, 503);
    const nowSec = Math.floor(clock().getTime() / 1000);
    const state = await makeSession(stateSecret(c.env.ADMIN_SECRET), nowSec, STATE_TTL);
    return c.redirect(instagram.authUrl(state, redirectUri(c.env.SITE_URL)), 302);
  });
  r.get("/admin/instagram/callback", async (c) => {
    const { instagram, clock } = c.get("services");
    const now = clock(), nowSec = Math.floor(now.getTime() / 1000);
    if (!(await verifySession(c.req.query("state"), stateSecret(c.env.ADMIN_SECRET), nowSec))) return c.text("bad or expired state", 400);
    if (c.req.query("error")) return c.redirect("/admin/?instagram=denied", 302);
    const code = c.req.query("code");
    if (!code) return c.text("missing code", 400);
    try {
      const token = await instagram.exchangeCode(code, redirectUri(c.env.SITE_URL));
      await saveIgToken(c.env.DB, c.env.ADMIN_SECRET, token);
      await refreshFeed(deps(c), now, true);
      return c.redirect("/admin/?instagram=connected", 302);
    } catch (e) {
      console.error("instagram: connect failed", e);
      await clearIgConnection(c.env.DB);
      return c.redirect("/admin/?instagram=failed", 302);
    }
  });
  // A token pasted from the Meta console (API setup → Generate access tokens): the foolproof path when the
  // OAuth redirect cannot come back to the browser on a phone (2026-09-10). Long-lived tokens last ~60 days
  // and the feed job renews them, so this is a one-time paste.
  r.post("/admin/api/instagram/token", async (c) => {
    const { instagram, clock } = c.get("services");
    if (!c.env.MEDIA) return c.json({ error: "storage_not_configured" }, 503);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
    if (accessToken.length < 20) return c.json({ error: "paste the whole token" }, 400);
    const now = clock();
    try {
      const me = await instagram.whoAmI(accessToken);
      await saveIgToken(c.env.DB, c.env.ADMIN_SECRET, { accessToken, userId: me.userId, username: me.username, expiresAt: Math.floor(now.getTime() / 1000) + 60 * 86400 });
    } catch (e) {
      console.error("instagram: pasted token rejected", e);
      return c.json({ error: "Instagram did not accept that token. Generate a fresh one and paste all of it." }, 400);
    }
    const feed = await refreshFeed(deps(c), now, true);
    return c.json({ ok: true, feed });
  });
  r.post("/admin/api/instagram/disconnect", async (c) => { await clearIgConnection(c.env.DB); return c.body(null, 204); });
  r.post("/admin/api/instagram/refresh", async (c) => c.json(await refreshFeed(deps(c), c.get("services").clock(), true)));
  r.put("/admin/api/instagram/posts/:id", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (typeof body.hidden !== "boolean") return c.json({ error: "hidden must be boolean" }, 400);
    if (!(await setPostHidden(c.env.DB, c.req.param("id"), body.hidden))) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
}
