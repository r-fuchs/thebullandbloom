import { describe, it, expect } from "vitest";
import { makeStateToken, verifyStateToken } from "../../src/core/state-token";

describe("oauth state token", () => {
  it("verifies a fresh token and rejects an expired one", async () => {
    const t = await makeStateToken("s", 1000, 60);
    expect(await verifyStateToken(t, "s", 1030)).toBe(true);
    expect(await verifyStateToken(t, "s", 1061)).toBe(false);
  });
  it("rejects tampering, wrong secret, and garbage", async () => {
    const t = await makeStateToken("s", 1000, 60);
    const [exp, sig] = t.split(".");
    expect(await verifyStateToken(`${Number(exp) + 9999}.${sig}`, "s", 1030)).toBe(false);
    expect(await verifyStateToken(t, "other", 1030)).toBe(false);
    expect(await verifyStateToken("nope", "s", 1030)).toBe(false);
    expect(await verifyStateToken(undefined, "s", 1030)).toBe(false);
  });
});
