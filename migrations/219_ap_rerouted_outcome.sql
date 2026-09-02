-- 219 — AP auto-entry: 'rerouted' is a real outcome.
--
-- Chris, 2026-09-02, after the second MPI test: "nothing should have been
-- posted into JAWS because it waits until you post it into the Portal inbox
-- sub folder to do the check."
--
-- He is right, and it is the whole reason that folder exists. The JAWS intake
-- watches ONLY accounts@justautoswholesale.com / "Portal Invoices", because the
-- wholesale Inbox carries invoices tied to open purchase orders and stock
-- receival that must NOT auto-post — a human drags in the ones that should.
--
-- The billed-to reroute drove straight past that gate: an invoice billed to
-- JAWS that landed in the VPS inbox was posted against JAWS on the spot, from
-- an inbox that has no gate at all. The forward was right; posting was not.
--
-- So a reroute into a FOLDER-GATED company file now ends the portal's
-- involvement: forward the email, tell the inbox it came from, and log it as
-- 'rerouted'. The invoice is then entered the ordinary way, when someone puts
-- it in the folder — the check runs there, in the right company, with the
-- normal duplicate guard.
--
-- 'rerouted' has to be a TERMINAL outcome (the sweep treats anything other
-- than 'error' as terminal), or the VPS inbox would forward the same email
-- every 15 minutes forever.
--
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd via apply_migration.

alter table public.ap_auto_entry_log drop constraint if exists ap_auto_entry_log_outcome_check;
alter table public.ap_auto_entry_log add constraint ap_auto_entry_log_outcome_check
  check (outcome = any (array[
    'posted', 'flagged', 'skipped_not_invoice', 'skipped_duplicate', 'error', 'rerouted'
  ]));

comment on column public.ap_auto_entry_log.outcome is
  'posted | flagged | skipped_not_invoice | skipped_duplicate | error | rerouted. '
  'rerouted = the document was billed to the OTHER company whose intake is folder-gated, '
  'so the email was forwarded there and nothing was entered from this inbox.';
