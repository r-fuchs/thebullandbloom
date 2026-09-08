import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getOverrides, putAdminOverride, clearAdminOverride } from "../../src/store/overrides";

describe("overrides", () => {
  it("round-trips an admin override", async () => {
    await putAdminOverride(env.DB, "2026-09-10", { cap: 2, closed: false });
    const m = await getOverrides(env.DB, "2026-09-01", "2026-09-30");
    expect(m.get("2026-09-10")).toEqual({ cap: 2, closed: false });
  });
  it("replaces on second put and clears", async () => {
    await putAdminOverride(env.DB, "2026-09-11", { cap: null, closed: true });
    await putAdminOverride(env.DB, "2026-09-11", { cap: 5, closed: false });
    expect((await getOverrides(env.DB, "2026-09-11", "2026-09-11")).get("2026-09-11")).toEqual({ cap: 5, closed: false });
    await clearAdminOverride(env.DB, "2026-09-11");
    expect((await getOverrides(env.DB, "2026-09-11", "2026-09-11")).has("2026-09-11")).toBe(false);
  });
  it("merges sources: closed wins from either, cap from admin", async () => {
    await env.DB.prepare("INSERT INTO day_overrides (date, source, cap, closed) VALUES ('2026-09-12','calendar',NULL,1)").run();
    await putAdminOverride(env.DB, "2026-09-12", { cap: 3, closed: false });
    expect((await getOverrides(env.DB, "2026-09-12", "2026-09-12")).get("2026-09-12")).toEqual({ cap: 3, closed: true });
  });
  it("respects the date range", async () => {
    await putAdminOverride(env.DB, "2026-10-01", { cap: 1, closed: false });
    expect((await getOverrides(env.DB, "2026-09-01", "2026-09-30")).has("2026-10-01")).toBe(false);
  });
});
