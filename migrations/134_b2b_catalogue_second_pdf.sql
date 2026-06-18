-- 134_b2b_catalogue_second_pdf.sql
-- Allow a second instructions/spec PDF per B2B catalogue product. The existing
-- instructions_url is the first slot (stored at b2b-catalogue-pdfs/{id}/...);
-- the second lives under b2b-catalogue-pdfs/{id}/doc2/...

alter table public.b2b_catalogue add column if not exists instructions_url_2 text;
