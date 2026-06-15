// lib/b2bSupplierAuth.ts
//
// Server-side auth helpers for SUPPLIER logins on the B2B portal. Suppliers
// authenticate through the very same Supabase auth + session cookie as
// distributors (ja-b2b-access-token) — the only difference is the identity
// lookup lands in b2b_supplier_users / b2b_suppliers instead of the
// distributor tables. A given auth user is therefore EITHER a distributor
// user OR a supplier user (emails are unique across both).
//
// Suppliers get a read-only Stock Wall of the products they supply; they
// never order, so there's no cart/pricing/distributor machinery here.

import type { NextApiRequest, NextApiResponse, GetServerSidePropsContext } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { B2B_ACCESS_COOKIE } from './b2bAuthServer'

let _sb: SupabaseClient | null = null
function svc(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface SupplierAccount {
  id: string
  name: string
  myobSupplierUids: string[]
  isActive: boolean
}
export interface SupplierUser {
  id: string
  authUserId: string
  email: string
  fullName: string | null
  isActive: boolean
  supplier: SupplierAccount
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {}
  const out: Record<string, string> = {}
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=')
    if (idx > 0) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim())
  }
  return out
}
function getToken(req: NextApiRequest | { headers: Record<string, any> }): string | null {
  const auth = (req.headers.authorization || (req.headers as any).Authorization) as string | undefined
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7)
  const cookies = parseCookies((req.headers as any).cookie)
  return cookies[B2B_ACCESS_COOKIE] || null
}

export async function getCurrentSupplierUserFromToken(token: string): Promise<SupplierUser | null> {
  const sb = svc()
  const { data: authData, error: authErr } = await sb.auth.getUser(token)
  if (authErr || !authData?.user) return null

  const { data: row, error } = await sb
    .from('b2b_supplier_users')
    .select(`
      id, auth_user_id, email, full_name, is_active,
      supplier:b2b_suppliers!b2b_supplier_users_supplier_id_fkey ( id, name, myob_supplier_uids, is_active )
    `)
    .eq('auth_user_id', authData.user.id)
    .maybeSingle()
  if (error || !row) return null
  if (row.is_active === false) return null

  const sup: any = Array.isArray(row.supplier) ? row.supplier[0] : row.supplier
  if (!sup || sup.is_active === false) return null

  return {
    id: row.id,
    authUserId: row.auth_user_id,
    email: row.email,
    fullName: row.full_name,
    isActive: row.is_active,
    supplier: { id: sup.id, name: sup.name, myobSupplierUids: sup.myob_supplier_uids || [], isActive: sup.is_active },
  }
}

export async function getCurrentSupplierUser(req: NextApiRequest | { headers: Record<string, any> }): Promise<SupplierUser | null> {
  const token = getToken(req)
  if (!token) return null
  return getCurrentSupplierUserFromToken(token)
}

// Page guard: suppliers only. Anyone else → the shared B2B login.
export async function requireSupplierPageAuth(context: GetServerSidePropsContext) {
  const user = await getCurrentSupplierUser(context.req as any)
  if (!user) return { redirect: { destination: '/b2b/login', permanent: false } }
  return {
    props: {
      supplier: {
        userId: user.id,
        email: user.email,
        fullName: user.fullName,
        id: user.supplier.id,
        name: user.supplier.name,
      },
    },
  }
}

export function withSupplierAuth<T = any>(
  handler: (req: NextApiRequest, res: NextApiResponse, user: SupplierUser) => Promise<T> | T,
) {
  return async function (req: NextApiRequest, res: NextApiResponse): Promise<void> {
    const user = await getCurrentSupplierUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }
    try { await handler(req, res, user) }
    catch (e: any) {
      console.error('withSupplierAuth handler threw:', e)
      if (!res.writableEnded) res.status(500).json({ error: e?.message || 'Internal error' })
    }
  }
}
