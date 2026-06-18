-- 133_md_prepick_on_order.sql
-- Add "on order" (incoming on open MD purchase orders) to each Pre Pick part.
-- Sourced from the MD stock-detail endpoint /stocks/{id}.ordered_quantity; the
-- open-PO lines behind it come from that same response's current_purchase_items
-- (stored raw for the click-through drill-down).

alter table public.md_prepick_items add column if not exists on_order        numeric(12,2) not null default 0;
alter table public.md_prepick_items add column if not exists on_order_detail jsonb;
