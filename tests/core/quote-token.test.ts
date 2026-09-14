import { describe, it, expect } from "vitest";
import { signQuote, verifyQuote, type QuoteClaim } from "../../src/core/quote-token";

const SECRET = "test-secret";
const claim: QuoteClaim = {
  feeCents: 1200, quoteId: "dqt_1", kind: "uber", date: "2026-09-16",
  addr: "5 elm street|apt 2|hudson|ny|12534", exp: 1_800_000_900,
};

describe("quote token", () => {
  it("round-trips a claim before it expires", async () => {
    const t = await signQuote(SECRET, claim);
    expect(await verifyQuote(SECRET, t, 1_800_000_000)).toEqual(claim);
  });
  it("refuses an expired token", async () => {
    const t = await signQuote(SECRET, claim);
    expect(await verifyQuote(SECRET, t, 1_800_000_901)).toBeNull();
  });
  it("refuses a token signed with another secret", async () => {
    const t = await signQuote("other", claim);
    expect(await verifyQuote(SECRET, t, 1_800_000_000)).toBeNull();
  });
  it("refuses a token whose fee was edited in the browser", async () => {
    const t = await signQuote(SECRET, claim);
    const [payload, sig] = t.split(".");
    const edited = btoa(JSON.stringify({ ...claim, feeCents: 1 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyQuote(SECRET, `${edited}.${sig}`, 1_800_000_000)).toBeNull();
    expect(await verifyQuote(SECRET, payload, 1_800_000_000)).toBeNull();
  });
  it("refuses garbage without throwing", async () => {
    expect(await verifyQuote(SECRET, "", 1)).toBeNull();
    expect(await verifyQuote(SECRET, "no-dot", 1)).toBeNull();
    expect(await verifyQuote(SECRET, "!!!.???", 1)).toBeNull();
  });
});
