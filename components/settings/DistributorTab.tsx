// components/settings/DistributorTab.tsx
// Combined Distributor Report configuration:
//   - Customers          → /admin/groups (alias mapping + Distributor / Sundry / Excluded membership)
//   - Revenue Categories → DistributorReportTab (which MYOB account codes feed each category)
//
// These were previously two separate tabs in /settings ("Distributor Groups" and
// "Distributor Report"). They cover different halves of the same report and now
// live under one tab with internal sub-nav.

import { useState } from 'react'
import DistributorReportTab from './DistributorReportTab'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  accent:'#4f8ef7',
}

type SubTab = 'customers' | 'categories'

export default function DistributorTab({ initialSubTab = 'customers' }: { initialSubTab?: SubTab }) {
  const [sub, setSub] = useState<SubTab>(initialSubTab)

  const subTabs: { id: SubTab; label: string; hint: string }[] = [
    { id: 'customers',  label: 'Customers',          hint: 'MYOB name aliases · Distributor / Sundry / Excluded membership' },
    { id: 'categories', label: 'Revenue Categories', hint: 'Which MYOB account codes feed each category in the report' },
  ]
  const active = subTabs.find(s => s.id === sub) ?? subTabs[0]

  return (
    <div style={{display:'flex',flexDirection:'column',gap:14}}>
      {/* Sub-tab nav */}
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

      {sub === 'customers' && (
        <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden',height:'calc(100vh - 240px)',minHeight:600}}>
          <iframe src="/admin/groups?embed=1" style={{width:'100%',height:'100%',border:'none',display:'block'}} title="Distributor customers"/>
        </div>
      )}
      {sub === 'categories' && <DistributorReportTab/>}
    </div>
  )
}
