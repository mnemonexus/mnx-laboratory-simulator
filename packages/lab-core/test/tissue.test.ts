// Plant tissue in liquids (models/tissue.ts): potato gains water in dilute solutions and loses it in
// concentrated ones, crossing over near 0.3 M sucrose; salt draws water out twice as hard as sucrose
// of the same molarity (two ions); beetroot keeps its pigment until heat or ethanol damages its
// membranes; and lifting pieces out with forceps takes only a film of the liquid.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { liquidVolume } from '../src/kernel/state.ts'
import { sampleAbsorbance } from '../src/models/measurement.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function soak(tissue: string, liquid: Array<[string, string]>, opts: { minutes?: number; bathC?: number } = {}) {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'eye', 'core:visual-inspection')
  addPlace(w, cat, 'bath', 'core:water-bath')
  addSupply(w, cat, { id: 'liquid', label: 'liquid', container: 'core:reagent-bottle-250ml', amount: '100 mL', components: liquid.map(([substance, conc]) => ({ substance, conc })) })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r
  }
  run('core:fetch', { equipment: 'core:test-tube', id: 't', label: 't' })
  run('core:transfer', { source: 'liquid', destination: 't', volume: '10 mL' })
  if (opts.bathC) {
    run('core:set-environment', { device: 'bath', temperature: `${opts.bathC} Cel` })
    run('core:place-in', { container: 't', place: 'bath' })
    run('core:advance-time', { duration: '10 min' })
  }
  run('core:add-solid', { substance: tissue, destination: 't', mass: '2 g' })
  const before = k.world.containers.t.contents.solid[tissue]
  run('core:advance-time', { duration: `${opts.minutes ?? 120} min` })
  const t = k.world.containers.t
  return { change: (t.contents.solid[tissue] - before) / before, k, run, tube: t }
}

describe('osmosis in potato', () => {
  it('gains mass in water and dilute sucrose, loses it in concentrated sucrose, crossing over near 0.3 M', () => {
    const at = (m: number) => soak('bio:potato-tissue', m > 0 ? [['core:sucrose', `${m} mol/L`]] : []).change
    const changes = [0, 0.2, 0.4, 0.6, 1.0].map(at)
    expect(changes[0]).toBeGreaterThan(0.03)
    expect(changes[1]).toBeGreaterThan(0)
    expect(changes[2]).toBeLessThan(0)
    expect(changes[4]).toBeLessThan(changes[3])
    // Linear crossing between 0.2 and 0.4 M: the isotonic point.
    const iso = 0.2 + (0.2 * changes[1]) / (changes[1] - changes[2])
    expect(iso).toBeGreaterThan(0.25)
    expect(iso).toBeLessThan(0.35)
  })

  it('salt draws water out harder than the same molarity of sucrose', () => {
    expect(soak('bio:potato-tissue', [['aq:sodium-chloride', '0.3 mol/L']]).change).toBeLessThan(soak('bio:potato-tissue', [['core:sucrose', '0.3 mol/L']]).change - 0.03)
  })

  it('lifting pieces out brings only a film of the liquid', () => {
    const s = soak('bio:potato-tissue', [], { minutes: 5 })
    s.run('core:fetch', { equipment: 'core:weighing-boat', id: 'boat', label: 'boat' })
    s.run('core:lift-out', { source: 't', destination: 'boat' })
    expect(liquidVolume(s.k.world.containers.boat.contents) * 1000).toBeLessThan(0.05)
    expect(s.k.world.containers.boat.contents.solid['bio:potato-tissue']).toBeGreaterThan(1.9)
  })
})

describe('beetroot membranes', () => {
  const leak = (opts: { bathC?: number; ethanol?: number }) => {
    const s = soak('bio:beetroot-tissue', opts.ethanol ? [['core:ethanol', `${opts.ethanol} mol/L`]] : [], { minutes: 20, ...(opts.bathC ? { bathC: opts.bathC } : {}) })
    return sampleAbsorbance(cat, s.tube, 538, 1)
  }
  it('leak little pigment when cool and much above about 60 °C', () => {
    const cool = leak({})
    const hot = leak({ bathC: 75 })
    expect(cool).toBeLessThan(0.1)
    expect(hot).toBeGreaterThan(10 * cool)
  })
  it('leak pigment in 50 % ethanol but not in 10 %', () => {
    expect(leak({ ethanol: 1.7 })).toBeLessThan(0.15)
    expect(leak({ ethanol: 8.6 })).toBeGreaterThan(0.5)
  })
})
