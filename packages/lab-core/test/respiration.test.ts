// Yeast respiration through the kernel (E14): dried yeast ferments glucose and sucrose (two and four
// ethanol and CO₂ per molecule) but not lactose; the carbon dioxide it makes comes off as gas once the
// liquid is saturated; living yeast with glucose decolourises methylene blue, heat-killed yeast does not.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function flask(sugar: Array<[string, string]>, opts: { bathC?: number; minutes: number; syringe?: boolean; dye?: boolean; boilYeast?: boolean }) {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'eye', 'core:visual-inspection')
  addEquipment(w, cat, 'syringe', 'core:gas-syringe')
  addPlace(w, cat, 'bath', 'core:water-bath')
  addSupply(w, cat, { id: 'sugar', label: 'sugar', container: 'core:reagent-bottle-250ml', amount: '100 mL', components: sugar.map(([substance, conc]) => ({ substance, conc })) })
  addSupply(w, cat, { id: 'yeast', label: 'yeast', container: 'core:reagent-bottle-250ml', amount: '100 mL', components: [{ substance: 'bio:bakers-yeast', conc: '20 g/L' }] })
  addSupply(w, cat, { id: 'mb', label: 'mb', container: 'core:reagent-bottle-250ml', amount: '50 mL', components: [{ substance: 'bio:methylene-blue', conc: '0.31 mM' }] })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, string>
  }
  run('core:fetch', { equipment: 'core:conical-flask-100ml', id: 'f', label: 'f' })
  run('core:set-environment', { device: 'bath', temperature: `${opts.bathC ?? 35} Cel` })
  if (opts.boilYeast) {
    run('core:fetch', { equipment: 'core:boiling-tube', id: 'y', label: 'y' })
    run('core:transfer', { source: 'yeast', destination: 'y', volume: '10 mL' })
    run('core:set-environment', { device: 'bath', temperature: '90 Cel' })
    run('core:place-in', { container: 'y', place: 'bath' })
    run('core:advance-time', { duration: '10 min' })
    run('core:remove-from', { container: 'y' })
    run('core:set-environment', { device: 'bath', temperature: `${opts.bathC ?? 35} Cel` })
    run('core:transfer', { source: 'y', destination: 'f', all: true })
  } else run('core:transfer', { source: 'yeast', destination: 'f', volume: '10 mL' })
  run('core:transfer', { source: 'sugar', destination: 'f', volume: '10 mL' })
  if (opts.dye) run('core:transfer', { source: 'mb', destination: 'f', volume: '2 mL' })
  run('core:mix', { container: 'f', method: 'swirl', cycles: 3 })
  run('core:place-in', { container: 'f', place: 'bath' })
  if (opts.syringe) run('core:connect-gas', { container: 'f', syringe: 'syringe' })
  run('core:advance-time', { duration: `${opts.minutes} min` })
  const species = (s: string) => k.world.containers.f.contents.layers.reduce((a, l) => a + (l.species[s] ?? 0), 0)
  return { species, run }
}

describe('fermentation by yeast', () => {
  it('turns each sucrose into four ethanol, each glucose into two, and leaves lactose alone', () => {
    // 0.5 mmol of sugar, all used in an hour.
    expect(flask([['core:sucrose', '0.05 mol/L']], { minutes: 60 }).species('core:ethanol') * 1000).toBeCloseTo(2, 1)
    expect(flask([['core:glucose', '0.05 mol/L']], { minutes: 60 }).species('core:ethanol') * 1000).toBeCloseTo(1, 1)
    expect(flask([['core:lactose', '0.05 mol/L']], { minutes: 60 }).species('core:ethanol')).toBe(0)
  })

  it('gives off carbon dioxide into a gas syringe once the liquid is saturated', () => {
    const f = flask([['core:glucose', '0.10 mol/L']], { minutes: 25, syringe: true })
    expect(Number.parseFloat(f.run('core:measure', { instrument: 'syringe', subject: 'f' }).value)).toBeGreaterThan(5)
  })
})

describe('methylene blue', () => {
  it('is decolourised by living yeast with glucose but not by heat-killed yeast', () => {
    expect(flask([['core:glucose', '0.10 mol/L']], { minutes: 15, dye: true }).run('core:measure', { instrument: 'eye', subject: 'f' }).appearance).not.toMatch(/blue/)
    expect(flask([['core:glucose', '0.10 mol/L']], { minutes: 15, dye: true, boilYeast: true }).run('core:measure', { instrument: 'eye', subject: 'f' }).appearance).toMatch(/blue/)
  })
})
