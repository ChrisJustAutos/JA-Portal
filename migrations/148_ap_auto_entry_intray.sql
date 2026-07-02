-- 148_ap_auto_entry_intray.sql
-- Generalise the auto-entry dedup/audit log for a SECOND source: the MYOB In
-- Tray (documents uploaded to MYOB waiting to become bills), alongside the
-- accounts email inbox. Email rows dedup on (graph_message_id, graph_attachment_id);
-- In Tray rows dedup on intray_doc_uid.

alter table ap_auto_entry_log
  add column if not exists source         text not null default 'email',
  add column if not exists intray_doc_uid text;

-- Email ids no longer apply to In Tray rows.
alter table ap_auto_entry_log alter column graph_message_id    drop not null;
alter table ap_auto_entry_log alter column graph_attachment_id drop not null;

-- Replace the old NOT NULL unique constraint with source-scoped partial uniques.
alter table ap_auto_entry_log drop constraint if exists ap_auto_entry_log_graph_message_id_graph_attachment_id_key;
create unique index if not exists ap_auto_entry_log_graph_uniq
  on ap_auto_entry_log (graph_message_id, graph_attachment_id) where graph_message_id is not null;
create unique index if not exists ap_auto_entry_log_intray_uniq
  on ap_auto_entry_log (intray_doc_uid) where intray_doc_uid is not null;
