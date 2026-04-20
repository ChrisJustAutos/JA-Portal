-- ═══════════════════════════════════════════════════════════════════
-- 004_user_logos_storage.sql
-- Status: ALREADY APPLIED to Supabase project qtiscbvhlvdvafwtdtcd
-- Saved here for reference / disaster recovery only.
--
-- Creates the 'user-logos' storage bucket with:
--   - 5 MB file size limit enforced at storage level
--   - Allowed MIME types: PNG, JPEG, SVG
--   - Public reads (via signed URL or direct public URL)
--   - RLS write access restricted to each user's own folder
-- ═══════════════════════════════════════════════════════════════════

-- Create the bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'user-logos',
  'user-logos',
  true,
  5242880,  -- 5 MB
  ARRAY['image/png','image/jpeg','image/jpg','image/svg+xml']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- RLS policies for storage.objects table (scoped to user-logos bucket)
DROP POLICY IF EXISTS "users_upload_own_logo" ON storage.objects;
DROP POLICY IF EXISTS "users_update_own_logo" ON storage.objects;
DROP POLICY IF EXISTS "users_delete_own_logo" ON storage.objects;
DROP POLICY IF EXISTS "anyone_read_logos" ON storage.objects;

-- Users can INSERT files only into their own folder
CREATE POLICY "users_upload_own_logo"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'user-logos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can UPDATE only their own files
CREATE POLICY "users_update_own_logo"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'user-logos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can DELETE only their own files
CREATE POLICY "users_delete_own_logo"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'user-logos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Anyone can SELECT (read) logos — bucket is public for <img src=...> to work
CREATE POLICY "anyone_read_logos"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'user-logos');
