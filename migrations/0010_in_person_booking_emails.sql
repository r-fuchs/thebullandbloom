-- The admin "Add a booking" form (2026-10-03) recorded in-person parties without queueing their
-- confirmation email. Queue it once for every such booking (paid, no Stripe session) that gave an
-- address and has no row yet; the drain job sends on the next cron. Anthony's own headcount email
-- is not backfilled: he entered these himself.
INSERT INTO outbox (id, kind, order_id, created_at, attempts, next_attempt_at)
SELECT lower(hex(randomblob(16))), 'booking_confirmed_customer', b.id,
       CAST(strftime('%s', 'now') AS INTEGER), 0, CAST(strftime('%s', 'now') AS INTEGER)
FROM bookings b
WHERE b.status = 'paid' AND b.stripe_session_id IS NULL AND b.customer_email <> ''
  AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.order_id = b.id AND o.kind = 'booking_confirmed_customer');
