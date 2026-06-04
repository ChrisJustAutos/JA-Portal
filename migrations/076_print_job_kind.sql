-- 076_print_job_kind.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- The print queue (label_print_jobs) now carries more than freight labels: at
-- Book-freight we also enqueue the MYOB tax invoice. `kind` tells the workshop
-- print agent which printer to send each job to — 'label' → the DYMO 4XL,
-- 'invoice' → the office A4 printer (agent env INVOICE_PRINTER_NAME). Existing
-- rows default to 'label' so nothing changes for in-flight jobs.

alter table public.label_print_jobs
  add column if not exists kind text not null default 'label';

do $$
begin
  if not exists (
    select 1 from information_schema.constraint_column_usage
    where table_name = 'label_print_jobs' and constraint_name = 'label_print_jobs_kind_chk'
  ) then
    alter table public.label_print_jobs
      add constraint label_print_jobs_kind_chk check (kind in ('label','invoice'));
  end if;
end $$;
