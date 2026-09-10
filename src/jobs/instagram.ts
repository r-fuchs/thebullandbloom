import type { IgMedia, IgToken, Instagram } from "../adapters/instagram";
import { insertPost, knownPostIds, loadIgSync, loadIgToken, recordIgSync, saveIgToken } from "../store/instagram";

export const FEED_LIMIT = 24;
export const REFRESH_EVERY_SECONDS = 6 * 3600;        // spec §4.4: every six hours
export const TOKEN_RENEW_BEFORE_SECONDS = 14 * 86400; // renew a long-lived token in its last two weeks

export interface InstagramDeps { db: D1Database; media: R2Bucket; instagram: Instagram; adminSecret: string }
export type FeedResult = { status: "skipped" | "not_due" } | { status: "ok"; added: number } | { status: "error"; error: string };

/** The image we keep for a post: the still for videos, the first image for carousels and photos (§4.4). */
export function imageUrlFor(m: IgMedia): string | null {
  if (m.mediaType === "VIDEO") return m.thumbnailUrl ?? null;
  return m.mediaUrl ?? null;
}
export const mediaKeyFor = (igId: string) => `ig/${igId}`;

/** Runs on the 15-minute cron; does the work only when six hours have passed (or `force`). Never throws. */
export async function refreshFeed(deps: InstagramDeps, now: Date, force = false): Promise<FeedResult> {
  const nowSec = Math.floor(now.getTime() / 1000);
  let token = await loadIgToken(deps.db, deps.adminSecret);
  if (!token) return { status: "skipped" };
  const sync = await loadIgSync(deps.db);
  if (!force && sync.at !== null && nowSec - sync.at < REFRESH_EVERY_SECONDS) return { status: "not_due" };
  try {
    token = await maybeRenew(deps, token, nowSec);
    const media = await deps.instagram.recentMedia(token, FEED_LIMIT);
    const known = await knownPostIds(deps.db);
    let added = 0;
    for (const m of media) {
      if (known.has(m.id)) continue;
      const url = imageUrlFor(m);
      if (!url) continue;
      const img = await deps.instagram.fetchImage(url);
      const key = mediaKeyFor(m.id);
      await deps.media.put(key, img.bytes, { httpMetadata: { contentType: img.contentType, cacheControl: "public, max-age=31536000, immutable" } });
      await insertPost(deps.db, { igId: m.id, permalink: m.permalink, caption: m.caption ?? null, mediaKey: key, contentType: img.contentType, takenAt: m.timestamp, fetchedAt: nowSec });
      added++;
    }
    await recordIgSync(deps.db, nowSec, null);
    return { status: "ok", added };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("instagram: refresh failed", msg);
    // keep the last cached set (spec §4.5); record the failure for admin; try again next tick
    await recordIgSync(deps.db, sync.at ?? nowSec, msg).catch(() => {});
    return { status: "error", error: msg };
  }
}

async function maybeRenew(deps: InstagramDeps, token: IgToken, nowSec: number): Promise<IgToken> {
  if (token.expiresAt - nowSec > TOKEN_RENEW_BEFORE_SECONDS) return token;
  const fresh = await deps.instagram.refreshToken(token);
  await saveIgToken(deps.db, deps.adminSecret, fresh);
  return fresh;
}
