import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { loadDefaults, saveDefaults } from "../../src/store/settings";

const base = { cap: 4, cutoff: "11:00", openWeekdays: [2, 3, 4, 5, 6] };

describe("settings", () => {
  it("returns base defaults when nothing is saved", async () => {
    expect(await loadDefaults(env.DB, base)).toEqual(base);
  });
  it("overlays saved values and keeps the rest", async () => {
    await saveDefaults(env.DB, { cap: 6, openWeekdays: [1, 2] });
    expect(await loadDefaults(env.DB, base)).toEqual({ cap: 6, cutoff: "11:00", openWeekdays: [1, 2] });
    await saveDefaults(env.DB, { cutoff: "10:30" });
    expect((await loadDefaults(env.DB, base)).cutoff).toBe("10:30");
  });
});
