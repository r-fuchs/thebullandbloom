import type { DeliveryWindow } from "../adapters/uber";
import type { PostalAddress, StoreConfig } from "../config";
import { instantAt } from "./time";

const MIN = 60_000;
/** Uber requires pickup_ready_dt to be less than 30 days out; stay a day clear of the edge. */
export const MAX_SCHEDULE_DAYS = 29;
/** How long after the ready time the courier may still collect. Uber's floor is 10 minutes. */
const PICKUP_WINDOW_MIN = 60;
/** Uber requires pickup_deadline_dt at least 20 minutes from now; 25 absorbs clock skew. */
const DEADLINE_FLOOR_MIN = 25;
/** How long after collection the courier has to arrive. Uber's floor is 20 minutes. */
const DROPOFF_WINDOW_MIN = 90;

/**
 * The four timestamps Uber wants, built so every documented constraint holds:
 * pickupDeadline >= pickupReady + 10 min and >= now + 20 min; dropoffReady <= pickupDeadline;
 * dropoffDeadline >= dropoffReady + 20 min and >= pickupDeadline. A ready time already in the
 * past (a same-day order placed after the studio's ready hour) becomes "now".
 */
export function deliveryWindow(pickupReadyAt: Date, now: Date): DeliveryWindow {
  const ready = Math.max(+pickupReadyAt, +now);
  const deadline = Math.max(ready + PICKUP_WINDOW_MIN * MIN, +now + DEADLINE_FLOOR_MIN * MIN);
  return {
    pickupReadyAt: new Date(ready),
    pickupDeadlineAt: new Date(deadline),
    dropoffReadyAt: new Date(deadline),
    dropoffDeadlineAt: new Date(deadline + DROPOFF_WINDOW_MIN * MIN),
  };
}

/**
 * When the courier should collect for an order on `date`: the studio's ready time in studio
 * time. Beyond Uber's 30-day scheduling limit there is no way to ask about that day, so we
 * quote an ASAP job instead and tell the caller the fee is an estimate (`scheduled: false`).
 * The storefront only offers 28 days, so this branch is a safety net, not a normal path.
 */
export function pickupReadyFor(cfg: StoreConfig, date: string, now: Date): { at: Date; scheduled: boolean } {
  const at = instantAt(cfg.timezone, date, cfg.studio.readyTime);
  if (+at > +now + MAX_SCHEDULE_DAYS * 86_400_000) return { at: now, scheduled: false };
  return { at, scheduled: true };
}

export type ParsedAddress = { ok: true; address: PostalAddress } | { ok: false; error: string };

/** Validate and normalise an address off the wire. Never throws. */
export function parseAddress(raw: unknown): ParsedAddress {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return { ok: false, error: "address required" };
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const street = s(a.street), unit = s(a.unit), city = s(a.city), state = s(a.state).toUpperCase(), zip = s(a.zip);
  if (street === "") return { ok: false, error: "street address required" };
  if (street.length > 200) return { ok: false, error: "street address is too long" };
  if (unit.length > 100) return { ok: false, error: "unit is too long" };
  if (city === "") return { ok: false, error: "city required" };
  if (city.length > 100) return { ok: false, error: "city is too long" };
  if (!/^[A-Z]{2}$/.test(state)) return { ok: false, error: "state must be a two-letter code" };
  if (!/^\d{5}$/.test(zip)) return { ok: false, error: "zip must be five digits" };
  return { ok: true, address: { street, unit, city, state, zip } };
}

/** A stable fingerprint of an address, so a quote can be bound to the address it priced. */
export function addressKey(a: PostalAddress): string {
  return [a.street, a.unit, a.city, a.state, a.zip].map((v) => v.trim().toLowerCase().replace(/\s+/g, " ")).join("|");
}

/** The flat fee for a zip on the repo's fallback list, or null when the zip is not on it (spec §4.2). */
export function fallbackFeeFor(cfg: StoreConfig, zip: string): number | null {
  return cfg.delivery.fallbackZips.includes(zip) ? cfg.delivery.fallbackFeeCents : null;
}

/** What the courier's manifest says is in the box. No customer detail — couriers see the manifest. */
export function deliveryItemName(sizeName: string): string {
  return `${sizeName} — hand-tied flowers`;
}

/**
 * E.164 or nothing. Uber's phone fields match `^\+[0-9]+$` and reject anything else, so a number
 * typed as "(518) 555-0100" has to be converted before it ever reaches a delivery request.
 * A bare 10-digit number is assumed to be US (+1); that is the only country the studio serves.
 */
export function normalizePhone(raw: string | undefined | null): string | null {
  const s = (raw ?? "").trim();
  if (s === "") return null;
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
