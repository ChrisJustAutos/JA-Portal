// lib/b2b-reminders.ts
// SERVER-ONLY. The three B2B nudges, driven by pages/api/cron/b2b-reminders.ts.
//
//   1. Abandoned cart      → distributor. 24h after the cart was last touched,
//                            and again at 72h. Then silence.
//   2. Checkout unfinished → distributor. Once, 24h after a checkout was
//                            started and never paid.
//   3. Stalled order       → US. A paid order that hasn't shipped after 2 days,
//                            escalating once more at 5.
//
// Everything here is best-effort and idempotent: a pass that throws is logged
// and the others still run, and re-running the cron sends nothing twice.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { sendMail } from './email'
import { getFromMailbox } from './b2b-settings'
import { renderEmail, linesTableHtml, buttonHtml } from './email-templates'
import { hasUnusableEmail } from './email-recipients'

const BASE_URL = process.env.B2B_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || process.env.JA_PORTAL_BASE_URL || 'https://justautos.app'

// Hours/days after which each nudge fires. Deliberately constants in one place:
// changing the cadence is a code edit, but the WORDING is editable in the
// portal (Admin → B2B → Email templates), which is what actually gets tweaked.
const CART_FIRST_HOURS = 24
const CART_FINAL_HOURS = 72
// Past this a cart isn't a live opportunity, it's furniture — and "freight was
// quoted more than 24 hours ago" reads absurdly against a cart from last month.
const CART_MAX_AGE_DAYS = 14
const CHECKOUT_HOURS   = 24
const STALL_DAYS       = 2
const STALL_ESCALATE_DAYS = 5

let _sb: SupabaseClient | null = null
function svc(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}
function money(n: any): string { const v = Number(n); return Number.isFinite(v) ? `$${v.toFixed(2)}` : '—' }
function hoursAgo(h: number): string { return new Date(Date.now() - h * 3600_000).toISOString() }
function daysAgo(d: number): string { return new Date(Date.now() - d * 86_400_000).toISOString() }
function plural(n: number, one: string, many = `${one}s`): string { return `${n} ${n === 1 ? one : many}` }

export interface ReminderRun {
  cartFirst: number
  cartFinal: number
  checkout: number
  stalled: number
  skipped: string[]
}

// ---------------------------------------------------------------------------
// 1. Abandoned carts
// ---------------------------------------------------------------------------

/**
 * A cart's "last touched" time comes from its ITEMS, not b2b_carts.updated_at —
 * the cart item routes bump the item rows and leave the cart's own timestamp
 * alone, so trusting the cart would call an actively-used cart abandoned.
 *
 * Comparing the reminder stamp against that same item timestamp is also what
 * re-arms the cycle: touch the cart and the stamp is now older than the newest
 * item, so the cart legitimately becomes a candidate again.
 */
async function sweepCarts(c: SupabaseClient, run: ReminderRun): Promise<void> {
  const { data: carts } = await c
    .from('b2b_carts')
    .select(`
      id, distributor_id, distributor_user_id, reminder_24_at, reminder_72_at,
      distributor:b2b_distributors!b2b_carts_distributor_id_fkey ( display_name, primary_contact_email, is_active ),
      items:b2b_cart_items ( id, qty, added_at, updated_at, catalogue:b2b_catalogue ( sku, name ) )
    `)
    .limit(200)

  for (const cart of (carts || []) as any[]) {
    try {
      const items: any[] = Array.isArray(cart.items) ? cart.items : []
      if (items.length === 0) continue        // paid/cleared carts have no lines

      const dist: any = Array.isArray(cart.distributor) ? cart.distributor[0] : cart.distributor
      if (!dist || dist.is_active === false) continue

      // Newest activity on any line — adds, quantity changes, the lot.
      const touchedMs = Math.max(...items.map(i =>
        Math.max(Date.parse(i.updated_at || 0) || 0, Date.parse(i.added_at || 0) || 0)))
      if (!Number.isFinite(touchedMs) || touchedMs <= 0) continue
      const ageHours = (Date.now() - touchedMs) / 3600_000
      if (ageHours > CART_MAX_AGE_DAYS * 24) continue

      // Stage 2 first: past 72h it's the final nudge, not the opening one.
      const sent24 = Date.parse(cart.reminder_24_at || 0) || 0
      const sent72 = Date.parse(cart.reminder_72_at || 0) || 0
      let stage: 'first' | 'final' | null = null
      if (ageHours >= CART_FINAL_HOURS && sent72 < touchedMs) stage = 'final'
      else if (ageHours >= CART_FIRST_HOURS && ageHours < CART_FINAL_HOURS && sent24 < touchedMs) stage = 'first'
      if (!stage) continue

      const to = await cartRecipient(c, cart, dist)
      if (!to) { run.skipped.push(`cart ${cart.id}: no usable email`); continue }

      const linesBlock = linesTableHtml(items.map(it => {
        const cat: any = Array.isArray(it.catalogue) ? it.catalogue[0] : it.catalogue
        return { description: [cat?.sku, cat?.name].filter(Boolean).join(' — ') || 'Item', qty: it.qty }
      }))
      const key = stage === 'final' ? 'distributor_cart_reminder_final' : 'distributor_cart_reminder'
      const r = await renderEmail(key, {
        contact_name: to.name || dist.display_name || 'there',
        distributor_name: dist.display_name || '',
        item_count: plural(items.length, 'item'),
      }, { lines_table: linesBlock, cart_link: buttonHtml('View your cart', `${BASE_URL}/b2b/cart`) })
      if (!r.enabled) continue

      await sendMail(await getFromMailbox(), { to: [to.email], subject: r.subject, html: r.html })
      await c.from('b2b_carts')
        .update(stage === 'final' ? { reminder_72_at: new Date().toISOString() } : { reminder_24_at: new Date().toISOString() })
        .eq('id', cart.id)
      if (stage === 'final') run.cartFinal++; else run.cartFirst++
    } catch (e: any) {
      console.error(`b2b-reminders: cart ${cart?.id} failed:`, e?.message || e)
    }
  }
}

/** The person whose cart it is, if their login is still active; else the distributor's primary contact. */
async function cartRecipient(c: SupabaseClient, cart: any, dist: any): Promise<{ email: string; name: string } | null> {
  if (cart.distributor_user_id) {
    const { data: u } = await c.from('b2b_distributor_users')
      .select('email, full_name, is_active').eq('id', cart.distributor_user_id).maybeSingle()
    if (u?.is_active !== false && u?.email && !hasUnusableEmail(u.email)) {
      return { email: String(u.email).trim(), name: (u.full_name || '').split(' ')[0] || '' }
    }
  }
  const primary = String(dist?.primary_contact_email || '').trim()
  if (primary && !hasUnusableEmail(primary)) return { email: primary, name: dist?.display_name || '' }
  return null
}

// ---------------------------------------------------------------------------
// 2. Checkout started, never paid
// ---------------------------------------------------------------------------

/**
 * One nudge, 24h after an abandoned checkout. Guarded hard, because chasing
 * someone for money they already paid is the worst outcome here:
 *   · Stripe is re-asked directly — if the session actually completed, we say
 *     nothing and flag it instead (the portal's own SOP rule).
 *   · A later PAID order from the same distributor means they simply went
 *     round again (the B2B-2026-000051 → 000052 pattern) — skip.
 *   · Test orders never get chased.
 * The once-only guard is a b2b_order_events row, so no new column is needed.
 */
async function sweepUnfinishedCheckouts(c: SupabaseClient, run: ReminderRun): Promise<void> {
  const { data: orders } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, customer_po, total_inc, created_at, distributor_id,
      stripe_checkout_session_id, stripe_payment_intent_id, is_test,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( display_name, primary_contact_email, is_active )
    `)
    .eq('status', 'pending_payment')
    .lt('created_at', hoursAgo(CHECKOUT_HOURS))
    .is('paid_at', null)
    .limit(50)

  for (const o of (orders || []) as any[]) {
    try {
      if (o.is_test) continue
      const dist: any = Array.isArray(o.distributor) ? o.distributor[0] : o.distributor
      if (!dist || dist.is_active === false) continue

      // Already nudged?
      const { data: prior } = await c.from('b2b_order_events')
        .select('id').eq('order_id', o.id).eq('event_type', 'checkout_reminder_sent').limit(1)
      if (prior && prior.length > 0) continue

      // Did they just go round again and pay? Then this row is a ghost.
      const { data: later } = await c.from('b2b_orders')
        .select('id').eq('distributor_id', o.distributor_id)
        .not('paid_at', 'is', null).gt('created_at', o.created_at).limit(1)
      if (later && later.length > 0) {
        run.skipped.push(`${o.order_number}: a later order was paid`)
        continue
      }

      // Ask Stripe outright rather than trusting our own row.
      if (o.stripe_checkout_session_id) {
        const { retrieveCheckoutSession } = await import('./stripe')
        const s: any = await retrieveCheckoutSession(String(o.stripe_checkout_session_id)).catch(() => null)
        const paid = s && (s.payment_status === 'paid' || s.payment_status === 'processing' || s.status === 'complete')
        if (paid) {
          // Money moved but our row never caught up — a reminder would be wrong
          // AND this needs a human. Record it and leave it alone.
          await c.from('b2b_order_events').insert({
            order_id: o.id, event_type: 'checkout_reminder_skipped', actor_type: 'system', actor_id: null,
            notes: `Not reminded — Stripe reports the checkout session as ${s.payment_status || s.status}. The order row is behind; check before chasing.`,
          }).then(() => {}, () => {})
          run.skipped.push(`${o.order_number}: Stripe says ${s.payment_status || s.status}`)
          continue
        }
      }

      const primary = String(dist.primary_contact_email || '').trim()
      if (!primary || hasUnusableEmail(primary)) { run.skipped.push(`${o.order_number}: no usable email`); continue }

      const { data: lines } = await c.from('b2b_order_lines').select('qty, sku, name').eq('order_id', o.id)
      const linesBlock = linesTableHtml((lines || []).map((l: any) => ({ description: [l.sku, l.name].filter(Boolean).join(' — '), qty: l.qty })))
      const r = await renderEmail('distributor_checkout_unfinished', {
        distributor_name: dist.display_name || '',
        order_number: o.order_number,
        customer_po: o.customer_po ? ` (your PO ${o.customer_po})` : '',
        order_total: money(o.total_inc),
      }, { lines_table: linesBlock, shop_link: buttonHtml('Back to the shop', `${BASE_URL}/b2b/catalogue`) })
      if (!r.enabled) continue

      await sendMail(await getFromMailbox(), { to: [primary], subject: r.subject, html: r.html })
      await c.from('b2b_order_events').insert({
        order_id: o.id, event_type: 'checkout_reminder_sent', actor_type: 'system', actor_id: null,
        notes: `Reminded ${primary} that this checkout was never completed.`,
      }).then(() => {}, () => {})
      run.checkout++
    } catch (e: any) {
      console.error(`b2b-reminders: unfinished checkout ${o?.order_number} failed:`, e?.message || e)
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Paid but not shipped — this one chases US, not the customer
// ---------------------------------------------------------------------------

async function sweepStalledOrders(c: SupabaseClient, run: ReminderRun): Promise<void> {
  const { data: orders } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, total_inc, paid_at, customer_po, is_test,
      machship_consignment_id, machship_manifest_id, dropship_pos,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( display_name )
    `)
    .eq('status', 'paid')
    .lt('paid_at', daysAgo(STALL_DAYS))
    .is('shipped_at', null)
    .limit(50)

  for (const o of (orders || []) as any[]) {
    try {
      if (o.is_test) continue
      const ageDays = Math.floor((Date.now() - (Date.parse(o.paid_at || '') || Date.now())) / 86_400_000)
      const stage = ageDays >= STALL_ESCALATE_DAYS ? String(STALL_ESCALATE_DAYS) : String(STALL_DAYS)

      const { data: prior } = await c.from('b2b_order_events')
        .select('id').eq('order_id', o.id).eq('event_type', 'stall_reminder')
        .eq('metadata->>stage', stage).limit(1)
      if (prior && prior.length > 0) continue

      // Say WHY it looks stalled, so whoever reads it knows if it's really ours
      // to chase — a drop-ship waiting on a supplier is a different problem to
      // an order nobody has picked.
      const dist: any = Array.isArray(o.distributor) ? o.distributor[0] : o.distributor
      const pos: any[] = Array.isArray(o.dropship_pos) ? o.dropship_pos : []
      const unbilled = pos.filter(p => !p.billed_at)
      const where = o.machship_manifest_id ? 'manifested but not marked shipped'
        : o.machship_consignment_id ? 'freight booked, not yet shipped'
        : unbilled.length > 0 ? `waiting on ${unbilled.map(p => p.supplier_name).join(', ')} (drop-ship)`
        : 'no freight booked yet'

      const text = `:hourglass: *${o.order_number}* — paid ${ageDays} days ago and still not shipped.\n`
        + `${dist?.display_name || 'Distributor'}${o.customer_po ? ` · their PO ${o.customer_po}` : ''} · ${money(o.total_inc)} inc GST\n`
        + `Status: ${where}.\n${BASE_URL}/admin/b2b/orders/${o.id}`
      const { postB2bOrderSlack } = await import('./b2b-slack')
      await postB2bOrderSlack(c, text)

      try {
        const { notify } = await import('./notifications')
        await notify({
          module: 'b2b',
          title: `Not shipped after ${ageDays} days — ${o.order_number}`,
          body: `${dist?.display_name || 'Distributor'} · ${money(o.total_inc)} · ${where}.`,
          href: `/admin/b2b/orders/${o.id}`,
          dedupeKey: `b2b-stalled:${o.id}:${stage}`,
          roles: ['admin', 'manager'],
        })
      } catch {}

      await c.from('b2b_order_events').insert({
        order_id: o.id, event_type: 'stall_reminder', actor_type: 'system', actor_id: null,
        notes: `Paid ${ageDays} days ago, not shipped — ${where}.`,
        metadata: { stage, age_days: ageDays },
      }).then(() => {}, () => {})
      run.stalled++
    } catch (e: any) {
      console.error(`b2b-reminders: stalled order ${o?.order_number} failed:`, e?.message || e)
    }
  }
}

// ---------------------------------------------------------------------------

/** Runs all three passes. One failing pass never stops the others. */
export async function runB2bReminders(): Promise<ReminderRun> {
  const c = svc()
  const run: ReminderRun = { cartFirst: 0, cartFinal: 0, checkout: 0, stalled: 0, skipped: [] }
  for (const [name, pass] of [
    ['carts', sweepCarts], ['checkouts', sweepUnfinishedCheckouts], ['stalled', sweepStalledOrders],
  ] as Array<[string, (c: SupabaseClient, r: ReminderRun) => Promise<void>]>) {
    try { await pass(c, run) } catch (e: any) {
      console.error(`b2b-reminders: ${name} pass failed:`, e?.message || e)
      run.skipped.push(`${name} pass failed: ${e?.message || e}`)
    }
  }
  return run
}
