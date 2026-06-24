-- ═══════════════════════════════════════════════════════════════════
-- 140_print_agent_trays.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- Per-job-kind paper tray (bin) selection so one printer can pull letters,
-- A4 invoices and envelopes from different trays. Passed to the agent's
-- pdf-to-printer as the `bin` option. Blank = the printer's default tray.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.print_agent_settings ADD COLUMN IF NOT EXISTS letter_bin   TEXT;
ALTER TABLE public.print_agent_settings ADD COLUMN IF NOT EXISTS envelope_bin TEXT;
ALTER TABLE public.print_agent_settings ADD COLUMN IF NOT EXISTS invoice_bin  TEXT;
