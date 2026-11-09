// Making and recovering salts through the kernel: an insoluble base dissolving in warm acid, crystals
// growing as a saturated solution cools, the water a precipitate's formula holds, and heat kept
// honest when a concentrated solution crystallises. Each follows from data (surface rates, log K
// and its ΔH, molar masses, enthalpies), not from rules about particular salts.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { contentsMassKg } from '../src/kernel/materials.ts'
import { addPlace } from '../src/kernel/world.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function bench(liquids: Array<[id: string, substance: string, conc: string]>) {
  const w = emptyWorld(1)
  addPlace(w, cat, 'bath', 'core:water-bath', 'Water bath', '25 Cel')
  for (const [id, substance, conc] of liquids) addSupply(w, cat, { id, label: id, container: 'core:reagent-bottle-250ml', amount: '200 mL', components: [{ substance, conc }] })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  }
  const solid = (id: string, s: string) => {
    const c = k.world.containers[id].contents
    return (c.solid[s] ?? 0) + c.layers.reduce((a, l) => a + (l.particles?.[s] ?? 0), 0)
  }
  return { k, run, solid }
}

describe('a soluble salt from an insoluble base', () => {
  it('copper(II) oxide hardly dissolves in cold acid but does near 70 °C', () => {
    const dissolved = (celsius: number) => {
      const { run, solid } = bench([['acid', 'aq:sulfuric-acid', '1 mol/L']])
      run('core:fetch', { equipment: 'core:beaker-100ml', id: 'b' })
      run('core:transfer', { source: 'acid', destination: 'b', volume: '25 mL', tool: 'pour' })
      if (celsius > 25) {
        run('core:set-environment', { device: 'bath', temperature: `${celsius} Cel` })
        run('core:place-in', { container: 'b', place: 'bath' })
        run('core:advance-time', { duration: '5 min' })
      }
      run('core:add-solid', { substance: 'aq:copper-ii-oxide', destination: 'b', mass: '1 g' })
      const start = solid('b', 'aq:copper-ii-oxide')
      run('core:advance-time', { duration: '10 min' })
      return 1 - solid('b', 'aq:copper-ii-oxide') / start
    }
    expect(dissolved(20)).toBeLessThan(0.15)
    expect(dissolved(70)).toBeGreaterThan(0.5)
  })

  it('a hot concentrated copper(II) sulfate solution grows blue crystals as it cools', () => {
    const { k, run, solid } = bench([['cu', 'aq:copper-ii-sulfate', '1.8 mol/L']])
    run('core:fetch', { equipment: 'core:beaker-100ml', id: 'b' })
    run('core:set-environment', { device: 'bath', temperature: '80 Cel' })
    run('core:place-in', { container: 'b', place: 'bath' })
    run('core:transfer', { source: 'cu', destination: 'b', volume: '20 mL', tool: 'pour' })
    run('core:advance-time', { duration: '10 min' })
    // Hot, it holds more than the 1.4 M it can hold at room temperature.
    const hot = solid('b', 'aq:copper-ii-sulfate-pentahydrate')
    run('core:remove-from', { container: 'b' })
    run('core:advance-time', { duration: '60 min' })
    const cold = solid('b', 'aq:copper-ii-sulfate-pentahydrate')
    expect(cold).toBeGreaterThan(hot + 0.002)
    expect(k.world.containers.b.contents.temperatureK).toBeGreaterThan(290)
    expect(k.world.containers.b.contents.temperatureK).toBeLessThan(300)
  })
})

describe('mass and heat stay true', () => {
  it('a hydroxide precipitating takes its water from the liquid: the mass of the contents is kept', () => {
    const { k, run } = bench([['cu', 'aq:copper-ii-sulfate', '0.5 mol/L'], ['oh', 'aq:sodium-hydroxide', '1 mol/L']])
    run('core:fetch', { equipment: 'core:beaker-100ml', id: 'a' })
    run('core:fetch', { equipment: 'core:beaker-100ml', id: 'b' })
    run('core:transfer', { source: 'cu', destination: 'a', volume: '20 mL', tool: 'pour' })
    run('core:transfer', { source: 'oh', destination: 'b', volume: '20 mL', tool: 'pour' })
    const before = contentsMassKg(cat, k.world.containers.a.contents) + contentsMassKg(cat, k.world.containers.b.contents)
    run('core:transfer', { source: 'b', destination: 'a', all: true })
    run('core:mix', { container: 'a', method: 'stir', cycles: 3 })
    run('core:advance-time', { duration: '30 min' })
    const after = contentsMassKg(cat, k.world.containers.a.contents) + contentsMassKg(cat, k.world.containers.b.contents)
    expect(Math.abs(after - before) * 1000).toBeLessThan(0.05)
  })

  it('evaporating a solution until it crystallises leaves a sensible temperature', () => {
    const { k, run, solid } = bench([['cu', 'aq:copper-ii-sulfate', '0.8 mol/L']])
    run('core:fetch', { equipment: 'core:beaker-100ml', id: 'b' })
    run('core:transfer', { source: 'cu', destination: 'b', volume: '25 mL', tool: 'pour' })
    run('core:dry', { container: 'b', method: 'heat', duration: '110 min' })
    const c = k.world.containers.b.contents
    expect(solid('b', 'aq:copper-ii-sulfate-pentahydrate')).toBeGreaterThan(0.005)
    expect(c.temperatureK).toBeGreaterThan(285)
    expect(c.temperatureK).toBeLessThan(310)
  }, 120000)
})
