-- 197_leave_decision_emails.sql
-- Emails the applicant when their leave application on the Monday board
-- "Payroll & Leave Applications" (5027074711) is Approved or Denied.
--
-- Two tables:
--
--  leave_staff_directory  name-as-typed-on-the-board -> email. The board's
--    Email Address column is only filled when someone uses the Leave Request
--    form; managers hand-create most rows ("Callan O", "Dan O", "Terry") with
--    no address at all, so without a directory the automation would silently
--    do nothing on most approvals. Editable in Settings -> Leave Notifications.
--    match_key is the normalised form the resolver looks up (lower-cased,
--    punctuation stripped, whitespace collapsed).
--
--  leave_decision_emails  one row per (item, decision) — the dedupe key AND
--    the audit trail. status:
--      baseline    seeded on the very first run for everything already decided,
--                  so going live doesn't email 100+ historical applications
--      sent        the applicant was emailed
--      no_address  couldn't resolve an address; retried every run (HR may add
--                  one to the column or the directory), HR notified once
--      failed      resolved, but the send threw; retried every run
create table if not exists leave_staff_directory (
  id          uuid primary key default gen_random_uuid(),
  match_name  text not null,                    -- as typed on the board
  match_key   text not null,                    -- normalised lookup key
  email       text not null,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists lsd_key_uq on leave_staff_directory (match_key);

create table if not exists leave_decision_emails (
  id              uuid primary key default gen_random_uuid(),
  monday_item_id  text not null,
  decision        text not null check (decision in ('approved','denied')),
  applicant_name  text,
  email_to        text,
  email_source    text,                         -- 'column' | 'directory'
  status          text not null check (status in ('baseline','sent','no_address','failed')),
  error           text,
  leave_start     date,
  leave_end       date,
  classification  text,
  total_days      text,
  attempts        integer not null default 0,
  hr_notified_at  timestamptz,                  -- "no address for X" notice sent
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists lde_item_decision_uq on leave_decision_emails (monday_item_id, decision);
create index if not exists lde_status_idx on leave_decision_emails (status);
create index if not exists lde_created_idx on leave_decision_emails (created_at desc);

-- Seed the directory from the people who already exist in monday.com and the
-- portal, including the short forms the board actually uses ("Chris R",
-- "Tyronne W"). Deliberately NO bare "matt" key — Matt Huddy and Matt Smith
-- would be ambiguous, and a wrong address is worse than no address.
-- Callan O and Dan O have no known email; they'll surface in the unresolved
-- list for HR to add.
insert into leave_staff_directory (match_name, match_key, email, note) values
  ('Christopher Russell', 'christopher russell', 'chris@justautosmechanical.com.au',   'seeded from monday.com'),
  ('Chris Russell',       'chris russell',       'chris@justautosmechanical.com.au',   'seeded'),
  ('Chris R',             'chris r',             'chris@justautosmechanical.com.au',   'board short form'),
  ('Morgan Wickham',      'morgan wickham',      'morgan@justautosmechanical.com.au',  'seeded from monday.com'),
  ('Morgan',              'morgan',              'morgan@justautosmechanical.com.au',  'board short form'),
  ('Ryan Doodson',        'ryan doodson',        'ryan@justautosmechanical.com.au',    'seeded from monday.com'),
  ('Ryan D',              'ryan d',              'ryan@justautosmechanical.com.au',    'board short form'),
  ('Ryan',                'ryan',                'ryan@justautosmechanical.com.au',    'board short form'),
  ('James Wilson',        'james wilson',        'james@justautosmechanical.com.au',   'seeded from monday.com'),
  ('James',               'james',               'james@justautosmechanical.com.au',   'board short form'),
  ('Tyronne Wright',      'tyronne wright',      'tyronne@justautosmechanical.com.au', 'seeded from monday.com'),
  ('Tyronne W',           'tyronne w',           'tyronne@justautosmechanical.com.au', 'board short form'),
  ('Tyronne',             'tyronne',             'tyronne@justautosmechanical.com.au', 'board short form'),
  ('Matt Smith',          'matt smith',          'tuning@justautosmechanical.com.au',  'seeded from monday.com'),
  ('Matt S',              'matt s',              'tuning@justautosmechanical.com.au',  'board short form'),
  ('Matt Huddy',          'matt huddy',          'matt.h@justautosmechanical.com.au',  'seeded from monday.com'),
  ('Matt H',              'matt h',              'matt.h@justautosmechanical.com.au',  'board short form'),
  ('Laura Smith',         'laura smith',         'laura.d.smith4@gmail.com',           'seeded from monday.com'),
  ('Laura',               'laura',               'laura.d.smith4@gmail.com',           'board short form'),
  ('Caylum Flack',        'caylum flack',        'caylum@justautosmechanical.com.au',  'seeded from monday.com'),
  ('Caylum',              'caylum',              'caylum@justautosmechanical.com.au',  'board short form'),
  ('Kaleb Rowe',          'kaleb rowe',          'kaleb@justautosmechanical.com.au',   'seeded from monday.com'),
  ('Kaleb',               'kaleb',               'kaleb@justautosmechanical.com.au',   'board short form'),
  ('Sam Perry',           'sam perry',           'sam@justautosmechanical.com.au',     'seeded from monday.com'),
  ('Sam',                 'sam',                 'sam@justautosmechanical.com.au',     'board short form'),
  ('Dom Simpson',         'dom simpson',         'dom@justautosmechanical.com.au',     'seeded from monday.com'),
  ('Dom',                 'dom',                 'dom@justautosmechanical.com.au',     'board short form'),
  ('Terry Evans',         'terry evans',         'terry@justautosmechanical.com.au',   'seeded from monday.com'),
  ('Terry',               'terry',               'terry@justautosmechanical.com.au',   'board short form'),
  ('Graham Roy',          'graham roy',          'graham@justautosmechanical.com.au',  'seeded from monday.com'),
  ('Graham',              'graham',              'graham@justautosmechanical.com.au',  'board short form'),
  ('Micheal Murphy',      'micheal murphy',      'micheal@justautosmechanical.com.au', 'seeded from monday.com'),
  ('Micheal',             'micheal',             'micheal@justautosmechanical.com.au', 'board short form'),
  ('Jarred',              'jarred',              'jarred@justautosmechanical.com.au',  'seeded from monday.com')
on conflict (match_key) do nothing;
