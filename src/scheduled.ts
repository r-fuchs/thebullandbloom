import type { Env } from "./env";
import { expireHolds } from "./store/orders";

export async function runScheduled(env: Env, now: Date): Promise<{ expiredHolds: number }> {
  const expiredHolds = await expireHolds(env.DB, Math.floor(now.getTime() / 1000));
  return { expiredHolds };
}
