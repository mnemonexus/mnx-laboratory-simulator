// Daphnia heart rate (E15): under the microscope a water flea's heart beats about 60 times in 15 s
// at room temperature, faster in warmer water, faster with caffeine and slower with ethanol.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

/** Beats a minute of a Daphnia in a solution at a temperature (the mean of five animals). */
function bpm(components: Array<{ substance: string; conc: string }>, celsius?: number): number {
  const w = emptyWorld(3)
  addEquipment(w, cat, 'scope', 'core:microscope')
  addPlace(w, cat, 'bath', 'core:water-bath')
  addSupply(w, cat, components.length ? { id: 's', label: 's', container: 'core:reagent-bottle-250ml', amount: '100 mL', components } : { id: 's', label: 's', container: 'core:reagent-bottle-250ml', amount: '100 mL', preparation: 'core:water-deionised' })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, number>
  }
  run('core:fetch', { equipment: 'core:beaker-100ml', id: 'b', label: 'b' })
  run('core:transfer', { source: 's', destination: 'b', volume: '20 mL', tool: 'pour' })
  if (celsius) {
    run('core:set-environment', { device: 'bath', temperature: `${celsius} Cel` })
    run('core:place-in', { container: 'b', place: 'bath' })
  }
  run('core:advance-time', { duration: '10 min' })
  let sum = 0
  for (let i = 0; i < 5; i++) {
    run('core:fetch', { equipment: 'core:microscope-slide', id: `s${i}`, label: 's' })
    run('core:transfer', { source: 'b', destination: `s${i}`, volume: '50 uL' })
    run('core:add-solid', { substance: 'bio:daphnia', destination: `s${i}`, mass: '0.1 mg' })
    sum += run('core:measure', { instrument: 'scope', subject: `s${i}`, objective: '10x' }).beats15s * 4
  }
  return sum / 5
}

describe('Daphnia heart rate', () => {
  it('beats about 250 times a minute at room temperature, faster when warmer', () => {
    const room = bpm([])
    expect(room).toBeGreaterThan(220)
    expect(room).toBeLessThan(290)
    expect(bpm([], 30)).toBeGreaterThan(1.4 * room)
  })

  it('caffeine speeds it and ethanol slows it', () => {
    const room = bpm([])
    expect(bpm([{ substance: 'chem:caffeine', conc: '5 mM' }])).toBeGreaterThan(1.15 * room)
    expect(bpm([{ substance: 'core:ethanol', conc: '39.5 g/L' }])).toBeLessThan(0.7 * room)
  })
})
