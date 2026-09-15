-- Plan 5 (D34): hand-tied or arranged in a vase, and what the vase cost.
ALTER TABLE orders ADD COLUMN presentation TEXT NOT NULL DEFAULT 'hand-tied' CHECK (presentation IN ('hand-tied','vase'));
ALTER TABLE orders ADD COLUMN vase_cents INTEGER NOT NULL DEFAULT 0;
