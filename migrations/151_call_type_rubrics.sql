-- 151_call_type_rubrics.sql
--
-- Per-call-type coaching + portal-side analysis groundwork.
--
-- 1. coaching_rubrics.call_types — a rubric may now define call TYPES, each
--    with its own dimension set (id/label/weight/description/anchors) and a
--    scoreable flag. The analyser classifies the call's type first, then
--    scores against that type's dimensions. Non-scoreable types (suppliers,
--    personal, wrong numbers) are classified but never scored, so they stop
--    polluting coaching averages. Rubrics without call_types (v1-v3) keep
--    the single global dimension set.
--
-- 2. call_analysis.call_type + confidence — what the classifier decided.
--
-- 3. call_advisor_roster — name/alias → Slack id + extension map used by the
--    portal analyser to turn a transcript self-introduction ("you're speaking
--    with Kaleb") into calls.effective_advisor_* attribution. Extensions are
--    shared across staff (hot-desking), so the transcript is the source of
--    truth and the extension only a hint.

alter table coaching_rubrics
  add column if not exists call_types jsonb;

alter table call_analysis
  add column if not exists call_type text,
  add column if not exists call_type_confidence numeric;

create index if not exists idx_call_analysis_call_type on call_analysis (call_type);

create table if not exists call_advisor_roster (
  id uuid primary key default gen_random_uuid(),
  name text not null,                    -- canonical display name ("Kaleb")
  aliases text[] not null default '{}',  -- other names heard on calls ("Dominic" for Dom)
  slack_user_id text,                    -- joins calls.effective_advisor_slack_user_id
  extensions text[] not null default '{}', -- usual extensions (hint only — shared desks)
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table call_advisor_roster enable row level security;

-- Portal reads/writes via service role only (same model as the other call tables).
