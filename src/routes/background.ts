import type { Context, ExecutionContext } from "hono";

/** Run `work` after the response when the runtime gives us an ExecutionContext; otherwise (tests) await it. */
export function background(c: Context, work: Promise<unknown>): Promise<void> {
  const guarded = work.then(() => undefined, (e) => { console.error("background job failed", e); });
  let ctx: ExecutionContext | undefined;
  try { ctx = c.executionCtx; } catch { ctx = undefined; } // Hono throws when there is none
  if (ctx) { ctx.waitUntil(guarded); return Promise.resolve(); }
  return guarded;
}
