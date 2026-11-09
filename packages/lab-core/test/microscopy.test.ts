// The compound microscope: what a look shows follows from the optics and the set-up (lamp,
// objective, condenser, focus, oil, phase annulus), never from what the slide is called.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addContainer, addEquipment, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function bench(): Kernel {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'scope', 'core:compound-microscope')
  addContainer(w, cat, { id: 'stem', equipment: 'core:prepared-slide.plant-stem', label: 'Stem' })
  addContainer(w, cat, { id: 'slide', equipment: 'core:microscope-slide', label: 'Slide' })
  addSupply(w, cat, { id: 'oil', label: 'Immersion oil', container: 'core:dropper-bottle-10ml', amount: '10 mL', preparation: 'core:immersion-oil' })
  addSupply(w, cat, { id: 'yeast', label: 'Yeast', container: 'core:microtube-1.5ml', amount: '1 mL', preparation: 'core:water-deionised', populations: [{ substance: 'micro:saccharomyces-cerevisiae', perL: 2e10 }] })
  return createKernel(cat, w)
}

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

/** A look: how each structure (by part of its label) was seen, and the flags. */
function look(k: Kernel, subject: string) {
  run(k, 'core:measure', { instrument: 'scope', subject })
  const m = k.world.measurements[k.world.measurements.length - 1]
  const seen = (part: string) => m.features?.find((f) => f.shape.includes(part))?.seen ?? null
  return { seen, flags: m.flags[subject] ?? [], m }
}

function setUp(k: Kernel, slide: string) {
  run(k, 'core:configure', { instrument: 'scope', lamp: 0.5, objective: '4x', illumination: 'brightfield', condenser: 'adjusted' })
  run(k, 'core:focus', { instrument: 'scope', subject: slide, knob: 'coarse' })
  run(k, 'core:focus', { instrument: 'scope', subject: slide, knob: 'fine' })
}

describe('microscopy', () => {
  it('a microscope nobody has set up gives a competent look, as the staining practicals expect', () => {
    const k = bench()
    const r = look(k, 'stem')
    expect(r.m.settings.objective).toBe('100x-oil')
    expect(r.flags).toEqual([])
    expect(r.seen('pits')).toBe('clearly')
  })

  it('once used, it starts dark and unfocused', () => {
    const k = bench()
    run(k, 'core:configure', { instrument: 'scope', objective: '4x' })
    expect(look(k, 'stem').m.display.stem).toMatch(/dark/)
    run(k, 'core:configure', { instrument: 'scope', lamp: 0.5 })
    expect(look(k, 'stem').flags).toContain('out-of-focus')
  })

  it('finer detail needs a higher numerical aperture, and the oil objective needs its oil', () => {
    const k = bench()
    setUp(k, 'stem')
    expect(look(k, 'stem').seen('nuclei')).toBe('as specks')
    run(k, 'core:configure', { instrument: 'scope', objective: '40x', lamp: 0.65 })
    run(k, 'core:focus', { instrument: 'scope', subject: 'stem', knob: 'fine' })
    const at40 = look(k, 'stem')
    expect(at40.seen('nuclei')).toBe('clearly')
    expect(at40.seen('pits')).toBe('as specks')
    run(k, 'core:configure', { instrument: 'scope', objective: '100x-oil', lamp: 0.85 })
    run(k, 'core:focus', { instrument: 'scope', subject: 'stem', knob: 'fine' })
    const dry = look(k, 'stem')
    expect(dry.flags).toContain('no-oil')
    expect(dry.seen('pits')).not.toBe('clearly')
    run(k, 'core:configure', { instrument: 'scope', objective: 'none' })
    run(k, 'core:transfer', { source: 'oil', destination: 'stem', volume: '25 uL', tool: 'pour' })
    run(k, 'core:configure', { instrument: 'scope', objective: '100x-oil' })
    // Parfocal: nearly in focus after turning the nosepiece; the fine knob finishes it.
    expect(look(k, 'stem').flags).toContain('out-of-focus')
    run(k, 'core:focus', { instrument: 'scope', subject: 'stem', knob: 'fine' })
    expect(look(k, 'stem').seen('pits')).toBe('clearly')
  })

  it('turning the 40× back over oil coats it until it is cleaned', () => {
    const k = bench()
    setUp(k, 'stem')
    run(k, 'core:transfer', { source: 'oil', destination: 'stem', volume: '25 uL', tool: 'pour' })
    run(k, 'core:configure', { instrument: 'scope', objective: '100x-oil', lamp: 0.85 })
    const r = run(k, 'core:configure', { instrument: 'scope', objective: '40x' })
    expect(r.event.facts.oiled).toEqual(['40x'])
    run(k, 'core:focus', { instrument: 'scope', subject: 'stem', knob: 'fine' })
    expect(look(k, 'stem').flags).toContain('oil-on-lens')
    run(k, 'core:configure', { instrument: 'scope', objective: 'none' })
    run(k, 'core:clean-lens', { instrument: 'scope', slide: 'stem' })
    expect((k.world.equipment.scope.state as { microscope: { oiled: string[] } }).microscope.oiled).toEqual([])
    run(k, 'core:configure', { instrument: 'scope', objective: '40x' })
    expect(look(k, 'stem').flags).not.toContain('oil-on-lens')
  })

  it('coarse focusing at high power cracks the slide; the fine knob cannot find a specimen', () => {
    const k = bench()
    run(k, 'core:configure', { instrument: 'scope', lamp: 0.6, objective: '40x' })
    expect(run(k, 'core:focus', { instrument: 'scope', subject: 'stem', knob: 'fine' }).event.facts.found).toBe(false)
    expect(run(k, 'core:focus', { instrument: 'scope', subject: 'stem', knob: 'coarse' }).event.facts.crashed).toBe(true)
    expect(k.world.incidents.some((i) => i.kind === 'mechanical')).toBe(true)
  })

  it('unstained cells are faint in bright field, clear with the matched phase annulus, faint with the wrong one', () => {
    const k = bench()
    run(k, 'core:transfer', { source: 'yeast', destination: 'slide', volume: '10 uL' })
    setUp(k, 'slide')
    run(k, 'core:configure', { instrument: 'scope', objective: '40x', lamp: 0.65 })
    run(k, 'core:focus', { instrument: 'scope', subject: 'slide', knob: 'fine' })
    expect(look(k, 'slide').seen('yeast')).toBe('faintly')
    run(k, 'core:configure', { instrument: 'scope', illumination: 'ph2', lamp: 0.9 })
    expect(look(k, 'slide').seen('yeast')).toBe('clearly')
    run(k, 'core:configure', { instrument: 'scope', illumination: 'ph1' })
    const wrong = look(k, 'slide')
    expect(wrong.flags).toContain('annulus-mismatch')
    expect(wrong.seen('yeast')).toBe('faintly')
  })

  it('writing in the middle of a slide is seen upside down and back to front', () => {
    const k = bench()
    run(k, 'core:label', { container: 'slide', text: 'e', position: 'centre' })
    setUp(k, 'slide')
    const r = look(k, 'slide')
    expect(r.m.features![0].note).toMatch(/upside down and back to front/)
    run(k, 'core:configure', { instrument: 'scope', objective: '10x' })
    expect(look(k, 'slide').m.features![0].note).toMatch(/only part of it is in view/)
  })
})
