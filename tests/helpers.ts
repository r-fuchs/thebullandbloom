import { env } from "cloudflare:test";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Payments, WebhookEvent } from "../src/adapters/payments";

export class RecordingPayments implements Payments {
  created: Array<Parameters<Payments["createCheckout"]>[0]> = [];
  failNext = false;
  nextEvent: WebhookEvent = { type: "other" };
  async createCheckout(input: Parameters<Payments["createCheckout"]>[0]) {
    if (this.failNext) { this.failNext = false; throw new Error("stripe down"); }
    this.created.push(input);
    return { id: `cs_${this.created.length}`, url: `https://checkout.example/${this.created.length}` };
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
