import type { Connection } from "../adapters/google";
export interface ConnectionSource { load(): Promise<Connection | null> }
export function connectionSource(_db: D1Database, _secret: string): ConnectionSource {
  return { load: async () => null };
}
