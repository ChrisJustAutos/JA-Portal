-- 143_agent_findings.sql
--
-- Shared "agents" framework store. Each monitoring agent (comms / accounts /
-- marketing / ops) produces FINDINGS into a single inbox; agent_runs is the
-- per-run audit trail. Mirrors the dedupe + RLS-on/service-role-only pattern
-- used elsewhere (stocktake_uploads, ap_statement_scans).

create table if not exists agent_findings (
  id               uuid primary key default gen_random_uuid(),
  agent            text not null,                 -- comms | accounts | marketing | ops
  kind             text not null,                 -- machine code, e.g. 'graph_sub_error'
  severity         text not null default 'info',  -- info | warn | action
  confidence       text,                          -- high | medium | low
  title            text not null,
  body             text,
  href             text,
  suggested_action jsonb,                          -- a proposed action (executed on approval)
  status           text not null default 'new',   -- new | auto_done | awaiting_approval | approved | dismissed | done
  dedupe_key       text,
  payload          jsonb,
  decided_by       uuid,
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One open finding per (agent, dedupe_key); re-runs update in place.
create unique index if not exists agent_findings_dedupe_uidx
  on agent_findings (agent, dedupe_key) where dedupe_key is not null;
create index if not exists agent_findings_status_idx on agent_findings (status, created_at desc);
create index if not exists agent_findings_agent_idx  on agent_findings (agent, created_at desc);

create table if not exists agent_runs (
  id             uuid primary key default gen_random_uuid(),
  agent          text not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  ok             boolean,
  findings_count int default 0,
  error          text,
  detail         jsonb
);
create index if not exists agent_runs_agent_idx on agent_runs (agent, started_at desc);

alter table agent_findings enable row level security;
alter table agent_runs     enable row level security;
