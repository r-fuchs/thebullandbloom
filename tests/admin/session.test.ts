import { describe, it, expect } from "vitest";
import { makeSession, verifySession, passcodeMatches } from "../../src/admin/session";

describe("admin session", () => {
  it("verifies a fresh token and rejects an expired one", async () => {
    const t = await makeSession("s", 1000, 60);
    expect(await verifySession(t, "s", 1030)).toBe(true);
    expect(await verifySession(t, "s", 1061)).toBe(false);
  });
  it("rejects tampering, wrong secret, and garbage", async () => {
    const t = await makeSession("s", 1000, 60);
    const [exp, sig] = t.split(".");
    expect(await verifySession(`${Number(exp) + 9999}.${sig}`, "s", 1030)).toBe(false);
    expect(await verifySession(t, "other", 1030)).toBe(false);
    expect(await verifySession("nope", "s", 1030)).toBe(false);
    expect(await verifySession(undefined, "s", 1030)).toBe(false);
  });
  it("compares passcodes", async () => {
    expect(await passcodeMatches("open-sesame-1234", "open-sesame-1234")).toBe(true);
    expect(await passcodeMatches("open-sesame-1235", "open-sesame-1234")).toBe(false);
    expect(await passcodeMatches("", "open-sesame-1234")).toBe(false);
  });
});
