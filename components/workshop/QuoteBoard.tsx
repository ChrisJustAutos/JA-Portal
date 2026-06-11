// components/workshop/QuoteBoard.tsx
// Monday-style kanban over workshop_quotes — one component mounted in both
// the workshop Quotes page (Board view) and /crm/quotes. Drag a card between
// status columns (optimistic PATCH), click a card to open the quote builder,
// convert accepted quotes to a diary booking in place. workshop_quotes stays
// the single source of truth; the CRM mount just shows lead chips on cards.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/router'
import { QUOTE_STATUSES, QUOTE_STATUS_META, QuoteStatus, vehicleLabel, customerLabel } from '../../lib/workshop'
import { T } from '../../lib/ui/theme'
import { money2 as money, fmtDate } from '../../lib/ui/format'
import { useToast, useConfirm } from '../ui/Feedback'

interface QuoteRow {
  id: string
  status: QuoteStatus
  total: number | null
  notes: string | null
  created_at: string
  customer?: { id: string; name: string } | null
  vehicle?: { id: string; rego: string | null; make: string | null; model: string | null; year: number | null } | null
  lead?: { id: string; title: string; stage: string } | null
}

export default function QuoteBoard({ canEdit, showLeadChips, onChanged }: {
  canEdit: boolean
  showLeadChips?: boolean
  onChanged?: () => void
}) {
  const router = useRouter()
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [quotes, setQuotes] = useState<QuoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [convertingId, setConvertingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/workshop/quotes?view=active${showLeadChips ? '&with_leads=1' : ''}`)
      const d = await r.json()
      if (r.ok) setQuotes(Array.isArray(d.quotes) ? d.quotes : [])
    } catch { /* keep */ } finally { setLoading(false) }
  }, [showLeadChips])
  useEffect(() => { load() }, [load])

  const byStatus = useMemo(() => {
    const m: Record<string, QuoteRow[]> = {}
    for (const s of QUOTE_STATUSES) m[s] = []
    for (const q of quotes) (m[q.status] = m[q.status] || []).push(q)
    return m
  }, [quotes])

  async function moveStatus(id: string, status: QuoteStatus) {
    const prev = quotes
    setQuotes(p => p.map(q => q.id === id ? { ...q, status } : q))
    try {
      const r = await fetch(`/api/workshop/quotes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
      if (!r.ok) { setQuotes(prev); toast((await r.json()).error || 'Move failed', 'error') }
      else onChanged?.()
    } catch { setQuotes(prev) }
  }

  async function convert(q: QuoteRow, e: React.MouseEvent) {
    e.stopPropagation()
    const ok = await confirmDialog({
      title: 'Convert quote to booking?',
      message: `Creates a diary job for ${q.customer?.name || 'the customer'} with the quote's lines and marks the quote converted.`,
      confirmLabel: 'Convert',
    })
    if (!ok) return
    setConvertingId(q.id)
    try {
      const r = await fetch(`/api/workshop/quotes/${q.id}/convert`, { method: 'POST' })
      const d = await r.json()
      if (r.ok && d.booking_id) { toast('Converted — opening the job card', 'success'); router.push(`/workshop/job/${d.booking_id}`) }
      else toast(d.error || 'Convert failed', 'error')
    } catch (er: any) { toast(er?.message || 'Convert failed', 'error') } finally { setConvertingId(null) }
  }

  return (
    <div style={{ display: 'flex', gap: 12, flex: 1, overflowX: 'auto', minHeight: 0, alignItems: 'stretch' }}>
      {QUOTE_STATUSES.map(status => {
        const meta = QUOTE_STATUS_META[status]
        const items = byStatus[status] || []
        const sum = items.reduce((a, q) => a + (Number(q.total) || 0), 0)
        return (
          <div key={status}
            onDragOver={e => { if (dragId) { e.preventDefault(); setDragOver(status) } }}
            onDragLeave={() => setDragOver(o => o === status ? null : o)}
            onDrop={e => { e.preventDefault(); if (dragId) moveStatus(dragId, status); setDragId(null); setDragOver(null) }}
            style={{
              width: 250, minWidth: 250, display: 'flex', flexDirection: 'column',
              background: dragOver === status ? 'rgba(79,142,247,0.06)' : T.bg2,
              border: `1px solid ${dragOver === status ? T.accent : T.border}`, borderRadius: 10,
            }}>
            <div style={{ padding: '10px 12px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color }} />
              <span style={{ fontSize: 12, fontWeight: 600 }}>{meta.label}</span>
              <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{items.length}</span>
              <span style={{ flex: 1 }} />
              {sum > 0 && <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{money(sum)}</span>}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {loading && items.length === 0 && <div style={{ fontSize: 11, color: T.text3, textAlign: 'center', padding: '12px 0', fontStyle: 'italic' }}>…</div>}
              {items.map(q => (
                <div key={q.id}
                  draggable={canEdit}
                  onDragStart={() => setDragId(q.id)}
                  onDragEnd={() => { setDragId(null); setDragOver(null) }}
                  onClick={() => router.push(`/workshop/quote/${q.id}`)}
                  style={{
                    background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10,
                    cursor: 'pointer', opacity: dragId === q.id ? 0.4 : 1,
                  }}>
                  <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 3, lineHeight: 1.3 }}>{q.customer ? customerLabel(q.customer as any) : 'No customer'}</div>
                  {q.vehicle && <div style={{ fontSize: 11, color: T.text2, marginBottom: 5 }}>{vehicleLabel(q.vehicle)}</div>}
                  {showLeadChips && q.lead && (
                    <div style={{ fontSize: 10, color: T.text3, marginBottom: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>↪ {q.lead.title}</div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {Number(q.total) > 0 && <span style={{ fontSize: 11, color: T.green, fontFamily: 'monospace' }}>{money(q.total)}</span>}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{fmtDate(q.created_at)}</span>
                  </div>
                  {canEdit && status === 'accepted' && (
                    <button onClick={e => convert(q, e)} disabled={convertingId === q.id}
                      style={{ marginTop: 8, width: '100%', padding: '5px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: `${T.green}1e`, color: T.green, border: `1px solid ${T.green}55` }}>
                      {convertingId === q.id ? 'Converting…' : '→ Convert to booking'}
                    </button>
                  )}
                </div>
              ))}
              {!loading && items.length === 0 && <div style={{ fontSize: 11, color: T.text3, textAlign: 'center', padding: '12px 0', fontStyle: 'italic' }}>—</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
