// Water-quality colorimetry: molybdenum blue needs its reductant; zinc grains settle behind a
// clearing front; zinc reduces nitrate only where the liquid touches it (a heterogeneous reaction).
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addContainer, addEquipment, addSupply, createKernel, emptyWorld, type Kernel, liquidVolume } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function bench(): Kernel {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'p1000', 'core:micropipette-p1000')
  addEquipment(w, cat, 'p200', 'core:micropipette-p200')
  const sup = (id: string, prep: string, amount = '20 mL', container = 'core:reagent-bottle-50ml') => addSupply(w, cat, { id, label: id, container, amount, preparation: prep })
  sup('po4', 'chem:phosphate-standard-10mgl')
  sup('no3', 'chem:nitrate-standard-180mgl')
  sup('moly', 'chem:molybdate-reagent')
  sup('asc', 'chem:ascorbic-acid-0.1m')
  sup('water', 'core:water-deionised', '50 mL')
  sup('zinc', 'chem:zinc-slurry', '1.5 mL', 'core:microtube-2ml')
  for (const id of ['with', 'without']) addContainer(w, cat, { id, equipment: 'core:cuvette-ps-macro-1cm', label: id })
  addContainer(w, cat, { id: 'bijou', equipment: 'core:bijou-7ml', label: 'bijou' })
  addContainer(w, cat, { id: 'off', equipment: 'core:bijou-7ml', label: 'off the zinc' })
  return createKernel(cat, w)
}

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

function pour(k: Kernel, source: string, destination: string, volume: string) {
  run(k, 'core:transfer', { source, destination, volume, tool: 'pour' })
}

const species = (k: Kernel, c: string, s: string) => k.world.containers[c].contents.layers.reduce((a, l) => a + (l.species[s] ?? 0), 0)
const zinc = (k: Kernel, c: string) => {
  const x = k.world.containers[c].contents
  return { suspended: x.layers.reduce((a, l) => a + (l.particles?.['chem:zinc-dust'] ?? 0), 0), settled: x.solid['chem:zinc-dust'] ?? 0 }
}

describe('water-quality colorimetry', () => {
  it('phosphate turns blue with molybdate only when ascorbic acid reduces it', () => {
    const k = bench()
    for (const c of ['with', 'without']) {
      pour(k, 'po4', c, '1 mL')
      pour(k, 'water', c, '1 mL')
      pour(k, 'moly', c, '0.5 mL')
    }
    pour(k, 'asc', 'with', '0.5 mL')
    pour(k, 'water', 'without', '0.5 mL')
    for (const c of ['with', 'without']) run(k, 'core:mix', { container: c, method: 'stir', cycles: 1 })
    run(k, 'core:advance-time', { duration: '20 min' })
    const blue = (c: string) => species(k, c, 'chem:phosphomolybdenum-blue')
    // Nearly all of the phosphate (1 mL of 0.105 mM) is blue after 20 minutes.
    expect(blue('with')).toBeGreaterThan(0.9 * 1.053e-7)
    expect(blue('without')).toBe(0)
  })

  it('zinc grains settle out of a few millilitres in well under a minute once it stands', () => {
    const k = bench()
    run(k, 'core:mix', { container: 'zinc', method: 'vortex', cycles: 1 })
    pour(k, 'no3', 'bijou', '5 mL')
    run(k, 'core:transfer', { source: 'zinc', destination: 'bijou', volume: '50 uL', tool: 'pour' })
    run(k, 'core:close', { container: 'bijou' })
    run(k, 'core:mix', { container: 'bijou', method: 'invert', cycles: 5 })
    run(k, 'core:advance-time', { duration: '5 s' })
    const early = zinc(k, 'bijou')
    expect(early.suspended).toBeGreaterThan(early.settled)
    run(k, 'core:advance-time', { duration: '1 min' })
    const late = zinc(k, 'bijou')
    expect(late.suspended).toBeLessThan(0.01 * late.settled)
  })

  it('zinc reduces nitrate where the liquid touches it, and stops once the liquid is taken off', () => {
    const k = bench()
    run(k, 'core:mix', { container: 'zinc', method: 'vortex', cycles: 1 })
    pour(k, 'no3', 'bijou', '5 mL')
    run(k, 'core:transfer', { source: 'zinc', destination: 'bijou', volume: '50 uL', tool: 'pour' })
    run(k, 'core:close', { container: 'bijou' })
    run(k, 'core:mix', { container: 'bijou', method: 'invert', cycles: 5 })
    run(k, 'core:open', { container: 'bijou' })
    run(k, 'core:advance-time', { duration: '1 min' })
    const fraction = () => species(k, 'bijou', 'chem:sodium-nitrite') / (species(k, 'bijou', 'chem:sodium-nitrite') + species(k, 'bijou', 'chem:sodium-nitrate'))
    // A few per cent a minute: partial, so timing must match between standards and samples.
    expect(fraction()).toBeGreaterThan(0.015)
    expect(fraction()).toBeLessThan(0.06)
    pour(k, 'bijou', 'off', '3 mL')
    const atTransfer = species(k, 'off', 'chem:sodium-nitrite') / liquidVolume(k.world.containers.off.contents)
    run(k, 'core:advance-time', { duration: '10 min' })
    expect(species(k, 'off', 'chem:sodium-nitrite') / liquidVolume(k.world.containers.off.contents)).toBeLessThan(1.1 * atTransfer)
    // The liquid left on the zinc keeps going.
    expect(fraction()).toBeGreaterThan(0.15)
  })
})
