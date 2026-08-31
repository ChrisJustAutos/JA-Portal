-- 214 — B2B: ONE number for the portal order and the MYOB document.
--
-- THE PROBLEM
-- Two independent sequences were running, so nothing cross-referenced:
--
--   * the portal order number — `b2b_orders.order_number`, defaulted from
--     b2b_next_order_number(): 'B2B-' || YYYY || '-' || nextval(b2b_order_seq)
--     → B2B-2026-000057. Advances on EVERY order, including the ones that are
--     abandoned at the payment screen or cancelled.
--   * the MYOB document number — b2b_next_myob_invoice_number(), which
--     increments b2b_settings.myob_invoice_number_seq (prefix JAWSB2B,
--     padding 4) → JAWSB2B0065. Advances only when a MYOB write succeeds,
--     AND is also consumed by lib/b2b-stock-transfer.ts for the VPS↔JAWS
--     intercompany transfers.
--
-- Live drift when this was written: B2B-2026-000057 → JAWSB2B0065,
-- B2B-2026-000050 → JAWSB2B0059, B2B-2026-000049 → JAWSB2B0055. Anything
-- from 6 to 9 out, so staff had to look an order up to translate between the
-- number the distributor quotes and the number MYOB and accounts quote.
--
-- THE FIX
-- The portal order number IS the MYOB number, allocated once at order
-- creation and posted verbatim as the MYOB `Number` field.
--
--   order_number = 'JAWSB2B' || lpad(nextval('b2b_order_seq'), 4, '0')
--                = JAWSB2B0100
--
-- WHY 4 DIGITS AND NOT 6 — two hard caps stack up:
--   * MYOB's Number field is 13 characters. Full stop.
--   * lib/b2b-dropship.ts stamps our number on the SUPPLIER purchase order,
--     and one order can drop-ship from several suppliers, so suppliers 2..n
--     get a '-2', '-3' suffix and the whole thing is then .slice(0, 13).
--     A 13-character base ('JAWSB2B000100') would have had the suffix sliced
--     clean off, handing supplier 2 a PO number IDENTICAL to supplier 1's —
--     MYOB rejects the duplicate and falls back to its own meaningless
--     sequential numbering, which is the exact behaviour that feature exists
--     to remove.
--   'JAWSB2B' + 4 digits = 11 characters, leaving exactly 2 for '-2'..'-9'.
--   It also keeps the JAWSB2B00NN shape staff already read off MYOB.
--
-- WHY THE SEQUENCE JUMPS TO 100
-- MYOB's register already holds JAWSB2B0048–JAWSB2B0065 (sales) and the
-- transfers listed below. Continuing the portal sequence from 62 would make
-- the unified series appear to run BACKWARDS against numbers already filed.
-- setval(99) starts it at JAWSB2B0100: clear of everything, with a visible
-- gap that marks where the unified series begins.
--
-- HISTORY IS NOT REWRITTEN. Existing order_numbers stay B2B-2026-0000NN and
-- keep their separate MYOB numbers. lib/b2b-myob-invoice.ts only posts
-- order_number as the MYOB Number when it matches /^JAWSB2B\d{4}$/, so the
-- legacy pending_payment orders (B2B-2026-000053 / 000054 — 15 characters,
-- which MYOB would reject outright) still go through
-- b2b_next_myob_invoice_number(). That guard also makes the
-- deploy-vs-migration ordering irrelevant.
--
-- STOCK TRANSFERS MOVE OFF THE SHARED ALLOCATOR (see below) — they have to,
-- or they collide with the sale series.
--
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd via apply_migration.


-- ─── 1. The unified order/MYOB number ───────────────────────────────────

create or replace function public.b2b_next_order_number()
returns text
language plpgsql
as $function$
declare
  v_seq    bigint;
  v_number text;
begin
  v_seq := nextval('public.b2b_order_seq');

  -- lpad TRUNCATES when the value is longer than the width:
  -- lpad('10000', 4, '0') = '1000'. Left alone, order 10000 would silently
  -- mint JAWSB2B1000 — a duplicate of order 1000 — and checkout would then
  -- die on the order_number unique constraint with no clue why. Refuse
  -- instead: widening the format is a deliberate decision, because
  -- 'JAWSB2B' + 5 digits = 12 chars leaves only 1 char for the drop-ship
  -- '-n' suffix (lib/b2b-dropship.ts) and MYOB's cap is 13.
  if v_seq > 9999 then
    raise exception
      'b2b_order_seq has reached % — the JAWSB2B#### format is full. Widen it deliberately: MYOB caps Number at 13 chars and lib/b2b-dropship.ts needs 2 of them for the multi-supplier "-n" suffix.',
      v_seq;
  end if;

  v_number := 'JAWSB2B' || lpad(v_seq::text, 4, '0');

  if length(v_number) > 13 then
    raise exception 'Generated order number "%" exceeds MYOB''s 13-char limit', v_number;
  end if;

  return v_number;
end;
$function$;

-- Next order = JAWSB2B0100. (Live last_value was 61; MYOB holds up to 0065.)
select setval('public.b2b_order_seq', 99, true);


-- ─── 2. Stock transfers get their OWN number stream ─────────────────────
--
-- lib/b2b-stock-transfer.ts consumed b2b_next_myob_invoice_number(), which
-- is precisely what caused the drift (65 numbers issued against 57 orders).
-- 24 transfers have already gone through it, wearing JAWSB2B0016 … JAWSB2B0064.
--
-- With sales now numbered from the ORDER sequence, a shared allocator becomes
-- an active collision risk: b2b_settings.myob_invoice_number_seq sits at 65
-- and would reach 0100 after only 35 more transfers. 'JAWSTFR' shares no
-- prefix with 'JAWSB2B', so collision is impossible by construction.
--
-- The 24 existing transfers keep the JAWSB2B numbers they were filed under —
-- nothing is rewritten. Transfer 25 onward reads JAWSTFR0001, JAWSTFR0002, …
-- (accounts will see the format change).

alter table public.b2b_settings
  add column if not exists myob_transfer_number_prefix  text    default 'JAWSTFR',
  add column if not exists myob_transfer_number_padding integer default 4,
  add column if not exists myob_transfer_number_seq     integer default 0;

-- Backfill the singleton row in case the defaults didn't apply (the row
-- pre-dates the columns).
update public.b2b_settings
   set myob_transfer_number_prefix  = coalesce(myob_transfer_number_prefix,  'JAWSTFR'),
       myob_transfer_number_padding = coalesce(myob_transfer_number_padding, 4),
       myob_transfer_number_seq     = coalesce(myob_transfer_number_seq,     0)
 where id = 'singleton';

-- Allocator: row-level locked increment + read-back, modelled exactly on
-- b2b_next_myob_invoice_number() / b2b_next_myob_credit_note_number().
create or replace function public.b2b_next_myob_transfer_number()
returns text
language plpgsql
as $function$
declare
  v_prefix  text;
  v_padding integer;
  v_seq     integer;
  v_number  text;
begin
  -- Increment + read-back in one statement (Postgres serialises this row-level)
  update b2b_settings
     set myob_transfer_number_seq = coalesce(myob_transfer_number_seq, 0) + 1
   where id = 'singleton'
  returning
    coalesce(myob_transfer_number_prefix,  'JAWSTFR'),
    coalesce(myob_transfer_number_padding, 4),
    myob_transfer_number_seq
  into v_prefix, v_padding, v_seq;

  if v_seq is null then
    raise exception 'b2b_settings singleton row missing';
  end if;
  if v_padding < 1 or v_padding > 12 then
    raise exception 'Invalid transfer number padding: %', v_padding;
  end if;

  -- greatest(...) instead of a bare lpad: lpad TRUNCATES a value longer than
  -- the width (lpad('10000',4,'0') = '1000'), which would silently mint a
  -- duplicate of transfer 1000 AND still pass the 13-char guard below. Growing
  -- to 5 digits is harmless here — JAWSTFR10000 is 12 characters.
  v_number := v_prefix || lpad(v_seq::text, greatest(v_padding, length(v_seq::text)), '0');

  if length(v_number) > 13 then
    raise exception 'Generated transfer number "%" exceeds MYOB''s 13-char limit (prefix="%", padding=%)',
      v_number, v_prefix, v_padding;
  end if;

  return v_number;
end;
$function$;

-- Preview helper (stable, no side effects) — mirrors the invoice/credit-note ones.
create or replace function public.b2b_preview_next_myob_transfer_number()
returns text
language sql
stable
as $function$
  select coalesce(myob_transfer_number_prefix, 'JAWSTFR')
       || lpad((coalesce(myob_transfer_number_seq, 0) + 1)::text,
               greatest(coalesce(myob_transfer_number_padding, 4),
                        length((coalesce(myob_transfer_number_seq, 0) + 1)::text)),
               '0')
  from b2b_settings
  where id = 'singleton';
$function$;


-- ─── 3. Keep intercompany transfers out of JAWS reporting ───────────────
--
-- The Management Dashboard excludes B2B intercompany journals from JAWS
-- revenue/GP by matching the GL "ID No." against the configured
-- exclusions.invoiceNumberPattern, which is the literal 'B2B'. Sale numbers
-- stay JAWSB2B#### so they still match — but a JAWSTFR#### transfer would
-- NOT, leaving it to the memoPattern arm alone ('Stock transfer.*JA Portal').
-- That arm should catch it, but it depends on MYOB propagating our
-- JournalMemo onto every GL line, so widen the ID arm too rather than betting
-- the intercompany exclusion on one untested assumption.

update public.mgmt_dashboard_charts
   set config = jsonb_set(config, '{exclusions,invoiceNumberPattern}', '"B2B|JAWSTFR"')
 where config -> 'exclusions' ->> 'invoiceNumberPattern' = 'B2B';
