import { env } from "cloudflare:test";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Payments, WebhookEvent } from "../src/adapters/payments";

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
  async parseWebhook(_raw: string, signature: string) {
    if (signature !== "good") throw new Error("bad signature");
    return this.nextEvent;
  }
}

export function testApp(now = new Date("2026-09-08T14:00:00Z")) {
  const payments = new RecordingPayments();
  const app = buildApp({ payments, clock: () => now, config: loadConfig() });
  const fetch = (path: string, init?: RequestInit) =>
    app.request(new Request(`https://example.com${path}`, init), undefined, env);
  return { app, payments, fetch };
}

export async function seedAdminOverride(date: string, cap: number | null, closed: boolean) {
  await env.DB.prepare("INSERT OR REPLACE INTO day_overrides (date, source, cap, closed) VALUES (?, 'admin', ?, ?)")
    .bind(date, cap, closed ? 1 : 0).run();
}
