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
  UBER_CLIENT_ID?: string;       // optional: without these, delivery falls back or hides (spec §4.5)
  UBER_CLIENT_SECRET?: string;
  UBER_CUSTOMER_ID?: string;
  UBER_WEBHOOK_SECRET?: string;
  /** "1" on the sandbox deployment: Create Delivery then carries Uber's Robocourier test block */
  UBER_ROBOCOURIER?: string;
}
