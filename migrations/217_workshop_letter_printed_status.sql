-- 217 — workshop letters: mark them PRINTED when they actually print.
--
-- THE PROBLEM
-- Chris, 2026-09-02: "Letter section has quite a few queued letters. Why's
-- that?" — 368 of them, going back to 24 June.
--
-- They were not stuck. `workshop_letter_jobs.status` is only ever written as
-- 'queued' (on create), 'failed' (on a render/queue error) or 'skipped'
-- (deposits and non-job invoices the poller deliberately ignores). There has
-- never been a PRINTED state. The actual printing happens on child rows in
-- `label_print_jobs` (one letter + one envelope), and the print agent — which
-- talks to Supabase directly, so there is no API route to hook — marks its own
-- rows 'done' and never touches the parent. So "queued" only ever meant
-- "handed to the printer", and every letter since June piled up looking
-- outstanding.
--
-- Proven before changing anything: of the 368, **338 have a matching
-- label_print_jobs row already at 'done'** and 30 have one at 'failed'. The
-- failures are all 24 June – 13 July, the window when letters printed from the
-- MSI laptop and it was off-network; nothing has failed since the move to
-- PORTAL-CENTRE on 13 July.
--
-- THE FIX
--   1. printed_at column.
--   2. Backfill the 338 to 'printed', stamped with the print job's own
--      printed_at, not now() — the history should read when it printed.
--   3. Backfill the 30 to 'written_off' (Chris: "Write them off, too old").
--      The row is kept for the audit trail but drops out of the default list
--      alongside 'skipped'.
--   4. A TRIGGER so this cannot drift again. The agent writes to the database
--      directly, so a database trigger is the only place that catches every
--      path — a Next route would miss it entirely.
--
-- The letters page already renders 'printed' green (pages/workshop/letters.tsx
-- statusColor), so the UI has been waiting for this value all along.
--
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd via apply_migration.

alter table public.workshop_letter_jobs
  add column if not exists printed_at timestamptz;

-- 1. Already printed → 'printed', with the real print time.
update public.workshop_letter_jobs w
   set status = 'printed',
       printed_at = p.printed_at
  from public.label_print_jobs p
 where p.storage_path = w.letter_storage_path
   and p.kind = 'letter'
   and p.status = 'done'
   and w.status = 'queued';

-- 2. Print failed and too old to chase → written off.
update public.workshop_letter_jobs w
   set status = 'written_off',
       error = coalesce(w.error, 'print failed 24 Jun - 13 Jul (MSI laptop off-network); written off 2026-09-02 as too old to reprint')
  from public.label_print_jobs p
 where p.storage_path = w.letter_storage_path
   and p.kind = 'letter'
   and p.status = 'failed'
   and w.status = 'queued';

-- 3. Keep it correct from here.
create or replace function public.mark_letter_printed()
returns trigger
language plpgsql
as $function$
begin
  -- Only on the transition INTO 'done', and only for the letter itself: the
  -- envelope is a second print row against the same letter and must not flip
  -- the parent on its own.
  if new.kind = 'letter' and new.status = 'done' and old.status is distinct from 'done' then
    update public.workshop_letter_jobs
       set status = 'printed',
           printed_at = coalesce(new.printed_at, now())
     where letter_storage_path = new.storage_path
       and status = 'queued';
  end if;
  return new;
end;
$function$;

drop trigger if exists label_print_jobs_mark_letter_printed on public.label_print_jobs;
create trigger label_print_jobs_mark_letter_printed
after update on public.label_print_jobs
for each row execute function public.mark_letter_printed();
