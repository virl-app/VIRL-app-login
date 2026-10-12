-- [PROFILE PR] Private storage bucket for a creator's own headline font.
--
-- A creator can upload one TTF/OTF/WOFF (2 MB cap) for the weekly rendered
-- post. Files live under <auth.uid()>/<filename>; the client may only read,
-- write and delete inside its own prefix, and the bucket is private so the
-- renderer reads it with the service key. profiles.brand already holds the
-- choice as { font: { kind: "upload", path, name } } (migration 030 added
-- the brand jsonb column), so no profile change here.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'brand-fonts', 'brand-fonts', false, 2097152,
  ARRAY['font/ttf', 'font/otf', 'font/woff', 'font/sfnt', 'application/x-font-ttf', 'application/x-font-opentype', 'application/font-woff', 'application/font-sfnt', 'application/vnd.ms-opentype', 'application/octet-stream']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS brand_fonts_select_own ON storage.objects;
DROP POLICY IF EXISTS brand_fonts_insert_own ON storage.objects;
DROP POLICY IF EXISTS brand_fonts_update_own ON storage.objects;
DROP POLICY IF EXISTS brand_fonts_delete_own ON storage.objects;

CREATE POLICY brand_fonts_select_own ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'brand-fonts' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY brand_fonts_insert_own ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'brand-fonts' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY brand_fonts_update_own ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'brand-fonts' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'brand-fonts' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY brand_fonts_delete_own ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'brand-fonts' AND (storage.foldername(name))[1] = auth.uid()::text);
