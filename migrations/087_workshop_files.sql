-- 087_workshop_files.sql
-- Job card Files & photos: metadata table + PRIVATE storage bucket.
-- Uploads go client → Supabase Storage via one-time signed upload tokens
-- (created server-side with the service role), so no storage RLS policies
-- are needed; downloads are via short-lived signed URLs. This dodges
-- Vercel's ~4.5 MB request-body cap for phone photos.

CREATE TABLE IF NOT EXISTS public.workshop_files (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID REFERENCES public.workshop_bookings(id)  ON DELETE SET NULL,
  vehicle_id       UUID REFERENCES public.workshop_vehicles(id)  ON DELETE SET NULL,
  customer_id      UUID REFERENCES public.workshop_customers(id) ON DELETE SET NULL,
  file_name        TEXT NOT NULL,
  storage_path     TEXT NOT NULL UNIQUE,
  mime_type        TEXT,
  size_bytes       BIGINT,
  uploaded_by      UUID,
  uploaded_by_name TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workshop_files_booking_idx  ON public.workshop_files (booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workshop_files_vehicle_idx  ON public.workshop_files (vehicle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workshop_files_customer_idx ON public.workshop_files (customer_id, created_at DESC);

ALTER TABLE public.workshop_files ENABLE ROW LEVEL SECURITY; -- service-role only, like 031

-- Private bucket: 25 MB cap, images + common documents.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('workshop-files', 'workshop-files', false, 26214400,
        ARRAY['image/png','image/jpeg','image/jpg','image/webp','image/heic','image/heif','image/gif',
              'application/pdf','application/msword',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
