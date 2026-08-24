-- 200_ap_auto_entry_manual_check.sql
--
-- "Entered manually?" check on the AP Slack flag cards. A flagged invoice is
-- usually keyed into MYOB by hand, leaving the Slack card looking outstanding
-- forever. The button asks MYOB directly; a hit marks the log row posted and
-- records that a PERSON posted it, not the automation — so the supplier-trust
-- counts ("N posted") stay honest.

alter table ap_auto_entry_log
  add column if not exists entered_manually  boolean not null default false,
  add column if not exists manual_checked_by text,
  add column if not exists manual_checked_at timestamptz;

comment on column ap_auto_entry_log.entered_manually is
  'True when the bill was found already in MYOB via the Slack "Entered manually?" check — the invoice is entered, but by a person, not this automation';

-- Constraint drift: lib/ap-auto-entry.ts has written outcome='skipped_duplicate'
-- since the cross-source duplicate guard shipped, but the original check
-- constraint (migration 145) never listed it — so every one of those audit
-- rows was silently rejected and the attachment got re-processed next run.
alter table ap_auto_entry_log drop constraint if exists ap_auto_entry_log_outcome_check;
alter table ap_auto_entry_log add constraint ap_auto_entry_log_outcome_check
  check (outcome in ('posted','flagged','skipped_not_invoice','skipped_duplicate','error'));
