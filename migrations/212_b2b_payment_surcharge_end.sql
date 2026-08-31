-- 212_b2b_payment_surcharge_end.sql
--
-- Scheduled end of ALL payment surcharges (card, PayTo and BECS alike).
-- Chris, 2026-08-31: "the Card surcharge in b2b portal needs to be turned off
-- 1st October", extended to every method on his answer.
--
-- A date rather than someone remembering to zero the settings on the morning.
-- On and after this date every surcharge computation returns 0 - cart estimate,
-- checkout, and the MYOB documents that follow from them - and the underlying
-- card_fee_percent / card_fee_fixed values are left untouched, so the change is
-- reversible by clearing the date rather than by retyping the old rates.
--
-- NULL = no end date, surcharges apply as configured.

alter table public.b2b_settings
  add column if not exists payment_surcharge_ends_on date;

comment on column public.b2b_settings.payment_surcharge_ends_on is
  'Date (Brisbane) from which ALL payment surcharges stop - card, PayTo and BECS. NULL means no end date. Set 2026-10-01 per Chris 2026-08-31.';

update public.b2b_settings
   set payment_surcharge_ends_on = date '2026-10-01'
 where id = 'singleton';
