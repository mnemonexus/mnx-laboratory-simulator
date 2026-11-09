import { useState } from 'react'
import { VALIDITY_VERDICTS, type SessionView } from '../../../packages/lab-core/src/index.ts'
import { calibrationInput, calibrationPlot, displayedQuantity, interpolationInput, isAnalysisItem, type AnalysisItem } from '../../../packages/lab-core/src/analysis/workspace.ts'
import { show, usePractical } from './usePractical'

const input = 'ui-input h-8 !py-0 text-[12px] w-full min-w-0'
type Tool = 'calibration' | 'calculation' | 'conclusion'

export function AnalysisPanel({ view }: { view: SessionView }) {
  const [, rt] = usePractical()
  const [tool, setTool] = useState<Tool>('calibration')
  const [measurement, setMeasurement] = useState('')
  const [xs, setXs] = useState<Record<string, string>>({})
  const [xLabel, setXLabel] = useState('Concentration')
  const [name, setName] = useState('')
  const [expression, setExpression] = useState('')
  const [claim, setClaim] = useState('')
  const [validity, setValidity] = useState('valid-with-limitations')
  const [evidence, setEvidence] = useState('')
  const [selected, setSelected] = useState(-1)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const source = view.measurements.find((m) => m.id === measurement) ?? view.measurements[view.measurements.length - 1]
  const entries = view.notebook.filter((n) => isAnalysisItem(n.value)) as Array<{ field: string; value: AnalysisItem }>
  const active = entries[selected < 0 || selected >= entries.length ? entries.length - 1 : selected]
  const label = (id: string) => view.containers.find((c) => c.id === id)?.label ?? id
  const rows = source ? Object.entries(source.display).map(([subject, display]) => ({ subject, display, x: xs[`${source.id}:${subject}`] ?? '', flags: source.flags[subject] ?? [] })) : []
  const run = (op: string, params: Record<string, unknown>) => {
    setError('')
    setNotice('')
    if (rt.analyse(op, params)) { setSelected(-1); setNotice('Recorded in the notebook.') }
    else setError(rt.getSnapshot().view?.lastRefusal?.message ?? 'Could not record this analysis.')
  }
  const attempt = (fn: () => void) => { try { fn() } catch (e) { setError((e as Error).message); setNotice('') } }
  const field = `analysis:${name.trim() || (tool === 'calibration' ? 'Calibration' : 'Calculation')}`
  const evidenceOptions = [
    ...view.measurements.map((m) => ({ id: m.id, label: `${m.id} · ${label(m.subject)}` })),
    ...entries.map((n, i) => ({ id: `${n.field}#${i + 1}`, label: `${n.field.replace('analysis:', '')} (${i + 1})` })),
  ]

  return <div className="space-y-3 text-[12px]" data-testid="analysis-panel">
    <label className="flex items-center gap-2">Tool
      <select className={input} value={tool} onChange={(e) => { setTool(e.target.value as Tool); setError(''); setNotice('') }} data-testid="analysis-tool">
        <option value="calibration">Standard curve</option><option value="calculation">Calculation</option><option value="conclusion">Conclusion</option>
      </select>
    </label>
    {tool === 'calibration' && <>
      {!source ? <p className="text-[var(--muted)]">Take a measurement at the bench, then return to fit your standards.</p> : <>
        <label className="block">Measurement
          <select className={input} value={source.id} onChange={(e) => setMeasurement(e.target.value)} data-testid="analysis-measurement">
            {view.measurements.map((m) => <option key={m.id} value={m.id}>{m.id} · {label(m.subject)}</option>)}
          </select>
        </label>
        <label className="block">X axis<input className={input} value={xLabel} onChange={(e) => setXLabel(e.target.value)} data-testid="analysis-x-label" /></label>
        <p className="text-[var(--muted)]">Enter X for standards, including units where needed. Leave unknowns empty.</p>
        <div className="max-h-60 overflow-auto">
          <table className="w-full text-left" data-testid="analysis-data-table">
            <thead><tr><th className="py-1 pr-2">Sample</th><th className="pr-2">Reading</th><th className="w-36">X</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.subject} className="border-t border-[var(--line)]">
              <td className="py-1 pr-2 break-words">{view.containers.find((c) => c.id === r.subject)?.position ?? label(r.subject)}</td>
              <td className="pr-2 font-mono-ui">{r.display}{r.flags.length > 0 && <span className="block text-[var(--warn)] text-[10px]">{r.flags.join(', ')}</span>}</td>
              <td><input className={input} aria-label={`X for ${label(r.subject)}`} value={r.x} disabled={!displayedQuantity(r.display)} onChange={(e) => setXs({ ...xs, [`${source.id}:${r.subject}`]: e.target.value })} data-testid={`analysis-x-${r.subject}`} /></td>
            </tr>)}</tbody>
          </table>
        </div>
        <details className="text-[var(--muted)]"><summary className="cursor-pointer">Curve options</summary>
          <label className="block mt-2">Notebook name<input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Calibration" data-testid="analysis-name" /></label>
          <p className="mt-1">Linear regression with an intercept. Inspect residuals before using the curve. Warnings remain attached to the source readings.</p>
        </details>
        <button className="ui-btn-solid h-8 px-3" disabled={rows.filter((r) => r.x.trim()).length < 2} onClick={() => attempt(() => run('core:fit', { ...calibrationInput(rows, source.id, xLabel), model: 'linear', recordAs: field }))} data-testid="analysis-fit">Fit standards</button>
      </>}
    </>}
    {tool === 'calculation' && <>
      <label className="block">Notebook name<input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Calculation" data-testid="calculation-name" /></label>
      <label className="block">Expression<textarea className="ui-input w-full min-h-20 font-mono-ui text-[12px]" value={expression} onChange={(e) => setExpression(e.target.value)} placeholder="(2 mg/mL) * (50 uL) / (200 uL)" data-testid="calculation-expression" /></label>
      <details className="text-[var(--muted)]"><summary className="cursor-pointer">Expression help</summary><p className="mt-1">Use quantities, arithmetic, mean(list(...)), sd(list(...)) and convert(value, 'unit'). Incompatible units are refused. This calculator does not read hidden sample values.</p></details>
      <button className="ui-btn-solid h-8 px-3" disabled={!expression.trim()} onClick={() => run('core:compute', { expression: expression.trim(), recordAs: field })} data-testid="analysis-calculate">Calculate and record</button>
    </>}
    {tool === 'conclusion' && <>
      <label className="block">Claim and limitations<textarea className="ui-input w-full min-h-24 text-[12px]" value={claim} onChange={(e) => setClaim(e.target.value)} data-testid="conclusion-claim" /></label>
      <label className="block">Evidence<select className={input} value={evidence} onChange={(e) => setEvidence(e.target.value)} data-testid="conclusion-evidence"><option value="">Choose a measurement or analysis</option>{evidenceOptions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>
      <label className="block">Your validity judgement<select className={input} value={validity} onChange={(e) => setValidity(e.target.value)} data-testid="conclusion-validity">{VALIDITY_VERDICTS.map((v) => <option key={v} value={v}>{v.replace(/-/g, ' ')}</option>)}</select></label>
      <button className="ui-btn-solid h-8 px-3" disabled={!claim.trim() || !evidence} onClick={() => run('core:conclude', { claim: claim.trim(), evidence: [evidence], validity })} data-testid="analysis-conclude">Record conclusion</button>
    </>}
    {error && <p role="alert" className="text-[var(--danger)]" data-testid="analysis-error">{error}</p>}
    {notice && <p role="status" className="text-[var(--muted)]" data-testid="analysis-notice">{notice}</p>}
    {active && <section className="border-t border-[var(--line)] pt-3 space-y-2">
      <label className="flex items-center gap-2">Recorded<select className={input} value={selected < 0 || selected >= entries.length ? entries.length - 1 : selected} onChange={(e) => setSelected(Number(e.target.value))} data-testid="analysis-recorded">{entries.map((n, i) => <option key={i} value={i}>{n.field.replace('analysis:', '')} ({i + 1})</option>)}</select></label>
      <AnalysisResult item={active.value} />
      {active.value.operation === 'core:fit' && <UnknownReading key={`${active.field}-${entries.indexOf(active)}`} item={active.value} view={view} run={run} attempt={attempt} />}
      <details className="text-[var(--muted)]"><summary className="cursor-pointer">Inputs and provenance</summary><pre className="mt-2 whitespace-pre-wrap break-all text-[10px]" data-testid="analysis-provenance">{JSON.stringify(active.value.inputs, null, 2)}</pre></details>
    </section>}
  </div>
}

function UnknownReading({ item, view, run, attempt }: { item: AnalysisItem; view: SessionView; run: (op: string, p: Record<string, unknown>) => void; attempt: (fn: () => void) => void }) {
  const [reading, setReading] = useState('')
  const [factor, setFactor] = useState('1')
  const choices = view.measurements.flatMap((m) => Object.entries(m.display).filter(([, text]) => displayedQuantity(text)).map(([subject, display]) => ({ key: `${m.id}:${subject}`, measurement: m.id, subject, display, flags: m.flags[subject] ?? [] })))
  const selected = choices.find((c) => c.key === reading)
  return <details className="text-[var(--muted)]" data-testid="analysis-unknown"><summary className="cursor-pointer">Read an unknown from this curve</summary><div className="mt-2 space-y-2">
    <label className="block">Reading<select className={input} value={reading} onChange={(e) => setReading(e.target.value)} data-testid="unknown-reading"><option value="">Choose a reading</option>{choices.map((c) => <option key={c.key} value={c.key}>{c.measurement} · {c.subject} · {c.display}{c.flags.length > 0 ? ` (${c.flags.join(', ')})` : ''}</option>)}</select></label>
    <label className="block">Dilution factor<input className={input} value={factor} onChange={(e) => setFactor(e.target.value)} data-testid="unknown-factor" /></label>
    <button className="ui-btn h-8" disabled={!selected} onClick={() => attempt(() => selected && run('core:interpolate', { ...interpolationInput(item, selected.display, factor, selected), recordAs: 'analysis:Unknown' }))} data-testid="unknown-calculate">Interpolate and record</button>
  </div></details>
}

function AnalysisResult({ item }: { item: AnalysisItem }) {
  const plot = calibrationPlot(item)
  if (plot) return <div data-testid="analysis-result" className="space-y-2">
    <p className="font-mono-ui">y = {show(plot.fit.params.slope)}x + {show(plot.fit.params.intercept)} · R² {show(plot.fit.r2)} · n = {plot.fit.n}</p>
    {plot.fit.n === 2 && <p className="text-[var(--warn)]">Two points define a line; they do not establish linearity.</p>}
    <ScatterPlot plot={plot} />
    <details className="text-[var(--muted)]"><summary className="cursor-pointer">Residuals (observed − fitted)</summary><table className="w-full mt-2 text-left font-mono-ui"><thead><tr><th>X</th><th>Reading</th><th>Residual</th></tr></thead><tbody>{plot.points.map((p, i) => <tr key={i}><td>{show(p.x)}</td><td>{show(p.y)}</td><td>{show(p.residual)}</td></tr>)}</tbody></table></details>
  </div>
  if (item.operation === 'core:interpolate') {
    const results = item.outputs.results as Array<{ x: number; unit: string | null; inRange: boolean; factor: number }>
    return <div data-testid="analysis-result">{results.map((r, i) => <p key={i} className={r.inRange ? '' : 'text-[var(--warn)]'}>{show(r.x)} {r.unit ?? ''} · dilution ×{r.factor}{!r.inRange && ' · Outside calibration range'}</p>)}</div>
  }
  return <p className="font-mono-ui break-words" data-testid="analysis-result">{show(item.outputs.value ?? item.outputs.values ?? item.outputs.groups ?? item.outputs)}</p>
}

function ScatterPlot({ plot }: { plot: NonNullable<ReturnType<typeof calibrationPlot>> }) {
  // Only plot geometry lives here; fit and residuals come from the core analysis operation.
  const { points, fit } = plot
  const xmin = Math.min(...points.map((p) => p.x)), xmax = Math.max(...points.map((p) => p.x))
  const ymin = Math.min(...points.map((p) => p.y)), ymax = Math.max(...points.map((p) => p.y))
  const x = (v: number) => 64 + (v - xmin) / (xmax - xmin || 1) * 390
  const y = (v: number) => 180 - (v - ymin) / (ymax - ymin || 1) * 140
  const predicted = (v: number) => fit.params.intercept + fit.params.slope * v
  return <svg viewBox="0 0 510 245" className="w-full" role="img" aria-label={`Standard curve: ${plot.yLabel} against ${plot.xLabel}`} data-testid="analysis-plot">
    <defs><clipPath id="analysis-plot-clip"><rect x="59" y="15" width="400" height="190" /></clipPath></defs>
    <path d="M64 20V180H465" fill="none" stroke="var(--muted)" />
    <g clipPath="url(#analysis-plot-clip)"><line x1={x(xmin)} y1={y(predicted(xmin))} x2={x(xmax)} y2={y(predicted(xmax))} stroke="var(--muted)" strokeDasharray="5 4" />{points.map((p, i) => <circle key={i} cx={x(p.x)} cy={y(p.y)} r="4" fill="var(--ink)"><title>{show(p.x)}, {show(p.y)}</title></circle>)}</g>
    <g fill="var(--muted)" fontSize="10"><text x="64" y="198">{show(xmin)}</text><text x="454" y="198" textAnchor="end">{show(xmax)}</text><text x="58" y="183" textAnchor="end">{show(ymin)}</text><text x="58" y="43" textAnchor="end">{show(ymax)}</text><text x="260" y="222" textAnchor="middle">{plot.xLabel}</text><text transform="translate(14 105) rotate(-90)" textAnchor="middle">{plot.yLabel}</text></g>
  </svg>
}
