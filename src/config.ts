import raw from "../store.config.json";

export interface Size { id: string; name: string; description: string; priceCents: number; vaseFeeCents: number }
export interface Cadence { id: string; name: string; perMonth: number }
export interface SubscriptionCell { sizeId: string; cadenceId: string; priceCents: number }
export interface Subscriptions { cadences: Cadence[]; cells: SubscriptionCell[]; note?: string }
/** Structured address, the shape the Uber adapter and the storefront both use. */
export interface PostalAddress { street: string; unit: string; city: string; state: string; zip: string }
export interface DeliveryZone { name: string; feeCents: number; zips: string[] }

/** One sitting of a class (Plan 7). `date` is YYYY-MM-DD and `start` is HH:MM in the studio timezone. */
export interface OfferSession { id: string; date: string; start: string; seats: number }
/**
 * A bookable class or event sold by the seat (Plan 7, D47). `enabled` makes it bookable at all;
 * `showOnHome` puts the teaser card on the homepage (D49). The fields map one-to-one onto a Stripe
 * Product plus Price, so a later source swap (spec §7) keeps this shape.
 */
export interface Offer {
  id: string; slug: string; enabled: boolean; showOnHome: boolean;
  name: string; tagline: string; description: string; image: string; imageAlt: string;
  priceCents: number; durationMinutes: number;
  /** bookings close this many hours before a session starts (D54); 24 when absent */
  bookingClosesHoursBefore: number;
  sessions: OfferSession[];
}
/** Meta Pixel id for the class pages and the thank-you page only (D51); empty = no pixel. */
export interface Marketing { metaPixelId: string }
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
   * Delivery pricing (spec Plan 5 D35/D36). `mode` "uber" (default): Uber prices each address and
   * a zone fee covers listed zips Uber will not serve. `mode` "flat": Uber is never called and
   * every listed zip gets its zone fee. A zip in no zone is outside the delivery area. Empty
   * zones = no fallback.
   */
  delivery: { mode?: "uber" | "flat"; zones: DeliveryZone[] };
  holdMinutes: number;
  /** Plan 7. Absent = no offers. */
  offers?: Offer[];
  /** Plan 7. Absent = no pixel. */
  marketing?: Marketing;
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ZIP = /^\d{5}$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const SLUG = /^[a-z0-9-]+$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ASSET = /^assets\/[A-Za-z0-9._-]+$/;

function ymdValid(s: unknown): boolean {
  if (typeof s !== "string" || !YMD.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.toISOString().slice(0, 10) === s;
}

function validateOffers(offers: unknown): void {
  if (offers === undefined) return;
  if (!Array.isArray(offers)) throw new Error("config: offers must be an array");
  const ids = new Set<string>(), slugs = new Set<string>();
  for (const o of offers as Offer[]) {
    if (typeof o?.id !== "string" || !SLUG.test(o.id)) throw new Error("config: every offer id must match [a-z0-9-]+");
    if (ids.has(o.id)) throw new Error(`config: duplicate offer id ${o.id}`);
    ids.add(o.id);
    if (typeof o.slug !== "string" || !SLUG.test(o.slug)) throw new Error(`config: offer ${o.id} slug must match [a-z0-9-]+`);
    if (slugs.has(o.slug)) throw new Error(`config: duplicate offer slug ${o.slug}`);
    slugs.add(o.slug);
    if (typeof o.enabled !== "boolean") throw new Error(`config: offer ${o.id} enabled must be true or false`);
    if (typeof o.showOnHome !== "boolean") throw new Error(`config: offer ${o.id} showOnHome must be true or false`);
    if (typeof o.name !== "string" || o.name.trim() === "") throw new Error(`config: offer ${o.id} name required`);
    for (const k of ["tagline", "description", "imageAlt"] as const) {
      if (typeof o[k] !== "string") throw new Error(`config: offer ${o.id} ${k} must be a string`);
    }
    if (typeof o.image !== "string" || !ASSET.test(o.image)) throw new Error(`config: offer ${o.id} image must be a path under assets/`);
    if (!Number.isInteger(o.priceCents) || o.priceCents <= 0) throw new Error(`config: offer ${o.id} priceCents must be a positive integer`);
    if (!Number.isInteger(o.durationMinutes) || o.durationMinutes < 0) throw new Error(`config: offer ${o.id} durationMinutes must be a non-negative integer`);
    if (o.bookingClosesHoursBefore === undefined) o.bookingClosesHoursBefore = 24;
    if (!Number.isInteger(o.bookingClosesHoursBefore) || o.bookingClosesHoursBefore < 0) throw new Error(`config: offer ${o.id} bookingClosesHoursBefore must be a non-negative integer`);
    if (!Array.isArray(o.sessions)) throw new Error(`config: offer ${o.id} sessions must be an array`);
    const sids = new Set<string>();
    for (const s of o.sessions) {
      if (typeof s?.id !== "string" || s.id.trim() === "") throw new Error(`config: offer ${o.id} has a session with no session id`);
      if (sids.has(s.id)) throw new Error(`config: offer ${o.id} duplicate session id ${s.id}`);
      sids.add(s.id);
      if (!ymdValid(s.date)) throw new Error(`config: offer ${o.id} session ${s.id} date must be YYYY-MM-DD`);
      if (!HM.test(s.start ?? "")) throw new Error(`config: offer ${o.id} session ${s.id} start must be HH:MM`);
      if (!Number.isInteger(s.seats) || s.seats <= 0) throw new Error(`config: offer ${o.id} session ${s.id} seats must be a positive integer`);
    }
  }
}

function validateMarketing(m: unknown): void {
  if (m === undefined) return;
  const id = (m as Marketing)?.metaPixelId;
  if (typeof id !== "string" || (id !== "" && !/^\d+$/.test(id))) throw new Error("config: marketing.metaPixelId must be a string of digits, or empty");
}

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
  if (!d || !Array.isArray(d.zones)) throw new Error("config: delivery.zones must be an array");
  const seenZips = new Set<string>();
  for (const z of d.zones) {
    if (typeof z?.name !== "string" || z.name.trim() === "") throw new Error("config: every delivery zone needs a name");
    if (!Number.isInteger(z.feeCents) || z.feeCents < 0) throw new Error(`config: delivery zone ${z.name} feeCents must be a non-negative integer`);
    if (!Array.isArray(z.zips) || !z.zips.every((x) => ZIP.test(x))) throw new Error(`config: delivery zone ${z.name} zips must be five-digit zips`);
    for (const x of z.zips) {
      if (seenZips.has(x)) throw new Error(`config: zip ${x} is in two delivery zones`);
      seenZips.add(x);
    }
  }
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
  validateOffers(cfg.offers);
  validateMarketing(cfg.marketing);
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

export function offersOf(cfg: StoreConfig): Offer[] {
  return cfg.offers ?? [];
}

export function offerById(cfg: StoreConfig, id: string): Offer | undefined {
  return offersOf(cfg).find((o) => o.id === id);
}

export function offerBySlug(cfg: StoreConfig, slug: string): Offer | undefined {
  return offersOf(cfg).find((o) => o.slug === slug);
}
