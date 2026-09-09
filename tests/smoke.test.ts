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
  it("wires the subscribe form by id so the order form's Formspree script can't hijack it", async () => {
    const r = await SELF.fetch("https://example.com/");
    const body = await r.text();
    expect(body).toContain('id="subscribe-form"');
    expect(body).toContain("querySelector('#subscribe-form')");
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
});
