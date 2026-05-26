-- ═══════════════════════════════════════════════════════════════════
-- 021_ap_invoice_attachment_id.sql
-- Per-attachment dedupe for AP inbox pulls.
--
-- Today ap_invoices.graph_message_id is the unique key — one invoice
-- per email. That breaks when a single email arrives with multiple PDFs
-- (or images), each a separate supplier invoice. We now want every
-- attachment to become its own row, so the dedupe key has to widen to
-- include the Graph attachment id.
--
-- Legacy rows keep graph_attachment_id = NULL and their existing
-- message-level uniqueness is preserved via a partial unique index on
-- graph_message_id WHERE graph_attachment_id IS NULL. New rows get the
-- attachment id populated and dedupe against the composite index below.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE ap_invoices
  ADD COLUMN IF NOT EXISTS graph_attachment_id TEXT;

-- Composite uniqueness for rows that have both fields populated
-- (i.e. everything ingested after this migration). Two attachments from
-- the same email get distinct attachment ids, so collisions only happen
-- on a genuine retry of the same attachment.
CREATE UNIQUE INDEX IF NOT EXISTS ap_invoices_graph_msg_att_unique
  ON ap_invoices (graph_message_id, graph_attachment_id)
  WHERE graph_message_id IS NOT NULL AND graph_attachment_id IS NOT NULL;

-- Preserve the original "one row per email" guarantee for legacy rows
-- that pre-date this migration (graph_attachment_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS ap_invoices_graph_msg_legacy_unique
  ON ap_invoices (graph_message_id)
  WHERE graph_message_id IS NOT NULL AND graph_attachment_id IS NULL;
