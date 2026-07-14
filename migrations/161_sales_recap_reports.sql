-- 161_sales_recap_reports.sql
-- Weekly Sales Recap storage (Reports → Sales Report). One row per week;
-- generated Mon 7am by the sales-recap runner. payload = computed 6-section
-- model, html = rendered report (email + portal view).
create table if not exists sales_recap_reports (
  id           uuid primary key default gen_random_uuid(),
  week_start   date not null,
  week_end     date not null,
  generated_at timestamptz not null default now(),
  payload      jsonb not null,
  html         text not null,
  emailed_to   text,
  is_current   boolean not null default true
);
create unique index if not exists sales_recap_week_uq on sales_recap_reports (week_start);
create index if not exists sales_recap_current on sales_recap_reports (is_current, generated_at desc);
