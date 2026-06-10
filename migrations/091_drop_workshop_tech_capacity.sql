-- 091_drop_workshop_tech_capacity.sql
-- Retire the vestigial workshop_tech_capacity table. Capacity moved to
-- workshop_technicians.daily_hours in migration 037 (which also seeded from
-- this table); nothing has read or written it since. The diary now takes
-- capacity from the bookings GET technicians payload.

DROP TABLE IF EXISTS public.workshop_tech_capacity;
