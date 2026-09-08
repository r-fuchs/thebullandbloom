import type { Env } from "./env";
import type { Services } from "./app";
import { expireHolds } from "./store/orders";

export interface ScheduledReport { expiredHolds: number }

export async function runScheduled(env: Env, _services: Services, now: Date): Promise<ScheduledReport> {
  const expiredHolds = await expireHolds(env.DB, Math.floor(now.getTime() / 1000));
  return { expiredHolds };
}
