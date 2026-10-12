import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { testApp, asAdmin } from "../helpers";
import { loadConfig, subscriptionCell } from "../../src/config";
import { loadPrices } from "../../src/store/prices";

const cfg = loadConfig();
const posy = cfg.sizes[0];
const weekly = subscriptionCell(cfg, posy.id, "weekly")!.priceCents;

describe("admin prices", () => {
  it("refuses a request with no Access token", async () => {
    const { fetch } = testApp();
    expect((await fetch("/admin/api/prices")).status).toBe(401);
  });

  it("lists every size and cell with its config default", async () => {
    const as = asAdmin(testApp().fetch);
    const body = await (await as("/admin/api/prices")).json() as any;
    expect(body.cadences).toEqual(cfg.subscriptions.cadences.map((c) => ({ id: c.id, name: c.name })));
    expect(body.sizes[0]).toEqual({
      id: posy.id, name: posy.name, description: posy.description,
      priceCents: posy.priceCents, vaseFeeCents: posy.vaseFeeCents,
      defaults: { priceCents: posy.priceCents, vaseFeeCents: posy.vaseFeeCents },
    });
    expect(body.cells).toContainEqual({ sizeId: posy.id, cadenceId: "weekly", priceCents: weekly, defaults: { priceCents: weekly } });
    expect(body.cells).toHaveLength(cfg.subscriptions.cells.length);
  });

  it("saves new prices and reads them back beside the defaults", async () => {
    const as = asAdmin(testApp().fetch);
    const r = await as("/admin/api/prices", { method: "PUT", body: JSON.stringify({
      sizes: { [posy.id]: { priceCents: 6500, vaseFeeCents: posy.vaseFeeCents } },
      cells: { [`${posy.id}/weekly`]: 21000 },
    }) });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.sizes[0]).toMatchObject({ priceCents: 6500, vaseFeeCents: posy.vaseFeeCents, defaults: { priceCents: posy.priceCents } });
    expect(body.cells).toContainEqual({ sizeId: posy.id, cadenceId: "weekly", priceCents: 21000, defaults: { priceCents: weekly } });
    // a value equal to its default is not stored, so the config stays the source of truth for it
    expect(await loadPrices(env.DB)).toEqual({ sizes: { [posy.id]: { priceCents: 6500 } }, cells: { [`${posy.id}/weekly`]: 21000 } });
    expect((await (await as("/admin/api/prices")).json() as any).sizes[0].priceCents).toBe(6500);
  });

  it("leaving a price out of the save returns it to the config", async () => {
    const as = asAdmin(testApp().fetch);
    const r = await as("/admin/api/prices", { method: "PUT", body: JSON.stringify({ sizes: {}, cells: {} }) });
    const body = await r.json() as any;
    expect(body.sizes[0].priceCents).toBe(posy.priceCents);
    expect(await loadPrices(env.DB)).toEqual({ sizes: {}, cells: {} });
  });

  it("rejects bad prices without saving anything", async () => {
    const as = asAdmin(testApp().fetch);
    const put = (b: unknown) => as("/admin/api/prices", { method: "PUT", body: JSON.stringify(b) });
    for (const bad of [
      { sizes: { nope: { priceCents: 100 } }, cells: {} },
      { sizes: {}, cells: { "nope/weekly": 100 } },
      { sizes: {}, cells: { [`${posy.id}/never`]: 100 } },
      { sizes: { [posy.id]: { priceCents: 0 } }, cells: {} },
      { sizes: { [posy.id]: { priceCents: 12.5 } }, cells: {} },
      { sizes: { [posy.id]: { vaseFeeCents: -1 } }, cells: {} },
      { sizes: { [posy.id]: { priceCents: 100_000_01 } }, cells: {} },
      { sizes: {}, cells: { [`${posy.id}/weekly`]: "21000" } },
      { sizes: [] },
      "nope",
    ]) {
      const r = await put(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await as("/admin/api/prices", { method: "PUT", body: "{" })).status).toBe(400);
    expect(await loadPrices(env.DB)).toEqual({ sizes: {}, cells: {} });
  });
});
