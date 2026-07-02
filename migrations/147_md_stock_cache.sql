-- 147_md_stock_cache.sql
--
-- Parts-bot stock cache. A GitHub-Actions worker (scripts/pull-md-stock.ts)
-- pages MechanicDesk's /stocks.json every ~30 min and replaces this table.
-- The Slack bot's search_md_stock tool reads it so front-counter parts queries
-- ("how many VDJ79 airboxes do we have?") answer instantly, without touching
-- MD at query time (no single-session collision, no scrape latency).
--
-- MD has no API — this cache is the only fast, collision-free way to answer.

create table if not exists md_stock_cache (
  stock_number   text primary key,          -- SKU (MD stock_number)
  md_stock_id    bigint,
  name           text not null default '',
  on_hand        numeric not null default 0, -- total system QTY
  available      numeric not null default 0, -- free-to-sell (on-hand − allocated)
  allocated      numeric not null default 0, -- committed to jobs
  on_order       numeric,                    -- incoming on open POs (null if MD list omits)
  alert_qty      numeric,                    -- MD reorder-alert threshold (null if omitted)
  buy_price      numeric,
  sell_price     numeric,
  bin            text,
  location       text,
  synced_at      timestamptz not null default now()
);

-- Trigram fuzzy search over SKU + name (matches the workshop_search approach).
create extension if not exists pg_trgm;
create index if not exists md_stock_cache_name_trgm on md_stock_cache using gin (name gin_trgm_ops);
create index if not exists md_stock_cache_sku_trgm  on md_stock_cache using gin (stock_number gin_trgm_ops);

-- One row per sync so the bot can say "synced X min ago" and we can watch health.
create table if not exists md_stock_sync_runs (
  id           uuid primary key default gen_random_uuid(),
  status       text not null default 'running',  -- running | done | error
  item_count   integer not null default 0,
  error        text,
  started_at   timestamptz not null default now(),
  completed_at timestamptz,
  requested_by text
);

create index if not exists md_stock_sync_runs_started_idx on md_stock_sync_runs (started_at desc);

-- Service-role only (worker ingest + server-side tool read via service key).
alter table md_stock_cache     enable row level security;
alter table md_stock_sync_runs enable row level security;
