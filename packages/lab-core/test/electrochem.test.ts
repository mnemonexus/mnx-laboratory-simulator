// Electrochemistry (E8): half-cells joined by a salt bridge give the difference of their Nernst
// potentials (the Daniell cell about 1.1 V, a copper concentration cell tens of millivolts, nothing
// without the bridge); a conductivity meter reads the ions (potassium chloride's standard values,
// a weak acid far below a strong one, pure water almost nothing).
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function bench(solutions: Record<string, Array<{ substance: string; conc: string }>>) {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'volts', 'core:voltmeter')
  addEquipment(w, cat, 'cond', 'core:conductivity-meter')
  for (const [id, components] of Object.entries(solutions)) addSupply(w, cat, { id, label: id, container: 'core:reagent-bottle-250ml', amount: '200 mL', components })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, unknown>
  }
  /** A beaker of a solution with a metal strip in it. */
  const halfCell = (id: string, solution: string, metal?: string) => {
    run('core:fetch', { equipment: 'core:beaker-100ml', id, label: id })
    run('core:transfer', { source: solution, destination: id, volume: '50 mL', tool: 'pour' })
    if (metal) run('core:add-solid', { substance: metal, destination: id, mass: '2 g' })
  }
  return { k, run, halfCell }
}

describe('electrochemical cells', () => {
  it('a Daniell cell gives about 1.1 V, and nothing without its salt bridge', () => {
    const { run, halfCell } = bench({ zn: [{ substance: 'aq:zinc-sulfate', conc: '1 mol/L' }], cu: [{ substance: 'aq:copper-ii-sulfate', conc: '1 mol/L' }] })
    halfCell('a', 'zn', 'aq:zinc-strip')
    halfCell('b', 'cu', 'aq:copper-strip')
    const open = Number(run('core:measure', { instrument: 'volts', subject: 'b', negative: 'a' }).value)
    expect(Math.abs(open)).toBeLessThan(0.02)
    run('core:connect-bridge', { from: 'a', to: 'b' })
    const e = Number(run('core:measure', { instrument: 'volts', subject: 'b', negative: 'a' }).value)
    expect(e).toBeGreaterThan(1.05)
    expect(e).toBeLessThan(1.15)
  })

  it('a copper concentration cell gives tens of millivolts, the dilute side negative', () => {
    const { run, halfCell } = bench({ c1: [{ substance: 'aq:copper-ii-sulfate', conc: '1 mol/L' }], c001: [{ substance: 'aq:copper-ii-sulfate', conc: '0.01 mol/L' }] })
    halfCell('a', 'c001', 'aq:copper-strip')
    halfCell('b', 'c1', 'aq:copper-strip')
    run('core:connect-bridge', { from: 'a', to: 'b' })
    const e = Number(run('core:measure', { instrument: 'volts', subject: 'b', negative: 'a' }).value)
    expect(e).toBeGreaterThan(0.02)
    expect(e).toBeLessThan(0.07)
  })

  it('zinc and copper in one acid make a simple cell of about a volt', () => {
    const { run, halfCell } = bench({ acid: [{ substance: 'core:sulfuric-acid', conc: '0.5 mol/L' }] })
    halfCell('a', 'acid', 'aq:zinc-strip')
    run('core:add-solid', { substance: 'aq:copper-strip', destination: 'a', mass: '2 g' })
    const e = Number(run('core:measure', { instrument: 'volts', subject: 'a', electrode: 'aq:copper-strip', negativeElectrode: 'aq:zinc-strip' }).value)
    expect(e).toBeGreaterThan(0.8)
    expect(e).toBeLessThan(1.2)
  })
})

describe('conductivity', () => {
  const read = (components: Array<{ substance: string; conc: string }>) => {
    const { run, halfCell } = bench({ s: components })
    halfCell('a', 's')
    return Number(run('core:measure', { instrument: 'cond', subject: 'a' }).value)
  }
  it('potassium chloride reads its standard values', () => {
    expect(read([{ substance: 'aq:potassium-chloride', conc: '0.01 mol/L' }])).toBeCloseTo(1413, -2)
    const k01 = read([{ substance: 'aq:potassium-chloride', conc: '0.1 mol/L' }])
    expect(Math.abs(k01 - 12880) / 12880).toBeLessThan(0.08)
  })

  it('a weak acid conducts far less than a strong one at the same concentration; pure water hardly at all', () => {
    const weak = read([{ substance: 'core:acetic-acid', conc: '0.1 mol/L' }])
    const strong = read([{ substance: 'core:hydrochloric-acid', conc: '0.1 mol/L' }])
    expect(weak).toBeGreaterThan(300)
    expect(weak).toBeLessThan(800)
    expect(strong / weak).toBeGreaterThan(40)
    expect(read([])).toBeLessThan(1)
  })
})
