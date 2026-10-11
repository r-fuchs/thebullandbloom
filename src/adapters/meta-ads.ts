// Meta Marketing API insights behind one interface, so the daily ads report (jobs/ads-report.ts)
// can be tested against a fake. Read-only: the token only needs `ads_read` on the ad account.

export interface CampaignInsights {
  campaignId: string;
  campaignName: string;
  /** the range the numbers cover, YYYY-MM-DD, as Meta reports it */
  dateStart: string;
  dateStop: string;
  spendCents: number;
  reach: number;
  impressions: number;
  linkClicks: number;
  landingPageViews: number;
  purchases: number;
}

export interface MetaAds {
  /** true when the access token is present */
  configured(): boolean;
  /** one row per campaign that delivered in [since, until] (inclusive, ad-account time zone); throws on any failure */
  campaignInsights(adAccountId: string, since: string, until: string): Promise<CampaignInsights[]>;
}

export class MetaAdsNotConfigured extends Error {
  constructor() { super("meta ads: not configured"); this.name = "MetaAdsNotConfigured"; }
}

const GRAPH = "https://graph.facebook.com/v21.0";
const FIELDS = "campaign_id,campaign_name,date_start,date_stop,spend,reach,impressions,inline_link_clicks,actions";

interface Action { action_type?: unknown; value?: unknown }
interface InsightRow {
  campaign_id?: unknown; campaign_name?: unknown; date_start?: unknown; date_stop?: unknown;
  spend?: unknown; reach?: unknown; impressions?: unknown; inline_link_clicks?: unknown; actions?: unknown;
}

const num = (v: unknown): number => { const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0; return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function action(actions: unknown, ...types: string[]): number {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) {
    const hit = (actions as Action[]).find((a) => a?.action_type === t);
    if (hit) return num(hit.value);
  }
  return 0;
}

/** Shapes one Graph API `insights` page into rows. Exported for tests. */
export function parseInsights(body: unknown): CampaignInsights[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error("meta ads insights: no data array in response");
  return (data as InsightRow[]).map((r) => ({
    campaignId: str(r.campaign_id),
    campaignName: str(r.campaign_name),
    dateStart: str(r.date_start),
    dateStop: str(r.date_stop),
    spendCents: Math.round(num(r.spend) * 100),
    reach: num(r.reach),
    impressions: num(r.impressions),
    linkClicks: num(r.inline_link_clicks),
    landingPageViews: action(r.actions, "landing_page_view"),
    // omni_purchase folds web and app purchases together; plain purchase is the web pixel alone
    purchases: action(r.actions, "omni_purchase", "purchase"),
  }));
}

export class MetaAdsApi implements MetaAds {
  constructor(private token: string | undefined, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  configured(): boolean { return typeof this.token === "string" && this.token !== ""; }

  async campaignInsights(adAccountId: string, since: string, until: string): Promise<CampaignInsights[]> {
    if (!this.configured()) throw new MetaAdsNotConfigured();
    const u = new URL(`${GRAPH}/act_${adAccountId}/insights`);
    u.searchParams.set("level", "campaign");
    u.searchParams.set("fields", FIELDS);
    u.searchParams.set("time_range", JSON.stringify({ since, until }));
    u.searchParams.set("limit", "100");
    // The token travels in a header, never in the URL, so it stays out of logs.
    const r = await this.fetchImpl(u.toString(), { headers: { authorization: `Bearer ${this.token}` } });
    const text = await r.text();
    if (!r.ok) throw new Error(`meta ads insights: ${r.status} ${text.slice(0, 300)}`);
    return parseInsights(JSON.parse(text));
  }
}
