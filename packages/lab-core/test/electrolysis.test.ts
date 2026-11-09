// Electrolysis (E8): Faraday's laws (copper deposited = It/2F), the discharge order (copper before
// hydrogen; chlorine from brine, oxygen from sulfate), a copper anode dissolving as fast as the
// cathode plates, hydrogen and oxygen 2 : 1 from dilute acid, and no current through pure water.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { layerPH } from '../src/models/acidbase.ts'
import { HYDROGEN } from '../src/models/surface.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const F = 96485.33212

function cell(electrolyte: Array<{ substance: string; conc: string }> | 'water', anode: string, cathode: string) {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'psu', 'core:dc-power-supply')
  addEquipment(w, cat, 'syr-a', 'core:gas-syringe')
  addEquipment(w, cat, 'syr-c', 'core:gas-syringe')
  addSupply(w, cat, electrolyte === 'water'
    ? { id: 'liquid', label: 'liquid', container: 'core:reagent-bottle-250ml', amount: '200 mL', preparation: 'core:water-deionised' }
    : { id: 'liquid', label: 'liquid', container: 'core:reagent-bottle-250ml', amount: '200 mL', components: electrolyte })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, string>
  }
  run('core:fetch', { equipment: 'core:beaker-250ml', id: 'cell', label: 'cell' })
  run('core:transfer', { source: 'liquid', destination: 'cell', volume: '150 mL', tool: 'pour' })
  for (const [id, material] of [['an', anode], ['cat', cathode]]) {
    run('core:fetch', { equipment: 'core:electrode-holder', id, label: id })
    run('core:add-solid', { substance: material, destination: id, mass: '2 g' })
  }
  const solid = (id: string) => k.world.containers[id].contents.solid
  return { k, run, solid }
}

describe('electrolysis', () => {
  it('copper(II) sulfate on graphite: copper on the cathode by Faraday’s law, oxygen at the anode, the liquid turning acidic', () => {
    const { k, run, solid } = cell([{ substance: 'aq:copper-ii-sulfate', conc: '0.5 mol/L' }], 'core:graphite-rod', 'core:graphite-rod')
    const pH0 = layerPH(cat, k.world.containers.cell.contents.layers[0], 298.15)!
    const out = run('core:electrolyse', { supply: 'psu', cell: 'cell', anode: 'an', cathode: 'cat', current: '0.5 A', duration: '20 min' })
    expect(out.cathode).toMatch(/deposit/)
    expect(out.anode).toMatch(/bubbles/)
    const copper = solid('cat')['aq:copper-metal'] ?? 0
    expect(copper).toBeCloseTo((0.5 * 1200) / (2 * F), 5)
    expect(layerPH(cat, k.world.containers.cell.contents.layers[0], 298.15)!).toBeLessThan(pH0 - 0.3)
  })

  it('copper electrodes: the anode loses what the cathode gains', () => {
    const { run, solid } = cell([{ substance: 'aq:copper-ii-sulfate', conc: '0.5 mol/L' }], 'aq:copper-strip', 'aq:copper-strip')
    const before = solid('an')['aq:copper-strip']
    run('core:electrolyse', { supply: 'psu', cell: 'cell', anode: 'an', cathode: 'cat', current: '0.4 A', duration: '15 min' })
    const lost = before - solid('an')['aq:copper-strip']
    const gained = solid('cat')['aq:copper-metal'] ?? 0
    expect(lost).toBeCloseTo((0.4 * 900) / (2 * F), 5)
    expect(gained).toBeCloseTo(lost, 5)
  })

  it('brine gives hydrogen and chlorine, which bleaches damp litmus, and turns alkaline', () => {
    const { k, run } = cell([{ substance: 'aq:sodium-chloride', conc: '3 mol/L' }], 'core:graphite-rod', 'core:graphite-rod')
    run('core:fetch', { equipment: 'core:test-tube', id: 'ta', label: 'ta' })
    run('core:fetch', { equipment: 'core:test-tube', id: 'tc', label: 'tc' })
    run('core:electrolyse', { supply: 'psu', cell: 'cell', anode: 'an', cathode: 'cat', current: '0.5 A', duration: '5 min', anodeGas: 'ta', cathodeGas: 'tc' })
    expect(run('core:test-gas', { container: 'ta', test: 'damp-blue-litmus' }).appearance).toMatch(/bleached/)
    expect(run('core:test-gas', { container: 'tc', test: 'lighted-splint' }).appearance).toMatch(/pop/)
    expect(layerPH(cat, k.world.containers.cell.contents.layers[0], 298.15)!).toBeGreaterThan(10)
  })

  it('dilute sulfuric acid gives hydrogen and oxygen, twice the volume of hydrogen', () => {
    const { k, run } = cell([{ substance: 'core:sulfuric-acid', conc: '0.5 mol/L' }], 'core:graphite-rod', 'core:graphite-rod')
    for (const [t, s] of [['ta', 'syr-a'], ['tc', 'syr-c']]) {
      run('core:fetch', { equipment: 'core:test-tube', id: t, label: t })
      run('core:connect-gas', { container: t, syringe: s })
    }
    run('core:electrolyse', { supply: 'psu', cell: 'cell', anode: 'an', cathode: 'cat', current: '0.3 A', duration: '10 min', anodeGas: 'ta', cathodeGas: 'tc' })
    const h2 = k.world.containers.tc.gas?.collectedMol?.[HYDROGEN] ?? 0
    const o2 = k.world.containers.ta.gas?.collectedMol?.['core:oxygen'] ?? 0
    expect(h2 / o2).toBeCloseTo(2, 3)
    expect(h2).toBeCloseTo((0.3 * 600) / (2 * F), 6)
  })

  it('pure water hardly conducts: the supply cannot reach its current', () => {
    const { run } = cell('water', 'core:graphite-rod', 'core:graphite-rod')
    const out = run('core:electrolyse', { supply: 'psu', cell: 'cell', anode: 'an', cathode: 'cat', current: '0.5 A', duration: '1 min' })
    expect(Number.parseFloat(out.current)).toBeLessThan(0.001)
    expect(out.notes).toMatch(/fell short/)
  })
})
