-- 126_b2b_catalogue_pdf_bucket_limit.sql
-- The instructions-PDF upload (catalogue editor) compresses then uploads to the
-- b2b-catalogue-pdfs bucket, with a client-side cap of 25 MB (PDF_MAX_BYTES).
-- The bucket itself was created with a 10 MB file_size_limit, so any PDF that
-- compression couldn't get under 10 MB passed the client check then bounced at
-- storage ("exceeded the maximum allowed size") — i.e. the uploader appeared to
-- "not work". Raise the bucket limit to 25 MB to match the code's intent.
update storage.buckets set file_size_limit = 26214400 where id = 'b2b-catalogue-pdfs';
