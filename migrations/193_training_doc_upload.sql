-- 193: training document → course generator storage.
--
-- Chris (2026-08-07): self-service document→course generator — staff upload a
-- PDF, the portal renders every page to a slide JPEG, drafts sections + a
-- suggested quiz with an LLM, and saves the module as a DISABLED draft for
-- review. Two buckets:
--   • b2b-training-slides  (PUBLIC)  — rendered page JPEGs, served straight
--     from storage via content.slide_base (repo-baked modules keep using
--     /public/training/<slug>/NN.jpg and have no slide_base).
--   • b2b-training-uploads (private) — the source PDFs, uploaded direct from
--     the browser with a signed upload URL (same pattern as B2B Resources).

insert into storage.buckets (id, name, public)
values ('b2b-training-slides', 'b2b-training-slides', true)
on conflict do nothing;

insert into storage.buckets (id, name, public)
values ('b2b-training-uploads', 'b2b-training-uploads', false)
on conflict do nothing;
