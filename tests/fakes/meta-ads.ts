import type { CampaignInsights, MetaAds } from "../../src/adapters/meta-ads";

export class FakeMetaAds implements MetaAds {
  isConfigured = true;
  /** rows returned for any range; filtered to those overlapping [since, until] */
  rows: CampaignInsights[] = [];
  calls: Array<{ adAccountId: string; since: string; until: string }> = [];
  failNext: string | null = null;

  configured() { return this.isConfigured; }
  async campaignInsights(adAccountId: string, since: string, until: string): Promise<CampaignInsights[]> {
    this.calls.push({ adAccountId, since, until });
    if (this.failNext) { const m = this.failNext; this.failNext = null; throw new Error(m); }
    return this.rows.filter((r) => r.dateStop >= since && r.dateStart <= until);
  }
}
