import { describe, it, expect } from "vitest";
import { EmailRoutingAlerts, NoAlerts, buildRaw } from "../../src/adapters/alerts";

const FROM = "alerts@thebullandbloom.com";

function fakeBinding(failFor: string[] = []) {
  const sent: any[] = [];
  const binding = { send: async (m: any) => { if (failFor.includes(m.to)) throw new Error("not verified"); sent.push(m); } } as unknown as SendEmail;
  return { binding, sent };
}

describe("EmailRoutingAlerts", () => {
  it("sends one message per recipient through the binding", async () => {
    const { binding, sent } = fakeBinding();
    const a = new EmailRoutingAlerts(binding, FROM, ["a@x.co", "b@x.co"]);
    expect(a.configured()).toBe(true);
    await a.notify("Stuck", "line one\nline two");
    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.to)).toEqual(["a@x.co", "b@x.co"]);
    expect(sent.every((m) => m.from === FROM)).toBe(true);
  });

  it("builds a minimal RFC 5322 text/plain message", () => {
    const raw = buildRaw(FROM, "a@x.co", "Stuck", "line one\nline two", new Date("2026-10-02T12:00:00Z"));
    const [head, body] = raw.split("\r\n\r\n");
    const lines = head.split("\r\n");
    expect(lines[0]).toBe(`From: ${FROM}`);
    expect(lines[1]).toBe("To: a@x.co");
    expect(lines[2]).toBe("Subject: Stuck");
    expect(lines[3]).toBe("Date: Fri, 02 Oct 2026 12:00:00 GMT");
    expect(lines[4]).toMatch(/^Message-ID: <[0-9a-f-]+@thebullandbloom\.com>$/);
    expect(lines.slice(5)).toEqual(["MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"]);
    expect(body).toBe("line one\r\nline two\r\n");
  });

  it("keeps an injected or non-ASCII subject on one safe line", () => {
    const raw = buildRaw(FROM, "a@x.co", "Bcc: evil@x.co\nNew order: José", "x");
    const lines = raw.split("\r\n");
    expect(lines.find((l) => l.startsWith("Subject:"))).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(lines.some((l) => l.startsWith("Bcc:"))).toBe(false);
  });

  it("one rejected recipient does not stop the others, and notify never throws", async () => {
    const { binding, sent } = fakeBinding(["a@x.co"]);
    await new EmailRoutingAlerts(binding, FROM, ["a@x.co", "b@x.co"]).notify("S", "T");
    expect(sent.map((m) => m.to)).toEqual(["b@x.co"]);
  });

  it("without a binding it is a no-op that reports not configured", async () => {
    const a = new EmailRoutingAlerts(undefined, FROM, ["a@x.co"]);
    expect(a.configured()).toBe(false);
    await expect(a.notify("S", "T")).resolves.toBeUndefined();
    expect(new NoAlerts().configured()).toBe(false);
  });
});
