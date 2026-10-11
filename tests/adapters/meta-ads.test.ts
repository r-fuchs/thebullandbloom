import { describe, it, expect } from "vitest";
import { MetaAdsApi, MetaAdsNotConfigured, parseInsights } from "../../src/adapters/meta-ads";

// One campaign row as Graph API v21 returns it for level=campaign.
const ROW = {
  campaign_id: "52546208021371", campaign_name: "Wreath & Sip Oct 17 test", date_start: "2026-10-07", date_stop: "2026-10-10",
  spend: "22.66", reach: "522", impressions: "723", inline_link_clicks: "21",
  actions: [{ action_type: "link_click", value: "21" }, { action_type: "landing_page_view", value: "17" }, { action_type: "omni_purchase", value: "1" }, { action_type: "purchase", value: "1" }],
};

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("parseInsights", () => {
  it("shapes a row: spend in cents, link clicks, landing page views and purchases from actions", () => {
    expect(parseInsights({ data: [ROW] })).toEqual([{
      campaignId: "52546208021371", campaignName: "Wreath & Sip Oct 17 test", dateStart: "2026-10-07", dateStop: "2026-10-10",
      spendCents: 2266, reach: 522, impressions: 723, linkClicks: 21, landingPageViews: 17, purchases: 1,
    }]);
  });

  it("treats missing actions and numbers as zero, and falls back to plain purchase", () => {
    const [r] = parseInsights({ data: [{ campaign_name: "x", spend: "0", actions: [{ action_type: "purchase", value: "2" }] }] });
    expect(r).toMatchObject({ spendCents: 0, reach: 0, impressions: 0, linkClicks: 0, landingPageViews: 0, purchases: 2 });
  });

  it("rejects a body with no data array", () => {
    expect(() => parseInsights({ error: { message: "bad token" } })).toThrow(/no data array/);
  });
});

describe("MetaAdsApi", () => {
  it("is not configured without a token and refuses to call", async () => {
    const api = new MetaAdsApi(undefined);
    expect(api.configured()).toBe(false);
    await expect(api.campaignInsights("1", "2026-10-10", "2026-10-10")).rejects.toBeInstanceOf(MetaAdsNotConfigured);
  });

  it("asks for campaign-level insights over the range, with the token in a header and not the URL", async () => {
    const { fn, calls } = fakeFetch(200, { data: [ROW] });
    const rows = await new MetaAdsApi("EAAtoken", fn).campaignInsights("1120923584233745", "2026-10-07", "2026-10-10");
    expect(rows).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe("https://graph.facebook.com/v21.0/act_1120923584233745/insights");
    expect(u.searchParams.get("level")).toBe("campaign");
    expect(u.searchParams.get("fields")).toContain("spend");
    expect(u.searchParams.get("fields")).toContain("actions");
    expect(JSON.parse(u.searchParams.get("time_range")!)).toEqual({ since: "2026-10-07", until: "2026-10-10" });
    expect(calls[0].url).not.toContain("EAAtoken");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer EAAtoken");
  });

  it("throws with the status and body on a Graph error", async () => {
    const { fn } = fakeFetch(400, { error: { message: "Invalid OAuth access token" } });
    await expect(new MetaAdsApi("bad", fn).campaignInsights("1", "2026-10-10", "2026-10-10")).rejects.toThrow(/400 .*Invalid OAuth/);
  });
});
