import { describe, it, expect } from "vitest";
import type { Offer, OfferSession } from "../../src/config";
import { bookingBlocker, humanDuration, humanTime, isBookable, nextBookable, seatsRemaining, sessionLabel, sessionStart } from "../../src/core/offers";

const NY = "America/New_York";
const session = (id: string, date: string, start: string, seats = 8): OfferSession => ({ id, date, start, seats });
const offer = (over: Partial<Offer> = {}): Offer => ({
  id: "wreath", slug: "wreath", enabled: true, showOnHome: true, name: "Wreath & Sip", tagline: "", description: "", image: "assets/wreath.jpg", imageAlt: "",
  priceCents: 8500, durationMinutes: 120, bookingClosesHoursBefore: 24,
  sessions: [session("nov7", "2026-11-07", "18:00")], ...over,
});
const clock = (iso: string) => ({ now: new Date(iso), tz: NY });

describe("sessionStart", () => {
  it("resolves the studio-local start on both sides of the DST change", () => {
    expect(sessionStart(session("a", "2026-10-31", "18:00"), NY).toISOString()).toBe("2026-10-31T22:00:00.000Z"); // EDT
    expect(sessionStart(session("b", "2026-11-07", "18:00"), NY).toISOString()).toBe("2026-11-07T23:00:00.000Z"); // EST
  });
});

describe("seatsRemaining", () => {
  it("subtracts and floors at zero", () => {
    expect(seatsRemaining(8, 0)).toBe(8);
    expect(seatsRemaining(8, 5)).toBe(3);
    expect(seatsRemaining(8, 8)).toBe(0);
    expect(seatsRemaining(8, 9)).toBe(0);
  });
});

describe("bookingBlocker / isBookable", () => {
  const o = offer();
  const s = o.sessions[0]; // starts 2026-11-07T23:00Z; closes 24h before
  it("is bookable more than the cutoff away with seats left", () => {
    expect(bookingBlocker(o, s, clock("2026-11-06T22:59:59Z"))).toBeNull();
    expect(isBookable(o, s, 7, clock("2026-11-06T22:59:59Z"))).toBe(true);
  });
  it("closes exactly at the cutoff and after it", () => {
    expect(bookingBlocker(o, s, clock("2026-11-06T23:00:00Z"))).toBe("closed");
    expect(isBookable(o, s, 0, clock("2026-11-06T23:00:00Z"))).toBe(false);
    expect(bookingBlocker(o, s, clock("2026-11-08T10:00:00Z"))).toBe("closed"); // past
  });
  it("is not bookable when full, but that is not a blocker (the guarded insert decides sold_out)", () => {
    expect(isBookable(o, s, 8, clock("2026-11-01T12:00:00Z"))).toBe(false);
    expect(bookingBlocker(o, s, clock("2026-11-01T12:00:00Z"))).toBeNull();
  });
  it("reports disabled ahead of closed", () => {
    const off = offer({ enabled: false });
    expect(bookingBlocker(off, off.sessions[0], clock("2026-11-01T12:00:00Z"))).toBe("disabled");
    expect(bookingBlocker(off, off.sessions[0], clock("2026-11-08T12:00:00Z"))).toBe("disabled");
    expect(isBookable(off, off.sessions[0], 0, clock("2026-11-01T12:00:00Z"))).toBe(false);
  });
  it("a zero-hour cutoff keeps bookings open until the start", () => {
    const o0 = offer({ bookingClosesHoursBefore: 0 });
    expect(bookingBlocker(o0, o0.sessions[0], clock("2026-11-07T22:59:59Z"))).toBeNull();
    expect(bookingBlocker(o0, o0.sessions[0], clock("2026-11-07T23:00:00Z"))).toBe("closed");
  });
});

describe("nextBookable", () => {
  it("picks the earliest bookable session regardless of config order", () => {
    const o = offer({ sessions: [session("c", "2026-11-21", "18:00"), session("a", "2026-11-07", "18:00", 2), session("b", "2026-11-14", "18:00")] });
    const taken = new Map([["a", 2]]); // a is full
    expect(nextBookable(o, taken, clock("2026-11-01T12:00:00Z"))?.id).toBe("b");
    expect(nextBookable(o, new Map(), clock("2026-11-01T12:00:00Z"))?.id).toBe("a");
    expect(nextBookable(o, new Map(), clock("2026-11-21T12:00:00Z"))).toBeNull(); // all closed
    expect(nextBookable(offer({ enabled: false }), new Map(), clock("2026-11-01T12:00:00Z"))).toBeNull();
  });
});

describe("labels", () => {
  it("formats times, session labels and durations", () => {
    expect(humanTime("18:00")).toBe("6 pm");
    expect(humanTime("18:30")).toBe("6:30 pm");
    expect(humanTime("09:05")).toBe("9:05 am");
    expect(humanTime("12:00")).toBe("12 pm");
    expect(humanTime("00:00")).toBe("12 am");
    expect(sessionLabel(session("x", "2026-11-07", "18:00"))).toBe("Sat Nov 7, 6 pm");
    expect(humanDuration(120)).toBe("2 hours");
    expect(humanDuration(60)).toBe("1 hour");
    expect(humanDuration(90)).toBe("90 minutes");
    expect(humanDuration(0)).toBe("");
  });
});
