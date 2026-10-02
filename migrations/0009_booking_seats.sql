-- A booking is one party, not one seat: `seats` is how many the party holds. Seats taken for a
-- session = SUM(seats) over rows with status held or paid. Existing rows were one seat each.
ALTER TABLE bookings ADD COLUMN seats INTEGER NOT NULL DEFAULT 1;
