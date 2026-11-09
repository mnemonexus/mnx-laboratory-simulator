// Heat held by solids and taken up in melting (E6): a hot metal block lifted into water shares its
// heat by heat capacity (method of mixtures); ice melts in warm water taking 334 J/g, with energy
// conserved through the change of phase; molten stearic acid freezes at a steady 69 °C (a plateau in
// its cooling curve); and solids that are pieces (ice, metal blocks) do not dissolve when stirred.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const C0 = 273.15

function lab() {
  const w = emptyWorld(1)
  addPlace(w, cat, 'bath', 'core:water-bath')
  addSupply(w, cat, { id: 'water', label: 'water', container: 'core:reagent-bottle-1l', amount: '800 mL', components: [] })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
  }
  const T = (id: string) => k.world.containers[id].contents.temperatureK - C0
  return { k, run, T }
}

describe('heat capacity of solids', () => {
  it('a hot aluminium block warms cold water as m c ΔT says, and does not dissolve', () => {
    const { k, run, T } = lab()
    run('core:set-environment', { device: 'bath', temperature: '95 Cel' })
    run('core:fetch', { equipment: 'core:beaker-250ml', id: 'hot', label: 'hot' })
    run('core:transfer', { source: 'water', destination: 'hot', volume: '150 mL' })
    run('core:place-in', { container: 'hot', place: 'bath' })
    run('core:add-solid', { substance: 'core:aluminium-block', destination: 'hot', mass: '50 g' })
    run('core:advance-time', { duration: '10 min' })
    const hot = T('hot')
    const block = k.world.containers.hot.contents.solid['core:aluminium-block'] * 26.98
    run('core:fetch', { equipment: 'core:calorimeter-cup', id: 'cup', label: 'cup' })
    run('core:transfer', { source: 'water', destination: 'cup', volume: '100 mL' })
    const cold = T('cup')
    run('core:lift-out', { source: 'hot', destination: 'cup' })
    run('core:mix', { container: 'cup', method: 'stir', cycles: 5 })
    const mixed = T('cup')
    expect(k.world.containers.cup.contents.solid['core:aluminium-block']).toBeGreaterThan(0)
    const c = (100 * 4.184 * (mixed - cold)) / (block * (hot - mixed))
    expect(c).toBeGreaterThan(0.85)
    expect(c).toBeLessThan(0.97)
  })
})

describe('melting and freezing', () => {
  it('ice melts in warm water taking about 334 J/g, energy conserved', () => {
    const { k, run, T } = lab()
    run('core:fetch', { equipment: 'core:calorimeter-cup', id: 'cup', label: 'cup' })
    run('core:transfer', { source: 'water', destination: 'cup', volume: '100 mL' })
    k.world.containers.cup.contents.temperatureK = C0 + 40
    run('core:add-solid', { substance: 'core:ice', destination: 'cup', mass: '20 g' })
    const ice = k.world.containers.cup.contents.solid['core:ice'] * 18.015
    run('core:mix', { container: 'cup', method: 'stir', cycles: 3 })
    run('core:advance-time', { duration: '30 s' })
    expect(k.world.containers.cup.contents.solid['core:ice'] ?? 0).toBe(0)
    const final = T('cup')
    // 100 g × 4.184 × (40 − T) = m L + m × 4.184 × T
    const L = (100 * 4.184 * (40 - final) - ice * 4.184 * final) / ice
    expect(L).toBeGreaterThan(300)
    expect(L).toBeLessThan(345)
  })

  it('molten stearic acid holds at its freezing point while it freezes', () => {
    const { k, run, T } = lab()
    run('core:set-environment', { device: 'bath', temperature: '80 Cel' })
    run('core:fetch', { equipment: 'core:boiling-tube', id: 'tube', label: 'tube' })
    run('core:add-solid', { substance: 'chem:stearic-acid', destination: 'tube', mass: '5 g' })
    run('core:place-in', { container: 'tube', place: 'bath' })
    run('core:advance-time', { duration: '10 min' })
    expect(k.world.containers.tube.contents.solid['chem:stearic-acid'] ?? 0).toBe(0)
    run('core:remove-from', { container: 'tube' })
    const readings: number[] = []
    for (let i = 0; i < 40; i++) {
      run('core:advance-time', { duration: '30 s' })
      readings.push(T('tube'))
    }
    expect(readings.filter((t) => Math.abs(t - 69.3) < 0.5).length).toBeGreaterThanOrEqual(6)
    expect(readings[readings.length - 1]).toBeLessThan(50)
  })
})
