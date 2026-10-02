import { env } from "cloudflare:test";
import { buildApp } from "../src/app";
import { loadConfig, type Offer, type StoreConfig } from "../src/config";
import type { Payments, SubscriptionCheckoutInput, WebhookEvent } from "../src/adapters/payments";
import { FakeGoogle } from "./fakes/google";
import { FakeMailer } from "./fakes/mailer";
import { FakeAlerts } from "./fakes/alerts";
import { FakeInstagram } from "./fakes/instagram";
import { FakeUber } from "./fakes/uber";
import { FakeAccess } from "./fakes/access";

// Module-scoped (not per-instance) so session ids stay unique across every
// RecordingPayments created within a test file, matching the D1 test DB,
// which persists across `it()` blocks in the same file (see tests/store/orders.test.ts's
// own `let n = 0` counter for the same reason). A per-instance counter would
// hand out "cs_1" again for the first checkout of every fresh testApp(),
// colliding with orders.stripe_session_id's UNIQUE constraint once more than
// one test's held order lands in that shared DB.
let sessionSeq = 0;

// Lets a test predict the session id the next `createCheckout` call (on any
// RecordingPayments instance in this file) will hand out, without advancing
// the counter itself — e.g. to pre-seed a UNIQUE-constraint collision on
// `orders.stripe_session_id` for testing the attachSession failure path.
export function peekNextSessionId(): string {
  return `cs_${sessionSeq + 1}`;
}

/**
 * Plan 7 fixtures. Dated against testApp's default clock (Tue 2026-09-08 10:00 EDT):
 *  - "past"  is before today and never appears in /api/offers;
 *  - "today" starts in five hours, inside the 24-hour cutoff, so it is listed but closed;
 *  - "sat"   is four days out with two seats: the bookable one.
 * The repo config's own offer is never used by tests (its values are Ryan's to change).
 */
export const WREATH: Offer = {
  id: "wreath-test", slug: "wreath-test", enabled: true, showOnHome: true, name: "Wreath & Sip",
  tagline: "Make an autumn wreath at the studio", description: "An evening at the studio.", image: "assets/wreath.jpg", imageAlt: "An autumn wreath",
  priceCents: 8500, durationMinutes: 120, bookingClosesHoursBefore: 24,
  sessions: [
    { id: "past", date: "2026-09-01", start: "18:00", seats: 8 },
    { id: "today", date: "2026-09-08", start: "15:00", seats: 8 },
    { id: "sat", date: "2026-09-12", start: "18:00", seats: 2 },
  ],
};
export const OFF_OFFER: Offer = { ...WREATH, id: "off-test", slug: "off-test", enabled: false, showOnHome: false };
export function offersConfig(offers: Offer[] = [WREATH, OFF_OFFER], metaPixelId = ""): StoreConfig {
  return { ...loadConfig(), offers, marketing: { metaPixelId } };
}

export class RecordingPayments implements Payments {
  created: Array<Parameters<Payments["createCheckout"]>[0]> = [];
  failNext = false;
  nextEvent: WebhookEvent = { type: "other" };
  async createCheckout(input: Parameters<Payments["createCheckout"]>[0]) {
    if (this.failNext) { this.failNext = false; throw new Error("stripe down"); }
    this.created.push(input);
    sessionSeq += 1;
    return { id: `cs_${sessionSeq}`, url: `https://checkout.example/${sessionSeq}` };
  }
  createdSubscriptions: SubscriptionCheckoutInput[] = [];
  portals: Array<{ customerId: string; returnUrl: string }> = [];
  async createSubscriptionCheckout(input: SubscriptionCheckoutInput) {
    if (this.failNext) { this.failNext = false; throw new Error("stripe down"); }
    this.createdSubscriptions.push(input);
    sessionSeq += 1;
    return { id: `cs_${sessionSeq}`, url: `https://checkout.example/${sessionSeq}` };
  }
  async portalLink(customerId: string, returnUrl: string) {
    this.portals.push({ customerId, returnUrl });
    return `https://billing.example/${customerId}`;
  }
  async parseWebhook(_raw: string, signature: string) {
    if (signature !== "good") throw new Error("bad signature");
    return this.nextEvent;
  }
}

export function testApp(now = new Date("2026-09-08T14:00:00Z"), config: StoreConfig = loadConfig()) {
  const payments = new RecordingPayments();
  const google = new FakeGoogle();
  const mailer = new FakeMailer();
  const alerts = new FakeAlerts();
  const instagram = new FakeInstagram();
  const uber = new FakeUber();
  const access = new FakeAccess();
  const app = buildApp({ payments, google, mailer, alerts, instagram, uber, access, clock: () => now, config });
  const fetch = (path: string, init?: RequestInit) =>
    app.request(new Request(`https://example.com${path}`, init), undefined, env);
  return { app, payments, google, mailer, alerts, instagram, uber, access, fetch };
}

/** Services object for jobs and runScheduled tests, sharing testApp's fakes. */
export function testServices(now = new Date("2026-09-08T14:00:00Z"), config: StoreConfig = loadConfig()) {
  const payments = new RecordingPayments();
  const google = new FakeGoogle();
  const mailer = new FakeMailer();
  const alerts = new FakeAlerts();
  const instagram = new FakeInstagram();
  const uber = new FakeUber();
  const access = new FakeAccess();
  return { services: { payments, google, mailer, alerts, instagram, uber, access, clock: () => now, config }, payments, google, mailer, alerts, instagram, uber, access };
}

/** A fetch that carries a Cloudflare Access identity the FakeAccess accepts (Plan 6). */
export function asAdmin(fetch: (path: string, init?: RequestInit) => Promise<Response> | Response, email = "ryan@fuchsassociates.com") {
  return async (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "cf-access-jwt-assertion": `test:${email}`, "content-type": "application/json" } });
}

export async function seedAdminOverride(date: string, cap: number | null, closed: boolean) {
  await env.DB.prepare("INSERT OR REPLACE INTO day_overrides (date, source, cap, closed) VALUES (?, 'admin', ?, ?)")
    .bind(date, cap, closed ? 1 : 0).run();
}
