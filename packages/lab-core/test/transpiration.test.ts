// Transpiration (E13): a leafy shoot in a potometer takes up water faster in light (its stomata
// open), in moving air, in dry air and in warm air; the potometer's scale reads the water taken up.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { saturationKPa } from '../src/models/transpiration.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

interface Air { place: 'lamp' | 'dark' | 'cabinet'; distance?: number; humidity?: number; wind?: string; temperature?: number }

/** mL of water a minute a 5 g shoot takes up. */
function uptake(air: Air): number {
  const w = emptyWorld(1)
  addPlace(w, cat, 'lamp', 'core:lamp')
  addPlace(w, cat, 'dark', 'core:dark-cupboard')
  addPlace(w, cat, 'cabinet', 'core:growth-cabinet')
  addSupply(w, cat, { id: 'water', label: 'water', container: 'core:reagent-bottle-1l', amount: '500 mL', preparation: 'core:water-deionised' })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, string>
  }
  run('core:fetch', { equipment: 'core:potometer', id: 'pot', label: 'pot' })
  run('core:transfer', { source: 'water', destination: 'pot', volume: '18 mL' })
  run('core:add-solid', { substance: 'bio:leafy-shoot', destination: 'pot', mass: '5 g' })
  if (air.distance) run('core:set-environment', { device: 'lamp', distance: `${air.distance} cm` })
  if (air.temperature) run('core:set-environment', { device: 'cabinet', temperature: `${air.temperature} Cel` })
  run('core:set-environment', { device: air.place, humidity: air.humidity ?? 0.5, wind: air.wind ?? 'still' })
  run('core:place-in', { container: 'pot', place: air.place })
  run('core:advance-time', { duration: '5 min' })
  const read0 = Number.parseFloat(run('core:read-volume', { container: 'pot' }).value)
  run('core:advance-time', { duration: '10 min' })
  const read1 = Number.parseFloat(run('core:read-volume', { container: 'pot' }).value)
  return (read1 - read0) / 10
}

describe('transpiration', () => {
  it('the saturation vapour pressure of water is 2.34 kPa at 20 °C and 4.24 kPa at 30 °C', () => {
    expect(saturationKPa(293.15)).toBeCloseTo(2.34, 2)
    expect(saturationKPa(303.15)).toBeCloseTo(4.24, 2)
  })

  it('a shoot under a lamp takes up about 0.02 mL a minute, far more than in the dark', () => {
    const lit = uptake({ place: 'lamp', distance: 20 })
    expect(lit).toBeGreaterThan(0.01)
    expect(lit).toBeLessThan(0.05)
    expect(uptake({ place: 'dark' })).toBeLessThan(lit / 3)
  })

  it('moving, dry and warm air raise the rate; humid air cuts it', () => {
    const still = uptake({ place: 'lamp', distance: 20 })
    expect(uptake({ place: 'lamp', distance: 20, wind: 'high' })).toBeGreaterThan(1.5 * still)
    expect(uptake({ place: 'lamp', distance: 20, humidity: 0.95 })).toBeLessThan(still / 4)
    expect(uptake({ place: 'lamp', distance: 20, humidity: 0.2 })).toBeGreaterThan(still)
    expect(uptake({ place: 'cabinet', temperature: 30 })).toBeGreaterThan(1.5 * uptake({ place: 'cabinet', temperature: 20 }))
  })
})
