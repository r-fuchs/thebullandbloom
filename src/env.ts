export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SITE_URL: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ADMIN_PASSCODE: string;
  ADMIN_SECRET: string;
  GOOGLE_CLIENT_ID?: string;     // optional: admin reports "not configured" when absent
  GOOGLE_CLIENT_SECRET?: string;
}
