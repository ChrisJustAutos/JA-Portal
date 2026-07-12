-- 157_call_concerns_genuine.sql
-- Routing rework: only GENUINE our-work issues post to Slack + get the
-- follow-up chase. Non-genuine detections (advice requests, status chases)
-- are still recorded (genuine=false, followup_status='dismissed') for later
-- review but make no noise.
alter table call_concerns add column if not exists genuine boolean not null default true;
alter table call_concerns add column if not exists confidence text;
update call_concerns set genuine = false where followup_status = 'dismissed';
