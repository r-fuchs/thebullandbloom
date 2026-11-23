-- Who a delivery is for, when that is not the person paying (a gift). NULL means the buyer.
ALTER TABLE orders ADD COLUMN recipient_name TEXT;
