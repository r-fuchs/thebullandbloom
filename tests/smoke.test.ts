import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("worker", () => {
  it("answers /api/health", async () => {
    const r = await SELF.fetch("https://example.com/api/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
  it("serves the static home page", async () => {
    const r = await SELF.fetch("https://example.com/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("The Bull and Bloom");
  });
  it("wires the Formspree inquiry form by id so it never catches the order or subscription forms", async () => {
    const r = await SELF.fetch("https://example.com/");
    const body = await r.text();
    expect(body).toContain('id="inquiry-form"');
    expect(body).toContain('id="subscribe-form"');
    expect(body).toContain("querySelector('#inquiry-form')");
    expect(body).not.toContain("querySelector('.form')");
  });
  it("serves the privacy policy at its clean URL (html_handling: auto-trailing-slash strips .html)", async () => {
    const r = await SELF.fetch("https://example.com/privacy");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("Privacy");
    expect(body).toContain("thebullandbloom@gmail.com");
    expect(body).toContain("stripe.com/privacy");
  });
  it("serves the order form with a pickup/delivery choice and address fields", async () => {
    const r = await SELF.fetch("https://example.com/");
    const body = await r.text();
    expect(body).toContain('id="fulfillment-picker"');
    expect(body).toContain('id="delivery-fields"');
    expect(body).toContain('name="zip"');
    expect(body).toContain('id="quote-note"');
  });

  it("serves the class landing page at /offers/<slug> for any slug (Plan 7 §3.2)", async () => {
    for (const path of ["/offers/wreath-and-sip", "/offers/anything-at-all"]) {
      const r = await SELF.fetch(`https://example.com${path}`);
      expect(r.status).toBe(200);
      const body = await r.text();
      expect(body).toContain('id="book-form"');
      expect(body).toContain("Reserve my seat");
      expect(body).toContain("Refreshments will be provided.");
      expect(body).toContain("Hosted at Anthony's home studio in Albany. The address comes with your confirmation.");
      expect(body).toContain('src="offer.js"');
      expect(body).not.toContain("40 Manning");
    }
    expect((await SELF.fetch("https://example.com/offers/offer.js")).status).toBe(200);
  });
});
