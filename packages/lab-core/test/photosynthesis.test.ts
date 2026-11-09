// Light-driven enzymes (E13): a lamp's light falls as the square of its distance, and pondweed gives
// off oxygen faster nearer the lamp (saturating), not at all in the dark, and less through a green
// filter than a red one; isolated chloroplasts reduce DCPIP in light but not in the dark; pond
// plankton in a sealed bottle gain oxygen in light and lose it in the dark.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function setup() {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'syringe', 'core:photosynthometer')
  addPlace(w, cat, 'lamp', 'core:lamp')
  addPlace(w, cat, 'dark', 'core:dark-cupboard')
  addSupply(w, cat, { id: 'hco3', label: 'hco3', container: 'core:reagent-bottle-1l', amount: '250 mL', components: [{ substance: 'aq:sodium-hydrogencarbonate', conc: '0.1 mol/L' }] })
  addSupply(w, cat, { id: 'chloro', label: 'chloro', container: 'core:reagent-bottle-250ml', amount: '50 mL', components: [{ substance: 'bio:chloroplasts', conc: '2 mg/mL' }] })
  addSupply(w, cat, { id: 'dcpip', label: 'dcpip', container: 'core:reagent-bottle-250ml', amount: '50 mL', components: [{ substance: 'bio:dcpip', conc: '1 mM' }] })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, string>
  }
  return { k, run }
}

/** mL of oxygen a minute from 5 g of pondweed at a lamp distance (0 = dark), optionally filtered. */
function pondweed(distanceCm: number, filter = 'none'): number {
  const { run } = setup()
  run('core:fetch', { equipment: 'core:boiling-tube', id: 't', label: 't' })
  run('core:transfer', { source: 'hco3', destination: 't', volume: '30 mL' })
  run('core:add-solid', { substance: 'bio:pondweed', destination: 't', mass: '5 g' })
  run('core:mix', { container: 't', method: 'swirl', cycles: 2 })
  if (distanceCm > 0) {
    run('core:set-environment', { device: 'lamp', distance: `${distanceCm} cm`, filter })
    run('core:place-in', { container: 't', place: 'lamp' })
  } else run('core:place-in', { container: 't', place: 'dark' })
  run('core:advance-time', { duration: '8 min' })
  run('core:connect-gas', { container: 't', syringe: 'syringe' })
  run('core:advance-time', { duration: '5 min' })
  return Number.parseFloat(run('core:measure', { instrument: 'syringe', subject: 't' }).value) / 5
}

describe('photosynthesis', () => {
  it('pondweed gives off oxygen faster nearer the lamp, levelling off, and none in the dark', () => {
    const r10 = pondweed(10)
    const r20 = pondweed(20)
    const r40 = pondweed(40)
    expect(r40).toBeLessThan(r20)
    expect(r20).toBeLessThan(r10)
    // Saturating: halving the distance from 20 to 10 cm (four times the light) less than doubles the rate.
    expect(r10 / r20).toBeLessThan(2)
    expect(pondweed(0)).toBe(0)
  })

  it('green light drives photosynthesis less than red', () => {
    expect(pondweed(10, 'green')).toBeLessThan(pondweed(10, 'red'))
  })

  it('chloroplasts reduce DCPIP in light but not in the dark', () => {
    const dcpipLeft = (place: string) => {
      const { k, run } = setup()
      run('core:fetch', { equipment: 'core:test-tube', id: 't', label: 't' })
      run('core:transfer', { source: 'chloro', destination: 't', volume: '1 mL' })
      run('core:transfer', { source: 'dcpip', destination: 't', volume: '0.5 mL' })
      run('core:mix', { container: 't', method: 'swirl', cycles: 3 })
      if (place === 'lamp') run('core:set-environment', { device: 'lamp', distance: '20 cm' })
      run('core:place-in', { container: 't', place })
      run('core:advance-time', { duration: '10 min' })
      return k.world.containers.t.contents.layers.reduce((a, l) => a + (l.species['bio:dcpip'] ?? 0), 0)
    }
    expect(dcpipLeft('lamp')).toBeLessThan(0.1 * dcpipLeft('dark'))
  })

  it('pond water in a stoppered, brim-full bottle gains oxygen in light and loses it in the dark; open, it stays near air saturation', () => {
    const oxygenAfterDay = (place: 'lamp' | 'dark', stopper: boolean) => {
      const w = emptyWorld(1)
      addPlace(w, cat, 'lamp', 'core:lamp')
      addPlace(w, cat, 'dark', 'core:dark-cupboard')
      addSupply(w, cat, { id: 'pond', label: 'pond', container: 'core:reagent-bottle-1l', amount: '1 L', components: [{ substance: 'core:oxygen', conc: '0.28 mM' }, { substance: 'aq:sodium-hydrogencarbonate', conc: '2 mM' }, { substance: 'bio:phytoplankton', conc: '5 mg/L' }, { substance: 'bio:plankton-respiration', conc: '5 mg/L' }] })
      const k = createKernel(cat, w)
      const run = (op: string, params: Record<string, unknown>) => {
        const r = k.execute({ op, params })
        if (!r.ok) throw new Error(r.refusal.message)
      }
      run('core:fetch', { equipment: 'core:bod-bottle-300ml', id: 'b', label: 'b' })
      run('core:transfer', { source: 'pond', destination: 'b', brim: true })
      const c = k.world.containers.b
      expect(c.capacityL - c.contents.layers[0].volumeL).toBeLessThan(1e-9)
      if (stopper) run('core:close', { container: 'b' })
      if (place === 'lamp') run('core:set-environment', { device: 'lamp', distance: '25 cm' })
      run('core:place-in', { container: 'b', place })
      run('core:advance-time', { duration: '24 h' })
      const l = k.world.containers.b.contents.layers[0]
      return ((l.species['core:oxygen'] ?? 0) / l.volumeL) * 32000
    }
    expect(oxygenAfterDay('lamp', true)).toBeGreaterThan(11)
    const sealed = oxygenAfterDay('dark', true)
    expect(sealed).toBeLessThan(8.5)
    // Open, the air slowly makes up some of what is respired.
    expect(oxygenAfterDay('dark', false)).toBeGreaterThan(sealed + 0.3)
  })
})
