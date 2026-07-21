-- 170: Live inventory tracking — load cell + HX711 + ESP32 modules weigh
-- parts bins; the portal converts grams -> units via per-bin unit weight.
-- Calibration lives SERVER-side (devices post raw counts): zero_offset_raw
-- set by the Tare button, grams_per_raw by known-weight calibration, so
-- everything is configurable from the portal without reflashing.
-- Applied to prod 2026-07-22.

create table if not exists scale_devices (
  id           uuid primary key default gen_random_uuid(),
  device_key   uuid not null unique default gen_random_uuid(),  -- flashed into the ESP32
  name         text not null,
  location     text,
  firmware     text,
  rssi         int,
  last_seen_at timestamptz,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists scale_bins (
  id               uuid primary key default gen_random_uuid(),
  device_id        uuid not null references scale_devices(id) on delete cascade,
  channel          int not null default 0,          -- HX711 channel / cell index on the module
  bin_number       text,
  part_number      text,
  part_name        text,
  unit_weight_g    numeric,                          -- grams per unit; null until set
  zero_offset_raw  numeric not null default 0,       -- raw counts with the bin EMPTY (tare)
  grams_per_raw    numeric,                          -- calibration factor; null until calibrated
  alert_min_units  int,
  -- live snapshot (updated on every ingest)
  last_raw         numeric,
  last_grams       numeric,
  last_units       numeric,
  last_reading_at  timestamptz,
  created_at       timestamptz not null default now(),
  unique (device_id, channel)
);

create table if not exists scale_readings (
  id         bigserial primary key,
  bin_id     uuid not null references scale_bins(id) on delete cascade,
  raw        numeric not null,
  grams      numeric,
  units      numeric,
  created_at timestamptz not null default now()
);
create index if not exists idx_scale_readings_bin_time on scale_readings (bin_id, created_at desc);

alter table scale_devices enable row level security;
alter table scale_bins enable row level security;
alter table scale_readings enable row level security;
-- No policies: service-role APIs only.
