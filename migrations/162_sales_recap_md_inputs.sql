-- Store the raw MechanicDesk scrape (diary notes + forward forecast) alongside
-- each generated recap, so the live Reports → Sales Report view can re-assemble
-- the report against fresh Monday order data without needing another scrape.
alter table sales_recap_reports add column if not exists md_inputs jsonb;
