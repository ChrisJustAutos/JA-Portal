// components/settings/ConnectionsHubTab.tsx
// Combined Connections settings tab:
//   - Health: read-only status dashboard for every integration
//             (accounting, workshop, comms, crm, phone, infra)
//   - MYOB:   OAuth connection management + payment clearing accounts
//
// These were previously two top-level tabs in /settings ("Connections" and
// "MYOB Connection"). They cover related ground (integration plumbing) and
// now live under one tab with internal sub-nav.

import { useState } from 'react'
import ConnectionsTab from './ConnectionsTab'
import MyobTab from './MyobTab'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  accent:'#4f8ef7',
}

type SubTab = 'health' | 'myob'

export default function ConnectionsHubTab({ initialSubTab = 'health' }: { initialSubTab?: SubTab }) {
  const [sub, setSub] = useState<SubTab>(initialSubTab)

  const subTabs: { id: SubTab; label: string; hint: string }[] = [
    { id: 'health', label: 'Health',          hint: 'Live status across every integration · auto-refreshes every 30s' },
    { id: 'myob',   label: 'MYOB Connection', hint: 'OAuth, company file selection, test, and clearing accounts for AP payments' },
  ]
  const active = subTabs.find(s => s.id === sub) ?? subTabs[0]

  return (
    <div style={{display:'flex',flexDirection:'column',gap:14}}>
      {/* Sub-tab nav — same pill pattern as the Distributor Report combined tab */}
      <div style={{display:'flex',gap:6,background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:6,alignSelf:'flex-start'}}>
        {subTabs.map(s => {
          const on = s.id === sub
          return (
            <button key={s.id} onClick={()=>setSub(s.id)}
              style={{
                padding:'7px 14px',borderRadius:6,border:'none',
                background: on ? `${T.accent}20` : 'transparent',
                color: on ? T.accent : T.text2,
                fontSize:12,fontWeight: on ? 600 : 500,
                cursor:'pointer',fontFamily:'inherit',
              }}>
              {s.label}
            </button>
          )
        })}
      </div>

      <div style={{fontSize:11,color:T.text3,marginTop:-6}}>{active.hint}</div>

      {sub === 'health' && <ConnectionsTab/>}
      {sub === 'myob'   && <MyobTab/>}
    </div>
  )
}
