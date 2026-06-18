-- 135_md_prepick_allocated.sql
-- Store MD's allocated_quantity (stock already committed/reserved to jobs) on
-- each Pre Pick part, from the same /stocks/{id} detail we read for on-order.
-- Informational column — does NOT change the to-pick / to-order maths (the
-- in-range demand already overlaps with what MD has allocated).

alter table public.md_prepick_items add column if not exists allocated numeric(12,2) not null default 0;
