import raw from "../store.config.json";

export interface Size { id: string; name: string; description: string; priceCents: number }
export interface StoreConfig {
  timezone: string;
  studio: { pickupAddress: string; pickupInstructions: string; ownerEmail: string };
  calendars: { closed: string; orders: string };
  sizes: Size[];
  defaults: { cap: number; cutoff: string; openWeekdays: number[] };
  holdMinutes: number;
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateConfig(cfg: StoreConfig): StoreConfig {
  if (!cfg.timezone) throw new Error("config: timezone required");
  if (!HM.test(cfg.defaults.cutoff)) throw new Error("config: defaults.cutoff must be HH:MM");
  if (!Number.isInteger(cfg.defaults.cap) || cfg.defaults.cap < 0) throw new Error("config: defaults.cap must be a non-negative integer");
  if (!cfg.defaults.openWeekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error("config: openWeekdays must be 0..6");
  if (!Number.isInteger(cfg.holdMinutes) || cfg.holdMinutes < 30) throw new Error("config: holdMinutes must be an integer >= 30 (Stripe minimum)");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.studio?.ownerEmail ?? "")) throw new Error("config: studio.ownerEmail must be an email address");
  if (!cfg.calendars?.closed || !cfg.calendars?.orders || cfg.calendars.closed === cfg.calendars.orders)
    throw new Error("config: calendars.closed and calendars.orders must be two distinct names");
  const ids = new Set<string>();
  for (const s of cfg.sizes) {
    if (ids.has(s.id)) throw new Error(`config: duplicate size id ${s.id}`);
    ids.add(s.id);
    if (!Number.isInteger(s.priceCents) || s.priceCents <= 0) throw new Error(`config: size ${s.id} priceCents must be a positive integer`);
  }
  return cfg;
}

export function loadConfig(): StoreConfig {
  return validateConfig(raw as StoreConfig);
}

export function sizeById(cfg: StoreConfig, id: string): Size | undefined {
  return cfg.sizes.find((s) => s.id === id);
}
