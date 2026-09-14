-- Launch reset (cutover, one time): remove every sandbox order, courier job, queued message, and test
-- subscriber from the production D1 so Anthony's first real day starts clean. Settings and day
-- overrides (his cap, cutoff, open weekdays, closed days) are kept. Stripe test subscriptions must be
-- cancelled in the Stripe TEST dashboard separately, and the test events on the "Bull and Bloom: Orders"
-- calendar deleted by hand. Run only with Ryan's go: npx wrangler d1 execute bullandbloom --remote --file scripts/launch-reset.sql
DELETE FROM outbox;
DELETE FROM deliveries;
DELETE FROM orders;
DELETE FROM subscribers;
SELECT 'orders' AS t, COUNT(*) AS n FROM orders UNION ALL SELECT 'deliveries', COUNT(*) FROM deliveries UNION ALL SELECT 'outbox', COUNT(*) FROM outbox UNION ALL SELECT 'subscribers', COUNT(*) FROM subscribers;
