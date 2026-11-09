// Real-time PCR: SYBR Green read after every cycle, Cq at a threshold, a standard curve whose slope
// gives the efficiency, and a melt curve that tells one product from primer-dimers. Every number
// comes from the PCR run cycle by cycle; nothing about this practical is special-cased.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { LabSession } from '../src/session/session.ts'
import { baselineCorrect, quantificationCycle } from '../src/models/qpcr.ts'
import { duplexTmK } from '../src/models/pcr.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const qpcr = readJson(join(PACKAGES, 'pack-molecular-biology', 'definitions', 'molbio6-qpcr-standard-curve.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const noted = (r: Result, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value as number
const record = (r: Result, quantity: string, unit: string) => r.kernel!.world.measurements.find((m) => m.quantity === quantity && m.unit === unit)!
const ntcWells = ['plate/A1', 'plate/A2', 'plate/A3']
const variant = (edit: (d: ExperimentDefinition) => void) => {
  const def = structuredClone(qpcr)
  edit(def)
  return compile(def, catalogue, { seed: 1 })
}
const runParams = (d: ExperimentDefinition) => d.procedure!.steps!.find((s) => s.id === 'run')!.params as Record<string, unknown>

describe('conformance: real-time PCR', () => {
  it('rehearses for several seeds: about 3.3 cycles per ten-fold, the unknown found, clean controls', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(qpcr, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(r.run!.decisions.ntc).toBe('specific')
      expect(noted(r, 'efficiency-%')).toBeGreaterThan(90)
      expect(noted(r, 'efficiency-%')).toBeLessThan(100)
    }
  }, 120000)

  it('reads Cq where a geometric signal crosses the threshold, after subtracting a sloping baseline', () => {
    // 0.001 doubling each cycle from read 13, on a background falling 0.002 a cycle: crosses 0.2 near cycle 20.6.
    const reads = Array.from({ length: 40 }, (_, i) => 1 - 0.002 * i + 0.001 * 2 ** Math.min(i - 12, 12) * (i > 12 ? 1 : 0))
    const cq = quantificationCycle(baselineCorrect(reads), 0.2)!
    expect(cq).toBeGreaterThan(19.5)
    expect(cq).toBeLessThan(21)
  })

  it('a short duplex melts lower than the amplicon: about 72 against 80 °C', () => {
    expect(duplexTmK(catalogue, 'molbio:gfp-qpcr-amplicon') - 273.15).toBeCloseTo(80.4, 0)
    expect(duplexTmK(catalogue, 'molbio:primer-dimer') - 273.15).toBeCloseTo(71.9, 0)
  })

  it('without the dye the PCR still works, but no well is ever determined', () => {
    const r = variant((d) => (d.materials!.supplies!.find((s) => s.id === 'master')!.preparation = 'molbio:pcr-master-mix-2x-no-dye'))
    const amp = record(r, 'fluorescence', '{cycles}')
    expect(Object.keys(amp.values ?? {})).toHaveLength(0)
    expect(Object.values(amp.display).every((t) => t === 'Undetermined')).toBe(true)
    expect(r.kernel!.world.containers['plate/A4'].contents.layers[0].species['molbio:gfp-qpcr-amplicon']).toBeGreaterThan(0)
  }, 60000)

  it('annealing far too cold: the no-template controls come up late and melt low (primer-dimers)', () => {
    const r = variant((d) => (runParams(d).annealTemperature = '45 Cel'))
    const amp = record(r, 'fluorescence', '{cycles}')
    const melt = record(r, 'fluorescence', 'Cel')
    for (const w of ntcWells) {
      expect(amp.values![w]).toBeGreaterThan(30)
      expect(melt.values![w]).toBeLessThan(76)
    }
    // With template, the product wins: one peak near 80 °C and the dimers suppressed.
    expect(melt.peaks!['plate/A4']).toHaveLength(1)
    expect(melt.values!['plate/A4']).toBeGreaterThan(78)
    expect(r.run!.decisions.ntc).toBe('dimers')
  }, 60000)

  it('the session view carries both sets of curves for the notebook to draw', () => {
    const started = LabSession.start(qpcr, catalogue, { seed: 1 })
    if (!started.ok) throw new Error(started.message)
    const s = started.session
    for (let i = 0; i < 200 && s.view().current; i++) s.demonstrate(s.view().current!)
    const [amp, melt] = s.view().measurements.filter((m) => m.curves).map((m) => m.curves!)
    expect(amp.axis.label).toBe('cycle')
    expect(amp.axis.values).toHaveLength(40)
    expect(amp.signal).toBe('ΔRn')
    expect(amp.threshold).toBe(0.2)
    expect(Object.keys(amp.series)).toHaveLength(21)
    expect(melt.axis.unit).toBe('Cel')
    expect(melt.signal).toBe('−dF/dT')
    expect(melt.peaks!['plate/A4']).toHaveLength(1)
  }, 60000)

  it('carried-over PCR product contaminates the water: the controls amplify and melt like the product', () => {
    const r = variant((d) => {
      d.variation = { ...(d.variation ?? {}), faults: [{ id: 'carry-over', probability: 1, apply: { supply: 'water', truth: { contains: [{ substance: 'molbio:gfp-amplicon', conc: '1e2 {copies}/uL' }] } } }] }
    })
    const amp = record(r, 'fluorescence', '{cycles}')
    const melt = record(r, 'fluorescence', 'Cel')
    for (const w of ntcWells) {
      expect(amp.values![w]).toBeGreaterThan(25)
      expect(melt.values![w]).toBeGreaterThan(78)
    }
    expect(r.run!.decisions.ntc).toBe('contaminated')
    expect(r.rehearsal!.goals.find((g) => g.id === 'g-specific')!.passed).toBe(false)
  }, 60000)
})
