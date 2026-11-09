// Respiration of whole organisms (E14): germinating peas over soda lime shrink the gas in a sealed
// respirometer by the oxygen they use (about 0.25 µmol/g/min at 25 °C, faster when warmer); without
// soda lime the volume hardly changes (RQ 1); boiled peas do nothing; in a vacuum flask the heat of
// germinating peas warms them by several degrees in two days.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function setup() {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'thermo', 'core:thermometer-digital')
  addPlace(w, cat, 'bath', 'core:water-bath')
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, string>
  }
  return { k, run }
}

/** mL of gas lost a minute from a respirometer of 5 g of organisms at a temperature, with or without soda lime. */
function shrinkage(organism: string, celsius: number, sodaLime = true): number {
  const { run } = setup()
  run('core:fetch', { equipment: 'core:respirometer', id: 'r', label: 'r' })
  if (sodaLime) run('core:add-solid', { substance: 'core:soda-lime', destination: 'r', mass: '3 g' })
  run('core:add-solid', { substance: organism, destination: 'r', mass: '5 g' })
  run('core:trap-air', { container: 'r', volume: '20 mL' })
  run('core:set-environment', { device: 'bath', temperature: `${celsius} Cel` })
  run('core:place-in', { container: 'r', place: 'bath' })
  run('core:advance-time', { duration: '10 min' })
  const v0 = Number.parseFloat(run('core:read-volume', { container: 'r' }).value)
  run('core:advance-time', { duration: '10 min' })
  const v1 = Number.parseFloat(run('core:read-volume', { container: 'r' }).value)
  return (v0 - v1) / 10
}

describe('respiration', () => {
  it('germinating peas over soda lime take up about 0.03 mL of oxygen a minute (5 g, 25 °C); boiled peas none', () => {
    const live = shrinkage('bio:germinating-peas', 25)
    expect(live).toBeGreaterThan(0.02)
    expect(live).toBeLessThan(0.04)
    expect(Math.abs(shrinkage('bio:boiled-peas', 25))).toBeLessThan(0.002)
  })

  it('without soda lime the carbon dioxide replaces the oxygen, and the volume hardly changes', () => {
    expect(Math.abs(shrinkage('bio:germinating-peas', 25, false))).toBeLessThan(0.1 * shrinkage('bio:germinating-peas', 25))
  })

  it('respiration speeds up with temperature (Q10 about 2)', () => {
    const r15 = shrinkage('bio:germinating-peas', 25)
    const r35 = shrinkage('bio:germinating-peas', 35)
    expect(r35 / r15).toBeGreaterThan(1.8)
    expect(r35 / r15).toBeLessThan(2.6)
  })

  it('germinating peas in a vacuum flask warm by several degrees in two days; boiled ones do not', () => {
    const warming = (peas: string) => {
      const { k, run } = setup()
      run('core:fetch', { equipment: 'core:vacuum-flask', id: 'f', label: 'f' })
      run('core:add-solid', { substance: peas, destination: 'f', mass: '100 g' })
      const t0 = k.world.containers.f.contents.temperatureK
      run('core:advance-time', { duration: '2 d' })
      return k.world.containers.f.contents.temperatureK - t0
    }
    expect(warming('bio:germinating-peas')).toBeGreaterThan(4)
    expect(Math.abs(warming('bio:boiled-peas'))).toBeLessThan(0.5)
  })
})
