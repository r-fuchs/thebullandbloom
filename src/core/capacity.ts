import { hmIn, weekdayOf, ymdIn } from "./time";

export interface Defaults { cap: number; cutoff: string; openWeekdays: number[] }
export interface Override { cap: number | null; closed: boolean }
export interface Clock { now: Date; tz: string }
export interface Availability {
  date: string; open: boolean; cap: number; used: number; remaining: number; orderable: boolean;
}

export function capFor(date: string, defaults: Defaults, override?: Override | null): number {
  if (override?.closed) return 0;
  if (override && override.cap !== null) return override.cap;
  return defaults.openWeekdays.includes(weekdayOf(date)) ? defaults.cap : 0;
}

export function remaining(cap: number, used: number): number {
  return Math.max(0, cap - used);
}

export function isOrderable(date: string, left: number, defaults: Defaults, clock: Clock): boolean {
  const today = ymdIn(clock.tz, clock.now);
  if (date < today) return false;
  if (left <= 0) return false;
  if (date === today && hmIn(clock.tz, clock.now) >= defaults.cutoff) return false;
  return true;
}

export function availabilityFor(
  date: string, defaults: Defaults, override: Override | null, used: number, clock: Clock,
): Availability {
  const cap = capFor(date, defaults, override);
  const left = remaining(cap, used);
  return { date, open: cap > 0, cap, used, remaining: left, orderable: isOrderable(date, left, defaults, clock) };
}
