-- 160_call_concerns_gates.sql
-- Channel gates (Chris 2026-07-13): don't post when the customer was booked
-- in during the call (issue has an owner + date), and only tune/workshop-work
-- issues post — product/part faults are recorded silently.
alter table call_concerns add column if not exists issue_type text;
alter table call_concerns add column if not exists booked_in boolean not null default false;
