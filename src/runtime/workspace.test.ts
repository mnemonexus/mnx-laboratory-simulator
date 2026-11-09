import { describe, expect, it } from 'vitest'
import { calibrationInput, calibrationPlot, displayedQuantity, interpolationInput, isAnalysisItem } from '../../packages/lab-core/src/analysis/workspace.ts'
import { PracticalRuntime } from './practical'

const rows = [
  { subject: 'A1', display: '0.1 AU', x: '0 mg/mL', flags: [] },
  { subject: 'A2', display: '0.6 AU', x: '500 ug/mL', flags: [] },
  { subject: 'A3', display: '1.1 AU', x: '1 mg/mL', flags: [] },
  { subject: 'A4', display: 'OVER', x: '', flags: ['saturated'] },
]
function open(host?: { load: (key: string) => Promise<string | null>; save: (key: string, value: string) => Promise<void> }) {
  const rt = new PracticalRuntime(host)
  expect(rt.start('bio1-bca-protein-assay', 'practical-session', 7)).toBe(true)
  return rt
}
const analyses = (rt: PracticalRuntime) => rt.getSnapshot().view!.notebook.filter((n) => isAnalysisItem(n.value))

describe('learner data workspace', () => {
  it('uses displayed values, compatible axis units and no hidden saturated readings', () => {
    expect(displayedQuantity('OVER')).toBeNull()
    expect(displayedQuantity('0.2 → 0.4')).toBeNull()
    expect(displayedQuantity('purple')).toBeNull()
    expect(() => calibrationInput(rows.map((r) => ({ ...r, x: r.subject === 'A4' ? '2 mg/mL' : r.x })), 'read-1', 'Protein')).toThrow(/numeric/)
    expect(() => calibrationInput(rows.slice(0, 2).map((r, i) => ({ ...r, x: i ? '5 mL' : '1 mg/mL' })), 'read-1', 'X')).toThrow(/compatible/)
    expect(() => calibrationInput(rows.slice(0, 2).map((r) => ({ ...r, x: '1 mM' })), 'read-1', 'X')).toThrow(/different/)
  })

  it('records a fit, its displayed sources and residuals in one event; interpolates with range checks', () => {
    const rt = open()
    const params = calibrationInput(rows, 'read-1', 'Protein')
    expect(rt.analyse('core:fit', { ...params, model: 'linear', recordAs: 'analysis:Protein' })).toBe(true)
    const item = analyses(rt)[0].value
    expect(isAnalysisItem(item)).toBe(true)
    if (!isAnalysisItem(item)) return
    const plot = calibrationPlot(item)!
    expect(plot.fit.params.slope).toBeCloseTo(1, 9)
    expect(plot.fit.params.intercept).toBeCloseTo(0.1, 9)
    expect(plot.fit.r2).toBeCloseTo(1, 9)
    expect(plot.xLabel).toBe('Protein (mg/mL)')
    expect(plot.points.map((p) => p.x)).toEqual([0, 0.5, 1])
    expect(item.inputs.sources).toEqual(rows.slice(0, 3).map((r) => ({ measurement: 'read-1', subject: r.subject, display: r.display, flags: r.flags })))
    expect(rt.analyse('core:interpolate', { ...interpolationInput(item, '1.6 AU', '4', { measurement: 'read-2', subject: 'unknown', flags: ['unstable'] }), recordAs: 'analysis:Unknown' })).toBe(true)
    const unknown = analyses(rt)[1].value
    if (!isAnalysisItem(unknown)) throw new Error('Missing analysis')
    expect(unknown.outputs.results).toMatchObject([{ x: 6, unit: 'mg/mL', inRange: false, factor: 4 }])
    expect(unknown.inputs.sources).toMatchObject([{ measurement: 'read-2', subject: 'unknown', flags: ['unstable'] }])
    expect(() => interpolationInput(item, '2 mL', '1', { measurement: 'r', subject: 'u' })).toThrow(/units/)
    expect(() => interpolationInput(item, '1 AU', '0', { measurement: 'r', subject: 'u' })).toThrow(/greater/)
    rt.rewind()
    expect(analyses(rt)).toHaveLength(1)
    rt.rewind()
    expect(analyses(rt)).toHaveLength(0)
  })

  it('contains calculation failures without a partial notebook entry', () => {
    const rt = open()
    expect(rt.analyse('core:compute', { expression: '1 mL + 2 mg', recordAs: 'analysis:bad' })).toBe(false)
    expect(analyses(rt)).toHaveLength(0)
    expect(rt.getSnapshot().error).toBeUndefined()
    expect(rt.analyse('core:compute', { expression: '(2 mg/mL) * (50 uL) / (200 uL)', recordAs: 'analysis:dilution' })).toBe(true)
    expect(analyses(rt)[0].value).toMatchObject({ outputs: { value: '0.5 g/L' } })
    expect(rt.analyse('core:transfer', {})).toBe(false)
  })

  it('restores analysis and evidence-linked conclusions through the existing host save', async () => {
    const store = new Map<string, string>()
    const host = { load: async (k: string) => store.get(k) ?? null, save: async (k: string, v: string) => { store.set(k, v) } }
    const rt = open(host)
    rt.analyse('core:fit', { ...calibrationInput(rows, 'read-1', 'Protein'), model: 'linear', recordAs: 'analysis:Protein' })
    rt.analyse('core:conclude', { claim: 'The unknown requires dilution.', evidence: ['analysis:Protein#1'], validity: 'inconclusive' })
    const restored = new PracticalRuntime(host)
    expect(await restored.resume()).toBe(true)
    expect(restored.getSnapshot().view!.notebook).toEqual(rt.getSnapshot().view!.notebook)
    const item = analyses(restored)[0].value
    expect(isAnalysisItem(item) && calibrationPlot(item)?.fit.r2).toBeCloseTo(1)
    expect(restored.getSnapshot().view!.notebook.at(-1)?.value).toMatchObject({ claim: 'The unknown requires dilution.', evidence: ['analysis:Protein#1'], validity: 'inconclusive' })
  })

  it('does not overwrite the current operation step outputs or raw measurements', () => {
    const rt = new PracticalRuntime()
    expect(rt.start('chem1-naoh-standardisation', 'practical-session', 4)).toBe(true)
    // Analysis has no procedure-step attribution, even while an operation is selected.
    const before = rt.getSnapshot().view!
    const operation = before.steps.find((s) => s.kind === 'operation')
    expect(operation).toBeTruthy()
    rt.goTo(operation!.id)
    expect(rt.perform('core:compute', { expression: '11' })).toBe(true)
    const outputs = rt.evaluate(`${operation!.id}.out`)
    expect(rt.evaluate(`${operation!.id}.out.value`)).toBe(11)
    const current = rt.getSnapshot().view!.current
    const steps = rt.getSnapshot().view!.steps
    rt.analyse('core:compute', { expression: '2 + 3', recordAs: 'analysis:sum' })
    expect(rt.getSnapshot().view!.recent.at(-1)?.params.recordAs).toBe('analysis:sum')
    expect(rt.getSnapshot().view!.current).toBe(current)
    expect(rt.getSnapshot().view!.steps).toEqual(steps)
    expect(rt.getSnapshot().view!.measurements).toEqual(before.measurements)
    expect(rt.evaluate(`${operation!.id}.out`)).toEqual(outputs)

    const measured = open()
    for (let i = 0; i < 6; i++) measured.demonstrate()
    const raw = structuredClone(measured.getSnapshot().view!.measurements)
    expect(raw.length).toBeGreaterThan(0)
    const reading = raw[0]
    const standards = Object.entries(reading.display).slice(0, 3).map(([subject, display], i) => ({ subject, display, x: `${i} mg/mL`, flags: reading.flags[subject] ?? [] }))
    expect(measured.analyse('core:fit', { ...calibrationInput(standards, reading.id, 'Concentration'), model: 'linear', recordAs: 'analysis:own-readings' })).toBe(true)
    expect(measured.getSnapshot().view!.measurements).toEqual(raw)
  })
})
