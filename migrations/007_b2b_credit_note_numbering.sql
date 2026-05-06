-- B2B credit-note numbering: separate prefix/padding/sequence so credit notes
-- get their own stream (default "CR000001", "CR000002", ...) instead of consuming
-- slots from the invoice sequence.
--
-- Applied to Supabase project qtiscbvhlvdvafwtdtcd via apply_migration on
-- 2026-05-07. This file is the tracked copy.

alter table public.b2b_settings
  add column if not exists myob_credit_note_number_prefix  text    default 'CR',
  add column if not exists myob_credit_note_number_padding integer default 6,
  add column if not exists myob_credit_note_number_seq     integer default 0;

-- Backfill the singleton row in case the defaults didn't apply (existing row pre-dates the columns).
update public.b2b_settings
   set myob_credit_note_number_prefix  = coalesce(myob_credit_note_number_prefix,  'CR'),
       myob_credit_note_number_padding = coalesce(myob_credit_note_number_padding, 6),
       myob_credit_note_number_seq     = coalesce(myob_credit_note_number_seq,     0)
 where id = 'singleton';

-- Allocator: row-level locked increment + read-back, mirroring b2b_next_myob_invoice_number.
create or replace function public.b2b_next_myob_credit_note_number()
returns text
language plpgsql
as $function$
declare
  v_prefix  text;
  v_padding integer;
  v_seq     integer;
  v_number  text;
begin
  update b2b_settings
     set myob_credit_note_number_seq = coalesce(myob_credit_note_number_seq, 0) + 1
   where id = 'singleton'
  returning
    coalesce(myob_credit_note_number_prefix,  'CR'),
    coalesce(myob_credit_note_number_padding, 6),
    myob_credit_note_number_seq
  into v_prefix, v_padding, v_seq;

  if v_seq is null then
    raise exception 'b2b_settings singleton row missing';
  end if;
  if v_padding < 1 or v_padding > 12 then
    raise exception 'Invalid credit note number padding: %', v_padding;
  end if;

  v_number := v_prefix || lpad(v_seq::text, v_padding, '0');

  if length(v_number) > 13 then
    raise exception 'Generated credit note number "%" exceeds MYOB''s 13-char limit (prefix="%", padding=%)',
      v_number, v_prefix, v_padding;
  end if;

  return v_number;
end;
$function$;

-- Preview helper (stable, no side effects).
create or replace function public.b2b_preview_next_myob_credit_note_number()
returns text
language sql
stable
as $function$
  select coalesce(myob_credit_note_number_prefix, 'CR')
       || lpad((coalesce(myob_credit_note_number_seq, 0) + 1)::text,
               coalesce(myob_credit_note_number_padding, 6),
               '0')
  from b2b_settings
  where id = 'singleton';
$function$;
