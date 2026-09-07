import { describe, it, expect } from "vitest";
import { loadConfig, sizeById, validateConfig } from "../src/config";

describe("config", () => {
  it("loads the repo config", () => {
    const cfg = loadConfig();
    expect(cfg.timezone).toBe("America/New_York");
    expect(cfg.sizes.length).toBeGreaterThan(0);
    expect(sizeById(cfg, cfg.sizes[0].id)?.id).toBe(cfg.sizes[0].id);
    expect(sizeById(cfg, "nope")).toBeUndefined();
  });
  it("rejects bad cutoff", () => {
    const cfg = { ...loadConfig(), defaults: { cap: 1, cutoff: "25:00", openWeekdays: [1] } };
    expect(() => validateConfig(cfg)).toThrow(/cutoff/);
  });
  it("rejects duplicate size ids and non-integer cents", () => {
    const base = loadConfig();
    expect(() => validateConfig({ ...base, sizes: [base.sizes[0], base.sizes[0]] })).toThrow(/duplicate/);
    expect(() => validateConfig({ ...base, sizes: [{ ...base.sizes[0], priceCents: 1.5 }] })).toThrow(/priceCents/);
  });
});
