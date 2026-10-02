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
      expect(body).toContain('id="load-status"');
      expect(body).not.toContain("40 Manning");
    }
    const offerJs = await SELF.fetch("https://example.com/offers/offer.js");
    expect(offerJs.status).toBe(200);
    const offerJsText = await offerJs.text();
    expect(offerJsText).toContain("'autoConfig', false");
    expect(offerJsText).toContain("onerror");
  });

  it("carries the Current offers teaser and its nav link, both hidden until a bookable offer renders (Plan 7 §3.3)", async () => {
    const body = await (await SELF.fetch("https://example.com/")).text();
    expect(body).toMatch(/<section id="offers" hidden>/);
    expect(body).toMatch(/<a href="#offers" id="nav-offers" hidden>Offers<\/a>/);
    expect(body).toContain('id="offer-cards"');
    expect(body).toContain("Current offers");
    expect(body).not.toContain("connect.facebook.net");
    const js = await (await SELF.fetch("https://example.com/store.js")).text();
    expect(js).toContain("fetch('/api/offers')");
    expect(js).not.toContain("fbq");
    expect(js).toContain("img.onerror");
    expect(js).toContain('class="tagline"');
    expect(js).not.toContain("querySelector('.tag')");
  });

  it("thanks page carries the booking variant and fires Purchase only through the pixel loader (Plan 7 §3.4, §3.9)", async () => {
    const body = await (await SELF.fetch("https://example.com/thanks")).text();
    expect(body).toContain("Your seat is booked. The address and the details are in the email on its way to you.");
    expect(body).toContain("[?&]booking=");
    expect(body).toContain("fbq('track', 'Purchase'");
    expect(body).toContain("currency: 'USD'");
    expect(body).toContain("'autoConfig', false");
  });
  it("privacy page names the pixel on the class and thank-you pages only (Plan 7 §3.9)", async () => {
    const body = await (await SELF.fetch("https://example.com/privacy")).text();
    expect(body).not.toContain("There are no advertising trackers on this site");
    expect(body).toContain("Meta Pixel");
    expect(body).toContain("facebook.com/privacy/policy");
    expect(body).toContain("Last updated: October 2, 2026");
    expect(body).not.toContain("share your information with anyone");
  });
});
