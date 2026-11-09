// Gas laws (E10): trapped air obeys Boyle's and Charles's laws; a volatile liquid injected into a
// hot syringe gives its molar mass from pV = nRT; water's vapour swells a bubble of air beyond
// Charles's law by its vapour pressure (47 kPa at 80 °C); an oil film's size gives the molecule's
// length.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { vapourPressureKPa } from '../src/models/gaslaws.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function bench() {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'p', 'core:pressure-sensor')
  addEquipment(w, cat, 'hypo', 'core:syringe-1ml')
  addEquipment(w, cat, 'ruler', 'core:ruler')
  addPlace(w, cat, 'ice', 'core:ice-bath')
  addPlace(w, cat, 'bath', 'core:water-bath')
  addPlace(w, cat, 'oven', 'core:oven')
  addSupply(w, cat, { id: 'acetone', label: 'propanone', container: 'core:reagent-bottle-50ml', amount: '20 mL', components: [{ substance: 'chem:propanone', conc: '784 g/L' }] })
  addSupply(w, cat, { id: 'water', label: 'water', container: 'core:reagent-bottle-250ml', amount: '200 mL', preparation: 'core:water-deionised' })
  addSupply(w, cat, { id: 'oleic', label: 'oleic acid, 0.05 % in ethanol', container: 'core:reagent-bottle-50ml', amount: '20 mL', components: [{ substance: 'chem:oleic-acid', conc: '0.4475 g/L' }, { substance: 'core:ethanol', conc: '789 g/L' }] })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, string>
  }
  const num = (s: string) => Number.parseFloat(s)
  return { k, run, num }
}

describe('gas laws', () => {
  it('Boyle: halving the volume of trapped air doubles its pressure', () => {
    const { run, num } = bench()
    run('core:fetch', { equipment: 'core:gas-syringe-sealed', id: 's', label: 's' })
    run('core:trap-air', { container: 's', volume: '50 mL' })
    run('core:hold-plunger', { container: 's', volume: '50 mL' })
    const p50 = num(run('core:measure', { instrument: 'p', subject: 's' }).value)
    run('core:hold-plunger', { container: 's', volume: '25 mL' })
    const p25 = num(run('core:measure', { instrument: 'p', subject: 's' }).value)
    expect(p50).toBeCloseTo(101.3, 0)
    expect(p25 / p50).toBeCloseTo(2, 2)
  })

  it('Charles: the free volume of trapped air goes as the absolute temperature', () => {
    const { run, num } = bench()
    run('core:fetch', { equipment: 'core:gas-syringe-sealed', id: 's', label: 's' })
    run('core:trap-air', { container: 's', volume: '50 mL' })
    run('core:place-in', { container: 's', place: 'ice' })
    run('core:advance-time', { duration: '10 min' })
    const cold = num(run('core:read-volume', { container: 's' }).value)
    run('core:remove-from', { container: 's' })
    run('core:set-environment', { device: 'bath', temperature: '80 Cel' })
    run('core:place-in', { container: 's', place: 'bath' })
    run('core:advance-time', { duration: '10 min' })
    const hot = num(run('core:read-volume', { container: 's' }).value)
    expect(hot / cold).toBeCloseTo(353.15 / 273.15, 1)
  })

  it('propanone injected into a syringe in an oven at 100 °C gives its molar mass', () => {
    const { run, num } = bench()
    run('core:fetch', { equipment: 'core:gas-syringe-sealed', id: 's', label: 's' })
    run('core:trap-air', { container: 's', volume: '5 mL' })
    run('core:place-in', { container: 's', place: 'oven' })
    run('core:advance-time', { duration: '10 min' })
    const v0 = num(run('core:read-volume', { container: 's' }).value)
    run('core:transfer', { source: 'acetone', destination: 's', volume: '0.15 mL', tool: 'hypo' })
    run('core:advance-time', { duration: '15 min' })
    const v1 = num(run('core:read-volume', { container: 's' }).value)
    const grams = 0.15 * 0.784
    const mol = (101.325 * (v1 - v0)) / 1000 / (8.314 * 373.15)
    expect(grams / mol).toBeGreaterThan(54)
    expect(grams / mol).toBeLessThan(62)
  })

  it('water’s vapour pressure: 3.2 kPa at 25 °C and 47 kPa at 80 °C (Clausius–Clapeyron)', () => {
    expect(vapourPressureKPa(cat, 'core:water', 298.15)!).toBeCloseTo(3.3, 0)
    expect(vapourPressureKPa(cat, 'core:water', 353.15)!).toBeGreaterThan(44)
    expect(vapourPressureKPa(cat, 'core:water', 353.15)!).toBeLessThan(50)
  })

  it('a drop of dilute oleic acid spreads into a film about 11 cm across', () => {
    const { run, num } = bench()
    run('core:fetch', { equipment: 'core:ripple-tray', id: 'tray', label: 'tray' })
    run('core:transfer', { source: 'water', destination: 'tray', volume: '150 mL', tool: 'pour' })
    run('core:transfer', { source: 'oleic', destination: 'tray', volume: '20 uL' })
    const d = num(run('core:measure', { instrument: 'ruler', subject: 'tray' }).value)
    expect(d).toBeGreaterThan(9.5)
    expect(d).toBeLessThan(12.5)
  })
})
