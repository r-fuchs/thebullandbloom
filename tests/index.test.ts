import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

describe("default export fetch", () => {
  it("refuses to serve when a required secret is missing", async () => {
    const badEnv = { ...env, ADMIN_SECRET: "" };
    const r = await worker.fetch(new Request("https://example.com/api/health"), badEnv, ctx);
    expect(r.status).toBe(500);
    expect(await r.text()).toBe("misconfigured");
  });
  it("serves normally when all secrets are present", async () => {
    const r = await worker.fetch(new Request("https://example.com/api/health"), env, ctx);
    expect(r.status).toBe(200);
  });
});
