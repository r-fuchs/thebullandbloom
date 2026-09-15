-- Plan 5 (D37): sales tax Stripe collected on the session, in cents.
ALTER TABLE orders ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0;
