-- 187: MachShip manifest tracking — consignments are now manifested
-- immediately after booking (unmanifested consignments never reach the carrier).
ALTER TABLE public.b2b_orders ADD COLUMN IF NOT EXISTS machship_manifest_id text;
