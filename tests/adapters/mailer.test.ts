import { describe, it, expect } from "vitest";
import { MailerNotConfigured, ResendMailer } from "../../src/adapters/mailer";

const FROM = "The Bull and Bloom <orders@thebullandbloom.com>";
const MAIL = { to: "pat@example.com", subject: "Your bouquet", text: "Hi Pat" };

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("ResendMailer", () => {
  it("posts the message to Resend with the bearer key, from and reply-to", async () => {
    const { fn, calls } = fakeFetch(200, { id: "em_1" });
    await new ResendMailer("re_key", FROM, "shop@gmail.com", fn).send(MAIL);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.method).toBe("POST");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer re_key");
    expect(h["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      from: FROM, to: ["pat@example.com"], reply_to: "shop@gmail.com", subject: "Your bouquet", text: "Hi Pat",
    });
  });

  it("throws with the status and the provider's message on a 4xx", async () => {
    const { fn } = fakeFetch(403, { name: "validation_error", message: "The domain is not verified" });
    await expect(new ResendMailer("re_key", FROM, "shop@gmail.com", fn).send(MAIL)).rejects.toThrow("resend 403: The domain is not verified");
  });

  it("throws with the raw body when the error is not JSON", async () => {
    const { fn } = fakeFetch(502, "bad gateway");
    await expect(new ResendMailer("re_key", FROM, "shop@gmail.com", fn).send(MAIL)).rejects.toThrow("resend 502: bad gateway");
  });

  it("is not configured without a key and throws MailerNotConfigured before any request", async () => {
    const { fn, calls } = fakeFetch(200, {});
    for (const key of [undefined, ""]) {
      const m = new ResendMailer(key, FROM, "shop@gmail.com", fn);
      expect(m.configured()).toBe(false);
      await expect(m.send(MAIL)).rejects.toBeInstanceOf(MailerNotConfigured);
    }
    expect(calls).toHaveLength(0);
    expect(new ResendMailer("re_key", FROM, "shop@gmail.com", fn).configured()).toBe(true);
  });
});
