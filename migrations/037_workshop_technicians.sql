-- ═══════════════════════════════════════════════════════════════════
-- 037_workshop_technicians.sql
-- Workshop-managed technicians/staff that drive the diary lanes, replacing
-- the previous derivation straight from the PBX extensions directory. A
-- "technician" here is any staff member who can own diary bookings;
-- show_in_diary excludes the rest (office/sales) and active=false retires
-- someone who has left. The lane key is `code`, stored in
-- workshop_bookings.technician_ext, so existing bookings keep their lane.
-- Service-role-only (RLS on, no policy).
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.workshop_technicians (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  code          TEXT NOT NULL UNIQUE,        -- lane key (workshop_bookings.technician_ext)
  role          TEXT,                        -- free text: Technician / Service advisor / Apprentice
  color         TEXT,                        -- diary lane colour (hex)
  phone_ext     TEXT,                        -- optional PBX extension link
  daily_hours   NUMERIC(5,1) NOT NULL DEFAULT 8,
  show_in_diary BOOLEAN NOT NULL DEFAULT true,
  active        BOOLEAN NOT NULL DEFAULT true,   -- employed; false = removed/left
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.workshop_technicians ENABLE ROW LEVEL SECURITY;

-- Seed from the current active PBX extensions (today's diary lanes): code =
-- extension, friendly name + capacity carried over, so the diary is unchanged
-- until an admin curates it in Settings.
INSERT INTO public.workshop_technicians (name, code, role, phone_ext, daily_hours, sort_order)
SELECT COALESCE(e.display_name, 'Ext ' || e.extension::text),
       e.extension::text,
       e.role,
       e.extension::text,
       COALESCE(c.daily_hours, 8),
       ROW_NUMBER() OVER (ORDER BY e.extension::text)
FROM public.extensions e
LEFT JOIN public.workshop_tech_capacity c ON c.technician_ext = e.extension::text
WHERE e.active = true
  AND lower(COALESCE(e.role, '')) NOT IN ('system', 'test')
ON CONFLICT (code) DO NOTHING;

-- Defensive: any technician_ext already on a booking but not covered above.
INSERT INTO public.workshop_technicians (name, code, daily_hours, sort_order)
SELECT 'Ext ' || b.technician_ext, b.technician_ext, 8, 900
FROM (SELECT DISTINCT technician_ext FROM public.workshop_bookings
      WHERE technician_ext IS NOT NULL AND technician_ext <> '') b
ON CONFLICT (code) DO NOTHING;
