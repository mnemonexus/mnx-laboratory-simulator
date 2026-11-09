// The notebook: measurements as the instruments displayed them, what was recorded and
// calculated, and incidents. Raw values only: nothing here is corrected or interpreted.
import { useState } from 'react'
import type { SessionView } from '../../../packages/lab-core/src/index.ts'
import { clock } from '../../runtime/present'
import { show, usePractical } from './usePractical'
import { GelImage } from './GelImage'
import { TlcImage } from './TlcImage'
import { BlotImage } from './BlotImage'
import { CurvePlot } from './CurvePlot'
import { AnalysisPanel } from './AnalysisPanel'
import { isAnalysisItem } from '../../../packages/lab-core/src/analysis/workspace.ts'

export function NotebookPanel({ view, onClose }: { view: SessionView; onClose: () => void }) {
  const [, rt] = usePractical()
  const [field, setField] = useState('')
  const [value, setValue] = useState('')
  const [tab, setTab] = useState<'notes' | 'analysis'>('notes')
  const label = (id: string) => view.containers.find((c) => c.id === id)?.label ?? view.equipment.find((e) => e.id === id)?.label ?? id
  const entries = view.notebook.filter((n) => !n.field.startsWith('decision:') && !isAnalysisItem(n.value))
  // A plate read lists every well; the empty ones only clutter the table.
  const inUse = (id: string) => {
    const c = view.containers.find((x) => x.id === id)
    return !c || c.kind !== 'well' || c.volumeMl > 0
  }

  return (
    <div className="ui-panel-solid p-4 flex flex-col gap-3 min-h-0 h-full" data-testid="notebook-panel">
      <div className="flex items-center justify-between">
        <span className="ui-kicker">Notebook</span>
        <button className="ui-btn h-7" onClick={onClose} data-testid="notebook-close">
          Close
        </button>
      </div>
      <div className="ui-nav text-[12px] shrink-0" role="tablist" aria-label="Notebook views">
        <button className={tab === 'notes' ? 'ui-tab ui-tab-on' : 'ui-tab'} role="tab" aria-selected={tab === 'notes'} onClick={() => setTab('notes')} data-testid="notebook-notes">Notes</button>
        <button className={tab === 'analysis' ? 'ui-tab ui-tab-on' : 'ui-tab'} role="tab" aria-selected={tab === 'analysis'} onClick={() => setTab('analysis')} data-testid="notebook-analysis">Analysis</button>
      </div>
      <div className="overflow-y-auto min-h-0 space-y-4 pr-1">
        {tab === 'analysis' ? <AnalysisPanel view={view} /> : <>
        <section>
          <h3 className="text-[12px] font-semibold mb-1.5">Measurements</h3>
          {view.measurements.length === 0 && <p className="text-[12px] text-[var(--faint)]">None yet.</p>}
          <ul className="space-y-2">
            {view.measurements.map((m) => (
              <li key={m.id} className="text-[12px]">
                <div className="text-[var(--muted)]">
                  <span className="font-mono-ui">{clock(m.timeS)}</span> · {label(m.instrument)} · {label(m.subject)}
                </div>
                <MeasurementTable display={m.display} flags={m.flags} label={label} inUse={inUse} />
                {m.gel && m.bands ? <GelImage gel={m.gel} bands={m.bands} /> : null}
                {m.tlc && m.bands ? <TlcImage tlc={m.tlc} bands={m.bands} /> : null}
                {m.blot && m.bands ? <BlotImage blot={m.blot} bands={m.bands} /> : null}
                {m.curves ? <CurvePlot curves={m.curves} wells={view.containers} display={m.display} /> : null}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="text-[12px] font-semibold mb-1.5">Recorded</h3>
          {entries.length === 0 && <p className="text-[12px] text-[var(--faint)]">Nothing recorded yet.</p>}
          <table className="w-full text-[12px]">
            <tbody>
              {entries.map((n, i) => (
                <tr key={i} className="border-b border-[var(--line)]">
                  <td className="py-1 pr-2 text-[var(--muted)] align-top">{n.field}</td>
                  <td className="py-1 break-words">{n.field === 'conclusion' && n.value && typeof n.value === 'object' && 'claim' in n.value ? <div className="space-y-1"><p>{String(n.value.claim)}</p>{'validity' in n.value && <p className="text-[var(--muted)]">Learner judgement: {String(n.value.validity).replace(/-/g, ' ')}</p>}{'evidence' in n.value && <p className="text-[var(--muted)]">Evidence: {show(n.value.evidence)}</p>}</div> : <span className="font-mono-ui">{show(n.value)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid gap-1.5 mt-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) auto' }}>
            <input className="ui-input h-7 !py-0 text-[12px]" placeholder="field" value={field} onChange={(e) => setField(e.target.value)} data-testid="note-field" />
            <input className="ui-input h-7 !py-0 text-[12px]" placeholder="value (e.g. 24.35 mL)" value={value} onChange={(e) => setValue(e.target.value)} data-testid="note-value" />
            <button
              className="ui-btn h-7"
              data-testid="note-add"
              onClick={() => {
                if (!field.trim()) return
                rt.note(field.trim(), value.trim())
                setValue('')
              }}
            >
              Add
            </button>
          </div>
        </section>
        {view.incidents.length > 0 && (
          <section>
            <h3 className="text-[12px] font-semibold mb-1.5 text-[var(--danger)]">Incidents</h3>
            <ul className="space-y-1">
              {view.incidents.map((x, i) => (
                <li key={i} className="text-[12px]">
                  {x.message}
                </li>
              ))}
            </ul>
          </section>
        )}
        </>}
      </div>
    </div>
  )
}

function MeasurementTable({ display, flags, label, inUse }: { display: Record<string, string>; flags: Record<string, string[]>; label: (id: string) => string; inUse: (id: string) => boolean }) {
  const all = Object.entries(display)
  const rows = all.length > 1 ? all.filter(([id]) => inUse(id)) : all
  const hidden = all.length - rows.length
  if (rows.length === 1) {
    const [id, text] = rows[0]
    return (
      <div className="font-mono-ui text-[12px] break-words">
        {text}
        {flags[id]?.length ? <span className="text-[var(--warn)]"> ({flags[id].join(', ')})</span> : null}
      </div>
    )
  }
  return (
    <div>
      <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 font-mono-ui text-[11.5px]">
        {rows.map(([id, text]) => (
          <div key={id} className="flex justify-between gap-2">
            <span className="text-[var(--faint)] truncate">{label(id).split(' ').pop()}</span>
            <span className={flags[id]?.length ? 'text-[var(--warn)]' : ''}>{text}</span>
          </div>
        ))}
      </div>
      {hidden > 0 && <div className="text-[11px] text-[var(--faint)] mt-0.5">{hidden} empty wells not shown</div>}
    </div>
  )
}
