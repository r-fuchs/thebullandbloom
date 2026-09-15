-- Plan 5 (D37): sales tax Stripe collected on the session, in cents.
ALTER TABLE orders ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0;

-- What a promotion code took off the session (D40).
ALTER TABLE orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
