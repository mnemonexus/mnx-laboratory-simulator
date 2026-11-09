// Wet solids and spot plates: a soil holds water with what lives in it, a scoop carries both in
// proportion, and drops spotted on agar are counted spot by spot (none where nothing grew,
// null where colonies run together).
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'
import { liquidVolume } from '../src/kernel/state.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

function world(cellsInSoil: number) {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'p20', 'core:micropipette-p20')
  addEquipment(w, cat, 'counter', 'core:colony-counter')
  addSupply(w, cat, {
    id: 'soil', label: 'soil', container: 'core:conical-flask-250ml', amount: '50 g',
    solids: [{ substance: 'core:soil', massG: 50 }],
    wet: { amount: '10 mL', populations: [{ substance: 'micro:pseudomonas-putida', total: cellsInSoil }] },
  })
  addSupply(w, cat, { id: 'susp', label: 'susp', container: 'core:universal-bottle-28ml', amount: '9.5 mL', preparation: 'micro:ringer-quarter' })
  addSupply(w, cat, { id: 'plate', label: 'plate', container: 'core:petri-dish-90mm', amount: '20 mL', preparation: 'micro:nutrient-agar' })
  const k = createKernel(cat, w)
  run(k, 'core:attach-tip', { pipette: 'p20' })
  return k
}

const cellsIn = (k: Kernel, id: string) => Object.values(k.world.containers[id].contents.layers.at(-1)?.populations ?? {}).reduce((a, p) => a + p.count, 0)

describe('wet solids', () => {
  it('a soil holds its water and organisms, and a scoop takes both in proportion', () => {
    const k = world(1e6)
    expect(liquidVolume(k.world.containers.soil.contents)).toBeCloseTo(0.01, 6)
    run(k, 'core:add-solid', { substance: 'soil', destination: 'susp', mass: '0.5 g' })
    // A hundredth of the soil carries a hundredth of its water and cells (the spatula is ±4 %).
    const moved = cellsIn(k, 'susp')
    expect(moved).toBeGreaterThan(0.9e4)
    expect(moved).toBeLessThan(1.1e4)
    expect(liquidVolume(k.world.containers.susp.contents)).toBeGreaterThan(0.0095)
  })
})

describe('spot plates', () => {
  it('counts each spot apart, and a crowded spot as confluent', () => {
    const k = world(1e6)
    run(k, 'core:add-solid', { substance: 'soil', destination: 'susp', mass: '5 g' })
    run(k, 'core:mix', { container: 'susp', method: 'vortex', cycles: 2 })
    // About 10⁵ cells per mL: a 5 µL spot holds about 500 (confluent); a few cells go in spots 2-4.
    run(k, 'core:transfer', { source: 'susp', destination: 'plate', volume: '5 uL', tool: 'p20', spot: 1 })
    run(k, 'core:advance-time', { duration: '40 h' })
    const r = run(k, 'core:measure', { instrument: 'counter', subject: 'plate' })
    const out = r.outputs as { bySector: Array<number | null>; display: string }
    expect(out.bySector).toEqual([null])
    expect(out.display).toBe('spot 1: confluent growth')
  })

  it('a spot plate where nothing grew still has its spots, each with none', () => {
    const k = world(0)
    for (const spot of [1, 2, 3]) run(k, 'core:transfer', { source: 'susp', destination: 'plate', volume: '5 uL', tool: 'p20', spot })
    run(k, 'core:advance-time', { duration: '40 h' })
    const out = run(k, 'core:measure', { instrument: 'counter', subject: 'plate' }).outputs as { bySector: Array<number | null>; display: string }
    expect(out.bySector).toEqual([0, 0, 0])
    expect(out.display).toBe('spot 1: none; spot 2: none; spot 3: none')
  })

  it('separate colonies are counted where they were spotted, and spot numbers are checked', () => {
    const k = world(2e5)
    run(k, 'core:add-solid', { substance: 'soil', destination: 'susp', mass: '5 g' })
    run(k, 'core:mix', { container: 'susp', method: 'vortex', cycles: 2 })
    // 2 × 10⁴ cells in ~10.5 mL: about 10 in each 5 µL spot; spot 2 is left out.
    for (const spot of [1, 3, 4]) run(k, 'core:transfer', { source: 'susp', destination: 'plate', volume: '5 uL', tool: 'p20', spot })
    run(k, 'core:advance-time', { duration: '40 h' })
    const out = run(k, 'core:measure', { instrument: 'counter', subject: 'plate' }).outputs as { bySector: Array<number | null> }
    expect(out.bySector[1]).toBe(0)
    for (const i of [0, 2, 3]) {
      expect(out.bySector[i]).toBeGreaterThan(2)
      expect(out.bySector[i]).toBeLessThan(25)
    }
    const bad = k.execute({ op: 'core:transfer', params: { source: 'susp', destination: 'plate', volume: '5 uL', tool: 'p20', spot: 49 } })
    expect(bad.ok).toBe(false)
  })
})
