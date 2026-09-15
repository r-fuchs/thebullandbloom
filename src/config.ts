import raw from "../store.config.json";

export interface Size { id: string; name: string; description: string; priceCents: number; vaseFeeCents: number }
export interface Cadence { id: string; name: string; perMonth: number }
export interface SubscriptionCell { sizeId: string; cadenceId: string; priceCents: number }
export interface Subscriptions { cadences: Cadence[]; cells: SubscriptionCell[]; note?: string }
/** Structured address, the shape the Uber adapter and the storefront both use. */
export interface PostalAddress { street: string; unit: string; city: string; state: string; zip: string }
export interface StoreConfig {
  timezone: string;
  studio: {
    pickupAddress: string; pickupInstructions: string; ownerEmail: string;
    /** studio-local HH:MM the bouquets are ready for a courier (spec §7) */
    readyTime: string;
    /** E.164; Uber requires a callable pickup number */
    phone: string;
    address: PostalAddress;
  };
  calendars: { closed: string; orders: string };
  sizes: Size[];
  /** Size × cadence grid sold as Stripe subscriptions (spec §2 item 5). Present in config ahead of Plan 4 so prices have a home. */
  subscriptions: Subscriptions;
  defaults: { cap: number; cutoff: string; openWeekdays: number[] };
  /**
   * `mode` "uber" (default): Uber prices each address; the flat fee covers listed zips Uber will
   * not serve (spec §4.2, §4.5). `mode` "flat": Uber is never called, even with its secrets on the
   * Worker — every listed zip gets the flat fee and Anthony drives. Empty zip list = no fallback.
   */
  delivery: { mode?: "uber" | "flat"; fallbackFeeCents: number; fallbackZips: string[] };
  holdMinutes: number;
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ZIP = /^\d{5}$/;
const E164 = /^\+[1-9]\d{7,14}$/;

export function validateConfig(cfg: StoreConfig): StoreConfig {
  if (!cfg.timezone) throw new Error("config: timezone required");
  if (!HM.test(cfg.defaults.cutoff)) throw new Error("config: defaults.cutoff must be HH:MM");
  if (!Number.isInteger(cfg.defaults.cap) || cfg.defaults.cap < 0) throw new Error("config: defaults.cap must be a non-negative integer");
  if (!cfg.defaults.openWeekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error("config: openWeekdays must be 0..6");
  if (!Number.isInteger(cfg.holdMinutes) || cfg.holdMinutes < 30) throw new Error("config: holdMinutes must be an integer >= 30 (Stripe minimum)");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.studio?.ownerEmail ?? "")) throw new Error("config: studio.ownerEmail must be an email address");
  if (!HM.test(cfg.studio?.readyTime ?? "")) throw new Error("config: studio.readyTime must be HH:MM");
  if (!E164.test(cfg.studio?.phone ?? "")) throw new Error("config: studio.phone must be E.164, e.g. +15183340517");
  const a = cfg.studio?.address;
  if (!a || typeof a.street !== "string" || a.street.trim() === "") throw new Error("config: studio.address.street required");
  if (typeof a.unit !== "string") throw new Error("config: studio.address.unit must be a string (empty when there is none)");
  if (typeof a.city !== "string" || a.city.trim() === "") throw new Error("config: studio.address.city required");
  if (!/^[A-Z]{2}$/.test(a.state ?? "")) throw new Error("config: studio.address.state must be a two-letter code");
  if (!ZIP.test(a.zip ?? "")) throw new Error("config: studio.address.zip must be five digits");
  const d = cfg.delivery;
  if (!d || !Number.isInteger(d.fallbackFeeCents) || d.fallbackFeeCents < 0) throw new Error("config: delivery.fallbackFeeCents must be a non-negative integer");
  if (!Array.isArray(d.fallbackZips) || !d.fallbackZips.every((z) => ZIP.test(z))) throw new Error("config: delivery.fallbackZips must be five-digit zips");
  if (d.mode !== undefined && d.mode !== "uber" && d.mode !== "flat") throw new Error('config: delivery.mode must be "uber" or "flat" when set');
  if (!cfg.calendars?.closed || !cfg.calendars?.orders || cfg.calendars.closed === cfg.calendars.orders)
    throw new Error("config: calendars.closed and calendars.orders must be two distinct names");
  const ids = new Set<string>();
  for (const s of cfg.sizes) {
    if (ids.has(s.id)) throw new Error(`config: duplicate size id ${s.id}`);
    ids.add(s.id);
    if (!Number.isInteger(s.priceCents) || s.priceCents <= 0) throw new Error(`config: size ${s.id} priceCents must be a positive integer`);
    if (!Number.isInteger(s.vaseFeeCents) || s.vaseFeeCents < 0) throw new Error(`config: size ${s.id} vaseFeeCents must be a non-negative integer`);
  }
  const cadences = new Set<string>();
  for (const c of cfg.subscriptions?.cadences ?? []) {
    if (cadences.has(c.id)) throw new Error(`config: duplicate cadence id ${c.id}`);
    cadences.add(c.id);
    if (![1, 2, 4].includes(c.perMonth)) throw new Error(`config: cadence ${c.id} perMonth must be 1, 2 or 4 (every four weeks, every other week, weekly)`);
  }
  const cells = new Set<string>();
  for (const cell of cfg.subscriptions?.cells ?? []) {
    const key = `${cell.sizeId}/${cell.cadenceId}`;
    if (!ids.has(cell.sizeId)) throw new Error(`config: subscription cell ${key} names an unknown size`);
    if (!cadences.has(cell.cadenceId)) throw new Error(`config: subscription cell ${key} names an unknown cadence`);
    if (cells.has(key)) throw new Error(`config: duplicate subscription cell ${key}`);
    cells.add(key);
    if (!Number.isInteger(cell.priceCents) || cell.priceCents <= 0) throw new Error(`config: subscription cell ${key} priceCents must be a positive integer`);
  }
  return cfg;
}

export function subscriptionCell(cfg: StoreConfig, sizeId: string, cadenceId: string): SubscriptionCell | undefined {
  return cfg.subscriptions.cells.find((c) => c.sizeId === sizeId && c.cadenceId === cadenceId);
}

export function loadConfig(): StoreConfig {
  return validateConfig(raw as StoreConfig);
}

export function sizeById(cfg: StoreConfig, id: string): Size | undefined {
  return cfg.sizes.find((s) => s.id === id);
}
