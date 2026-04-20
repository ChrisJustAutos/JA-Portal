// components/dashboard/WidgetCatalogPicker.tsx
// Modal that shows the full widget catalog grouped by category, for
// adding a new widget to the dashboard.

import { WIDGETS } from '../../lib/dashboard/catalog'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', pink:'#ff5ac4',
  accent:'#4f8ef7',
}

const CATEGORY_ORDER = ['metric','sales','chart','distributor','ops','activity','misc']
const CATEGORY_LABELS: Record<string, string> = {
  metric:      'Metric tiles',
  sales:       'Sales',
  chart:       'Charts',
  distributor: 'Distributor',
  ops:         'Ops / jobs',
  activity:    'Activity',
  misc:        'Misc',
}
const CATEGORY_COLORS: Record<string, string> = {
  metric: T.blue, sales: T.teal, chart: T.purple, distributor: T.amber,
  ops: T.green, activity: T.pink, misc: T.text3,
}

interface Props {
  onPick: (type: string) => void
  onClose: () => void
}

export default function WidgetCatalogPicker({ onPick, onClose }: Props) {
  const grouped: Record<string, typeof WIDGETS> = {}
  for (const w of WIDGETS) {
    if (!grouped[w.category]) grouped[w.category] = [] as any
    grouped[w.category].push(w)
  }

  return (
    <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:20}}
         onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           style={{background:T.bg2, border:`1px solid ${T.border2}`, borderRadius:12, width:'100%', maxWidth:760, maxHeight:'90vh', display:'flex', flexDirection:'column'}}>
        <div style={{padding:'16px 20px', borderBottom:`1px solid ${T.border}`, display:'flex', alignItems:'center', gap:12}}>
          <div>
            <div style={{fontSize:16, fontWeight:600}}>Add widget</div>
            <div style={{fontSize:12, color:T.text3, marginTop:3}}>Pick a widget type. You can customise its settings after adding.</div>
          </div>
          <div style={{flex:1}}/>
          <button onClick={onClose} style={{padding:'6px 12px', borderRadius:6, border:`1px solid ${T.border2}`, background:'transparent', color:T.text2, fontSize:12, fontFamily:'inherit', cursor:'pointer'}}>Close</button>
        </div>
        <div style={{padding:20, overflow:'auto', flex:1}}>
          {CATEGORY_ORDER.filter(c => grouped[c]).map(cat => (
            <div key={cat} style={{marginBottom:18}}>
              <div style={{fontSize:10, color:CATEGORY_COLORS[cat], textTransform:'uppercase', letterSpacing:'0.07em', fontWeight:700, marginBottom:8}}>{CATEGORY_LABELS[cat]}</div>
              <div style={{display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:8}}>
                {grouped[cat].map(w => (
                  <button key={w.type} onClick={() => onPick(w.type)}
                    style={{textAlign:'left', padding:'12px 14px', background:T.bg3, border:`1px solid ${T.border}`, borderRadius:8, color:T.text, fontFamily:'inherit', cursor:'pointer'}}>
                    <div style={{fontSize:13, fontWeight:600, marginBottom:4}}>{w.label}</div>
                    <div style={{fontSize:11, color:T.text3, lineHeight:1.4}}>{w.description}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
