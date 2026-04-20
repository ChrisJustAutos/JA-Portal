// components/dashboard/WidgetConfigPanel.tsx
// Modal panel for editing a single widget's config. Renders controls based
// on the fields defined in the widget's WidgetDef.

import { useEffect, useState } from 'react'
import { WidgetDef, METRICS, DATE_RANGE_OPTIONS } from '../../lib/dashboard/catalog'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
  accent:'#4f8ef7',
}

const BUCKET_OPTIONS = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
]
const COMPARE_OPTIONS = [
  { value: 'none', label: 'No comparison' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last_week', label: 'Last week' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_period', label: 'Previous period (same length)' },
]

interface Props {
  widgetDef: WidgetDef
  initialConfig: Record<string, any>
  onSave: (config: Record<string, any>) => void
  onCancel: () => void
  onDelete?: () => void
}

export default function WidgetConfigPanel({ widgetDef, initialConfig, onSave, onCancel, onDelete }: Props) {
  const [config, setConfig] = useState<Record<string, any>>(initialConfig || {})
  const [sources, setSources] = useState<Record<string, { value: string, label: string }[]>>({})

  // Load picker sources if any field needs them
  useEffect(() => {
    const sourcesNeeded: string[] = []
    for (const f of widgetDef.fields) {
      if (f.type.kind === 'metric_source') {
        for (const s of f.type.sources) if (!sourcesNeeded.includes(s)) sourcesNeeded.push(s)
      }
    }
    if (sourcesNeeded.length === 0) return
    Promise.all(sourcesNeeded.map(async s => {
      const r = await fetch(`/api/dashboard/sources?source=${s}`)
      if (r.ok) {
        const d = await r.json()
        return [s, d.items || []] as [string, any]
      }
      return [s, []] as [string, any]
    })).then(pairs => {
      const obj: Record<string, any> = {}
      for (const [k, v] of pairs) obj[k] = v
      setSources(obj)
    })
  }, [widgetDef])

  function set(key: string, value: any) {
    setConfig(c => ({ ...c, [key]: value }))
  }

  return (
    <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:20}}>
      <div style={{background:T.bg2, border:`1px solid ${T.border2}`, borderRadius:12, width:'100%', maxWidth:560, maxHeight:'90vh', display:'flex', flexDirection:'column'}}>
        <div style={{padding:'16px 20px', borderBottom:`1px solid ${T.border}`}}>
          <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{widgetDef.category}</div>
          <div style={{fontSize:16, fontWeight:600, marginTop:3}}>{widgetDef.label}</div>
          <div style={{fontSize:12, color:T.text3, marginTop:4}}>{widgetDef.description}</div>
        </div>

        <div style={{padding:20, overflow:'auto', flex:1}}>
          {widgetDef.fields.map(f => {
            const val = config[f.key] ?? ''
            return (
              <div key={f.key} style={{marginBottom:14}}>
                <label style={{display:'block', fontSize:11, color:T.text2, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:6}}>
                  {f.label}{f.required && <span style={{color:T.red, marginLeft:4}}>*</span>}
                </label>
                {f.type.kind === 'text' && (
                  <input type="text" value={val} onChange={e => set(f.key, e.target.value)} placeholder={f.type.placeholder}
                    style={{width:'100%', padding:'8px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box'}}/>
                )}
                {f.type.kind === 'number' && (
                  <input type="number" value={val} min={f.type.min} max={f.type.max} step={f.type.step || 1}
                    onChange={e => set(f.key, Number(e.target.value))}
                    style={{width:'100%', padding:'8px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box'}}/>
                )}
                {f.type.kind === 'select' && (
                  <select value={val} onChange={e => set(f.key, e.target.value)}
                    style={{width:'100%', padding:'8px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box'}}>
                    <option value="">— select —</option>
                    {f.type.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                )}
                {f.type.kind === 'metric' && (
                  <select value={val} onChange={e => set(f.key, e.target.value)}
                    style={{width:'100%', padding:'8px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box'}}>
                    <option value="">— select metric —</option>
                    {Object.entries(
                      METRICS.reduce<Record<string, typeof METRICS>>((acc, m) => {
                        if (!acc[m.group]) acc[m.group] = []
                        acc[m.group].push(m); return acc
                      }, {})
                    ).map(([group, metrics]) => (
                      <optgroup key={group} label={group}>
                        {metrics.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </optgroup>
                    ))}
                  </select>
                )}
                {f.type.kind === 'date_range' && (
                  <select value={val} onChange={e => set(f.key, e.target.value)}
                    style={{width:'100%', padding:'8px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box'}}>
                    {DATE_RANGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                )}
                {f.type.kind === 'compare' && (
                  <select value={val} onChange={e => set(f.key, e.target.value)}
                    style={{width:'100%', padding:'8px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box'}}>
                    {COMPARE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                )}
                {f.type.kind === 'bucket' && (
                  <select value={val} onChange={e => set(f.key, e.target.value)}
                    style={{width:'100%', padding:'8px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box'}}>
                    {BUCKET_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                )}
                {f.type.kind === 'metric_source' && (
                  <select value={val} onChange={e => set(f.key, e.target.value)}
                    style={{width:'100%', padding:'8px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box'}}>
                    <option value="">— select —</option>
                    {f.type.sources.map(src => {
                      const items = sources[src] || []
                      return items.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)
                    })}
                  </select>
                )}
                {f.type.kind === 'markdown' && (
                  <textarea value={val} onChange={e => set(f.key, e.target.value)}
                    placeholder="# Heading&#10;&#10;**Bold** or *italic*&#10;- list item"
                    style={{width:'100%', minHeight:120, padding:'8px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:13, fontFamily:'monospace', outline:'none', boxSizing:'border-box', resize:'vertical'}}/>
                )}
                {f.helpText && <div style={{fontSize:10, color:T.text3, marginTop:4}}>{f.helpText}</div>}
              </div>
            )
          })}
        </div>

        <div style={{padding:'14px 20px', borderTop:`1px solid ${T.border}`, display:'flex', alignItems:'center', gap:8}}>
          {onDelete && (
            <button onClick={() => {
              if (confirm('Remove this widget from your dashboard?')) onDelete()
            }} style={{padding:'8px 14px', borderRadius:6, border:`1px solid ${T.red}40`, background:'transparent', color:T.red, fontSize:12, fontFamily:'inherit', cursor:'pointer'}}>
              Remove widget
            </button>
          )}
          <div style={{flex:1}}/>
          <button onClick={onCancel} style={{padding:'8px 14px', borderRadius:6, border:`1px solid ${T.border2}`, background:'transparent', color:T.text2, fontSize:12, fontFamily:'inherit', cursor:'pointer'}}>
            Cancel
          </button>
          <button onClick={() => onSave(config)} style={{padding:'8px 18px', borderRadius:6, border:'none', background:T.accent, color:'#fff', fontSize:12, fontWeight:600, fontFamily:'inherit', cursor:'pointer'}}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
