// Cells in a centrifuge: big cells (algae, yeast) pellet in minutes at modest speed, bacteria need
// far more; mixing brings the pellet back; pouring off leaves it. Speeds in rpm go through the
// rotor's radius, and a counting chamber fills only to what fits under the coverslip.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld, type Kernel, liquidVolume } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function bench(): Kernel {
  const w = emptyWorld(1)
  addPlace(w, cat, 'spin', 'core:benchtop-centrifuge-4x50')
  addEquipment(w, cat, 'p20', 'core:micropipette-p20')
  for (const [id, organism] of [['algae', 'micro:chlorella-vulgaris'], ['bacteria', 'micro:escherichia-coli-k12']]) {
    addSupply(w, cat, { id, label: id, container: 'core:conical-tube-15ml', amount: '10 mL', preparation: 'core:water-deionised', populations: [{ substance: organism, perL: 1e8 }] })
  }
  addSupply(w, cat, { id: 'chamber', label: 'Haemocytometer', container: 'core:haemocytometer', amount: '0 mL', preparation: 'core:water-deionised' })
  return createKernel(cat, w)
}

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

const pelleted = (k: Kernel, id: string) => Object.values(k.world.containers[id].contents.cellPellet ?? {}).reduce((a, p) => a + p.count, 0)

function spin(k: Kernel, params: Record<string, unknown>) {
  for (const [id, slot] of [['algae', 1], ['bacteria', 3]] as const) {
    run(k, 'core:close', { container: id })
    run(k, 'core:place-in', { container: id, place: 'spin', position: slot })
  }
  return run(k, 'core:centrifuge', { centrifuge: 'spin', duration: '3 min', ...params })
}

describe('sedimentation of cells', () => {
  it('converts rpm through the rotor radius', () => {
    const k = bench()
    const r = spin(k, { rpm: 3000 })
    // 1.118e-5 × 11 cm × 3000² ≈ 1107 × g.
    expect(r.event.facts.rcf).toBeGreaterThan(1050)
    expect(r.event.facts.rcf).toBeLessThan(1150)
  })

  it('pellets 5 µm algae almost completely at about 1000 × g, but only some bacteria', () => {
    const k = bench()
    spin(k, { rcf: '1000 [RCF]' })
    expect(pelleted(k, 'algae') / 1e6).toBeGreaterThan(0.99)
    const fraction = pelleted(k, 'bacteria') / 1e6
    expect(fraction).toBeGreaterThan(0.1)
    expect(fraction).toBeLessThan(0.5)
  })

  it('pouring off leaves the pellet, and vortexing puts it back into the liquid', () => {
    const k = bench()
    spin(k, { rpm: 3000 })
    for (const c of ['algae', 'bacteria']) run(k, 'core:remove-from', { container: c })
    run(k, 'core:open', { container: 'algae' })
    addSupply(k.world, cat, { id: 'water', label: 'Water', container: 'core:reagent-bottle-50ml', amount: '20 mL', preparation: 'core:water-deionised' })
    addSupply(k.world, cat, { id: 'pot', label: 'Pot', container: 'core:beaker-100ml', amount: '0 mL', preparation: 'core:water-deionised' })
    run(k, 'core:transfer', { source: 'algae', destination: 'pot', all: true })
    expect(pelleted(k, 'algae')).toBeGreaterThan(0.99e6)
    run(k, 'core:transfer', { source: 'water', destination: 'algae', volume: '1 mL', tool: 'pour' })
    run(k, 'core:mix', { container: 'algae', method: 'swirl', cycles: 1 })
    expect(pelleted(k, 'algae')).toBeGreaterThan(0.8e6)
    run(k, 'core:mix', { container: 'algae', method: 'vortex', cycles: 2 })
    expect(pelleted(k, 'algae')).toBeLessThan(0.02e6)
  })

  it('a counting chamber takes only what fits under its coverslip', () => {
    const k = bench()
    run(k, 'core:attach-tip', { pipette: 'p20' })
    run(k, 'core:transfer', { source: 'algae', destination: 'chamber', volume: '20 uL', tool: 'p20' })
    expect(liquidVolume(k.world.containers.chamber.contents)).toBeLessThanOrEqual(10.001e-6)
  })

  it('a rotor takes only the tube formats it lists', () => {
    const k = bench()
    addSupply(k.world, cat, { id: 'micro', label: 'Microtube', container: 'core:microtube-1.5ml', amount: '1 mL', preparation: 'core:water-deionised' })
    const r = k.execute({ op: 'core:place-in', params: { container: 'micro', place: 'spin' } })
    expect(!r.ok && r.refusal.code).toBe('DOES-NOT-FIT')
  })
})
