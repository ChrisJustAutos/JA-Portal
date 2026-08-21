// components/reports/SalesDashboard.tsx
// Reports → Sales Dashboard — the portal rebuild of the Monday "Sales
// Dashboard" (2079976), combined with the Monday "Management Dashboard"
// (321206). Three views behind one tab:
//
//   Management — the Monday "Management Dashboard" (321206) widget for widget:
//                sales vs target per month / per salesperson / per day, plus the
//                cancelled and postponed exception totals. Default view.
//   Figures    — daily, monthly and per-salesperson sales taken over any date
//                range, with a person filter (Orders + Distributor bookings).
//   Pipeline   — the quote pipeline across the five rep Quote Channel boards:
//                what is still open, at what stage, and what converted.
//
// Each view fetches its own data, and only when it is first opened — the
// Pipeline pull touches five boards, so it shouldn't run for someone who only
// wanted the day's takings.

import React, { useState } from 'react'
import { T } from '../../lib/ui/theme'
import SalesFiguresView from './SalesFiguresView'
import SalesPipelineView from './SalesPipelineView'
import SalesManagementView from './SalesManagementView'

type View = 'management' | 'figures' | 'pipeline'

const TABS: Array<{ id: View; label: string; hint: string }> = [
  { id: 'management', label: 'Management', hint: 'Sales vs target per month, per salesperson and per day' },
  { id: 'figures', label: 'Figures', hint: 'Daily, monthly and per-salesperson sales over any date range' },
  { id: 'pipeline', label: 'Pipeline', hint: 'Open quotes by stage, rep and age' },
]

export default function SalesDashboard() {
  const [view, setView] = useState<View>('management')
  // Mount a view once it has been opened, then keep it mounted so switching
  // back doesn't re-pull Monday.
  const [seen, setSeen] = useState<Record<View, boolean>>({ management: true, figures: false, pipeline: false })

  const open = (v: View) => { setView(v); setSeen(s => (s[v] ? s : { ...s, [v]: true })) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 20px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        {TABS.map(t => {
          const on = t.id === view
          return (
            <button key={t.id} onClick={() => open(t.id)} title={t.hint} style={{
              background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              color: on ? T.text : T.text2, fontSize: 12.5, fontWeight: on ? 600 : 400,
              padding: '10px 12px', borderBottom: `2px solid ${on ? T.accent : 'transparent'}`,
            }}>{t.label}</button>
          )
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <div style={{ height: '100%', display: view === 'management' ? 'block' : 'none' }}>
          {seen.management && <SalesManagementView />}
        </div>
        <div style={{ height: '100%', display: view === 'figures' ? 'block' : 'none' }}>
          {seen.figures && <SalesFiguresView />}
        </div>
        <div style={{ height: '100%', display: view === 'pipeline' ? 'block' : 'none' }}>
          {seen.pipeline && <SalesPipelineView />}
        </div>
      </div>
    </div>
  )
}
