-- 201_jaws_stock_eom_slow_capital.sql
--
-- JAWS Stock EOM, second pass (Chris, 2026-08-25):
--   • Stock that has NEVER sold is excluded from the ageing, dead-stock and
--     slow-mover figures. On this item list it is almost always a kit component
--     that is never sold separately, and it dominated the dead-stock number
--     ($47.6k of July's $114.7k) with no action attached. The count and value
--     stay in the headline so the capital is visible, never silently dropped.
--   • Slow movers are now a CAPITAL measure, not just silence: a SKU joins the
--     list when nothing sold in the 90 days to month end, OR it still sells but
--     holds >180 days of cover with ≥$2,000 tied up beyond a 90-day target.
--     Ranked by "capital at risk" — value held beyond 90 days of its own demand.

alter table jaws_stock_snapshots
  add column if not exists slow_count   integer,
  add column if not exists slow_capital numeric;

comment on column jaws_stock_snapshots.slow_capital is
  'Capital at risk across the slow-mover list — value held beyond 90 days of each SKU''s own demand. Not comparable with dead_90_value, which is whole stock value.';

comment on column jaws_stock_snapshots.never_sold_value is
  'Held value that has never been invoiced. EXCLUDED from dead/slow/ageing figures from 2026-08-25 — on this item list it is almost always a kit component never sold separately.';
